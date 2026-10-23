// Keep this module dependency-free: installation copies it outside mutable control/state.
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rmdir, unlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

const UUID = '[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}';
const TOKEN = new RegExp(`^${UUID}$`);
const ACTIVITY = new RegExp(`^activity-(${UUID})\\.json$`);
const GATE = '.admission';
const MAINTENANCE = 'maintenance.json';
const OWNER_KEYS = [
  'schemaVersion',
  'kind',
  'token',
  'operation',
  'pid',
  'host',
  'uid',
  'createdAt',
];
const MAX_RECORD_BYTES = 16 * 1024;

export class CoordinationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CoordinationError';
    this.code = code;
  }
}

function invalid(message) {
  return new CoordinationError('COORDINATION_INVALID', message);
}

function busy(message) {
  return new CoordinationError(
    'COORDINATION_BUSY',
    `${message}; preserve ownership records and reconcile the owner and children before recovery. No automatic takeover is permitted.`,
  );
}

function currentUid() {
  if (typeof process.getuid !== 'function')
    throw invalid('Coordination requires a POSIX user identity');
  return process.getuid();
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function privateNode(stat, path, directory) {
  const expectedMode = directory ? 0o700 : 0o600;
  if (
    stat.isSymbolicLink() ||
    !(directory ? stat.isDirectory() : stat.isFile()) ||
    stat.uid !== currentUid() ||
    (stat.mode & 0o7777) !== expectedMode ||
    (!directory && stat.nlink !== 1)
  ) {
    throw invalid(
      `Coordination ${directory ? 'directory' : 'record'} must be an owned, private ${directory ? '0700 directory' : '0600 single-link regular file'}: ${path}`,
    );
  }
}

async function anchorIdentity(anchor, expected) {
  if (typeof anchor !== 'string' || !isAbsolute(anchor) || resolve(anchor) !== anchor)
    throw invalid('Coordination anchor must be an absolute canonical path');
  for (let current = anchor; ; current = dirname(current)) {
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw invalid(`Coordination anchor must not traverse symlinks: ${current}`);
    if (dirname(current) === current) break;
  }
  if ((await realpath(anchor)) !== anchor) throw invalid('Coordination anchor is redirected');
  const stat = await lstat(anchor);
  privateNode(stat, anchor, true);
  if (expected && !sameFile(stat, expected)) throw invalid('Coordination anchor identity changed');
  return stat;
}

function validateOperation(operation) {
  if (
    typeof operation !== 'string' ||
    !operation ||
    operation !== operation.trim() ||
    operation.length > 200 ||
    /[\u0000-\u001f\u007f]/.test(operation)
  )
    throw invalid(
      'Coordination operation must be a nonempty, single-line description of at most 200 characters',
    );
}

function makeOwner(kind, operation) {
  validateOperation(operation);
  return Object.freeze({
    schemaVersion: 1,
    kind,
    token: randomUUID(),
    operation,
    pid: process.pid,
    host: hostname(),
    uid: currentUid(),
    createdAt: new Date().toISOString(),
  });
}

function validateOwner(owner, kind, path) {
  if (
    !owner ||
    typeof owner !== 'object' ||
    Array.isArray(owner) ||
    Object.keys(owner).length !== OWNER_KEYS.length ||
    !OWNER_KEYS.every((key) => Object.hasOwn(owner, key)) ||
    owner.schemaVersion !== 1 ||
    owner.kind !== kind ||
    !TOKEN.test(owner.token) ||
    !Number.isSafeInteger(owner.pid) ||
    owner.pid <= 0 ||
    typeof owner.host !== 'string' ||
    !owner.host ||
    owner.host.length > 255 ||
    owner.uid !== currentUid() ||
    typeof owner.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(owner.createdAt)) ||
    new Date(owner.createdAt).toISOString() !== owner.createdAt
  )
    throw invalid(`Malformed coordination ownership record: ${path}`);
  validateOperation(owner.operation);
  return owner;
}

async function readOwner(path, kind) {
  const before = await lstat(path);
  privateNode(before, path, false);
  if (before.size > MAX_RECORD_BYTES)
    throw invalid(`Oversized coordination ownership record: ${path}`);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await file.stat();
    privateNode(opened, path, false);
    if (!sameFile(before, opened))
      throw invalid(`Coordination record changed while opening: ${path}`);
    const bytes = await file.readFile('utf8');
    if (Buffer.byteLength(bytes) > MAX_RECORD_BYTES)
      throw invalid(`Oversized coordination ownership record: ${path}`);
    let owner;
    try {
      owner = JSON.parse(bytes);
    } catch {
      throw invalid(`Malformed coordination ownership record: ${path}`);
    }
    const after = await lstat(path);
    privateNode(after, path, false);
    if (!sameFile(opened, after) || opened.size !== after.size || opened.mtimeMs !== after.mtimeMs)
      throw invalid(`Coordination record changed while reading: ${path}`);
    return { owner: validateOwner(owner, kind, path), stat: opened };
  } finally {
    await file.close();
  }
}

async function syncDirectory(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}

async function writeOwner(path, owner) {
  const file = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    // A restrictive umask may remove owner write permission; preserve the exact contract.
    await file.chmod(0o600);
    await file.writeFile(`${JSON.stringify(owner, null, 2)}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
  await syncDirectory(dirname(path));
}

async function removeOwned(path, owner, expectedStat) {
  const current = await readOwner(path, owner.kind);
  if (
    !sameFile(current.stat, expectedStat) ||
    !OWNER_KEYS.every((key) => current.owner[key] === owner[key])
  )
    throw invalid(
      `Coordination ownership changed; refusing to remove another owner's evidence: ${path}`,
    );
  await unlink(path);
  await syncDirectory(dirname(path));
}

async function acquireGate(anchor, identity) {
  const path = join(anchor, GATE);
  const owner = makeOwner('gate', 'coordination admission');
  const deadline = performance.now() + 1000;
  for (;;) {
    await anchorIdentity(anchor, identity);
    try {
      await mkdir(path, { mode: 0o700 });
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      // A crashed, partial or malformed gate is still an exclusion fence. Never remove it.
      try {
        privateNode(await lstat(path), path, true);
      } catch (inspectionError) {
        // The previous owner may normally finish between our mkdir and lstat.
        if (inspectionError.code !== 'ENOENT') throw inspectionError;
      }
      if (performance.now() >= deadline)
        throw busy(`Coordination admission gate is occupied: ${path}`);
      await delay(20);
    }
  }
  // Any failure after mkdir intentionally retains evidence, including an empty gate.
  privateNode(await lstat(path), path, true);
  await writeOwner(join(path, 'owner.json'), owner);
  const gateStat = await lstat(path);
  const ownerStat = await lstat(join(path, 'owner.json'));
  return async () => {
    await anchorIdentity(anchor, identity);
    const now = await lstat(path);
    privateNode(now, path, true);
    if (!sameFile(now, gateStat)) throw invalid('Coordination admission gate identity changed');
    const entries = await readdir(path);
    if (entries.length !== 1 || entries[0] !== 'owner.json')
      throw invalid('Coordination admission gate contains unexpected evidence');
    await removeOwned(join(path, 'owner.json'), owner, ownerStat);
    await rmdir(path);
    await syncDirectory(anchor);
  };
}

async function underGate(anchor, identity, action) {
  const releaseGate = await acquireGate(anchor, identity);
  try {
    return await action();
  } finally {
    await releaseGate();
  }
}

async function inventory(anchor) {
  const activities = [];
  let maintenance = null;
  for (const name of (await readdir(anchor)).sort()) {
    if (name === MAINTENANCE)
      maintenance = (await readOwner(join(anchor, name), 'maintenance')).owner;
    else if (name.startsWith('activity-')) {
      const match = ACTIVITY.exec(name);
      if (!match) throw invalid(`Unrecognized coordination activity evidence: ${name}`);
      const { owner } = await readOwner(join(anchor, name), 'activity');
      if (owner.token !== match[1])
        throw invalid(`Coordination activity filename and owner disagree: ${name}`);
      activities.push(owner);
    }
  }
  if (maintenance && activities.length)
    throw invalid('Conflicting maintenance and activity ownership evidence');
  return { anchor, activities, maintenance };
}

async function acquire(anchor, kind, { operation } = {}) {
  const owner = makeOwner(kind, operation);
  const identity = await anchorIdentity(anchor);
  const path = join(anchor, kind === 'maintenance' ? MAINTENANCE : `activity-${owner.token}.json`);
  const stat = await underGate(anchor, identity, async () => {
    const status = await inventory(anchor);
    if (status.maintenance)
      throw busy(`Maintenance owns coordination: ${status.maintenance.operation}`);
    if (kind === 'maintenance' && status.activities.length)
      throw busy(
        `Cannot start maintenance while ${status.activities.length} activity owner(s) remain`,
      );
    await anchorIdentity(anchor, identity);
    await writeOwner(path, owner);
    return lstat(path);
  });
  let released = false;
  return {
    owner,
    async release() {
      if (released) return;
      await underGate(anchor, identity, async () => {
        if (released) return;
        await anchorIdentity(anchor, identity);
        await removeOwned(path, owner, stat);
        released = true;
      });
    },
  };
}

/** Shared admission must surround mutable input reads and the lifetime of supervised children. */
export async function acquireActivity(anchor, options) {
  return acquire(anchor, 'activity', options);
}

/** Caller must inspect pending requests after admission, while keeping this ownership. */
export async function acquireMaintenance(anchor, options) {
  return acquire(anchor, 'maintenance', options);
}

/** A retirement append may run only in the process holding exclusive admission. */
export async function assertMaintenanceOwner(anchor, owner) {
  const identity = await anchorIdentity(anchor);
  if (owner?.kind !== 'maintenance' || owner.pid !== process.pid || owner.host !== hostname())
    throw invalid('Request reconciliation requires this process to own maintenance admission');
  await underGate(anchor, identity, async () => {
    const current = await inventory(anchor);
    if (!current.maintenance || !OWNER_KEYS.every((key) => current.maintenance[key] === owner[key]))
      throw invalid('Request reconciliation does not own current maintenance admission');
  });
}

/** Coherent read; an occupied/crashed admission gate fails closed after a bounded wait. */
export async function inspectCoordination(anchor) {
  const identity = await anchorIdentity(anchor);
  return underGate(anchor, identity, () => inventory(anchor));
}
