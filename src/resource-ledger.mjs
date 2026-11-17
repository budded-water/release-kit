import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicJson, digest, privateDirectory, verifyJournalEvent } from './state.mjs';

const MAX_EVENTS = 10000;
const MAX_RECORD = 2 * 1024 * 1024;
const MAX_BYTES = 64 * 1024 * 1024;

export function resourceError(code, message) {
  return Object.assign(new Error(message), { code });
}

export function resourceCode(error) {
  return typeof error?.code === 'string' && /^(?:(?:RESOURCE|COORDINATION)_[A-Z_]{1,60}|E[A-Z]{1,20})$/.test(error.code)
    ? error.code : 'RESOURCE_ASSESSMENT';
}

export async function readResourceJson(path, maxBytes = MAX_RECORD) {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maxBytes)
    throw resourceError('RESOURCE_RECORD_INVALID', 'Resource record is redirected, linked or oversized');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await file.stat();
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size)
      throw resourceError('RESOURCE_RECORD_CHANGED', 'Resource record changed while opening');
    const bytes = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!result.bytesRead) break;
      offset += result.bytesRead;
    }
    const after = await file.stat();
    const current = await lstat(path);
    if (offset !== before.size || after.mtimeMs !== before.mtimeMs ||
        current.dev !== before.dev || current.ino !== before.ino || current.size !== before.size ||
        current.mtimeMs !== before.mtimeMs || current.isSymbolicLink())
      throw resourceError('RESOURCE_RECORD_CHANGED', 'Resource record changed while reading');
    return { value: JSON.parse(bytes.subarray(0, offset)), size: offset,
      identity: { dev: before.dev, ino: before.ino, size: before.size, mtimeMs: before.mtimeMs, ctimeMs: before.ctimeMs } };
  } finally { await file.close(); }
}

export async function readResourceLedger(store) {
  const state = { schemaVersion: 1, kind: 'task-resource-ledger', tasks: {}, resources: {}, sessions: {} };
  const directory = join(store, 'resources', 'events');
  let names;
  try {
    const st = await lstat(directory);
    if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('Redirected resource event directory');
    names = (await readdir(directory)).sort();
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { sequence: 0, previous: null, bytes: 0, state };
  }
  if (names.length > MAX_EVENTS) throw resourceError('RESOURCE_BUDGET', 'Resource history entry budget exhausted');
  let previous = null, bytes = 0;
  const deadline = Date.now() + 30000;
  for (const [index, name] of names.entries()) {
    if (Date.now() >= deadline) throw resourceError('RESOURCE_BUDGET', 'Resource history time budget exhausted');
    if (name !== `${String(index + 1).padStart(8, '0')}.json`)
      throw resourceError('RESOURCE_HISTORY_INVALID', 'Resource history is partial or unrecognized');
    const record = await readResourceJson(join(directory, name));
    if ((bytes += record.size) > MAX_BYTES)
      throw resourceError('RESOURCE_BUDGET', 'Resource history byte budget exhausted');
    const verified = verifyJournalEvent(record.value, index + 1, previous);
    const changes = verified.state;
    if (changes.schemaVersion !== 1 || changes.kind !== 'task-resource-ledger-event')
      throw resourceError('RESOURCE_SCHEMA', 'Unsupported resource history');
    for (const kind of ['tasks', 'resources', 'sessions']) {
      const entries = changes[kind];
      if (!entries || Array.isArray(entries) || typeof entries !== 'object' ||
          Object.entries(entries).some(([key, value]) =>
            !(kind === 'resources' ? /^[a-f0-9]{64}$/ : /^[a-f0-9-]{36}$/).test(key) ||
            !value || typeof value !== 'object' || Array.isArray(value)))
        throw resourceError('RESOURCE_SCHEMA', 'Unsupported resource event entries');
      Object.assign(state[kind], entries);
    }
    previous = verified.digest;
  }
  if (!names.length) throw resourceError('RESOURCE_HISTORY_INVALID', 'Resource history is unexpectedly empty');
  return { sequence: names.length, previous, bytes, state };
}

// Caller holds a verified sole lifecycle writer lease. No mutable index is trusted.
export async function appendResourceState(store, ledger, assertOwner) {
  await assertOwner();
  if (ledger.sequence >= MAX_EVENTS) throw resourceError('RESOURCE_BUDGET', 'Resource history entry budget exhausted');
  const current = await readResourceLedger(store);
  if (current.sequence !== ledger.sequence || current.previous !== ledger.previous)
    throw resourceError('RESOURCE_HISTORY_CHANGED', 'Resource history changed before append');
  const sequence = ledger.sequence + 1;
  const changes = { schemaVersion: 1, kind: 'task-resource-ledger-event' };
  for (const kind of ['tasks', 'resources', 'sessions']) {
    if (Object.keys(current.state[kind]).some(key => !Object.hasOwn(ledger.state[kind], key)))
      throw resourceError('RESOURCE_HISTORY_INVALID', 'Resource history cannot remove prior identities');
    changes[kind] = Object.fromEntries(Object.entries(ledger.state[kind]).filter(([key, value]) =>
      digest(value) !== (Object.hasOwn(current.state[kind], key) ? digest(current.state[kind][key]) : null)));
  }
  const event = { sequence, previous: ledger.previous, digest: digest(changes), state: changes };
  const eventBytes = Buffer.byteLength(JSON.stringify(event, null, 2) + '\n');
  if (eventBytes > MAX_RECORD || current.bytes + eventBytes > MAX_BYTES)
    throw resourceError('RESOURCE_BUDGET', 'Resource event byte budget exhausted');
  await privateDirectory(join(store, 'resources', 'events'));
  await atomicJson(join(store, 'resources', 'events', `${String(sequence).padStart(8, '0')}.json`), event,
    { exclusive: true });
  ledger.sequence = sequence;
  ledger.previous = digest(event);
  ledger.bytes = current.bytes + eventBytes;
}
