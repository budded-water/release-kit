import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { lstat, readdir, statfs } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { acquireMaintenance, assertCoordinationOwner, assertMaintenanceOwner } from './coordination.mjs';
import { atomicJson, canonicalPrivatePath, digest, privateDirectory, releasePath } from './state.mjs';
import { appendResourceState, readResourceJson, readResourceLedger, resourceError, resourceCode } from './resource-ledger.mjs';
import { containsPath, fileIdentity, observeResource, overlapsPath, removeObservedResource, resourcePath, sameIdentity } from './resource-files.mjs';
import { inspectResourceReferences } from './resource-references.mjs';
import { inspectDispatchRequests } from './executor.mjs';

const sessions = new WeakSet();
const CONTRACT = 'task-resource-lifecycle/v1';
const featurePath = store => join(store, 'resources', 'feature.json');
const present = async path => {
  try { return await lstat(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};
async function cleanupWithinSignal(action, signal) {
  signal.throwIfAborted();
  let abort;
  const interrupted = new Promise((_, reject) => {
    abort = () => reject(resourceError('RESOURCE_SESSION_TIMEOUT', 'Running-resource finalization did not settle'));
    signal.addEventListener('abort', abort, { once: true });
  });
  try { return await Promise.race([Promise.resolve().then(action), interrupted]); }
  finally { signal.removeEventListener('abort', abort); }
}

function validatePolicy(policy, adapter) {
  if (policy?.schemaVersion !== 1 || !isAbsolute(policy.coordinationAnchor ?? '') ||
      !['cacheBudgetBytes', 'minimumFreeBytes'].every(key => Number.isSafeInteger(policy[key]) && policy[key] > 0) ||
      !policy.phaseBytes || Object.keys(policy.phaseBytes).length !== 3 ||
      !['validate', 'execute', 'content'].every(key => Number.isSafeInteger(policy.phaseBytes[key]) && policy.phaseBytes[key] > 0))
    throw resourceError('RESOURCE_POLICY', 'Lifecycle requires a versioned coordination, cache and phase-capacity policy');
  if (adapter?.schemaVersion !== 1 || !/^[a-f0-9]{64}$/.test(adapter.policy ?? '') ||
      typeof adapter.references !== 'function' || typeof adapter.reconstructable !== 'function' ||
      typeof adapter.toolchain !== 'function' ||
      !adapter.caches || !Object.keys(adapter.caches).length || Object.keys(adapter.caches).length > 20)
    throw resourceError('RESOURCE_POLICY', 'Lifecycle requires a trusted versioned resource adapter');
  if (adapter.sessions !== undefined && (!Array.isArray(adapter.sessions) || adapter.sessions.length > 20 ||
      adapter.sessions.some(kind => typeof kind !== 'string' || !/^[a-z][a-z0-9-]{0,79}$/.test(kind))))
    throw resourceError('RESOURCE_POLICY', 'Session kinds must be a bounded trusted declaration');
  for (const [kind, declaration] of Object.entries(adapter.caches)) {
    if (!/^[a-z][a-z0-9-]{0,79}$/.test(kind) || typeof declaration?.path !== 'string' ||
        isAbsolute(declaration.path) || declaration.path.includes('\\') ||
        declaration.path.split('/').some(part => !part || ['.', '..'].includes(part)) ||
        !Array.isArray(declaration.stages) || !declaration.stages.length ||
        declaration.stages.some(stage => !['install-validation', 'checks', 'ui-eval'].includes(stage)))
      throw resourceError('RESOURCE_POLICY', 'Cache declarations require exact preparation leaves and reuse dependencies');
  }
  const paths = Object.values(adapter.caches).map(declaration => declaration.path);
  if (paths.some((path, index) => paths.slice(index + 1).some(other => overlapsPath(path, other))))
    throw resourceError('RESOURCE_POLICY', 'Cache declarations must have distinct nonoverlapping leaves');
}

export async function assertResourceAdmission({ store, plan, session }) {
  if (!(await present(featurePath(store)))) return;
  if (!sessions.has(session) || session.store !== store || session.plan.id !== plan.id || session.plan.source !== plan.source)
    throw resourceError('RESOURCE_ADMISSION', 'Activated resource root requires a live lifecycle admission');
  await session.assertActive();
}

export function createResourceLifecycle({ stateDirectory, policy, adapter, signal } = {}) {
  validatePolicy(policy, adapter);
  policy = structuredClone(policy);
  adapter = { ...adapter, caches: structuredClone(adapter.caches),
    ...(adapter.sessions ? { sessions: [...adapter.sessions] } : {}) };
  if (typeof stateDirectory !== 'string' || !isAbsolute(stateDirectory) || resolve(stateDirectory) !== stateDirectory)
    throw resourceError('RESOURCE_POLICY', 'Lifecycle requires an explicit canonical absolute state root');
  const store = resolve(stateDirectory);
  const anchor = policy.coordinationAnchor;
  const identity = digest({ contract: CONTRACT, policy, adapter: adapter.policy, caches: adapter.caches,
    sessionKinds: adapter.sessions ?? [] });
  const marker = { schemaVersion: 1, contract: CONTRACT, stateDirectory: store, coordinationAnchor: anchor, policy: identity };

  async function validateRoot() {
    if (await canonicalPrivatePath(store) !== store || await canonicalPrivatePath(anchor) !== anchor ||
        containsPath(store, anchor) || containsPath(anchor, store))
      throw resourceError('RESOURCE_POLICY', 'Lifecycle requires distinct canonical state and coordination roots');
    const st = await lstat(store);
    if (!st.isDirectory() || (st.mode & 0o077) !== 0 || st.uid !== process.getuid())
      throw resourceError('RESOURCE_POLICY', 'Lifecycle state root must be private and owned');
  }
  async function feature() {
    await validateRoot();
    if (await canonicalPrivatePath(join(store, 'resources')) !== join(store, 'resources'))
      throw resourceError('RESOURCE_COMPATIBILITY', 'Resource metadata directory is redirected');
    if (!(await present(featurePath(store))))
      throw resourceError('RESOURCE_NOT_ACTIVATED', 'Lifecycle requires reviewed installed activation before execution');
    const current = (await readResourceJson(featurePath(store))).value;
    if (JSON.stringify(current) !== JSON.stringify(marker))
      throw resourceError('RESOURCE_COMPATIBILITY', 'Installed lifecycle feature or policy differs; reconcile under maintenance');
  }
  async function idle(lease, pendingRequest) {
    await assertMaintenanceOwner(anchor, lease.owner);
    const lockDirectory = join(store, 'locks');
    if (await present(lockDirectory)) {
      if ((await canonicalPrivatePath(lockDirectory)) !== lockDirectory || (await readdir(lockDirectory)).length)
        throw resourceError('RESOURCE_OWNERSHIP', 'Release or cleanup ownership remains unresolved');
    }
    const dispatch = await inspectDispatchRequests({ stateDirectory: store });
    if (dispatch.blockers.some(blocker => !(blocker.id === pendingRequest && blocker.reason === 'request-pending' &&
        dispatch.requests.find(request => request.id === pendingRequest)?.state === 'pending')))
      throw resourceError('RESOURCE_OWNERSHIP', 'Dispatch ownership must be reconciled before lifecycle maintenance');
  }
  async function activate({ lease } = {}) {
    signal?.throwIfAborted();
    await validateRoot();
    await idle(lease);
    if (await present(featurePath(store))) { await feature(); return marker; }
    if (await present(join(store, 'resources')))
      throw resourceError('RESOURCE_COMPATIBILITY', 'Unrecognized resource directory requires operator reconciliation');
    signal?.throwIfAborted();
    await atomicJson(featurePath(store), marker, { exclusive: true });
    return marker;
  }
  async function freeBytes() {
    const fs = await statfs(store, { bigint: true });
    const bytes = fs.bavail * fs.bsize;
    if (bytes < 0n || bytes > BigInt(Number.MAX_SAFE_INTEGER))
      throw resourceError('RESOURCE_CAPACITY', 'Filesystem free space is unavailable');
    return Number(bytes);
  }
  async function targetOwners() {
    const directory = join(store, 'targets');
    if (!(await present(directory))) return new Set();
    if (await canonicalPrivatePath(directory) !== directory)
      throw resourceError('RESOURCE_OWNERSHIP', 'Publication target ownership is redirected');
    const names = await readdir(directory);
    if (names.length > 1000) throw resourceError('RESOURCE_BUDGET', 'Publication target ownership budget exhausted');
    const owners = new Set();
    for (const name of names) {
      if (!/^[a-f0-9]{64}\.json$/.test(name))
        throw resourceError('RESOURCE_OWNERSHIP', 'Publication target ownership is unrecognized');
      const { value } = await readResourceJson(join(directory, name));
      if (!/^release-[a-f0-9]{24}$/.test(value.id ?? '') || !/^[a-f0-9]{40}$/.test(value.source ?? ''))
        throw resourceError('RESOURCE_OWNERSHIP', 'Publication target owner is unsupported');
      owners.add(value.id);
    }
    return owners;
  }
  async function dispatchReferences() {
    const inventory = await inspectDispatchRequests({ stateDirectory: store });
    if (inventory.requests.length > 1000 || inventory.requests.some(request => request.state === 'invalid'))
      throw resourceError('RESOURCE_OWNERSHIP', 'Dispatch reference scope is incomplete');
    const paths = [];
    for (const request of inventory.requests) {
      const record = (await readResourceJson(join(store, 'dispatch', 'requests', request.id, 'request.json'))).value;
      if (!record.value || record.sha256 !== digest(record.value) || record.sha256 !== request.requestDigest)
        throw resourceError('RESOURCE_REFERENCES', 'Dispatch reference manifest changed during observation');
      const value = record.value;
      for (const path of [value.controlRepository, value.releaseConfig,
        ...Object.values(value.acceptance ?? {}).map(receipt => receipt.path)]) {
        if (typeof path !== 'string' || !isAbsolute(path))
          throw resourceError('RESOURCE_REFERENCES', 'Dispatch input reference is unsupported');
        if (containsPath(store, resolve(path))) paths.push(resolve(path));
      }
    }
    return paths;
  }
  async function write(ledger, lease) {
    await appendResourceState(store, ledger, () => assertCoordinationOwner(anchor, lease.owner));
  }
  function validateResource(resource) {
    if (!resource || !/^[a-f0-9]{64}$/.test(resource.id ?? '') ||
        !/^[a-f0-9-]{36}$/.test(resource.generation ?? '') || resource.policy !== identity ||
        !['creating', 'retained', 'pending', 'reclaiming', 'reclaimed'].includes(resource.state) ||
        !Number.isSafeInteger(resource.lastUse) || !Object.hasOwn(adapter.caches, resource.kind))
      throw resourceError('RESOURCE_SCHEMA', 'Unsupported resource generation');
    const path = resourcePath(store, resource.path);
    const workspace = join(releasePath(store, resource.releaseId), 'validation');
    if (path !== join(workspace, adapter.caches[resource.kind].path) ||
        digest(resource.path) !== resource.id || !/^[a-f0-9]{40}$/.test(resource.source ?? '') ||
        !/^[a-f0-9]{64}$/.test(resource.toolchain ?? ''))
      throw resourceError('RESOURCE_PATH', 'Resource differs from trusted declaration');
    return path;
  }

  async function reclaim({ lease, trigger = 'explicit', phase, dryRun = false, pendingRequest } = {}) {
    signal?.throwIfAborted();
    await feature();
    if (!dryRun) await idle(lease, pendingRequest);
    const before = await freeBytes();
    const ledger = await readResourceLedger(store);
    const report = { schemaVersion: 1, kind: 'resource-maintenance', trigger, policy: identity,
      stateDirectory: store, coordinationAnchor: anchor,
      readOnly: dryRun, observationComplete: true, outcome: 'complete', beforeFreeBytes: before,
      afterFreeBytes: before, retainedCacheBytes: 0, resources: [], errors: [] };
    let references, targets;
    try {
      references = await inspectResourceReferences(store, adapter, { signal });
      for (const path of await dispatchReferences()) references.paths.add(path);
      targets = await targetOwners();
      if ([...targets].some(id => !references.states.has(id)))
        throw resourceError('RESOURCE_OWNERSHIP', 'Publication target has no verified release history');
    }
    catch (error) {
      signal?.throwIfAborted();
      report.observationComplete = false;
      report.outcome = 'incomplete';
      report.errors.push(error.code ?? 'RESOURCE_REFERENCES');
      return report;
    }
    const candidates = [];
    const resources = Object.values(ledger.state.resources);
    if (resources.length > 10000) throw resourceError('RESOURCE_BUDGET', 'Resource count exceeds budget');
    const paths = resources.map(validateResource);
    for (let i = 0; i < paths.length; i++)
      if (paths.some((path, j) => i !== j && overlapsPath(path, paths[i])))
        throw resourceError('RESOURCE_PATH', 'Overlapping registered resources require reconciliation');
    for (const resource of resources) {
      signal?.throwIfAborted();
      const path = validateResource(resource);
      if (resource.state === 'reclaimed') continue;
      const result = { id: resource.id, generation: resource.generation, path: resource.path, state: resource.state,
        disposition: 'protected', reasons: [], bytes: null };
      report.resources.push(result);
      if (resource.state === 'creating') result.reasons.push('creation-unconfirmed');
      const owner = ledger.state.tasks[resource.task];
      if (!owner || owner.releaseId !== resource.releaseId || owner.source !== resource.source ||
          owner.state !== 'settled' || !['succeeded', 'reconciled'].includes(owner.outcome))
        result.reasons.push('task-unsettled');
      if ([...references.paths].some(reference => overlapsPath(path, reference))) result.reasons.push('retained-reference');
      const state = references.states.get(resource.releaseId);
      if (!state || Object.values(state.stages).some(stage => ['running', 'failed', 'unknown'].includes(stage?.status)))
        result.reasons.push('release-unsettled');
      if (targets.has(resource.releaseId) && !(Object.values(state?.outcomes ?? {}).length &&
          Object.values(state.outcomes).every(outcome => outcome?.state === 'released' ||
            outcome?.state === 'available' && outcome.availabilityVerified === true ||
            outcome?.state === 'accepted' && !state.publicationRequested)))
        result.reasons.push('publication-target-unsettled');
      let observed;
      try { observed = await observeResource(store, resource, { signal }); }
      catch (error) {
        signal?.throwIfAborted();
        result.reasons.push(error.code ?? 'resource-unreadable');
        report.observationComplete = false;
        continue;
      }
      result.bytes = observed.bytes;
      report.retainedCacheBytes += observed.bytes;
      if (observed.missing && resource.state !== 'reclaiming') {
        result.reasons.push('unexpected-resource-loss');
        report.observationComplete = false;
      }
      if (result.reasons.length) continue;
      const reconstruction = await adapter.reconstructable({ resource: structuredClone(resource), state, store, signal });
      if (reconstruction?.source !== resource.source || reconstruction?.toolchain !== resource.toolchain || reconstruction?.sourceClean !== true ||
          reconstruction?.inputsAvailable !== true || reconstruction?.recoveryIndependent !== true) {
        result.reasons.push('reconstruction-unverified');
        continue;
      }
      result.disposition = 'eligible';
      candidates.push({ resource, result, observed });
    }
    // No partial inventory can clear any target, including targets scanned earlier.
    if (!report.observationComplete) {
      for (const result of report.resources) {
        result.disposition = 'protected';
        result.reasons.push('assessment-incomplete');
      }
      report.outcome = 'incomplete';
      return report;
    }
    candidates.sort((a, b) => a.resource.lastUse - b.resource.lastUse || a.resource.id.localeCompare(b.resource.id));
    let available = before;
    const floor = policy.minimumFreeBytes + (phase ? policy.phaseBytes[phase] : 0);
    for (const { resource, result, observed } of candidates) {
      const recovery = resource.state === 'reclaiming';
      if (!recovery && report.retainedCacheBytes <= policy.cacheBudgetBytes && available >= floor) continue;
      if (dryRun) { result.disposition = 'would-reclaim'; continue; }
      await idle(lease, pendingRequest);
      await references.assertUnchanged();
      signal?.throwIfAborted();
      resource.state = 'reclaiming';
      resource.reuseRevoked = true;
      await write(ledger, lease);
      try {
        const fresh = await observeResource(store, resource, { signal });
        if (!fresh.missing) await removeObservedResource(store, resource, fresh, { signal });
        resource.state = 'reclaimed';
        resource.reclaimedAt = new Date().toISOString();
        await write(ledger, lease);
      } catch (error) {
        signal?.throwIfAborted();
        lease.retain();
        report.ownershipRetained = true;
        report.outcome = 'incomplete';
        report.errors.push(error.code ?? 'RESOURCE_REMOVAL');
        result.disposition = 'incomplete';
        result.state = 'reclaiming';
        report.afterFreeBytes = await freeBytes();
        return report;
      }
      result.disposition = 'reclaimed';
      result.state = 'reclaimed';
      report.retainedCacheBytes -= observed.bytes;
      available = await freeBytes();
    }
    report.afterFreeBytes = await freeBytes();
    if (report.retainedCacheBytes > policy.cacheBudgetBytes || report.afterFreeBytes < floor)
      report.outcome = 'protected-capacity';
    return report;
  }

  async function reconcileTask({ lease, receipt } = {}) {
    signal?.throwIfAborted();
    await feature();
    await idle(lease);
    const ledger = await readResourceLedger(store);
    const task = typeof receipt?.taskId === 'string' && /^[a-f0-9-]{36}$/.test(receipt.taskId) &&
      Object.hasOwn(ledger.state.tasks, receipt.taskId) ? ledger.state.tasks[receipt.taskId] : null;
    if (receipt?.schemaVersion !== 1 || receipt.kind !== 'resource-task-settlement' ||
        receipt.policy !== identity || receipt.historyDigest !== ledger.previous || !task ||
        receipt.childrenSettled !== true || receipt.sessionsSettled !== true ||
        receipt.evidenceVerified !== true || typeof receipt.reason !== 'string' ||
        !receipt.reason.trim() || receipt.reason.length > 1000)
      throw resourceError('RESOURCE_RECONCILIATION', 'Task settlement requires a fresh explicit operator receipt');
    // This is an operator attestation after ownership reconciliation, never a PID
    // liveness heuristic or permission to replay release/provider operations.
    task.state = 'settled';
    task.outcome = 'reconciled';
    task.reconciliation = digest(receipt);
    for (const resource of Object.values(ledger.state.resources)) {
      if (resource.task !== task.id) continue;
      if (resource.state === 'retained') resource.state = 'pending';
      if (resource.state === 'creating' && !(await present(resourcePath(store, resource.path))))
        resource.state = 'reclaimed';
    }
    for (const session of Object.values(ledger.state.sessions))
      if (session.task === task.id) session.state = 'released';
    await write(ledger, lease);
    return { taskId: task.id, state: task.state, provenance: 'operator-attested' };
  }

  async function run({ plan, operation, lease: suppliedLease, pendingRequest, execute, settle = async () => {} } = {}) {
    signal?.throwIfAborted();
    if (!['validate', 'execute', 'content'].includes(operation) || typeof execute !== 'function' ||
        !/^release-[a-f0-9]{24}$/.test(plan?.id ?? '') || !/^[a-f0-9]{40}$/.test(plan?.source ?? ''))
      throw resourceError('RESOURCE_ADMISSION', 'Lifecycle task requires a bound plan and heavy operation');
    plan = structuredClone(plan);
    await feature();
    let lease;
    try { lease = suppliedLease ?? await acquireMaintenance(anchor, { operation: 'resource admission' }); }
    catch (error) {
      error.resourceAdmissionFailed = true;
      error.resourceMaintenance = { trigger: 'admission', stateDirectory: store, policy: identity, observationComplete: false,
        outcome: error.code === 'COORDINATION_BUSY' ? 'protected-capacity' : 'incomplete', errors: [resourceCode(error)] };
      throw error;
    }
    const owned = !suppliedLease;
    const initialKind = lease.owner.kind;
    let session, taskId, ledger, result, primaryError, teardownError, maintenance, completion;
    let safeToRelease = true;
    try {
      const admissionDeadline = Date.now() + 30000;
      while (lease.owner.kind !== 'maintenance') {
        signal?.throwIfAborted();
        try { await lease.transition('maintenance'); }
        catch (error) {
          // A scheduled worker may arrive before its dispatcher has returned.
          // Wait for voluntary release, never steal or ignore the other owner.
          if (!pendingRequest || error.code !== 'COORDINATION_BUSY' || Date.now() >= admissionDeadline) throw error;
          await delay(20, undefined, { signal });
        }
      }
      await idle(lease, pendingRequest);
      maintenance = await reclaim({ lease, trigger: 'admission', phase: operation, pendingRequest });
      if (maintenance.outcome !== 'complete') {
        const error = resourceError(maintenance.outcome === 'incomplete' ? 'RESOURCE_INCOMPLETE' : 'RESOURCE_CAPACITY',
          'Lifecycle admission could not establish safe capacity');
        error.resourceMaintenance = maintenance;
        throw error;
      }
      ledger = await readResourceLedger(store);
      if (Object.values(ledger.state.tasks).some(task => task.state !== 'settled'))
        throw resourceError('RESOURCE_OWNERSHIP', 'Prior resource task requires explicit settlement reconciliation');
      taskId = randomUUID();
      signal?.throwIfAborted();
      ledger.state.tasks[taskId] = { id: taskId, releaseId: plan.id, source: plan.source, operation,
        state: 'active', owner: lease.owner.token, phase: operation, reservedBytes: policy.phaseBytes[operation] };
      await write(ledger, lease);
      await lease.transition('activity');
      session = {
        store, plan: Object.freeze({ id: plan.id, source: plan.source }), taskId,
        async assertActive() {
          signal?.throwIfAborted();
          if (!sessions.has(session)) throw resourceError('RESOURCE_ADMISSION', 'Resource task admission has expired');
          await assertCoordinationOwner(anchor, lease.owner, 'activity');
        },
        async checkCapacity(phase) {
          await session.assertActive();
          if (!Object.hasOwn(policy.phaseBytes, phase))
            throw resourceError('RESOURCE_POLICY', 'Unknown resource allocation phase');
          if (await freeBytes() < policy.minimumFreeBytes + policy.phaseBytes[phase])
            throw resourceError('RESOURCE_CAPACITY', 'Heavy phase no longer has its required filesystem capacity');
          if (ledger.state.tasks[taskId].reservedBytes !== policy.phaseBytes[phase]) {
            ledger.state.tasks[taskId].reservedBytes = policy.phaseBytes[phase];
            ledger.state.tasks[taskId].phase = phase;
            await write(ledger, lease);
          }
        },
        async prepareCache(kind, workspace) {
          await session.assertActive();
          await session.checkCapacity(operation);
          if (resolve(workspace) !== join(releasePath(store, plan.id), 'validation') || !Object.hasOwn(adapter.caches, kind))
            throw resourceError('RESOURCE_PATH', 'Unknown cache class or workspace');
          const path = join(workspace, adapter.caches[kind].path);
          const rel = relative(store, path);
          resourcePath(store, rel);
          const toolchain = await adapter.toolchain({ workspace, source: plan.source, signal });
          if (!/^[a-f0-9]{64}$/.test(toolchain ?? ''))
            throw resourceError('RESOURCE_TOOLCHAIN', 'Cache requires a verified toolchain identity');
          const id = digest(rel);
          let resource = ledger.state.resources[id];
          const exists = await present(path);
          if (!resource && exists)
            throw resourceError('RESOURCE_LEGACY', 'Existing undeclared cache is protected; classify it separately');
          if (resource) {
            validateResource(resource);
            if (resource.kind !== kind)
              throw resourceError('RESOURCE_POLICY', 'Cache identity belongs to another declared kind');
            if (!['retained', 'pending', 'reclaimed'].includes(resource.state))
              throw resourceError('RESOURCE_INCOMPLETE', 'Resource generation requires reconciliation');
            if (resource.source !== plan.source || resource.toolchain !== toolchain)
              throw resourceError('RESOURCE_IDENTITY', 'Cache source or toolchain changed');
            if (resource.state !== 'reclaimed' && (!exists || !sameIdentity(exists, resource.identity)))
              throw resourceError('RESOURCE_IDENTITY', 'Cache disappeared without completed reclamation');
            if (resource.state === 'reclaimed' && exists)
              throw resourceError('RESOURCE_IDENTITY', 'Reclaimed cache was replaced by an unknown generation');
          }
          if (!resource || resource.state === 'reclaimed') {
            resource = { id, path: rel, generation: randomUUID(), releaseId: plan.id, source: plan.source,
              kind, toolchain, policy: identity, state: 'creating', task: taskId, lastUse: ledger.sequence + 1 };
            for (const other of Object.values(ledger.state.resources))
              if (other.id !== id && overlapsPath(resourcePath(store, other.path), path))
                throw resourceError('RESOURCE_PATH', 'Cache registration overlaps an existing resource');
            ledger.state.resources[id] = resource;
            await write(ledger, lease);
            await privateDirectory(path);
            resource.identity = fileIdentity(await lstat(path));
          }
          resource.state = 'retained';
          resource.task = taskId;
          resource.lastUse = ledger.sequence + 1;
          await write(ledger, lease);
          return path;
        },
        async cacheAvailable(kind, workspace) {
          await session.assertActive();
          const path = join(workspace, adapter.caches[kind]?.path ?? '');
          const resource = ledger.state.resources[digest(relative(store, path))];
          if (!resource || !['retained', 'pending'].includes(resource.state)) return false;
          validateResource(resource);
          return sameIdentity(await present(path), resource.identity);
        },
        async reuseAvailable(stage) {
          await session.assertActive();
          for (const resource of Object.values(ledger.state.resources)) {
            if (resource.releaseId !== plan.id || !adapter.caches[resource.kind]?.stages.includes(stage)) continue;
            if (!['retained', 'pending'].includes(resource.state) ||
                !sameIdentity(await present(validateResource(resource)), resource.identity)) return false;
          }
          return true;
        },
        async registerSession(kind, identity) {
          await session.assertActive();
          if (!adapter.sessions?.includes(kind) || typeof adapter.releaseSession !== 'function' ||
              typeof adapter.validateSession !== 'function' ||
              !identity || typeof identity !== 'object' || Array.isArray(identity) ||
              Buffer.byteLength(JSON.stringify(identity)) > 4096)
            throw resourceError('RESOURCE_SESSION', 'Session requires a trusted kind, identity and release adapter');
          if (await adapter.validateSession({ kind, identity: structuredClone(identity) }) !== true)
            throw resourceError('RESOURCE_SESSION', 'Session differs from trusted ownership policy');
          const id = randomUUID();
          if (Object.values(ledger.state.sessions).some(prior => prior.state !== 'released' &&
              prior.kind === kind && digest(prior.identity) === digest(identity)))
            throw resourceError('RESOURCE_SESSION', 'Running resource still has another registered owner');
          ledger.state.sessions[id] = { id, task: taskId, kind, identity: structuredClone(identity), state: 'owned' };
          await write(ledger, lease);
          return id;
        },
      };
      Object.freeze(session);
      sessions.add(session);
      try { result = await execute(session); }
      catch (error) { primaryError = error; }
      if (signal?.aborted) primaryError ??= signal.reason;
      const executionSucceeded = !primaryError && result?.state !== 'unknown' &&
        (result?.exitCode === undefined || result.exitCode === 0) &&
        (result?.state !== 'completed' || result.result?.exitCode === 0);
      // Session teardown must run even when execution/evidence/persistence failed.
      const cleanupController = new AbortController();
      const cleanupTimer = setTimeout(() => cleanupController.abort(
        resourceError('RESOURCE_SESSION_TIMEOUT', 'Running-resource finalization did not settle')), 45000);
      const cleanupSignal = cleanupController.signal;
      for (const running of Object.values(ledger.state.sessions).filter(entry => entry.task === taskId)) {
        try {
          // The durable owned intent already exists if this optional append fails.
          running.state = 'release-pending';
          try { await write(ledger, lease); } catch (error) { primaryError ??= error; }
          await cleanupWithinSignal(() => adapter.releaseSession({ session: structuredClone(running), store, signal: cleanupSignal }), cleanupSignal);
          running.state = 'released';
          try { await write(ledger, lease); } catch (error) { primaryError ??= error; }
        } catch (error) { teardownError ??= error; safeToRelease = false; }
      }
      try {
        await cleanupWithinSignal(() => settle({ session, result, error: primaryError, signal: cleanupSignal }), cleanupSignal);
      } catch (error) { teardownError ??= error; safeToRelease = false; }
      clearTimeout(cleanupTimer);
      sessions.delete(session);
      if (primaryError?.cleanupIncomplete) safeToRelease = false;
      if (safeToRelease) {
        ledger.state.tasks[taskId].state = 'settled';
        ledger.state.tasks[taskId].outcome = executionSucceeded && !primaryError ? 'succeeded' : 'failed';
        for (const resource of Object.values(ledger.state.resources))
          if (resource.task === taskId && resource.state === 'retained') resource.state = 'pending';
        try { await write(ledger, lease); }
        catch (error) { primaryError ??= error; }
      }
      if (executionSucceeded && !primaryError && !teardownError) {
        try {
          await lease.transition('maintenance');
          maintenance = await reclaim({ lease, trigger: 'settlement' });
        } catch (error) {
          maintenance = { outcome: 'deferred', reason: error.code ?? 'RESOURCE_MAINTENANCE' };
        }
      }
      if (primaryError) {
        if (teardownError) primaryError.resourceCleanup = teardownError.code ?? 'RESOURCE_SESSION_UNSETTLED';
        throw primaryError;
      }
      if (teardownError) throw teardownError;
      completion = { result, maintenance };
      return completion;
    } catch (error) {
      primaryError ??= error;
      if (!taskId) {
        error.resourceAdmissionFailed = true;
        error.resourceMaintenance ??= { trigger: 'admission', stateDirectory: store, policy: identity, observationComplete: false,
          outcome: 'incomplete', errors: [resourceCode(error)] };
      }
      throw error;
    } finally {
      if (session) sessions.delete(session);
      try {
        if (safeToRelease) {
          if (lease.retained) safeToRelease = false;
          else if (owned) await lease.release();
          else if (lease.owner.kind !== initialKind) await lease.transition(initialKind);
        }
      } catch (error) {
        safeToRelease = false;
        if (primaryError) primaryError.resourceOwnership = error.code ?? 'RESOURCE_OWNERSHIP';
        else if (completion) completion.maintenance = { ...completion.maintenance, outcome: 'incomplete',
          ownershipRetained: true, reason: error.code ?? 'RESOURCE_OWNERSHIP' };
        else throw error;
      }
      if (!safeToRelease) lease.retain();
    }
  }
  return Object.freeze({ activate, run, reclaim, reconcileTask, policyIdentity: identity,
    coordinationAnchor: anchor, stateDirectory: store });
}
