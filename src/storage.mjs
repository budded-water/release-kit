import { constants } from 'node:fs';
import { lstat, open, opendir } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { canonicalPrivatePath, verifyJournalEvent } from './state.mjs';

const RELEASE = /^release-[a-f0-9]{24}$/;
const WORKSPACE = /^(validation|store-content-source|build-(ios|android|harmony)(?:-attempt-[1-9]\d*)?)$/;
const RECORD_LIMIT = 8 * 1024 * 1024;
const METADATA_LIMIT = 64 * 1024 * 1024;
const within = (parent, child) => parent === child || child.startsWith(parent + sep);
const stamp = s => [s.dev, s.ino, s.mode, s.size, s.mtimeMs, s.ctimeMs].join(':');
const pathKey = key => ['path', 'file', 'directory', 'root', 'cwd', 'receipt', 'report', 'evidence', 'artifact'].includes(key) || /(?:Path|File|Directory|Root|Receipt|Report)$/.test(key);
function limit(value, fallback, max, name) {
  value ??= fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`Invalid ${name}`);
  return value;
}
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function knownState(state, id) {
  if (!record(state) || state.schemaVersion !== 1 || !record(state.plan) ||
      state.plan.id !== id || !/^[a-f0-9]{40}$/.test(state.plan.source ?? '') || !record(state.stages)) return false;
  for (const field of ['stages', 'artifacts', 'outcomes', 'checkpoints']) {
    if (state[field] !== undefined && (!record(state[field]) || Object.values(state[field]).some(value => !record(value)))) return false;
  }
  return state.testflight === undefined || record(state.testflight);
}
function unsettled(state) {
  if (Object.values(state.stages ?? {}).some(stage => !stage || stage.status !== 'succeeded')) return true;
  if (state.testflight && Object.keys(state.testflight).length &&
      !(state.testflight.build?.state === 'recorded' && state.testflight.build?.status === 'FINISHED' &&
        state.testflight.submission?.state === 'finished' && state.testflight.apple?.availabilityVerified === true)) return true;
  const outcomes = Object.values(state.outcomes ?? {});
  const terminal = outcomes.length && outcomes.every(outcome => outcome?.state === 'released' ||
    outcome?.state === 'available' && outcome.availabilityVerified === true ||
    outcome?.state === 'accepted' && !state.publicationRequested);
  return Boolean(state.publicationRequested && !terminal ||
    Object.values(state.checkpoints ?? {}).some(value => value && Object.keys(value).length) && !terminal ||
    outcomes.length && !terminal);
}

// No mkdir, locks, project imports, subprocesses, network or arbitrary file reads.
export async function inspectStorage({ stateDirectory, maxEntries, timeoutMs, signal } = {}) {
  if (typeof stateDirectory !== 'string' || !isAbsolute(stateDirectory)) throw new Error('Storage inspection requires an absolute state directory');
  maxEntries = limit(maxEntries, 100000, 10000000, 'entry budget');
  timeoutMs = limit(timeoutMs, 120000, 300000, 'storage timeout');
  signal?.throwIfAborted();
  const startedAt = new Date().toISOString();
  const deadline = Date.now() + timeoutMs;
  const declaredRoot = resolve(stateDirectory);
  const root = await canonicalPrivatePath(stateDirectory);
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory()) throw new Error('Storage root must be an existing directory');
  const errors = [], groups = new Map(), workspaces = new Map(), releases = new Map();
  const metadata = new Map(), directoryStamps = new Map(), seen = new Set(), inodes = new Set();
  const deferredDirectories = [];
  const references = new Map(), workspaceReferences = new Map(), referenceUnknown = new Set(), globalProtection = new Set();
  let visited = 0, apparentBytes = 0, allocatedBytes = 0, allocationKnown = true, symlinks = 0, hardLinkedFiles = 0;
  let metadataBytes = 0, objectNodes = 0, errorCount = 0;
  let metadataPhase = true;
  let referenceResolutionComplete = false;
  const fail = code => Object.assign(new Error(code), { storageCode: code });
  const check = () => {
    signal?.throwIfAborted();
    if (Date.now() >= deadline) throw fail('timeout');
  };
  const error = (code, path) => {
    errorCount++;
    if (errors.length < 100) errors.push({ code, ...(path ? { path } : {}) });
  };
  const groupFor = parts => parts[0] === 'releases' && parts[1] ? parts.slice(0, 2).join(sep) : parts[0] || '.';
  async function visit(path, depth) {
    check();
    if (++visited > maxEntries) throw fail('entry-budget-exhausted');
    if (depth > 128) throw fail('depth-budget-exhausted');
    const rel = relative(root, path), parts = rel ? rel.split(sep) : [];
    let st;
    try { st = await lstat(path); } catch { error('filesystem-unreadable', rel); return; }
    seen.add(rel);
    const groupName = rel && (st.isDirectory() || parts.length > 1) ? groupFor(parts) : '.';
    if (!groups.has(groupName)) groups.set(groupName, { path: groupName, apparentBytes: 0, files: 0, directories: 0, symlinks: 0 });
    const group = groups.get(groupName);
    const releaseId = parts[0] === 'releases' && RELEASE.test(parts[1] ?? '') ? parts[1] : undefined;
    if (parts[0] === 'releases' && parts.length === 2) {
      if (!releaseId || !st.isDirectory() || st.isSymbolicLink()) error('unrecognized-release', rel);
      else releases.set(releaseId, { id: releaseId, path: rel, events: [], current: null, verifiedEvents: 0, journalVerified: false, reasons: new Set() });
    }
    if (releaseId && parts.length === 3 && WORKSPACE.test(parts[2]) && st.isDirectory() && !st.isSymbolicLink()) {
      workspaces.set(rel, { path: rel, releaseId, kind: parts[2] === 'validation' ? 'validation' : parts[2] === 'store-content-source' ? 'store-content-source' : 'build',
        apparentBytes: 0, files: 0, symlinks: 0 });
    }
    const workspace = releaseId && parts.length >= 3 ? workspaces.get(parts.slice(0, 3).join(sep)) : undefined;
    if (parts.length === 1 && ['locks', 'dispatch', 'targets'].includes(parts[0]) && !st.isDirectory()) {
      globalProtection.add('ownership-root-unavailable');
      error('ownership-root-unavailable', rel);
    }
    if (parts[0] === 'locks' && parts.length > 1) globalProtection.add('lock-or-cleanup-ownership-present');
    if (parts[0] === 'dispatch' && parts.length > 1) globalProtection.add('dispatch-reconciliation-not-assessed');
    if (parts[0] === 'targets' && parts.length > 1) globalProtection.add('target-ownership-present');
    if (st.isSymbolicLink()) {
      symlinks++; group.symlinks++; if (workspace) workspace.symlinks++;
      if (releaseId && parts[2] === 'events') error('redirected-journal-entry', rel);
      return;
    }
    if (st.isFile()) {
      apparentBytes += st.size; group.apparentBytes += st.size; group.files++;
      if (workspace) { workspace.apparentBytes += st.size; workspace.files++; }
      const inode = `${st.dev}:${st.ino}`;
      if (!inodes.has(inode)) {
        inodes.add(inode);
        if (Number.isSafeInteger(st.blocks)) allocatedBytes += st.blocks * 512; else allocationKnown = false;
      }
      if (st.nlink > 1) hardLinkedFiles++;
      if (releaseId && parts[2] === 'events') {
        if (parts.length !== 4 || !/^\d{8}\.json$/.test(parts[3])) error('unrecognized-journal-entry', rel);
        else {
          metadata.set(rel, { path, size: st.size, stamp: stamp(st) });
          releases.get(releaseId)?.events.push(rel);
        }
      }
      return;
    }
    if (!st.isDirectory()) { error('unsupported-filesystem-entry', rel); return; }
    if (releaseId && parts[2] === 'events' && parts.length > 3) error('unrecognized-journal-entry', rel);
    group.directories++;
    if (!rel || parts[0] === 'releases' && parts.length <= 3) directoryStamps.set(rel, stamp(st));
    // Discover every release journal and immediate ownership marker before deep
    // workspaces can consume the shared entry/time budgets. Count each path once.
    const metadataDirectory = !rel || parts[0] === 'releases' && parts.length === 1 ||
      releaseId && (parts.length === 2 || parts.length === 3 && parts[2] === 'events') ||
      parts.length === 1 && ['locks', 'dispatch', 'targets'].includes(parts[0]);
    if (metadataPhase && !metadataDirectory) {
      deferredDirectories.push({ path, depth, stamp: stamp(st) });
      return;
    }
    await visitChildren(path, depth);
  }
  async function visitChildren(path, depth) {
    check();
    const rel = relative(root, path);
    let handle;
    try { handle = await opendir(path); } catch { error('filesystem-unreadable', rel); return; }
    try {
      for await (const child of handle) await visit(resolve(path, child.name), depth + 1);
    } catch (e) {
      if (e.storageCode || signal?.aborted) throw e;
      error('filesystem-unreadable', rel);
    }
  }
  async function collectReferences(value, releaseId) {
    const pending = [{ value, depth: 0, key: '' }];
    while (pending.length) {
      check();
      const { value: item, depth, key } = pending.pop();
      if (++objectNodes > 1000000 || depth > 64) throw fail('metadata-complexity-budget-exhausted');
      if (objectNodes % 1024 === 0) { await setImmediate(); check(); }
      if (typeof item === 'string') {
        if (/^file:/i.test(item)) { referenceUnknown.add(releaseId); continue; }
        if (isAbsolute(item)) {
          if (item.length > 4096) { referenceUnknown.add(releaseId); continue; }
          let target = resolve(item);
          // Normalize only the already-validated declared-root OS alias.
          if (within(declaredRoot, target)) target = resolve(root, relative(declaredRoot, target));
          if (within(root, target)) {
            const rel = relative(root, target);
            if (!references.has(rel)) {
              if (references.size >= 100000) throw fail('reference-budget-exhausted');
              references.set(rel, new Set());
            }
            references.get(rel).add(releaseId);
            const workspace = rel.split(sep).slice(0, 3).join(sep);
            if (workspaces.has(workspace)) {
              if (!workspaceReferences.has(workspace)) workspaceReferences.set(workspace, new Set());
              workspaceReferences.get(workspace).add(releaseId);
            }
          } else referenceUnknown.add(releaseId);
        } else if (pathKey(key) && item && !/^[a-z][a-z0-9+.-]*:\/\//i.test(item)) referenceUnknown.add(releaseId);
      } else if (item && typeof item === 'object') {
        const remaining = 1000000 - objectNodes - pending.length;
        if (Array.isArray(item) && item.length > remaining) throw fail('metadata-complexity-budget-exhausted');
        const keys = Object.keys(item);
        if (keys.length > remaining) throw fail('metadata-complexity-budget-exhausted');
        for (const childKey of keys) pending.push({ value: item[childKey], key: Array.isArray(item) ? key : childKey, depth: depth + 1 });
      }
    }
  }
  async function readEvent(entry) {
    check();
    if (entry.size > RECORD_LIMIT || (metadataBytes += entry.size) > METADATA_LIMIT) throw fail('journal-byte-budget-exhausted');
    if (typeof constants.O_NOFOLLOW !== 'number') throw fail('journal-no-follow-unavailable');
    const handle = await open(entry.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const st = await handle.stat();
      if (!st.isFile() || stamp(st) !== entry.stamp) throw fail('journal-changed');
      // Read at most the observed size plus one byte even if a concurrent writer grows it.
      const data = Buffer.alloc(entry.size + 1);
      let offset = 0;
      while (offset < data.length) {
        check();
        const { bytesRead } = await handle.read(data, offset, data.length - offset, offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      if (offset !== entry.size || stamp(await handle.stat()) !== entry.stamp) throw fail('journal-changed');
      return JSON.parse(data.subarray(0, offset).toString('utf8'));
    } finally { await handle.close(); }
  }
  try {
    await visit(root, 0);
    for (const release of releases.values()) {
      check();
      let previous = null;
      const names = release.events.sort();
      if (!names.length) { error('journal-missing', release.path); continue; }
      try {
        for (const [index, name] of names.entries()) {
          if (name.split(sep).at(-1) !== `${String(index + 1).padStart(8, '0')}.json`) throw fail('journal-sequence-invalid');
          const event = await readEvent(metadata.get(name));
          const verified = verifyJournalEvent(event, index + 1, previous);
          const state = verified.state;
          if (!knownState(state, release.id)) throw fail('journal-schema-unsupported');
          await collectReferences(state, release.id);
          release.current = state; previous = verified.digest; release.verifiedEvents++;
        }
        release.journalVerified = true;
        if (unsettled(release.current)) release.reasons.add('release-operations-unsettled-or-unrecognized');
      } catch (e) {
        if (signal?.aborted || e.storageCode === 'timeout') throw e;
        error(e.storageCode ?? 'journal-invalid', release.path);
      }
    }
    metadataPhase = false;
    for (const directory of deferredDirectories) {
      check();
      let st;
      try { st = await lstat(directory.path); }
      catch { error('filesystem-unreadable', relative(root, directory.path)); continue; }
      if (!st.isDirectory() || stamp(st) !== directory.stamp) {
        error('directory-changed', relative(root, directory.path));
        continue;
      }
      await visitChildren(directory.path, directory.depth);
    }
  } catch (e) {
    signal?.throwIfAborted();
    error(e.storageCode ?? 'storage-read-unavailable');
  }
  try {
    // Deep references are resolved only after measurement, including a partial
    // traversal. An unobserved path never becomes a proven absence or clearance.
    for (const [rel, owners] of references) {
      check();
      if (!seen.has(rel)) for (const owner of owners) referenceUnknown.add(owner);
    }
    referenceResolutionComplete = true;
    // Guard histories and selected directory inventories against ordinary concurrent writes.
    for (const [rel, expected] of directoryStamps) {
      check();
      try { if (stamp(await lstat(resolve(root, rel))) !== expected) error('directory-changed', rel); }
      catch { error('filesystem-unreadable', rel); }
    }
    for (const [rel, entry] of metadata) {
      check();
      try { if (stamp(await lstat(entry.path)) !== entry.stamp) error('journal-changed', rel); }
      catch { error('filesystem-unreadable', rel); }
    }
  } catch (e) {
    signal?.throwIfAborted();
    error(e.storageCode ?? 'storage-read-unavailable');
  }
  signal?.throwIfAborted();
  let complete = errors.length === 0;
  const workspaceReports = [];
  try {
    for (const workspace of [...workspaces.values()].sort((a, b) => a.path.localeCompare(b.path))) {
      check();
      const reasons = new Set(globalProtection);
      if (workspace.symlinks) reasons.add('contains-opaque-symlinks');
      if (!referenceResolutionComplete || referenceUnknown.size) reasons.add('journal-reference-scope-unresolved');
      for (const reason of releases.get(workspace.releaseId)?.reasons ?? []) reasons.add(reason);
      const referencedBy = new Set(workspaceReferences.get(workspace.path));
      const parts = workspace.path.split(sep);
      for (let depth = 0; depth <= parts.length; depth++) {
        for (const owner of references.get(parts.slice(0, depth).join(sep)) ?? []) {
          check(); referencedBy.add(owner);
        }
      }
      if (referencedBy.size) reasons.add('retained-journal-reference');
      workspaceReports.push({ ...workspace, protectionReasons: [...reasons].sort(), referencedBy: [...referencedBy].sort() });
      if (workspaceReports.length % 128 === 0) await setImmediate();
    }
  } catch (e) {
    signal?.throwIfAborted();
    error(e.storageCode ?? 'storage-assessment-unavailable');
    complete = false;
    const done = new Set(workspaceReports.map(workspace => workspace.path));
    for (const workspace of workspaces.values()) if (!done.has(workspace.path)) workspaceReports.push({ ...workspace, protectionReasons: [], referencedBy: [] });
  }
  if (!complete) for (const workspace of workspaceReports) workspace.protectionReasons.push('inventory-incomplete');
  signal?.throwIfAborted();
  const report = { schemaVersion: 1, kind: 'release-storage-inventory-v1', stateDirectory: root,
    startedAt, completedAt: new Date().toISOString(), readOnly: true, observationComplete: complete,
    scope: 'State-root lstat inventory and literal paths in retained journal snapshots; external files, source cleanliness and dispatch settlement are not inspected.',
    snapshot: 'non-atomic', coverage: complete ? 'complete-within-declared-scope' : 'partial',
    totals: { visitedEntries: Math.min(visited, maxEntries), apparentBytes, observedUniqueAllocatedBytes: allocationKnown ? allocatedBytes : null, symlinks, hardLinkedFiles },
    groups: [...groups.values()].sort((a, b) => a.path.localeCompare(b.path)),
    releases: [...releases.values()].map(release => ({ releaseId: release.id, verifiedEvents: release.verifiedEvents,
      referenceScopeResolved: release.journalVerified && referenceResolutionComplete && !referenceUnknown.has(release.id), protectionReasons: [...release.reasons].sort() })),
    workspaces: workspaceReports, errors, errorsTruncated: errorCount > errors.length, reclaimableBytes: null, deletionAuthorized: false };
  signal?.throwIfAborted();
  if (Date.now() >= deadline && report.observationComplete) {
    error('timeout'); report.observationComplete = false; report.coverage = 'partial';
    for (const workspace of workspaceReports) workspace.protectionReasons.push('inventory-incomplete');
    report.errorsTruncated = errorCount > errors.length;
  }
  return report;
}

export function planStorageCleanup(inventory) {
  if (inventory?.schemaVersion !== 1 || inventory.kind !== 'release-storage-inventory-v1' ||
      !Array.isArray(inventory.workspaces) || typeof inventory.observationComplete !== 'boolean') throw new Error('Expected a current storage inventory');
  const entries = inventory.workspaces.map(workspace => {
    if (!workspace || typeof workspace.path !== 'string' || !Array.isArray(workspace.protectionReasons) ||
        !Number.isSafeInteger(workspace.apparentBytes) || workspace.apparentBytes < 0) throw new Error('Invalid workspace inventory');
    const parts = workspace.path.split(sep);
    if (parts.length !== 3 || parts[0] !== 'releases' || !RELEASE.test(parts[1]) || !WORKSPACE.test(parts[2]) || workspace.releaseId !== parts[1]) throw new Error('Workspace must remain inside the declared release layout');
    const reasons = [...workspace.protectionReasons];
    if (!inventory.observationComplete && !reasons.includes('inventory-incomplete')) reasons.push('inventory-incomplete');
    return { path: workspace.path, releaseId: workspace.releaseId, apparentBytes: workspace.apparentBytes,
      disposition: reasons.length ? 'protected' : 'review-candidate', reasons,
      requiredChecks: ['exclusive-maintenance-and-fresh-scan', 'source-cleanliness-and-project-policy',
        'preserve-external-evidence-and-signature-inputs', 'invalidate-reconstructable-install-and-check-stages-without-replaying-side-effects'] };
  });
  return { schemaVersion: 1, kind: 'release-storage-cleanup-preview-v1', rulesVersion: 1,
    stateDirectory: inventory.stateDirectory, observationComplete: inventory.observationComplete,
    readOnly: true, applySupported: false, deletionAuthorized: false, reclaimableBytes: null,
    scope: inventory.scope, entries, errors: inventory.errors,
    counts: { reviewCandidates: entries.filter(entry => entry.disposition === 'review-candidate').length,
      protected: entries.filter(entry => entry.disposition === 'protected').length } };
}
