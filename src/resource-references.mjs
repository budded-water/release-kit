import { lstat, readdir } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { verifyJournalEvent } from './state.mjs';
import { readResourceJson, resourceError } from './resource-ledger.mjs';
import { containsPath } from './resource-files.mjs';

const pathKey = key => ['path', 'file', 'directory', 'root', 'cwd', 'receipt', 'report', 'evidence', 'artifact'].includes(key) ||
  /(?:Path|File|Directory|Root|Receipt|Report)$/.test(key);

// These schema-v1 fields are written by the engine's error formatter. Their
// strings preserve diagnostics, not file dependencies. Custom fields, including
// custom `error`/`message` fields, retain the conservative reference rules.
const platform = key => ['ios', 'android', 'harmony'].includes(key);
const engineStage = key => ['install-validation', 'checks', 'ui-eval'].includes(key) ||
  typeof key === 'string' && /^(?:preflight|install|doctor|build|publish|upload)-(?:ios|android|harmony)$/.test(key);
const diagnosticField = path =>
  path.length === 2 && ['sourceValidation', 'uiValidation'].includes(path[0]) && path[1] === 'error' ||
  path.length === 3 && path[0] === 'stages' && engineStage(path[1]) && path[2] === 'error' ||
  path.length === 3 && path[0] === 'acceptanceStatus' && platform(path[1]) && path[2] === 'error' ||
  path.length === 3 && ['outcomes', 'observations'].includes(path[0]) &&
    platform(path[1]) && path[2] === 'message' ||
  path.length === 4 && path[0] === 'retiredBuilds' && Number.isInteger(path[1]) &&
    path[2] === 'stage' && path[3] === 'error';

// All retained snapshots participate. The adapter additionally verifies referenced
// reports; parsing release JSON alone cannot prove those files contain no inputs.
export async function inspectResourceReferences(store, adapter, { signal, timeoutMs = 30000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  const paths = new Set(), states = new Map(), files = new Map(), directories = new Map();
  let entries = 0, bytes = 0, nodes = 0;
  const check = () => {
    signal?.throwIfAborted();
    if (Date.now() >= deadline || entries > 10000 || nodes > 1000000 || bytes > 64 * 1024 * 1024)
      throw resourceError('RESOURCE_BUDGET', 'Historical reference assessment is incomplete');
  };
  function collect(value, key = '', depth = 0, path = []) {
    check();
    if (++nodes > 1000000 || depth > 64) throw resourceError('RESOURCE_BUDGET', 'Reference complexity budget exhausted');
    if (typeof value === 'string') {
      if (diagnosticField(path)) return;
      // Planner v1 retains these Git object identities under legacy *Path keys.
      // A malformed value or similarly named custom field is still unknown.
      if (path.length === 3 && path[0] === 'plan' && path[1] === 'metadata' &&
          ['metadataPath', 'submissionInformationPath'].includes(path[2]) && /^[a-f0-9]{40}$/.test(value)) return;
      if (value.length > 4096 || /^file:/i.test(value))
        throw resourceError('RESOURCE_REFERENCES', 'Historical reference scope is unknown');
      if (isAbsolute(value)) {
        const path = resolve(value);
        if (!containsPath(store, path))
          throw resourceError('RESOURCE_REFERENCES', 'External historical reference requires reconciliation');
        paths.add(path);
      } else if (pathKey(key) && value && !/^[a-z][a-z0-9+.-]*:\/\//i.test(value))
        throw resourceError('RESOURCE_REFERENCES', 'Relative historical reference requires reconciliation');
    } else if (value && typeof value === 'object') {
      if (Object.keys(value).length > 1000000 - nodes)
        throw resourceError('RESOURCE_BUDGET', 'Reference complexity budget exhausted');
      for (const [childKey, child] of Object.entries(value))
        collect(child, Array.isArray(value) ? key : childKey, depth + 1,
          [...path, Array.isArray(value) ? Number(childKey) : childKey]);
    }
  }
  const releases = join(store, 'releases');
  const assertUnchanged = async () => {
    for (const [path, before] of files) {
      check();
      const st = await lstat(path);
      if (st.isSymbolicLink() || Object.entries(before).some(([key, value]) => st[key] !== value))
        throw resourceError('RESOURCE_REFERENCES', 'Retained reference file changed before reclamation');
    }
    for (const [path, before] of directories) {
      check();
      const st = await lstat(path);
      if (st.isSymbolicLink() || st.dev !== before.dev || st.ino !== before.ino ||
          JSON.stringify((await readdir(path)).sort()) !== JSON.stringify(before.names))
        throw resourceError('RESOURCE_REFERENCES', 'Retained reference directory changed before reclamation');
    }
  };
  let names;
  try {
    const st = await lstat(releases);
    if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('Redirected release root');
    names = await readdir(releases);
  } catch (error) {
    if (error.code === 'ENOENT') return { paths, states, assertUnchanged: async () => {
      try { await lstat(releases); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
      throw resourceError('RESOURCE_REFERENCES', 'Release history appeared after observation');
    } };
    throw error;
  }
  directories.set(releases, { ...(await lstat(releases)), names: [...names].sort() });
  for (const id of names.sort()) {
    check();
    if (!/^release-[a-f0-9]{24}$/.test(id))
      throw resourceError('RESOURCE_REFERENCES', 'Unrecognized release history');
    const directory = join(releases, id, 'events');
    for (const ancestor of [join(releases, id), directory]) {
      const st = await lstat(ancestor);
      if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('Redirected release history');
    }
    const events = (await readdir(directory)).sort();
    directories.set(directory, { ...(await lstat(directory)), names: events });
    if (!events.length) throw resourceError('RESOURCE_REFERENCES', 'Release history is missing');
    let previous = null;
    for (const [index, name] of events.entries()) {
      entries++;
      check();
      if (name !== `${String(index + 1).padStart(8, '0')}.json`)
        throw resourceError('RESOURCE_REFERENCES', 'Release history is partial');
      const record = await readResourceJson(join(directory, name), 8 * 1024 * 1024);
      files.set(join(directory, name), record.identity);
      bytes += record.size;
      check();
      const verified = verifyJournalEvent(record.value, index + 1, previous);
      const state = verified.state;
      if (state?.schemaVersion !== 1 || state.plan?.id !== id || !state.stages ||
          !/^[a-f0-9]{40}$/.test(state.plan.source ?? ''))
        throw resourceError('RESOURCE_REFERENCES', 'Release history schema is unsupported');
      collect(state);
      const additional = await adapter.references({ state, store, signal });
      if (!Array.isArray(additional) || additional.length > 10000 ||
          additional.some(path => typeof path !== 'string' || !isAbsolute(path) || !containsPath(store, resolve(path))))
        throw resourceError('RESOURCE_REFERENCES', 'Adapter did not establish complete retained reference scope');
      additional.forEach(path => paths.add(resolve(path)));
      states.set(id, state);
      previous = verified.digest;
    }
    if (JSON.stringify((await readdir(directory)).sort()) !== JSON.stringify(events))
      throw resourceError('RESOURCE_REFERENCES', 'Release history changed during assessment');
  }
  check();
  return { paths, states, assertUnchanged };
}
