import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmod, link, mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, symlink, writeFile, unlink, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { acquireActivity, acquireMaintenance, inspectCoordination } from './coordination.mjs';
import { createResourceLifecycle, assertResourceAdmission } from './resource-lifecycle.mjs';
import { appendResourceState, readResourceLedger } from './resource-ledger.mjs';
import { fileIdentity, observeResource, removeObservedResource } from './resource-files.mjs';
import { digest, privateDirectory, releasePath, saveState } from './state.mjs';
import { main } from './cli.mjs';

const plan = { id: `release-${'a'.repeat(24)}`, source: 'b'.repeat(40) };

test('cache kinds cannot alias or overlap declaration leaves', async t => {
  for (const path of ['.native/intermediates', '.native', '.native/intermediates/child']) {
    await assert.rejects(fixture(t, { caches: {
      compiler: { path: '.native/intermediates', stages: ['ui-eval'] },
      checks: { path, stages: ['checks'] },
    } }), { code: 'RESOURCE_POLICY' });
  }
});

test('reclaim CLI passes the selected execution environment to its trusted adapter', async t => {
  const f = await fixture(t);
  const path = join(f.root, 'policy.json');
  await writeFile(path, JSON.stringify(f.policy), { mode: 0o600 });
  const environment = { DEVELOPER_DIR: '/synthetic/toolchain' };
  let received;
  const code = await main({ args: ['storage-reclaim', '--config', path, '--dry-run'], environment,
    project: { resourceAdapter: async options => { received = options.environment; return f.adapter; } },
    output() {} });
  assert.equal(code, 0);
  assert.equal(received, environment);
});
async function fixture(t, overrides = {}, options = {}) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'resource-lifecycle-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = join(root, 'state'), anchor = join(root, 'coordination');
  await mkdir(store, { mode: 0o700 });
  await mkdir(anchor, { mode: 0o700 });
  const adapter = {
    schemaVersion: 1, policy: 'c'.repeat(64),
    caches: { compiler: { path: '.native/intermediates', stages: ['ui-eval'] } },
    references: async () => [],
    toolchain: async () => 'e'.repeat(64),
    validateSession: async () => true,
    reconstructable: async ({ resource }) => ({ source: resource.source, toolchain: resource.toolchain, sourceClean: true,
      inputsAvailable: true, recoveryIndependent: true }),
    ...overrides,
  };
  const policy = { schemaVersion: 1, stateDirectory: store, coordinationAnchor: anchor, cacheBudgetBytes: 8,
    minimumFreeBytes: 1, phaseBytes: { validate: 1, execute: 1, content: 1 }, ...options.policy };
  const lifecycle = createResourceLifecycle({ stateDirectory: store, policy, adapter, signal: options.signal });
  const lease = await acquireMaintenance(anchor, { operation: 'test activation' });
  await lifecycle.activate({ lease });
  await lease.release();
  const directory = releasePath(store, plan.id);
  const workspace = join(directory, 'validation');
  await privateDirectory(workspace);
  const state = { schemaVersion: 1, plan, stages: { checks: { status: 'succeeded' } } };
  await saveState(directory, state);
  return { root, store, anchor, policy, adapter, lifecycle, workspace, state };
}

test('admission requires a live bound session; normal settlement reclaims registered intermediate leaves', async t => {
  const f = await fixture(t);
  await assert.rejects(assertResourceAdmission({ store: f.store, plan }), { code: 'RESOURCE_ADMISSION' });
  let cache, expired;
  const result = await f.lifecycle.run({ plan, operation: 'validate', execute: async session => {
    expired = session;
    assert.throws(() => { session.store = '/different-state-root'; }, TypeError);
    await assertResourceAdmission({ store: f.store, plan, session });
    cache = await session.prepareCache('compiler', f.workspace);
    await writeFile(join(cache, 'object.o'), '0123456789abcdef');
    return 'checks-passed';
  } });
  assert.equal(result.result, 'checks-passed');
  assert.equal(result.maintenance.resources[0].disposition, 'reclaimed');
  await assert.rejects(stat(cache), { code: 'ENOENT' });
  await assert.rejects(assertResourceAdmission({ store: f.store, plan, session: expired }), { code: 'RESOURCE_ADMISSION' });
  assert.deepEqual((await inspectCoordination(f.anchor)).activities, []);
  assert.equal((await inspectCoordination(f.anchor)).maintenance, null);
  assert.equal((await readResourceLedger(f.store)).state.resources[digest('releases/' + plan.id + '/validation/.native/intermediates')].state, 'reclaimed');
  assert.equal(JSON.parse(await readFile(join(releasePath(f.store, plan.id), 'events', '00000001.json'))).state.stages.checks.status, 'succeeded');
});

test('a reconstructed generation is distinct and cache loss never becomes reuse', async t => {
  const f = await fixture(t);
  const generations = [];
  for (let index = 0; index < 3; index++) {
    await f.lifecycle.run({ plan, operation: 'validate', execute: async session => {
      assert.equal(await session.cacheAvailable('compiler', f.workspace), false);
      const cache = await session.prepareCache('compiler', f.workspace);
      assert.equal(await session.cacheAvailable('compiler', f.workspace), true);
      await writeFile(join(cache, 'object.o'), '0123456789abcdef');
    } });
    const ledger = await readResourceLedger(f.store);
    const resource = Object.values(ledger.state.resources)[0];
    generations.push(resource.generation);
    assert.equal(resource.state, 'reclaimed');
  }
  assert.equal(new Set(generations).size, 3);
});

test('legacy directories remain protected instead of silently registering them', async t => {
  const f = await fixture(t);
  const legacy = join(f.workspace, '.native/intermediates');
  await mkdir(legacy, { recursive: true });
  await writeFile(join(legacy, 'old.o'), 'retained');
  await assert.rejects(f.lifecycle.run({ plan, operation: 'validate',
    execute: session => session.prepareCache('compiler', f.workspace) }), { code: 'RESOURCE_LEGACY' });
  assert.equal(await readFile(join(legacy, 'old.o'), 'utf8'), 'retained');
});

test('historical and cross-release references protect registered leaves', async t => {
  const f = await fixture(t);
  let cache;
  await f.lifecycle.run({ plan, operation: 'validate', execute: async session => {
    cache = await session.prepareCache('compiler', f.workspace);
    await writeFile(join(cache, 'object.o'), '0123456789abcdef');
    f.state.oldEvidence = { path: join(cache, 'object.o') };
    await saveState(releasePath(f.store, plan.id), f.state);
    delete f.state.oldEvidence;
    await saveState(releasePath(f.store, plan.id), f.state);
  } });
  assert.equal(await readFile(join(cache, 'object.o'), 'utf8'), '0123456789abcdef');
  const lease = await acquireMaintenance(f.anchor, { operation: 'fresh collection' });
  try {
    const report = await f.lifecycle.reclaim({ lease });
    assert.equal(report.outcome, 'protected-capacity');
    assert.ok(report.resources[0].reasons.includes('retained-reference'));
  } finally { await lease.release(); }
});

test('failed evidence still runs session teardown and retains disk data and original error', async t => {
  const f = await fixture(t);
  const failure = Object.assign(new Error('evidence write failed'), { code: 'ENOSPC' });
  let cache, stopped = false;
  await assert.rejects(f.lifecycle.run({ plan, operation: 'validate',
    execute: async session => {
      cache = await session.prepareCache('compiler', f.workspace);
      await writeFile(join(cache, 'object.o'), 'diagnostic');
      throw failure;
    }, settle: async ({ error }) => { assert.equal(error, failure); stopped = true; },
  }), error => error === failure);
  assert.equal(stopped, true);
  assert.equal(await readFile(join(cache, 'object.o'), 'utf8'), 'diagnostic');
  assert.equal((await inspectCoordination(f.anchor)).activities.length, 0);
});

test('uncertain session teardown retains an activity fence', async t => {
  const f = await fixture(t);
  await assert.rejects(f.lifecycle.run({ plan, operation: 'validate', execute: async () => 'passed',
    settle: async () => { throw new Error('unknown simulator owner'); } }), /unknown simulator owner/);
  assert.equal((await inspectCoordination(f.anchor)).activities.length, 1);
  await assert.rejects(acquireMaintenance(f.anchor, { operation: 'must not steal' }), { code: 'COORDINATION_BUSY' });
});

test('incomplete receipt assessment is read-only and prevents all allocation', async t => {
  let f;
  f = await fixture(t, { references: async () => { throw new Error('unverified external receipt'); } });
  let cache;
  await f.lifecycle.run({ plan, operation: 'validate', execute: async session => {
    cache = await session.prepareCache('compiler', f.workspace);
    await writeFile(join(cache, 'object.o'), '0123456789abcdef');
  } }).catch(error => { assert.equal(error.code, 'RESOURCE_INCOMPLETE'); });
  // Admission above was intentionally blocked, so no resource was allocated.
  assert.equal(cache, undefined);
  const before = await readdir(join(f.store, 'resources'));
  const report = await f.lifecycle.reclaim({ dryRun: true });
  assert.equal(report.observationComplete, false);
  assert.deepEqual(await readdir(join(f.store, 'resources')), before);
});

test('supplied managed activity transitions atomically and returns the caller lease', async t => {
  const f = await fixture(t);
  const lease = await acquireActivity(f.anchor, { operation: 'managed wrapper' });
  const token = lease.owner.token;
  await f.lifecycle.run({ plan, operation: 'validate', lease, execute: async session => {
    assert.equal(lease.owner.kind, 'activity');
    await session.prepareCache('compiler', f.workspace);
    await assert.rejects(acquireMaintenance(f.anchor, { operation: 'competing collector' }), { code: 'COORDINATION_BUSY' });
  } });
  assert.equal(lease.owner.kind, 'activity');
  assert.equal(lease.owner.token, token);
  await lease.release();
});

test('undeclared mutation outside state remains untouched', async t => {
  const f = await fixture(t);
  await f.lifecycle.run({ plan, operation: 'validate', execute: async session => {
    await assert.rejects(session.prepareCache('compiler', f.root), { code: 'RESOURCE_PATH' });
  } });
  assert.equal((await stat(f.root)).isDirectory(), true);
});

test('a linked second cache makes assessment incomplete before any first-cache removal', async t => {
  const f = await fixture(t, { caches: {
    compiler: { path: '.native/intermediates', stages: ['ui-eval'] },
    index: { path: '.native/index', stages: ['ui-eval'] },
  } });
  let first, second;
  const outside = join(f.root, 'important');
  await writeFile(outside, 'durable');
  const result = await f.lifecycle.run({ plan, operation: 'validate', execute: async session => {
    first = await session.prepareCache('compiler', f.workspace);
    second = await session.prepareCache('index', f.workspace);
    await writeFile(join(first, 'object.o'), '0123456789abcdef');
    await symlink(outside, join(second, 'redirect'));
  } });
  assert.equal(result.maintenance.observationComplete, false);
  assert.equal(await readFile(join(first, 'object.o'), 'utf8'), '0123456789abcdef');
  assert.equal(await readFile(outside, 'utf8'), 'durable');
});

test('dry-run predicts only eligible targets and leaves disk, ledger and caller ownership unchanged', async t => {
  const f = await fixture(t);
  let cache;
  await f.lifecycle.run({ plan, operation: 'validate', execute: async session => {
    cache = await session.prepareCache('compiler', f.workspace);
    await writeFile(join(cache, 'object.o'), 'small');
  } });
  const lease = await acquireMaintenance(f.anchor, { operation: 'synthetic cache growth' });
  try {
    await writeFile(join(cache, 'object.o'), '0123456789abcdef');
    const before = await readResourceLedger(f.store);
    const ownership = await readFile(join(f.anchor, 'maintenance.json'), 'utf8');
    const result = await f.lifecycle.reclaim({ dryRun: true });
    assert.equal(result.readOnly, true);
    assert.equal(result.resources[0].disposition, 'would-reclaim');
    assert.equal((await readResourceLedger(f.store)).previous, before.previous);
    assert.equal(await readFile(join(f.anchor, 'maintenance.json'), 'utf8'), ownership);
    assert.equal(await readFile(join(cache, 'object.o'), 'utf8'), '0123456789abcdef');
  } finally { await lease.release(); }
});

test('a durable interrupted reclaim resumes from remaining files without changing release history', async t => {
  const f = await fixture(t);
  let cache;
  await f.lifecycle.run({ plan, operation: 'validate', execute: async session => {
    cache = await session.prepareCache('compiler', f.workspace);
    await writeFile(join(cache, 'first.o'), '1');
    await writeFile(join(cache, 'second.o'), '2');
  } });
  const lease = await acquireMaintenance(f.anchor, { operation: 'simulate interrupted removal' });
  try {
    const releaseBytes = await readFile(join(releasePath(f.store, plan.id), 'events', '00000001.json'), 'utf8');
    const ledger = await readResourceLedger(f.store);
    const resource = Object.values(ledger.state.resources)[0];
    resource.state = 'reclaiming';
    resource.reuseRevoked = true;
    await appendResourceState(f.store, ledger, async () => {});
    await unlink(join(cache, 'first.o'));
    const report = await f.lifecycle.reclaim({ lease });
    assert.equal(report.resources[0].disposition, 'reclaimed');
    await assert.rejects(stat(cache), { code: 'ENOENT' });
    assert.equal(await readFile(join(releasePath(f.store, plan.id), 'events', '00000001.json'), 'utf8'), releaseBytes);
  } finally { if (!lease.retained) await lease.release(); }
});

test('path replacement after observation cannot delete another generation or external files', async t => {
  const f = await fixture(t);
  const cache = join(f.workspace, '.native/intermediates');
  await mkdir(cache, { recursive: true });
  await writeFile(join(cache, 'object.o'), 'known');
  const resource = { path: `releases/${plan.id}/validation/.native/intermediates`, identity: fileIdentity(await stat(cache)) };
  const observed = await observeResource(f.store, resource);
  const outside = join(f.root, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, 'object.o'), 'preserved');
  await rename(cache, cache + '-old');
  await symlink(outside, cache);
  await assert.rejects(removeObservedResource(f.store, resource, observed));
  assert.equal(await readFile(join(outside, 'object.o'), 'utf8'), 'preserved');
  assert.equal(await readFile(join(cache + '-old', 'object.o'), 'utf8'), 'known');
});

test('settlement record write failure still releases verified running sessions and preserves the original error', async t => {
  if (process.getuid?.() === 0) return t.skip('Root bypasses directory write permissions');
  let directory, stopped = false;
  const f = await fixture(t, { sessions: ['synthetic-session'], releaseSession: async () => { stopped = true; } });
  try {
    await assert.rejects(f.lifecycle.run({ plan, operation: 'validate', execute: async session => {
      await session.registerSession('synthetic-session', { token: 'test-owned-session' });
      directory = join(f.store, 'resources', 'events');
      await chmod(directory, 0o500);
      return 'execution-passed';
    } }), error => ['EACCES', 'EPERM'].includes(error.code));
    assert.equal(stopped, true);
    assert.equal((await inspectCoordination(f.anchor)).activities.length, 0);
  } finally { if (directory) await chmod(directory, 0o700); }
});

test('a fresh explicit settlement receipt reconciles a failed task without rewriting publication state', async t => {
  const f = await fixture(t);
  await assert.rejects(f.lifecycle.run({ plan, operation: 'validate', execute: async () => { throw new Error('failed check'); } }), /failed check/);
  const lease = await acquireMaintenance(f.anchor, { operation: 'operator settlement' });
  try {
    const ledger = await readResourceLedger(f.store);
    const taskId = Object.keys(ledger.state.tasks)[0];
    const receipt = { schemaVersion: 1, kind: 'resource-task-settlement', taskId,
      policy: f.lifecycle.policyIdentity, historyDigest: ledger.previous,
      childrenSettled: true, sessionsSettled: true, evidenceVerified: true,
      reason: 'Synthetic operator independently verified owned task termination' };
    await assert.rejects(f.lifecycle.reconcileTask({ lease, receipt: { ...receipt, historyDigest: 'f'.repeat(64) } }),
      { code: 'RESOURCE_RECONCILIATION' });
    const result = await f.lifecycle.reconcileTask({ lease, receipt });
    assert.equal(result.provenance, 'operator-attested');
    assert.equal((await readResourceLedger(f.store)).state.tasks[taskId].outcome, 'reconciled');
  } finally { await lease.release(); }
});

test('reclaim CLI dry-run is no-write and explicit mutation keeps provider and release history untouched', async t => {
  const f = await fixture(t);
  const path = join(f.root, 'lifecycle.json');
  await writeFile(path, JSON.stringify(f.policy), { mode: 0o600 });
  let cache;
  await f.lifecycle.run({ plan, operation: 'validate', execute: async session => {
    cache = await session.prepareCache('compiler', f.workspace);
    await writeFile(join(cache, 'object.o'), 'small');
  } });
  const maintenance = await acquireMaintenance(f.anchor, { operation: 'synthetic growth' });
  await writeFile(join(cache, 'object.o'), '0123456789abcdef');
  await maintenance.release();
  const history = (await readResourceLedger(f.store)).previous;
  const releaseBytes = await readFile(join(releasePath(f.store, plan.id), 'events', '00000001.json'), 'utf8');
  let report;
  const options = { project: { resourceAdapter: () => f.adapter },
    command() { assert.fail('Maintenance must not invoke providers or native tools'); },
    output(value) { report = JSON.parse(value); } };
  assert.equal(await main({ ...options, args: ['storage-reclaim', '--config', path, '--dry-run'] }), 3);
  assert.equal(report.resources[0].disposition, 'would-reclaim');
  assert.equal((await readResourceLedger(f.store)).previous, history);
  assert.deepEqual(await readdir(f.anchor), []);
  assert.equal(await main({ ...options, args: ['storage-reclaim', '--config', path] }), 0);
  assert.equal(report.resources[0].disposition, 'reclaimed');
  await assert.rejects(stat(cache), { code: 'ENOENT' });
  assert.equal(await readFile(join(releasePath(f.store, plan.id), 'events', '00000001.json'), 'utf8'), releaseBytes);
});

test('pre-cancelled admission and observation do not mutate or allocate', async t => {
  const abort = new AbortController();
  const f = await fixture(t, {}, { signal: abort.signal });
  const before = await readdir(join(f.store, 'resources'));
  abort.abort(new Error('cancelled before admission'));
  await assert.rejects(f.lifecycle.run({ plan, operation: 'validate', execute() { assert.fail('must not execute'); } }), /cancelled/);
  await assert.rejects(f.lifecycle.reclaim({ dryRun: true }), /cancelled/);
  assert.deepEqual(await readdir(join(f.store, 'resources')), before);
  assert.deepEqual(await readdir(f.anchor), []);
});

test('unavailable phase capacity refuses new work without deleting protected resources', async t => {
  const f = await fixture(t, {}, { policy: { phaseBytes: { validate: 1000000000000000, execute: 1, content: 1 } } });
  await assert.rejects(f.lifecycle.run({ plan, operation: 'validate', execute() { assert.fail('must not allocate'); } }),
    { code: 'RESOURCE_CAPACITY' });
  assert.equal((await readResourceLedger(f.store)).sequence, 0);
  assert.deepEqual(await readdir(f.anchor), []);
});

test('cancellation still terminates a real owned child with an independent cleanup signal', async t => {
  const abort = new AbortController();
  let child, closed, cleaned = false;
  const token = 'registered-before-child-creation';
  const f = await fixture(t, { sessions: ['owned-child'],
    validateSession: async ({ identity }) => identity.token === token,
    releaseSession: async ({ session, signal }) => {
      assert.equal(session.identity.token, token);
      assert.equal(signal.aborted, false);
      assert.ok(child && child.pid);
      child.kill('SIGTERM');
      await closed;
      cleaned = true;
    },
  }, { signal: abort.signal });
  t.after(async () => { if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await closed; });
  await assert.rejects(f.lifecycle.run({ plan, operation: 'validate', execute: async session => {
    await session.registerSession('owned-child', { token });
    child = spawn(process.execPath, ['-e', 'process.stdout.write("ready");setInterval(()=>{},1000)'],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    closed = once(child, 'close');
    await once(child.stdout, 'data');
    abort.abort(new Error('cancelled after child startup'));
    return 'must-not-report-success';
  } }), /cancelled after child startup/);
  assert.equal(cleaned, true);
  assert.notEqual(child.signalCode, null);
  assert.equal((await inspectCoordination(f.anchor)).activities.length, 0);
  assert.equal(Object.values((await readResourceLedger(f.store)).state.sessions)[0].state, 'released');
});

test('capacity reclamation evicts an older eligible cache and preserves the recently used generation', async t => {
  const f = await fixture(t, { caches: {
    compiler: { path: '.native/intermediates', stages: ['ui-eval'] },
    index: { path: '.native/index', stages: ['ui-eval'] },
  } });
  let compiler, index;
  await f.lifecycle.run({ plan, operation: 'validate', execute: async session => {
    compiler = await session.prepareCache('compiler', f.workspace);
    index = await session.prepareCache('index', f.workspace);
    await writeFile(join(compiler, 'object.o'), '1234');
    await writeFile(join(index, 'index'), '5678');
  } });
  await f.lifecycle.run({ plan, operation: 'validate', execute: session => session.prepareCache('compiler', f.workspace) });
  const lease = await acquireMaintenance(f.anchor, { operation: 'synthetic compiler growth' });
  try {
    await writeFile(join(compiler, 'object.o'), '12345678');
    const result = await f.lifecycle.reclaim({ lease });
    assert.equal(result.outcome, 'complete');
    assert.equal(result.retainedCacheBytes, 8);
    await assert.rejects(stat(index), { code: 'ENOENT' });
    assert.equal(await readFile(join(compiler, 'object.o'), 'utf8'), '12345678');
  } finally { if (!lease.retained) await lease.release(); }
});

test('ownership finalization failure preserves the original task error and its actual lease fence', async t => {
  const f = await fixture(t);
  const lease = await acquireMaintenance(f.anchor, { operation: 'synthetic handoff fault' });
  const wrapper = { get owner() { return lease.owner; }, get retained() { return lease.retained; },
    retain: () => lease.retain(), release: () => lease.release(),
    transition: async kind => {
      if (kind === 'maintenance') throw Object.assign(new Error('handoff I/O failed'), { code: 'EIO' });
      return lease.transition(kind);
    } };
  const failure = new Error('original evidence failure');
  await assert.rejects(f.lifecycle.run({ plan, operation: 'validate', lease: wrapper,
    execute: async () => { throw failure; } }), error => error === failure && error.resourceOwnership === 'EIO');
  assert.equal(lease.retained, true);
  assert.equal((await inspectCoordination(f.anchor)).activities.length, 1);
});

test('adapter error codes cannot leak arbitrary values into bounded maintenance reports', async t => {
  const f = await fixture(t, { references: async () => {
    throw Object.assign(new Error('PRIVATE credential detail'), { code: 'PRIVATE_CREDENTIAL_VALUE' });
  } });
  const report = await f.lifecycle.reclaim({ dryRun: true });
  assert.equal(report.outcome, 'incomplete');
  assert.deepEqual(report.errors, ['RESOURCE_ASSESSMENT']);
  assert.equal(JSON.stringify(report).includes('PRIVATE'), false);
});

test('engine diagnostic text is not a file dependency while custom fields and typed paths remain protected', async t => {
  const f = await fixture(t);
  f.state.outcomes = { ios: { state: 'blocked', message: '/outside/compiler reported an error' } };
  f.state.retiredBuilds = [{ stage: { status: 'unknown', error: '/outside/tool failed earlier' } }];
  f.state.uiValidation = { state: 'passed', error: '/outside/old diagnostic retained in history' };
  await saveState(releasePath(f.store, plan.id), f.state);
  let cache;
  const result = await f.lifecycle.run({ plan, operation: 'validate', execute: async session => {
    cache = await session.prepareCache('compiler', f.workspace);
    await writeFile(join(cache, 'object.o'), '0123456789abcdef');
  } });
  assert.equal(result.maintenance.outcome, 'complete');
  await assert.rejects(stat(cache), { code: 'ENOENT' });
  const history = await readFile(join(releasePath(f.store, plan.id), 'events/00000002.json'), 'utf8');
  assert.ok(history.includes('/outside/compiler reported an error'));
  for (const value of [{ custom: { error: '/outside/required-input' } },
    { artifacts: { ios: { path: '/outside/required-artifact' } } },
    { plan: { ...plan, metadata: { metadataPath: 'not-a-Git-object' } } }]) {
    const protectedFixture = await fixture(t);
    Object.assign(protectedFixture.state, value);
    await saveState(releasePath(protectedFixture.store, plan.id), protectedFixture.state);
    const report = await protectedFixture.lifecycle.reclaim({ dryRun: true });
    assert.equal(report.outcome, 'incomplete');
    assert.deepEqual(report.errors, ['RESOURCE_REFERENCES']);
  }
});

test('compatible restart preserves the feature fence and incompatible policy cannot act as a rollback', async t => {
  const f = await fixture(t);
  const marker = join(f.store, 'resources/feature.json');
  const original = await readFile(marker);
  const incompatible = createResourceLifecycle({ stateDirectory: f.store,
    policy: { ...f.policy, cacheBudgetBytes: f.policy.cacheBudgetBytes + 1 }, adapter: f.adapter });
  await assert.rejects(incompatible.run({ plan, operation: 'validate', execute: async () => assert.fail('Must not execute') }),
    { code: 'RESOURCE_COMPATIBILITY' });
  assert.deepEqual(await readFile(marker), original);
  const restored = createResourceLifecycle({ stateDirectory: f.store, policy: f.policy, adapter: f.adapter });
  const result = await restored.run({ plan, operation: 'validate', execute: async session => {
    const cache = await session.prepareCache('compiler', f.workspace);
    await writeFile(join(cache, 'object.o'), '0123456789abcdef');
  } });
  assert.equal(result.maintenance.outcome, 'complete');
  assert.deepEqual(await readFile(marker), original);
  const file = join(f.root, 'policy.json');
  await writeFile(file, JSON.stringify(f.policy), { mode: 0o600 });
  await assert.rejects(main({ args: ['storage-reclaim', '--config', file, '--disable'],
    project: { resourceAdapter: async () => f.adapter }, output() {} }), /Unknown option/);
  assert.deepEqual(await readFile(marker), original);
});

test('dotted keys, wildcard objects and custom diagnostic lookalikes still protect actual cache inputs', async t => {
  const variants = {
    'dotted root key': (state, path) => { state['retiredBuilds.*.stage.error'] = path; },
    'dotted parent key': (state, path) => { state['retiredBuilds.*'] = { stage: { error: path } }; },
    'wildcard object': (state, path) => { state.retiredBuilds = { '*': { stage: { error: path } } }; },
    'numeric object': (state, path) => { state.retiredBuilds = { '0': { stage: { error: path } } }; },
    'custom stage': (state, path) => { state.stages.custom = { status: 'succeeded', error: path }; },
    'custom acceptance map': (state, path) => { state.acceptanceStatus = { custom: { error: path } }; },
  };
  for (const [name, reference] of Object.entries(variants)) {
    await t.test(name, async t => {
      const f = await fixture(t);
      let input;
      const result = await f.lifecycle.run({ plan, operation: 'validate', execute: async session => {
        const cache = await session.prepareCache('compiler', f.workspace);
        input = join(cache, 'required.o');
        await writeFile(input, '0123456789abcdef');
        reference(f.state, input);
        await saveState(releasePath(f.store, plan.id), f.state);
      } });
      assert.equal(result.maintenance.observationComplete, true);
      assert.equal(result.maintenance.outcome, 'protected-capacity');
      assert.ok(result.maintenance.resources[0].reasons.includes('retained-reference'));
      assert.equal(await readFile(input, 'utf8'), '0123456789abcdef');
    });
  }
});

test('the independent session finalizer deadline rejects and retains ownership when the adapter never settles', async t => {
  let started;
  const entered = new Promise(resolve => { started = resolve; });
  const f = await fixture(t, { sessions: ['synthetic-session'], releaseSession: async ({ signal }) => {
    started(signal);
    await new Promise(() => {});
  } });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const running = f.lifecycle.run({ plan, operation: 'validate', execute: async session => {
      await session.registerSession('synthetic-session', { owner: 'controlled never-settled session' });
    } });
    const rejected = assert.rejects(running, { code: 'RESOURCE_SESSION_TIMEOUT' });
    const cleanupSignal = await entered;
    assert.equal(cleanupSignal.aborted, false);
    t.mock.timers.tick(45000);
    await rejected;
    assert.equal(cleanupSignal.aborted, true);
    assert.equal((await inspectCoordination(f.anchor)).activities.length, 1);
    assert.equal(Object.values((await readResourceLedger(f.store)).state.sessions)[0].state, 'release-pending');
  } finally { t.mock.timers.reset(); }
});

test('a real cross-release reference protects another release cache and relative references block assessment', async t => {
  const f = await fixture(t);
  let cache;
  const other = { ...f.state, plan: { ...plan, id: `release-${'d'.repeat(24)}` } };
  await f.lifecycle.run({ plan, operation: 'validate', execute: async session => {
    cache = await session.prepareCache('compiler', f.workspace);
    await writeFile(join(cache, 'object.o'), '0123456789abcdef');
    other.requiredFile = join(cache, 'object.o');
    await saveState(releasePath(f.store, other.plan.id), other);
  } });
  const lease = await acquireMaintenance(f.anchor, { operation: 'cross-release reference check' });
  try {
    const report = await f.lifecycle.reclaim({ lease });
    assert.equal(report.outcome, 'protected-capacity');
    assert.ok(report.resources[0].reasons.includes('retained-reference'));
    other.requiredFile = 'relative/unknown-input';
    await saveState(releasePath(f.store, other.plan.id), other);
    const incomplete = await f.lifecycle.reclaim({ lease });
    assert.equal(incomplete.outcome, 'incomplete');
    assert.deepEqual(incomplete.errors, ['RESOURCE_REFERENCES']);
    assert.equal(await readFile(join(cache, 'object.o'), 'utf8'), '0123456789abcdef');
  } finally { await lease.release(); }
});

test('hard-linked files make the entire cache assessment incomplete without deleting earlier candidates', async t => {
  const f = await fixture(t, { caches: {
    compiler: { path: '.native/intermediates', stages: ['ui-eval'] },
    index: { path: '.native/index', stages: ['ui-eval'] },
  } });
  const outside = join(f.root, 'durable-input');
  await writeFile(outside, 'retained');
  let first;
  const result = await f.lifecycle.run({ plan, operation: 'validate', execute: async session => {
    first = await session.prepareCache('compiler', f.workspace);
    await writeFile(join(first, 'object.o'), '0123456789abcdef');
    const second = await session.prepareCache('index', f.workspace);
    await link(outside, join(second, 'shared-input'));
  } });
  assert.equal(result.maintenance.outcome, 'incomplete');
  assert.equal(await readFile(join(first, 'object.o'), 'utf8'), '0123456789abcdef');
  assert.equal(await readFile(outside, 'utf8'), 'retained');
  assert.equal((await stat(outside)).nlink, 2);
});

test('corrupt, truncated or missing ledger events fail closed before another task can allocate', async t => {
  for (const variant of ['checksum', 'truncated', 'missing']) {
    await t.test(variant, async t => {
      const f = await fixture(t);
      let cache;
      await f.lifecycle.run({ plan, operation: 'validate', execute: async session => {
        cache = await session.prepareCache('compiler', f.workspace);
        await writeFile(join(cache, 'object.o'), 'kept');
      } });
      const path = join(f.store, 'resources/events/00000001.json');
      if (variant === 'missing') await unlink(path);
      else if (variant === 'truncated') await writeFile(path, '{');
      else {
        const event = JSON.parse(await readFile(path, 'utf8'));
        Object.values(event.state.tasks)[0].reservedBytes++;
        await writeFile(path, JSON.stringify(event));
      }
      let allocated = false;
      await assert.rejects(f.lifecycle.run({ plan, operation: 'validate', execute: async () => { allocated = true; } }));
      assert.equal(allocated, false);
      assert.equal(await readFile(join(cache, 'object.o'), 'utf8'), 'kept');
      assert.equal((await inspectCoordination(f.anchor)).activities.length, 0);
    });
  }
});
