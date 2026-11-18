import test from 'node:test';
import { generateKeyPairSync, verify } from 'node:crypto';
import { attachStoreBuild, statusStore, uploadStore } from '../src/stores.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { mkdtemp, realpath, mkdir, writeFile, readFile, readdir, rename, rm } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRunner } from '../src/engine.mjs';
import { createPlan } from '../src/plan.mjs';
import { runCommand } from '../src/command.mjs';
import { acquireLock, digest, loadState, releasePath, saveState } from '../src/state.mjs';
import { main } from '../src/cli.mjs';
import { loadStoreContent } from '../src/store-content.mjs';
import { createRequest, dispatchRequest, runRequest, readRequestStatus, inspectDispatchRequests } from '../src/executor.mjs';
import { workerMain } from '../src/worker.mjs';
import { createResourceLifecycle } from '../src/resource-lifecycle.mjs';
import { appendResourceState, readResourceLedger } from '../src/resource-ledger.mjs';
import { inspectResourceReferences } from '../src/resource-references.mjs';
import { acquireActivity, acquireMaintenance, assertCoordinationOwner } from '../src/coordination.mjs';
import { executionHandlers } from '../src/execution.mjs';

async function fixture(t, platforms = ['ios', 'android']) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'release-engine-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const repo = join(base, 'repo');
  await mkdir(repo);
  const git = (args) => runCommand('git', args, { cwd: repo });
  await git(['init', '-q', '--initial-branch=main']);
  await git(['config', 'user.name', 'Synthetic']);
  await git(['config', 'user.email', 'test@example.invalid']);
  await git(['config', 'core.hooksPath', '/dev/null']);
  // A local origin exercises current-default-head gates without provider access.
  await git(['remote', 'add', 'origin', repo]);
  await writeFile(join(repo, '.gitignore'), '.ui-eval/\n');
  await writeFile(join(repo, 'app.json'), JSON.stringify({ expo: {
    version: '1.0.0', runtimeVersion: { policy: 'appVersion' },
    ios: { bundleIdentifier: 'example.synthetic' }, android: { package: 'example.synthetic' },
  } }));
  await writeFile(join(repo, 'eas.json'), '{}');
  await git(['add', '.']);
  await git(['commit', '-qm', 'synthetic source']);
  const calls = [];
  const project = {
    schemaVersion: 1, sourceValidationPolicy: 'synthetic/v1',
    checksDescription: 'synthetic checks', uiScope: 'synthetic-ui',
    async installValidation() { calls.push('install-validation'); },
    async checkSource() { calls.push('checks'); },
    async installBuild({ platform }) { calls.push(`install-${platform}`); },
    async evaluateUI({ root, source }) {
      calls.push('ui');
      await mkdir(join(root, '.ui-eval'), { recursive: true });
      const path = join(root, '.ui-eval', 'receipt.json');
      const bytes = JSON.stringify({ source });
      await writeFile(path, bytes);
      return { path, sha256: digest(bytes), source, scope: 'synthetic-ui' };
    },
    async revalidateUI({ source, evidence }) {
      assert.equal(JSON.parse(await readFile(evidence.path, 'utf8')).source, source);
    },
  };
  const config = { schemaVersion: 1 };
  const store = join(base, 'state');
  const adapters = Object.fromEntries(platforms.map(platform => [platform, {
    async doctor() { return { checks: [{ name: 'synthetic', ok: true }] }; },
    async build(ctx) {
      calls.push(`build-${platform}`);
      const path = join(ctx.releaseDir, `${platform}.artifact`);
      const bytes = `synthetic ${platform}`;
      await writeFile(path, bytes);
      return { path, sha256: digest(bytes), platform, appId: ctx.plan.appIds[platform],
        version: ctx.plan.version, buildNumber: '1' };
    },
    async inspect({ artifact }) { return { ...artifact }; },
    async publish(ctx) {
      calls.push(`publish-${platform}`);
      await ctx.checkpoint(`${platform}-upload`, { state: 'submitted' });
      return { state: 'submitted' };
    },
    async status() { calls.push(`status-${platform}`); return { state: 'in-review' }; },
  }]));
  const plan = await createPlan({ repo, ref: 'HEAD', platforms, config });
  const configPath = join(base, 'config.json');
  await writeFile(configPath, JSON.stringify(config));
  const options = { repo, store, config, project, adapters, command: runCommand };
  const receipts = async state => Object.fromEntries(await Promise.all(platforms.map(async platform => {
    const path = join(base, `${platform}-acceptance.json`);
    await writeFile(path, JSON.stringify({
      schemaVersion: 1, kind: 'native-acceptance', source: state.plan.source, platform,
      artifactSha256: state.artifacts[platform].sha256, passed: true,
      checkedAt: new Date().toISOString(), provenance: 'operator', checks: [{ name: 'synthetic', passed: true }],
      testedBuild: { kind: 'artifact', source: state.plan.source, sha256: state.artifacts[platform].sha256 },
    }));
    return [platform, path];
  })));
  return { ...options, base, plan, configPath, calls, receipts, options,
    runner: () => createRunner(options),
    state: () => loadState(releasePath(store, plan.id)),
    cli: (args) => main({ ...options, platformAdapters: adapters,
      args: [...args, '--config', configPath, '--state-dir', store], output() {} }),
  };
}

const cleanupError = () => Object.assign(new Error('Synthetic unsettled process group'), { cleanupIncomplete: true });

test('doctor diagnostics never create a journal-less release or block lifecycle admission', async t => {
  const f = await lifecycleFixture(t);
  f.adapters.ios.doctor = async ctx => {
    await ctx.command(process.execPath, ['-e', 'process.stdout.write("synthetic readiness")']);
    return { checks: [{ name: 'synthetic', ok: true }] };
  };
  const reports = [];
  assert.equal(await main({ ...f.options, platformAdapters: f.adapters,
    args: ['doctor', '--config', f.configPath, '--platforms', 'ios', '--state-dir', f.store],
    output: value => reports.push(JSON.parse(value)) }), 0);
  const logs = join(f.store, 'diagnostics', f.plan.id, 'logs');
  assert.equal(reports[0].diagnosticsDirectory, logs);
  assert.equal((await readdir(logs)).length, 1);
  await assert.rejects(readdir(join(f.store, 'releases')), { code: 'ENOENT' });
  f.options.resourceLifecycle = await enableResourceLifecycle(f);
  assert.equal((await f.runner().validate(f.plan)).sourceValidation.state, 'passed');
  assert.equal((await readdir(logs)).length, 1);
});

test('tracked store metadata Git identities do not become unresolved filesystem references', async t => {
  const f = await lifecycleFixture(t);
  await mkdir(join(f.repo, 'metadata'));
  await writeFile(join(f.repo, 'metadata', 'description.txt'), 'Synthetic listing');
  await writeFile(join(f.repo, 'submission.json'), '{}');
  await runCommand('git', ['add', '.'], { cwd: f.repo });
  await runCommand('git', ['commit', '-qm', 'synthetic tracked store metadata'], { cwd: f.repo });
  f.config.stores = { ios: { metadataPath: 'metadata', submissionInformationPath: 'submission.json' } };
  f.plan = await createPlan({ ...f.options, ref: 'HEAD', platforms: ['ios'] });
  assert.match(f.plan.metadata.metadataPath, /^[a-f0-9]{40}$/);
  assert.match(f.plan.metadata.submissionInformationPath, /^[a-f0-9]{40}$/);
  f.options.resourceLifecycle = await enableResourceLifecycle(f, 'checks');
  for (let index = 0; index < 2; index++) {
    const runner = f.runner();
    await runner.validate(f.plan);
    assert.equal(runner.resourceMaintenance.outcome, 'complete');
  }
  assert.equal(f.calls.filter(call => call === 'checks').length, 2);
  assert.equal(f.calls.filter(call => call === 'install-validation').length, 1);
});

async function lifecycleFixture(t, platforms = ['ios']) {
  const f = await fixture(t, platforms);
  await runCommand('git', ['remote', 'set-url', 'origin', 'https://github.com/example/synthetic.git'], { cwd: f.repo });
  f.plan = await createPlan({ repo: f.repo, ref: 'HEAD', platforms, config: f.config });
  f.state = () => loadState(releasePath(f.store, f.plan.id));
  // Substitute only transport: source verification still resolves and fetches
  // the actual local Git default branch and checks the isolated checkout.
  f.options.command = (binary, args, options) => runCommand(binary,
    binary === 'git' && ['ls-remote', 'fetch'].includes(args[0])
      ? args.map(arg => arg === 'origin' ? f.repo : arg) : args, options);
  const receipts = f.receipts;
  f.receipts = async state => {
    const result = await receipts(state);
    for (const platform of platforms) {
      const path = join(releasePath(f.store, f.plan.id), `${platform}-acceptance.json`);
      await writeFile(path, await readFile(result[platform]));
      result[platform] = path;
    }
    return result;
  };
  return f;
}

async function configureResourceLifecycle(f, stage, cacheBudgetBytes, signal) {
  const anchor = join(f.base, 'coordination');
  await mkdir(anchor, { mode: 0o700 });
  await mkdir(f.store, { mode: 0o700, recursive: true });
  const adapter = { schemaVersion: 1, policy: 'd'.repeat(64),
    caches: { compiler: { path: '.ui-eval/build/intermediates', stages: [stage] } },
    references: async () => [],
    toolchain: async () => 'e'.repeat(64),
    reconstructable: async ({ resource }) => ({ source: resource.source, toolchain: resource.toolchain, sourceClean: true,
      inputsAvailable: true, recoveryIndependent: true }) };
  const policy = { schemaVersion: 1, coordinationAnchor: anchor, cacheBudgetBytes,
    minimumFreeBytes: 1, phaseBytes: { validate: 1, execute: 1, content: 1 } };
  return createResourceLifecycle({ stateDirectory: f.store, policy, adapter, signal });
}

async function enableResourceLifecycle(f, stage = 'ui-eval', cacheBudgetBytes = 8, signal) {
  const lifecycle = await configureResourceLifecycle(f, stage, cacheBudgetBytes, signal);
  const lease = await acquireMaintenance(lifecycle.coordinationAnchor, { operation: 'synthetic lifecycle activation' });
  await lifecycle.activate({ lease });
  await lease.release();
  const hook = stage === 'checks' ? 'checkSource' : 'evaluateUI';
  const evaluate = f.project[hook];
  f.project[hook] = async ctx => {
    const cache = await ctx.resources.prepareCache('compiler', ctx.root);
    await writeFile(join(cache, 'object.o'), '0'.repeat(f.cacheBytes ?? 16));
    return evaluate(ctx);
  };
  return lifecycle;
}

test('activated engine refuses bypass and rebuilds reclaimed UI preparation', async t => {
  const f = await fixture(t);
  // Production histories record a repository URL, not a filesystem dependency
  // outside the state root. Keep validation local; it never fetches this origin.
  await runCommand('git', ['remote', 'set-url', 'origin', 'https://github.com/example/synthetic.git'], { cwd: f.repo });
  f.plan = await createPlan({ repo: f.repo, ref: 'HEAD', platforms: ['ios', 'android'], config: f.config });
  f.state = () => loadState(releasePath(f.store, f.plan.id));
  const lifecycle = await enableResourceLifecycle(f);
  await assert.rejects(f.runner().validate(f.plan, { ui: true }), { code: 'RESOURCE_ADMISSION' });
  assert.equal(f.calls.length, 0);
  f.options.resourceLifecycle = lifecycle;
  const runner = f.runner();
  const first = await runner.validate(f.plan, { ui: true });
  assert.equal(first.uiValidation.state, 'passed');
  assert.equal(runner.resourceMaintenance.outcome, 'complete', JSON.stringify(runner.resourceMaintenance));
  const second = await f.runner().validate(f.plan, { ui: true });
  assert.equal(second.uiValidation.state, 'passed');
  assert.equal(f.calls.filter(call => call === 'ui').length, 2);
  assert.equal(f.calls.filter(call => call === 'checks').length, 1);
  assert.equal(f.calls.some(call => call.startsWith('build-') || call.startsWith('publish-')), false);
  assert.equal((await f.state()).stages['ui-eval'].status, 'succeeded');
});

test('enabled dispatch releases its observer before one worker claims and validates under lifecycle admission', async t => {
  const f = await fixture(t, ['ios']);
  await runCommand('git', ['remote', 'set-url', 'origin', 'https://github.com/example/synthetic.git'], { cwd: f.repo });
  f.plan = await createPlan({ repo: f.repo, ref: 'HEAD', platforms: ['ios'], config: f.config });
  const lifecycle = await enableResourceLifecycle(f);
  const policy = { schemaVersion: 1, repository: 'example/synthetic', controlRepository: f.repo,
    releaseConfig: f.configPath, stateDirectory: f.store,
    github: { enabled: true, workflow: 'release-local.yml', ref: 'main',
      runnerName: 'synthetic-mac', runnerLabel: 'release-example', startTimeoutSeconds: 1, pollSeconds: 1 } };
  const request = await createRequest({ policy, plan: f.plan, operation: 'validate', ui: true });
  const handlers = executionHandlers({ policy, command: runCommand, localMain: main,
    environment: process.env, project: f.project, platformAdapters: f.adapters });
  const anchor = join(f.base, 'coordination');
  const dispatcher = await acquireActivity(anchor, { operation: 'dispatcher' });
  const scheduled = await dispatchRequest({ policy, id: request.id, mode: 'github', ...handlers,
    resourceLifecycle: lifecycle, resourceLease: dispatcher,
    github: { available: async () => ({ available: true, workflowSha: f.plan.source,
      workflowDigest: 'b'.repeat(64), runnerId: '1' }), dispatch: async () => ({ runId: '1' }) } });
  assert.equal(scheduled.state, 'pending');
  assert.equal(scheduled.resourceAdmission, 'worker-after-dispatcher-settlement');
  const worker = await acquireActivity(anchor, { operation: 'worker' });
  const running = runRequest({ policy, id: request.id, executor: 'github', ...handlers,
    resourceLifecycle: lifecycle, resourceLease: worker,
    worker: { runnerName: policy.github.runnerName, repository: policy.repository,
      workflowSha: f.plan.source, runId: '1', runAttempt: 1 } });
  await dispatcher.release();
  const result = await running;
  assert.equal(result.state, 'completed');
  assert.equal(result.result.exitCode, 0);
  assert.equal(result.resourceMaintenance.outcome, 'complete', JSON.stringify(result.resourceMaintenance));
  await worker.release();
  const claimBefore = await readFile(join(f.store, 'dispatch', 'requests', request.id, 'claim.json'), 'utf8');
  const repeated = await runRequest({ policy, id: request.id, executor: 'github', ...handlers,
    worker: { runnerName: policy.github.runnerName, repository: policy.repository,
      workflowSha: f.plan.source, runId: '1', runAttempt: 2 } });
  assert.equal(repeated.state, 'completed');
  assert.equal(await readFile(join(f.store, 'dispatch', 'requests', request.id, 'claim.json'), 'utf8'), claimBefore);
  assert.equal(f.calls.filter(call => call === 'ui').length, 1);
});

test('reclaimed checks cache reruns checks while preserving installation reuse and prior pass evidence', async t => {
  const f = await lifecycleFixture(t);
  f.options.resourceLifecycle = await enableResourceLifecycle(f, 'checks');
  await f.runner().validate(f.plan);
  await f.runner().validate(f.plan);
  assert.equal(f.calls.filter(call => call === 'checks').length, 2);
  assert.equal(f.calls.filter(call => call === 'install-validation').length, 1);
  const events = join(releasePath(f.store, f.plan.id), 'events');
  const history = await Promise.all((await readdir(events)).map(async name => JSON.parse(await readFile(join(events, name)))));
  assert.ok(history.some(event => event.state.stages.checks?.status === 'succeeded'));
  assert.ok(history.some(event => event.state.stages.checks?.status === 'invalidated'));
});

test('enabled lifecycle reclaims preparation and resumes completed native publication without repeating side effects', async t => {
  const f = await lifecycleFixture(t, ['ios', 'android']);
  f.options.resourceLifecycle = await enableResourceLifecycle(f, 'ui-eval', 64);
  f.cacheBytes = 128;
  const validation = f.runner();
  await validation.validate(f.plan, { ui: true });
  assert.equal(validation.resourceMaintenance.resources[0].disposition, 'reclaimed');
  f.cacheBytes = 16;
  const built = await f.runner().execute(f.plan, { publish: true });
  assert.equal(built.outcomes.ios.state, 'awaiting_acceptance');
  const submitted = await f.runner().execute(f.plan, { acceptance: await f.receipts(built) });
  assert.equal(submitted.outcomes.ios.state, 'submitted');
  const resumed = await f.runner().execute(f.plan);
  assert.equal(resumed.outcomes.ios.state, 'in-review');
  assert.ok(f.calls.filter(call => call === 'ui').length >= 2);
  for (const platform of f.plan.platforms) {
    assert.equal(f.calls.filter(call => call === `build-${platform}`).length, 1);
    assert.equal(f.calls.filter(call => call === `publish-${platform}`).length, 1);
    assert.deepEqual(resumed.checkpoints[platform], submitted.checkpoints[platform]);
  }
});

test('enabled lifecycle preserves uncertain publication checkpoint and never resubmits on resume', async t => {
  const f = await lifecycleFixture(t);
  f.options.resourceLifecycle = await enableResourceLifecycle(f, 'ui-eval', 64);
  f.cacheBytes = 128;
  const validation = f.runner();
  await validation.validate(f.plan, { ui: true });
  assert.equal(validation.resourceMaintenance.resources[0].disposition, 'reclaimed');
  f.cacheBytes = 16;
  let reconciliations = 0;
  f.adapters.ios.publish = async ctx => {
    reconciliations++;
    if (ctx.previous['ios-upload']) {
      assert.deepEqual(ctx.previous['ios-upload'], { state: 'intent' });
      throw new Error('Synthetic provider reconciliation remains uncertain');
    }
    f.calls.push('publish-ios');
    await ctx.checkpoint('ios-upload', { state: 'intent' });
    throw new Error('Synthetic lost provider response');
  };
  const built = await f.runner().execute(f.plan, { publish: true });
  const failed = await f.runner().execute(f.plan, { acceptance: await f.receipts(built) });
  assert.equal(failed.stages['publish-ios'].status, 'unknown');
  const resumed = await f.runner().execute(f.plan);
  assert.equal(resumed.stages['publish-ios'].status, 'unknown');
  assert.deepEqual(resumed.checkpoints.ios, failed.checkpoints.ios);
  assert.equal(f.calls.filter(call => call === 'build-ios').length, 1);
  assert.equal(f.calls.filter(call => call === 'publish-ios').length, 1);
  assert.equal(reconciliations, 2);
});

test('run/resume preserves builds and submission checkpoints, and revokes failed replacement acceptance', async t => {
  const f = await fixture(t);
  const built = await f.runner().execute(f.plan, { publish: true });
  assert.equal(built.outcomes.ios.state, 'awaiting_acceptance');
  assert.equal(f.calls.some(x => x.startsWith('publish-')), false);
  const acceptance = await f.receipts(built);
  const submitted = await f.runner().execute(f.plan, { acceptance });
  assert.equal(submitted.publicationRequested, true);
  assert.equal(submitted.outcomes.android.state, 'submitted');
  const resumed = await f.runner().execute(f.plan);
  assert.equal(resumed.outcomes.ios.state, 'in-review');
  for (const platform of f.plan.platforms) {
    assert.equal(f.calls.filter(x => x === `build-${platform}`).length, 1);
    assert.equal(f.calls.filter(x => x === `publish-${platform}`).length, 1);
  }
  await writeFile(acceptance.ios, '{}');
  const failed = await f.runner().execute(f.plan, { acceptance: { ios: acceptance.ios } });
  assert.equal(failed.outcomes.ios.state, 'blocked');
  assert.equal(failed.acceptance.ios, undefined);
  assert.equal(failed.acceptanceStatus.ios.state, 'failed');
  assert.deepEqual(failed.checkpoints, submitted.checkpoints);
  assert.equal(failed.acceptanceHistory[0].receipt.artifactSha256, built.artifacts.ios.sha256);
  assert.deepEqual(await readdir(join(f.store, 'locks')), []);
});

test('an unresolved build requires explicit reconciliation and never replays on ordinary resume', async t => {
  const f = await fixture(t, ['ios']);
  const build = f.adapters.ios.build;
  let attempts = 0;
  f.adapters.ios.build = async ctx => {
    attempts++;
    if (attempts === 1) throw new Error('Synthetic lost build result');
    return build(ctx);
  };
  await f.runner().execute(f.plan);
  await f.runner().execute(f.plan);
  assert.equal(attempts, 1);
  const recovered = await f.runner().execute(f.plan, {
    retryBuild: { platform: 'ios', reason: 'Synthetic operator confirmed tools and allocation settled' },
  });
  assert.equal(attempts, 2);
  assert.equal(recovered.retiredBuilds[0].stage.status, 'unknown');
  assert.equal(recovered.buildAttempts.ios, 2);
  assert.equal(recovered.outcomes.ios.state, 'awaiting_acceptance');
});

test('same-source configuration changes cannot steal publication ownership', async t => {
  const f = await fixture(t, ['ios']);
  const built = await f.runner().execute(f.plan);
  await f.runner().execute(f.plan, { publish: true, acceptance: await f.receipts(built) });
  const config = { ...f.config, policyRevision: 'new' };
  const plan = await createPlan({ repo: f.repo, ref: f.plan.source, platforms: ['ios'], config });
  const runner = createRunner({ ...f.options, config });
  const replacement = await runner.execute(plan);
  const result = await runner.execute(plan, { publish: true, acceptance: await f.receipts(replacement) });
  assert.match(result.outcomes.ios.message, /already owns this source/);
  assert.equal(f.calls.filter(x => x === 'publish-ios').length, 1);
});

test('cleanup uncertainty stops remaining platforms, retains ownership and blocks another release', async t => {
  const f = await fixture(t);
  f.adapters.ios.build = async () => { throw cleanupError(); };
  await assert.rejects(f.runner().execute(f.plan), { cleanupIncomplete: true });
  assert.equal(f.calls.includes('build-android'), false);
  assert.equal((await f.state()).stages['build-ios'].cleanupIncomplete, true);
  const locks = await readdir(join(f.store, 'locks'));
  assert.ok(locks.includes(`${f.plan.id}.lock`));
  assert.ok(locks.includes('cleanup-incomplete.lock'));
  const plan = await createPlan({ repo: f.repo, ref: f.plan.source, platforms: ['ios'], config: f.config });
  const count = f.calls.length;
  await assert.rejects(f.runner().validate(plan), { code: 'CLEANUP_INCOMPLETE' });
  assert.equal(f.calls.length, count);
  assert.equal((await f.runner().status(f.plan.id)).stages['build-ios'].status, 'unknown');
  assert.ok((await inspectDispatchRequests({ stateDirectory: f.store })).blockers.some(b => b.reason === 'cleanup-incomplete'));
});

test('swallowed publication command cleanup cannot complete a dispatch or release its target lock', async t => {
  const f = await fixture(t, ['ios']);
  const built = await f.runner().execute(f.plan);
  const acceptance = await f.receipts(built);
  f.options.command = async (binary, args, options) => {
    if (binary === 'synthetic-publish') throw cleanupError();
    return runCommand(binary, args, options);
  };
  f.adapters.ios.publish = async ctx => {
    await ctx.checkpoint('ios-upload', { state: 'intent' });
    try { await ctx.command('synthetic-publish', []); } catch {}
    return { state: 'unknown' };
  };
  const policy = {
    schemaVersion: 1, repository: 'example/synthetic', controlRepository: f.repo,
    releaseConfig: f.configPath, stateDirectory: f.store,
    github: { enabled: false, workflow: 'release-local.yml', ref: 'main',
      runnerName: 'synthetic-mac', runnerLabel: 'release-example' },
  };
  const request = await createRequest({ policy, plan: f.plan, operation: 'run', publish: true });
  const result = await runRequest({ policy, id: request.id, executor: 'local', validate() {},
    async execute() {
      // Even an embedding caller that catches the runner error cannot settle this request.
      try { await f.runner().execute(f.plan, { publish: true, acceptance }); } catch {}
      return { exitCode: 2 };
    },
  });
  assert.equal(result.state, 'unknown');
  assert.equal(result.result.exitCode, null);
  const state = await f.state();
  assert.equal(state.stages['publish-ios'].status, 'unknown');
  assert.equal(state.stages['publish-ios'].cleanupIncomplete, true);
  assert.deepEqual(state.checkpoints.ios['ios-upload'], { state: 'intent' });
  assert.ok((await readdir(join(f.store, 'locks'))).some(x => x.startsWith('target-')));
  assert.equal((await inspectDispatchRequests({ stateDirectory: f.store })).clear, false);
});

test('real command cleanup uncertainty retains UI admission even if the adapter catches the error', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t, ['ios']);
  const evaluate = f.project.evaluateUI;
  const kill = process.kill.bind(process);
  f.project.evaluateUI = async ctx => {
    t.mock.method(process, 'kill', (pid, signal) => {
      if (pid < 0) throw Object.assign(new Error('Synthetic observation denial'), { code: 'EPERM' });
      return kill(pid, signal);
    });
    try { await ctx.command(process.execPath, ['-e', 'process.exit(0)']); } catch {}
    return evaluate(ctx);
  };
  await assert.rejects(f.runner().validate(f.plan, { ui: true }), { cleanupIncomplete: true });
  assert.ok((await readdir(join(f.store, 'locks'))).includes('ui-eval.lock'));
  assert.equal((await f.state()).uiValidation.state, 'failed');
  f.project.evaluateUI = evaluate;
  await assert.rejects(f.runner().validate(f.plan, { ui: true }), { cleanupIncomplete: true });
});

test('CLI run/resume fail closed for pending review, unknown, missing and unverified outcomes', async t => {
  const f = await fixture(t, ['android']);
  const built = await f.runner().execute(f.plan);
  const acceptance = await f.receipts(built);
  for (const outcome of [{ state: 'pending-review' }, { state: 'future-provider-state' }, {},
    { state: 'available' }, { state: 'accepted' }, { state: 'prepared' }]) {
    f.adapters.android.publish = async () => outcome;
    f.adapters.android.status = async () => outcome;
    assert.equal(await f.cli(['resume', f.plan.id, '--publish', '--acceptance', `android=${acceptance.android}`]), 2);
  }
  for (const outcome of [{ state: 'submitted' }, { state: 'in-review' },
    { state: 'available', availabilityVerified: true }]) {
    f.adapters.android.publish = async () => outcome;
    f.adapters.android.status = async () => outcome;
    assert.equal(await f.cli(['resume', f.plan.id]), 0);
  }
});

test('settled cancellation stops later platforms but releases locks without a cleanup fence', async t => {
  const f = await fixture(t);
  const abort = new AbortController();
  f.options.signal = abort.signal;
  f.adapters.ios.build = async ctx => {
    const timer = setTimeout(() => abort.abort(), 100);
    try {
      await ctx.command(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        signal: ctx.signal, timeout: 5000, cleanupMs: 100,
      });
    } finally {
      clearTimeout(timer);
    }
  };
  await assert.rejects(f.runner().execute(f.plan), /interrupted/);
  assert.equal(f.calls.includes('build-android'), false);
  assert.equal((await f.state()).stages['build-ios'].cleanupIncomplete, undefined);
  assert.deepEqual(await readdir(join(f.store, 'locks')), []);
});

test('GitHub worker SSH verification preserves cleanup uncertainty through sanitized errors before claiming', async t => {
  const f = await fixture(t, ['ios']);
  await runCommand('git', ['remote', 'set-url', 'origin', 'git@synthetic-alias:example/synthetic.git'], { cwd: f.repo });
  const plan = await createPlan({ repo: f.repo, ref: 'HEAD', platforms: ['ios'], config: f.config });
  const policy = {
    schemaVersion: 1, repository: 'example/synthetic', controlRepository: f.repo,
    releaseConfig: f.configPath, stateDirectory: f.store,
    github: { enabled: true, workflow: 'release-local.yml', ref: 'main',
      runnerName: 'synthetic-mac', runnerLabel: 'release-example', startTimeoutSeconds: 1, pollSeconds: 1 },
  };
  const policyPath = join(f.base, 'executor.json');
  await writeFile(policyPath, JSON.stringify(policy));
  const request = await createRequest({ policy, plan, operation: 'validate' });
  await dispatchRequest({ policy, id: request.id, mode: 'github', github: {
    async available() { return { available: true, workflowSha: plan.source, workflowDigest: 'b'.repeat(64), runnerId: '1' }; },
    async dispatch() { return {}; },
  } });
  let sshCalls = 0;
  await assert.rejects(workerMain({
    repo: f.repo, project: f.project, platformAdapters: f.adapters,
    args: ['--request', request.id, '--executor-config', policyPath],
    environment: {
      GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'workflow_dispatch',
      GITHUB_REPOSITORY: policy.repository, GITHUB_REF: 'refs/heads/main',
      GITHUB_WORKFLOW_REF: `${policy.repository}/.github/workflows/release-local.yml@refs/heads/main`,
      RUNNER_NAME: policy.github.runnerName, RUNNER_ENVIRONMENT: 'self-hosted', RUNNER_OS: 'macOS',
      GITHUB_SHA: plan.source, GITHUB_WORKFLOW_SHA: plan.source, GITHUB_RUN_ID: '1', GITHUB_RUN_ATTEMPT: '1',
    },
    async command(binary, args, options) {
      if (binary === 'ssh') {
        sshCalls++;
        throw Object.assign(new Error('synthetic-private-ssh-config'), { cleanupIncomplete: true });
      }
      return runCommand(binary, args, options);
    },
    invoke() { assert.fail('An unverified worker cannot execute'); },
    output() {},
  }), error => {
    assert.equal(error.cleanupIncomplete, true);
    assert.doesNotMatch(error.message, /synthetic-private-ssh-config/);
    return true;
  });
  assert.equal(sshCalls, 1);
  assert.equal((await readRequestStatus({ policy, id: request.id })).state, 'pending');
  const fence = await readFile(join(f.store, 'locks', 'cleanup-incomplete.lock'), 'utf8');
  assert.doesNotMatch(fence, /synthetic-private-ssh-config/);
  await assert.rejects(f.runner().validate(plan), { code: 'CLEANUP_INCOMPLETE' });
});

test('a newly declared counterpart policy revokes cached mismatched acceptance before publication', async t => {
  const f = await fixture(t, ['ios']);
  const built = await f.runner().execute(f.plan);
  const paths = await f.receipts(built);
  const receipt = JSON.parse(await readFile(paths.ios, 'utf8'));
  receipt.testedBuild = { kind: 'counterpart', source: f.plan.source, sha256: 'b'.repeat(64),
    configurationRelationship: 'Legacy operator counterpart', limitations: 'Synthetic' };
  await writeFile(paths.ios, JSON.stringify(receipt));
  const accepted = await f.runner().execute(f.plan, { acceptance: paths });
  assert.equal(accepted.acceptanceStatus.ios.state, 'passed');
  f.adapters.ios.inspect = async ({ artifact }) => ({ ...artifact,
    acceptanceCounterparts: [{ source: f.plan.source, sha256: 'c'.repeat(64) }] });
  const blocked = await f.runner().execute(f.plan, { publish: true });
  assert.equal(blocked.acceptance.ios, undefined);
  assert.equal(blocked.acceptanceStatus.ios.state, 'failed');
  assert.equal(blocked.acceptanceHistory.at(-1).receipt.testedBuild.sha256, 'b'.repeat(64));
  assert.equal(f.calls.filter(x => x === 'publish-ios').length, 0);
  assert.equal(f.calls.filter(x => x === 'build-ios').length, 1);
});

test('matching declared counterpart acceptance is reused without rebuilding or replacing its receipt', async t => {
  const f = await fixture(t, ['ios']);
  f.adapters.ios.inspect = async ({ artifact }) => ({ ...artifact,
    acceptanceCounterparts: [{ source: f.plan.source, sha256: 'c'.repeat(64) }] });
  const built = await f.runner().execute(f.plan);
  const paths = await f.receipts(built);
  const receipt = JSON.parse(await readFile(paths.ios, 'utf8'));
  receipt.testedBuild = { kind: 'counterpart', source: f.plan.source, sha256: 'c'.repeat(64),
    configurationRelationship: 'Verified counterpart', limitations: 'Synthetic' };
  await writeFile(paths.ios, JSON.stringify(receipt));
  const accepted = await f.runner().execute(f.plan, { acceptance: paths });
  const resumed = await f.runner().execute(f.plan);
  assert.deepEqual(resumed.acceptance.ios, accepted.acceptance.ios);
  assert.equal(resumed.acceptanceStatus.ios.state, 'passed');
  assert.equal(f.calls.filter(x => x === 'build-ios').length, 1);
  assert.equal(f.calls.filter(x => x === 'publish-ios').length, 0);
});


async function acceptedIos(f) {
  const built = await f.runner().execute(f.plan);
  return f.runner().execute(f.plan, { acceptance: await f.receipts(built) });
}
function boundedAdapter(f) {
  f.adapters.ios.upload = async ctx => {
    assert.equal(ctx.publicationRequested, false);
    assert.equal(ctx.uploadRequested, true);
    f.calls.push('upload-ios');
    await ctx.checkpoint('ios-upload', { state: 'uploaded', buildId: 'owned-build' });
    return { state: 'uploaded', buildId: 'owned-build' };
  };
}

async function attachFixture(t, { managed = false, prepared = false } = {}) {
  const f = managed ? await lifecycleFixture(t) : await fixture(t, ['ios']);
  f.config.stores = { ios: { appId: '123', bundleId: 'example.synthetic', apiKeyPathEnv: 'ATTACH_TEST_KEY' } };
  if (prepared) {
    f.config.stores.ios.contentPath = 'content.json';
    await writeFile(join(f.repo, 'content.json'), JSON.stringify({ schemaVersion: 1, platform: 'ios',
      version: '1.0.0', locales: [{ locale: 'en-US', fields: { whatsNew: 'Synthetic notes' }, screenshots: [] }] }));
    await runCommand('git', ['add', 'content.json'], { cwd: f.repo });
    await runCommand('git', ['commit', '-qm', 'synthetic prepared content'], { cwd: f.repo });
  }
  await writeFile(f.configPath, JSON.stringify(f.config));
  f.plan = await createPlan({ repo: f.repo, ref: 'HEAD', platforms: ['ios'], config: f.config });
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const keyPath = join(f.base, 'attach-key.json');
  await writeFile(keyPath, JSON.stringify({ key_id: 'synthetic', issuer_id: 'synthetic',
    key: privateKey.export({ format: 'pem', type: 'pkcs8' }) }), { mode: 0o600 });
  f.options.environment = { ...process.env, ATTACH_TEST_KEY: keyPath };
  f.adapters.ios.upload = async ctx => {
    f.calls.push('upload-ios');
    const { appId, version, buildNumber, sha256 } = ctx.artifact;
    await ctx.checkpoint('ios-upload', { state: 'uploaded', buildId: 'apple-build',
      identity: { appId, version, buildNumber, sha256 } });
    return { state: 'uploaded', buildId: 'apple-build' };
  };
  await acceptedIos(f);
  assert.equal(await f.cli(['upload', f.plan.id]), 0);
  const state = () => loadState(releasePath(f.store, f.plan.id));
  const remote = { versionId: 'manual-draft', buildId: 'apple-build', selected: null,
    state: 'PREPARE_FOR_SUBMISSION', releaseType: 'MANUAL', processing: 'VALID', expired: false, relationshipMissing: false, snapshotSelected: undefined, linkageSelected: undefined,
    inventoryMissing: false, inventorySelected: undefined, draftDeleted: false, snapshotState: undefined,
    onPatch: null, onFreshBuild: null };
  if (prepared) {
    const directory = releasePath(f.store, f.plan.id);
    const stored = await state();
    const { inputDigest } = await loadStoreContent({ root: join(directory, 'build-ios'), config: f.config,
      platform: 'ios', plan: f.plan, command: f.options.command });
    stored.storePreparation = { ios: { status: 'prepared', inputDigest,
      observation: { remote: { target: { id: remote.versionId } } } } };
    await saveState(directory, stored);
  }
  const requests = [];
  const build = id => ({ id, type: 'builds', attributes: { version: '1', processingState: remote.processing, expired: remote.expired },
    relationships: { preReleaseVersion: { data: { id: 'pre-version', type: 'preReleaseVersions' } } } });
  const draft = (selected = remote.selected, state = remote.state) => ({ id: remote.versionId, type: 'appStoreVersions', attributes: {
    versionString: '1.0.0', appVersionState: state, releaseType: remote.releaseType, platform: 'IOS',
  }, relationships: { build: { data: selected ? { id: selected, type: 'builds' } : null } } });
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const u = new URL(url), method = options.method ?? 'GET';
    requests.push({ method, path: u.pathname });
    assert.equal(u.origin, 'https://api.appstoreconnect.apple.com');
    assert.equal(options.redirect, 'error');
    const [header, payload, signature] = options.headers.Authorization.slice('Bearer '.length).split('.');
    assert.equal(JSON.parse(Buffer.from(payload, 'base64url')).aud, 'appstoreconnect-v1');
    assert(verify('sha256', Buffer.from(`${header}.${payload}`), { key: publicKey, dsaEncoding: 'ieee-p1363' },
      Buffer.from(signature, 'base64url')));
    if (method === 'PATCH') {
      assert.equal(u.pathname, '/v1/appStoreVersions/manual-draft/relationships/build');
      assert.deepEqual(JSON.parse(options.body), { data: { type: 'builds', id: 'apple-build' } });
      const saved = await state();
      assert.equal(saved.checkpoints.ios['ios-attach'].state, 'intent');
      assert.equal(saved.publicationRequested, false);
      if (remote.onPatch) return remote.onPatch();
      remote.selected = 'apple-build';
      return new Response(null, { status: 204 });
    }
    assert.equal(method, 'GET');
    switch (u.pathname) {
      case '/v1/apps/123': return Response.json({ data: { id: '123', type: 'apps', attributes: { bundleId: 'example.synthetic' } } });
      case '/v1/apps/123/appStoreVersions': {
        assert.equal(u.searchParams.get('filter[platform]'), 'IOS');
        const listed = draft(remote.inventorySelected);
        const selected = listed.relationships.build.data?.id;
        return Response.json({ data: remote.inventoryMissing ? [] : [listed],
          included: selected && !remote.inventoryMissing ? [build(selected)] : [] });
      }
      case '/v1/builds':
        assert.equal(u.searchParams.get('filter[app]'), '123');
        assert.equal(u.searchParams.get('filter[version]'), '1');
        assert.equal(u.searchParams.get('filter[preReleaseVersion.version]'), '1.0.0');
        return Response.json({ data: [build(remote.buildId)], included: [{ id: 'pre-version', type: 'preReleaseVersions',
          attributes: { version: '1.0.0', platform: 'IOS' } }] });
      case '/v1/builds/apple-build':
        await remote.onFreshBuild?.();
        return Response.json({ data: build(remote.buildId) });
      case '/v1/appStoreVersions/manual-draft':
        assert.equal(u.searchParams.get('include'), 'build');
        if (remote.draftDeleted) return new Response(null, { status: 404 });
        return Response.json({ data: draft(remote.snapshotSelected, remote.snapshotState) });
      case '/v1/appStoreVersions/manual-draft/relationships/build':
        return Response.json(remote.relationshipMissing ? {} : { data: draft(remote.linkageSelected).relationships.build.data });
      default: throw new Error('Unexpected synthetic request');
    }
  });
  const invoke = async (options = [], signal) => {
    const output = [];
    const exit = await main({ ...f.options, platformAdapters: f.adapters, signal,
      args: ['attach', f.plan.id, '--version-id', 'manual-draft', '--config', f.configPath, '--state-dir', f.store, ...options],
      output: s => output.push(JSON.parse(s)) });
    return { exit, report: output[0] };
  };
  const owner = join(f.store, 'targets', `${digest({ appId: 'example.synthetic', platform: 'ios', destination: 'app-store' })}.json`);
  return { ...f, state, remote, requests, invoke, owner };
}

test('attach runner refuses an unknown release without creating a journal directory', async t => {
  const f = await fixture(t, ['ios']);
  await assert.rejects(f.runner().attachBuild(f.plan, { versionId: 'manual-draft' }), /Unknown release ID/);
  await assert.rejects(readdir(join(f.store, 'releases')), { code: 'ENOENT' });
  await inspectResourceReferences(f.store, { references: async () => [] });
});

test('attach CLI binds the journaled build once, preserves upload-only intent and can read-confirm again', async t => {
  const f = await attachFixture(t);
  assert.equal(await f.cli(['resume', f.plan.id]), 0);
  const before = await f.state();
  assert.equal(before.checkpoints.ios['ios-attach'], undefined);
  assert.equal(before.publicationRequested, false);
  assert.equal(f.remote.selected, null);
  assert.equal(f.requests.some(request => request.method !== 'GET'), false);
  const owner = await readFile(f.owner);
  const first = await f.invoke();
  assert.equal(first.exit, 0);
  assert.equal(first.report.state, 'attached');
  assert.equal(first.report.writeAttempted, true);
  assert.equal(first.report.buildId, 'apple-build');
  assert.equal(first.report.versionId, 'manual-draft');
  const attached = await f.state();
  assert.equal(attached.checkpoints.ios['ios-attach'].state, 'attached');
  assert.deepEqual(attached.checkpoints.ios['ios-upload'], before.checkpoints.ios['ios-upload']);
  assert.deepEqual(attached.stages, before.stages);
  assert.equal(attached.publicationRequested, false);
  assert.deepEqual(await readFile(f.owner), owner);
  assert.equal((await f.invoke()).report.writeAttempted, false);
  assert.deepEqual(await f.state(), attached);
  assert.equal(await f.cli(['resume', f.plan.id]), 0);
  assert.equal(f.requests.filter(r => r.method === 'PATCH').length, 1);
  assert.equal(f.calls.filter(call => call === 'build-ios').length, 1);
  assert.equal(f.calls.includes('publish-ios'), false);
  assert.equal(f.remote.releaseType, 'MANUAL');
});

test('attach records a previously selected exact build using reads alone', async t => {
  const f = await attachFixture(t);
  f.remote.selected = 'apple-build';
  assert.equal((await f.state()).checkpoints.ios['ios-attach'], undefined);

  const observed = await f.invoke();
  assert.equal(observed.exit, 0);
  assert.equal(observed.report.writeAttempted, false);
  assert.equal((await f.state()).checkpoints.ios['ios-attach'].state, 'attached');
  assert.ok(f.requests.length > 0 && f.requests.every(r => r.method === 'GET'));
});

test('attach CLI reconciles a lost response and fences publication until confirmation', async t => {
  const f = await attachFixture(t);
  f.remote.onPatch = () => { throw new Error('private provider transport failure'); };
  const first = await f.invoke();
  assert.equal(first.exit, 2);
  assert.equal(first.report.state, 'unknown');
  assert.equal(first.report.writeAttempted, true);
  assert.equal(JSON.stringify(first).includes('private provider'), false);
  const unknown = await f.state();
  assert.equal(unknown.checkpoints.ios['ios-attach'].state, 'intent');
  const retry = await f.invoke();
  assert.equal(retry.exit, 2);
  assert.equal(retry.report.writeAttempted, false);
  await assert.rejects(f.cli(['resume', f.plan.id, '--publish']), /Reconcile the pending iOS attachment/);
  assert.deepEqual(await f.state(), unknown);
  f.remote.selected = 'apple-build';
  const reconciled = await f.invoke();
  assert.equal(reconciled.exit, 0);
  assert.equal(reconciled.report.writeAttempted, false);
  assert.equal((await f.state()).checkpoints.ios['ios-attach'].state, 'attached');
  assert.equal(f.requests.filter(r => r.method === 'PATCH').length, 1);
});

test('a successful PATCH response cannot confirm an empty relationship', async t => {
  const f = await attachFixture(t);
  f.remote.onPatch = () => new Response(null, { status: 204 });
  const first = await f.invoke();
  assert.equal(first.exit, 2);
  assert.equal(first.report.state, 'unknown');
  const patch = f.requests.findIndex(request => request.method === 'PATCH');
  assert.ok(patch >= 0);
  assert.deepEqual(f.requests.at(-1), { method: 'GET', path: f.requests[patch].path });
  assert.ok(f.requests.length > patch + 1);
  assert.equal((await f.state()).checkpoints.ios['ios-attach'].state, 'intent');
  await assert.rejects(f.cli(['resume', f.plan.id, '--publish']), /Reconcile the pending iOS attachment/);
  assert.equal((await f.invoke()).exit, 2);
  assert.equal(f.requests.filter(request => request.method === 'PATCH').length, 1);
});

test('attach honors both locks and only uses an existing managed admission', async t => {
  const f = await attachFixture(t, { managed: true });
  const target = digest({ appId: 'example.synthetic', platform: 'ios', destination: 'app-store' });
  for (const name of [f.plan.id, `target-${target}`]) {
    const unlock = await acquireLock(join(f.store, 'locks', `${name}.lock`));
    try { await assert.rejects(f.invoke(), /Execution lock exists/); }
    finally { await unlock(); }
  }
  const lifecycle = await enableResourceLifecycle(f, 'checks');
  f.options.resourceLifecycle = lifecycle;
  await assert.rejects(f.invoke(), { code: 'RESOURCE_ADMISSION' });
  assert.deepEqual(f.requests, []);
  const operation = await lifecycle.run({ plan: f.plan, operation: 'execute', execute: async resourceSession => {
    const runner = createRunner({ ...f.options, resourceSession });
    const maintenance = runner.resourceMaintenance;
    const report = await runner.attachBuild(f.plan, { versionId: 'manual-draft' });
    assert.equal(runner.resourceMaintenance, maintenance);
    return report;
  } });
  assert.equal(operation.result.state, 'attached');
  assert.equal(f.requests.filter(request => request.method === 'PATCH').length, 1);
});

test('preloading an inactive lifecycle policy preserves ordinary attachment', async t => {
  const f = await attachFixture(t, { managed: true });
  const lifecycle = await configureResourceLifecycle(f, 'checks', 8);
  const lease = await acquireActivity(lifecycle.coordinationAnchor, { operation: 'synthetic managed attachment' });
  try {
    f.options.resourceLease = lease;
    await assert.rejects(f.invoke(), /activity lease requires its lifecycle policy/);
    assert.deepEqual(f.requests, []);
    f.options.resourceLifecycle = lifecycle;
    await assert.rejects(f.invoke(), { code: 'RESOURCE_NOT_ACTIVATED' });
    assert.deepEqual(f.requests, []);
  } finally {
    await lease.release();
    delete f.options.resourceLease;
  }
  const attached = await f.invoke();
  assert.equal(attached.exit, 0);
  assert.equal((await f.state()).checkpoints.ios['ios-attach'].state, 'attached');
  assert.equal(f.requests.filter(request => request.method === 'PATCH').length, 1);
});

test('a heavy session cannot delegate through the attach CLI before its configuration is loaded', async t => {
  const f = await attachFixture(t, { managed: true });
  const lifecycle = await enableResourceLifecycle(f, 'checks');
  await lifecycle.run({ plan: f.plan, operation: 'execute', execute: async resourceSession => {
    await assert.rejects(main({ ...f.options, resourceSession,
      args: ['attach', f.plan.id, '--state-dir', f.store, '--version-id', 'manual-draft',
        '--config', join(f.base, 'missing-config.json')], output() {} }), /dedicated local invocation/);
    return { state: 'uploaded' };
  } });
  assert.equal((await f.state()).checkpoints.ios['ios-attach'], undefined);
  assert.deepEqual(f.requests, []);
});

async function displaceActivityRecord(f, lifecycle, lease, { replace = false } = {}) {
  const owner = join(lifecycle.coordinationAnchor, 'activity-' + lease.owner.token + '.json');
  const saved = join(f.base, 'original-owner.json');
  await rename(owner, saved);
  if (replace) await writeFile(owner, await readFile(saved), { mode: 0o600 });
  return () => rename(saved, owner);
}

test('managed attach borrows its installed activity without starting a resource task', async t => {
  const f = await attachFixture(t, { managed: true });
  const lifecycle = await enableResourceLifecycle(f, 'checks');
  f.options.resourceLifecycle = lifecycle;
  await assert.rejects(f.invoke(), { code: 'RESOURCE_ADMISSION' });
  const otherAnchor = join(f.base, 'other-coordination');
  await mkdir(otherAnchor, { mode: 0o700 });
  const foreignLease = await acquireActivity(otherAnchor, { operation: 'synthetic foreign activity' });
  try {
    f.options.resourceLease = foreignLease;
    await assert.rejects(f.invoke(), { code: 'COORDINATION_INVALID' });
    assert.deepEqual(f.requests, []);
  } finally {
    await foreignLease.release();
  }
  const lease = await acquireActivity(lifecycle.coordinationAnchor, { operation: 'synthetic managed attach' });
  const owner = lease.owner;
  const ledger = await readResourceLedger(f.store);
  const calls = [...f.calls];
  const another = { ...f.plan, id: 'release-' + 'e'.repeat(24) };
  await saveState(releasePath(f.store, another.id), { ...(await f.state()), plan: another });
  let session;
  try {
    await lifecycle.admitAttach({ plan: f.plan, lease, execute: async admitted => {
      session = admitted;
      const runner = createRunner({ ...f.options, resourceSession: admitted });
      await assert.rejects(runner.validate(f.plan), { code: 'RESOURCE_ADMISSION' });
      await assert.rejects(runner.attachBuild(another, { versionId: 'manual-draft' }),
        { code: 'RESOURCE_ADMISSION' });
      assert.equal((await loadState(releasePath(f.store, another.id))).checkpoints.ios['ios-attach'], undefined);
    } });
    await assert.rejects(createRunner({ ...f.options, resourceSession: session })
      .attachBuild(f.plan, { versionId: 'manual-draft' }), { code: 'RESOURCE_ADMISSION' });
    assert.deepEqual(f.requests, []);

    f.options.resourceLease = lease;
    f.remote.onFreshBuild = async () => {
      await assert.rejects(lease.transition('maintenance'), /borrowed by an active operation/);
      await assert.rejects(lease.release(), /borrowed by an active operation/);
    };
    const attached = await f.invoke();
    assert.equal(attached.exit, 0);
    assert.equal(attached.report.state, 'attached');
    assert.equal(attached.report.writeAttempted, true);
    assert.equal(lease.owner, owner);
    await assertCoordinationOwner(lifecycle.coordinationAnchor, owner, 'activity');
    assert.deepEqual(await readResourceLedger(f.store), ledger);
    assert.deepEqual(f.calls, calls);
  } finally {
    await lease.release();
  }
  assert.equal(f.requests.filter(request => request.method === 'PATCH').length, 1);
});

test('managed attach refuses intent if activity or activation changes during provider reads', async t => {
  for (const [variant, code] of [['owner-missing', 'COORDINATION_INVALID'],
      ['owner-replaced', 'COORDINATION_INVALID'], ['marker-missing', 'RESOURCE_ADMISSION'],
      ['marker-changed', 'RESOURCE_COMPATIBILITY']]) {
    await t.test(variant, async t => {
      const f = await attachFixture(t, { managed: true });
      const lifecycle = await enableResourceLifecycle(f, 'checks');
      const lease = await acquireActivity(lifecycle.coordinationAnchor, { operation: 'synthetic interrupted activity' });
      f.options.resourceLifecycle = lifecycle;
      f.options.resourceLease = lease;
      const marker = join(f.store, 'resources', 'feature.json');
      let restoreOwner;
      f.remote.onFreshBuild = async () => {
        if (variant.startsWith('owner-'))
          restoreOwner = await displaceActivityRecord(f, lifecycle, lease, { replace: variant === 'owner-replaced' });
        if (variant === 'marker-missing') await rm(marker);
        if (variant === 'marker-changed') {
          const saved = JSON.parse(await readFile(marker, 'utf8'));
          await writeFile(marker, JSON.stringify({ ...saved, policy: 'f'.repeat(64) }));
        }
      };
      try {
        await assert.rejects(f.invoke(), { code });
        assert.equal((await f.state()).checkpoints.ios['ios-attach'], undefined);
        assert.ok(f.requests.length > 0 && f.requests.every(request => request.method === 'GET'));
      } finally {
        await restoreOwner?.();
        await lease.release();
      }
    });
  }
});

test('managed attach refuses unsettled lifecycle history before provider access', async t => {
  const f = await attachFixture(t, { managed: true });
  const lifecycle = await enableResourceLifecycle(f, 'checks');
  const maintenance = await acquireMaintenance(lifecycle.coordinationAnchor, { operation: 'record synthetic interrupted task' });
  try {
    const ledger = await readResourceLedger(f.store);
    const id = '11111111-1111-4111-8111-111111111111';
    ledger.state.tasks[id] = { id, releaseId: f.plan.id, source: f.plan.source, operation: 'execute',
      state: 'active', owner: maintenance.owner.token, phase: 'execute', reservedBytes: 1 };
    await appendResourceState(f.store, ledger, () => maintenance.assertOwnership());
  } finally {
    await maintenance.release();
  }
  const lease = await acquireActivity(lifecycle.coordinationAnchor, { operation: 'synthetic attach before recovery' });
  try {
    f.options.resourceLifecycle = lifecycle;
    f.options.resourceLease = lease;
    await assert.rejects(f.invoke(), { code: 'RESOURCE_OWNERSHIP' });
    assert.deepEqual(f.requests, []);
    assert.equal((await f.state()).checkpoints.ios['ios-attach'], undefined);
  } finally {
    await lease.release();
  }
});

test('managed attach derives the same continuous guard from an existing heavy session', async t => {
  for (const [variant, code] of [['owner-replaced', 'COORDINATION_INVALID'], ['marker-changed', 'RESOURCE_COMPATIBILITY']]) {
    await t.test(variant, async t => {
      const f = await attachFixture(t, { managed: true });
      const lifecycle = await enableResourceLifecycle(f, 'checks');
      const lease = await acquireActivity(lifecycle.coordinationAnchor, { operation: 'synthetic managed parent' });
      const marker = join(f.store, 'resources', 'feature.json');
      const markerBytes = await readFile(marker);
      let restoreOwner;
      f.remote.onFreshBuild = async () => {
        if (variant === 'owner-replaced') {
          restoreOwner = await displaceActivityRecord(f, lifecycle, lease, { replace: true });
        } else {
          await writeFile(marker, JSON.stringify({ ...JSON.parse(markerBytes), policy: 'f'.repeat(64) }));
        }
      };
      try {
        await lifecycle.run({ plan: f.plan, operation: 'execute', lease, execute: async resourceSession => {
          try {
            const runner = createRunner({ ...f.options, resourceSession });
            await assert.rejects(runner.attachBuild(f.plan, { versionId: 'manual-draft' }), { code });
            assert.equal((await f.state()).checkpoints.ios['ios-attach'], undefined);
            assert.ok(f.requests.length > 0 && f.requests.every(request => request.method === 'GET'));
          } finally {
            await restoreOwner?.();
            if (variant === 'marker-changed') await writeFile(marker, markerBytes);
          }
        } });
      } finally {
        await lease.release();
      }
    });
  }
});

test('managed attach keeps intent when its activity ends after the write and reconciles under a fresh lease', async t => {
  const f = await attachFixture(t, { managed: true });
  const lifecycle = await enableResourceLifecycle(f, 'checks');
  const lease = await acquireActivity(lifecycle.coordinationAnchor, { operation: 'synthetic interrupted write' });
  f.options.resourceLifecycle = lifecycle;
  f.options.resourceLease = lease;
  let restoreOwner;
  f.remote.onPatch = async () => {
    f.remote.selected = 'apple-build';
    restoreOwner = await displaceActivityRecord(f, lifecycle, lease);
    return new Response(null, { status: 204 });
  };
  try {
    await assert.rejects(f.invoke(), { code: 'COORDINATION_INVALID' });
    assert.equal((await f.state()).checkpoints.ios['ios-attach'].state, 'intent');
  } finally {
    await restoreOwner?.();
    await lease.release();
  }

  const recovery = await acquireActivity(lifecycle.coordinationAnchor, { operation: 'synthetic reconciliation' });
  try {
    f.options.resourceLease = recovery;
    const attached = await f.invoke();
    assert.equal(attached.exit, 0);
    assert.equal(attached.report.writeAttempted, false);
    assert.equal((await f.state()).checkpoints.ios['ios-attach'].state, 'attached');
    assert.equal(f.requests.filter(request => request.method === 'PATCH').length, 1);
  } finally {
    await recovery.release();
  }
});

test('managed attach checks ownership again after saving intent and before PATCH dispatch', async t => {
  const f = await attachFixture(t, { managed: true });
  const lifecycle = await enableResourceLifecycle(f, 'checks');
  const lease = await acquireActivity(lifecycle.coordinationAnchor, { operation: 'synthetic pre-dispatch loss' });
  f.options.resourceLifecycle = lifecycle;
  f.options.resourceLease = lease;
  const check = lease.assertOwnership;
  let restoreOwner;
  lease.assertOwnership = async options => {
    if (!restoreOwner && (await f.state()).checkpoints.ios['ios-attach']?.state === 'intent' &&
        f.requests.every(request => request.method === 'GET'))
      restoreOwner = await displaceActivityRecord(f, lifecycle, lease);
    return check(options);
  };
  try {
    await assert.rejects(f.invoke(), { code: 'COORDINATION_INVALID' });
    assert.equal((await f.state()).checkpoints.ios['ios-attach'].state, 'intent');
    assert.ok(f.requests.length > 0 && f.requests.every(request => request.method === 'GET'));
  } finally {
    await restoreOwner?.();
    await lease.release();
  }
  const recovery = await acquireActivity(lifecycle.coordinationAnchor, { operation: 'synthetic read-only reconciliation' });
  try {
    f.options.resourceLease = recovery;
    const result = await f.invoke();
    assert.equal(result.exit, 2);
    assert.equal(result.report.writeAttempted, false);
    assert.ok(f.requests.every(request => request.method === 'GET'));
  } finally {
    await recovery.release();
  }
});

test('managed attach retains activity even when a heavy callback catches uncertain source cleanup', async t => {
  for (const nested of [false, true]) await t.test(nested ? 'existing heavy task' : 'standalone', async t => {
    const f = await attachFixture(t, { managed: true });
    const lifecycle = await enableResourceLifecycle(f, 'checks');
    const lease = await acquireActivity(lifecycle.coordinationAnchor, { operation: 'synthetic uncertain source cleanup' });
    f.options.resourceLifecycle = lifecycle;
    f.options.resourceLease = lease;
    const command = f.options.command;
    f.options.command = async (binary, args, options) => {
      if (binary === 'git' && args[0] === 'ls-remote') throw cleanupError();
      return command(binary, args, options);
    };
    if (nested) {
      await assert.rejects(lifecycle.run({ plan: f.plan, operation: 'execute', lease,
        execute: async resourceSession => {
          const runner = createRunner({ ...f.options, resourceSession });
          await assert.rejects(runner.attachBuild(f.plan, { versionId: 'manual-draft' }), { cleanupIncomplete: true });
          return { state: 'uploaded' };
        },
        settle: async ({ error }) => assert.equal(error?.cleanupIncomplete, true),
      }), { cleanupIncomplete: true });
      const tasks = Object.values((await readResourceLedger(f.store)).state.tasks);
      assert.deepEqual(tasks.map(task => task.state), ['active']);
    } else {
      await assert.rejects(f.invoke(), { cleanupIncomplete: true });
    }
    assert.equal(lease.retained, true);
    await assertCoordinationOwner(lifecycle.coordinationAnchor, lease.owner, 'activity');
    await assert.rejects(acquireMaintenance(lifecycle.coordinationAnchor, { operation: 'synthetic maintenance' }),
      { code: 'COORDINATION_BUSY' });
    assert.equal((await f.state()).checkpoints.ios['ios-attach'], undefined);
    assert.ok(f.requests.length > 0 && f.requests.every(request => request.method === 'GET'));
  });
});

test('an explicitly borrowed attachment protects activity across its caller boundary', async t => {
  for (const detached of [false, true]) await t.test(detached ? 'early return' : 'caught error', async t => {
    const f = await attachFixture(t, { managed: true });
    const lifecycle = await enableResourceLifecycle(f, 'checks');
    const lease = await acquireActivity(lifecycle.coordinationAnchor, { operation: 'synthetic explicit attachment' });
    const started = Promise.withResolvers();
    const resume = Promise.withResolvers();
    const command = f.options.command;
    f.options.command = async (binary, args, options) => {
      if (binary === 'git' && args[0] === 'ls-remote') {
        started.resolve();
        if (detached) await resume.promise;
        throw cleanupError();
      }
      return command(binary, args, options);
    };
    let attachment;
    try {
      await lifecycle.admitAttach({ plan: f.plan, lease, execute: async resourceSession => {
        const runner = createRunner({ ...f.options, resourceSession });
        attachment = runner.attachBuild(f.plan, { versionId: 'manual-draft' });
        if (detached) await Promise.race([started.promise, attachment]);
        else await assert.rejects(attachment, { cleanupIncomplete: true });
      } });
      if (detached) await assert.rejects(lease.release(), /borrowed by an active operation/);
    } finally {
      resume.resolve();
      await assert.rejects(attachment, { cleanupIncomplete: true });
    }
    await assert.rejects(lease.release(), { cleanupIncomplete: true });
    await assertCoordinationOwner(lifecycle.coordinationAnchor, lease.owner, 'activity');
    await assert.rejects(acquireMaintenance(lifecycle.coordinationAnchor, { operation: 'synthetic maintenance' }),
      { code: 'COORDINATION_BUSY' });
    assert.equal((await f.state()).checkpoints.ios['ios-attach'], undefined);
    assert.ok(f.requests.length > 0 && f.requests.every(request => request.method === 'GET'));
  });
});

test('a heavy task returning before its attachment finishes keeps the task and lease active', async t => {
  const f = await attachFixture(t, { managed: true });
  const lifecycle = await enableResourceLifecycle(f, 'checks');
  const lease = await acquireActivity(lifecycle.coordinationAnchor, { operation: 'synthetic detached attachment' });
  const started = Promise.withResolvers();
  const resume = Promise.withResolvers();
  const command = f.options.command;
  f.options.command = async (binary, args, options) => {
    if (binary === 'git' && args[0] === 'ls-remote') {
      started.resolve();
      await resume.promise;
      throw cleanupError();
    }
    return command(binary, args, options);
  };
  let attachment;
  let settled = false;
  try {
    await assert.rejects(lifecycle.run({ plan: f.plan, operation: 'execute', lease,
      execute: async resourceSession => {
        const runner = createRunner({ ...f.options, resourceSession });
        attachment = runner.attachBuild(f.plan, { versionId: 'manual-draft' });
        await Promise.race([started.promise, attachment]);
        return { state: 'uploaded' };
      },
      settle: async () => { settled = true; },
    }), { code: 'RESOURCE_OWNERSHIP', cleanupIncomplete: true });
    assert.equal(settled, false);
    assert.equal(lease.retained, true);
    const tasks = Object.values((await readResourceLedger(f.store)).state.tasks);
    assert.deepEqual(tasks.map(task => task.state), ['active']);
    await assert.rejects(acquireMaintenance(lifecycle.coordinationAnchor, { operation: 'synthetic maintenance' }),
      { code: 'COORDINATION_BUSY' });
  } finally {
    resume.resolve();
    await assert.rejects(attachment, { cleanupIncomplete: true });
  }
  assert.equal((await f.state()).checkpoints.ios['ios-attach'], undefined);
  assert.ok(f.requests.length > 0 && f.requests.every(request => request.method === 'GET'));
});

test('a heavy task cannot settle after starting attachment but before asynchronous admission', async t => {
  const f = await attachFixture(t, { managed: true });
  const lifecycle = await enableResourceLifecycle(f, 'checks');
  const lease = await acquireActivity(lifecycle.coordinationAnchor, { operation: 'synthetic early parent return' });
  let attachment;
  let settled = false;
  try {
    await assert.rejects(lifecycle.run({ plan: f.plan, operation: 'execute', lease,
      execute: resourceSession => {
        const runner = createRunner({ ...f.options, resourceSession });
        attachment = runner.attachBuild(f.plan, { versionId: 'manual-draft' });
        attachment.catch(() => {});
        return { state: 'uploaded' };
      },
      settle: async () => { settled = true; },
    }), { code: 'RESOURCE_OWNERSHIP', cleanupIncomplete: true });
    assert.equal(settled, false);
    assert.equal(lease.retained, true);
    const tasks = Object.values((await readResourceLedger(f.store)).state.tasks);
    assert.deepEqual(tasks.map(task => task.state), ['active']);
  } finally {
    await assert.rejects(attachment, /admission|ownership|lease/i);
  }
  assert.equal((await f.state()).checkpoints.ios['ios-attach'], undefined);
  assert.deepEqual(f.requests, []);
});

test('managed attach cannot dispatch PATCH when its parent returns during the final ownership check', async t => {
  const f = await attachFixture(t, { managed: true });
  const lifecycle = await enableResourceLifecycle(f, 'checks');
  const lease = await acquireActivity(lifecycle.coordinationAnchor, { operation: 'synthetic parent return before dispatch' });
  const verified = Promise.withResolvers();
  const resume = Promise.withResolvers();
  const check = lease.assertOwnership;
  lease.assertOwnership = async options => {
    await check(options);
    if ((await f.state()).checkpoints.ios['ios-attach']?.state === 'intent') {
      verified.resolve();
      await resume.promise;
    }
  };
  let attachment;
  try {
    await assert.rejects(lifecycle.run({ plan: f.plan, operation: 'execute', lease,
      execute: async resourceSession => {
        const runner = createRunner({ ...f.options, resourceSession });
        attachment = runner.attachBuild(f.plan, { versionId: 'manual-draft' });
        await Promise.race([verified.promise, attachment]);
        return { state: 'uploaded' };
      },
    }), { code: 'RESOURCE_OWNERSHIP', cleanupIncomplete: true });
    assert.equal(lease.retained, true);
    const tasks = Object.values((await readResourceLedger(f.store)).state.tasks);
    assert.deepEqual(tasks.map(task => task.state), ['active']);
  } finally {
    resume.resolve();
    await assert.rejects(attachment, { code: 'RESOURCE_ADMISSION' });
  }
  assert.equal((await f.state()).checkpoints.ios['ios-attach'].state, 'intent');
  assert.ok(f.requests.length > 0 && f.requests.every(request => request.method === 'GET'));
});

test('attachment checks local admission at fetch after the Apple token resolves', async t => {
  const f = await attachFixture(t);
  const state = await f.state();
  let active = true;
  const ctx = {
    platform: 'ios', plan: f.plan, config: f.config, artifact: state.artifacts.ios,
    env: f.options.environment, uploadRequested: true, publicationRequested: false,
    previous: state.checkpoints.ios,
    assertPublicationSource: async () => {},
    assertAttachmentCurrent() {
      if (!active) throw new Error('Synthetic attachment admission expired');
    },
    now() {
      // Revoke after the token callback begins, before the awaiting transport resumes.
      if (state.checkpoints.ios['ios-attach']?.state === 'intent') queueMicrotask(() => { active = false; });
      return Date.now();
    },
    async checkpoint(name, evidence) {
      state.checkpoints.ios[name] = evidence;
      await saveState(releasePath(f.store, f.plan.id), state);
    },
  };
  await assert.rejects(attachStoreBuild(ctx, { versionId: 'manual-draft' }), /attachment admission expired/);
  assert.equal((await f.state()).checkpoints.ios['ios-attach'].state, 'intent');
  assert.ok(f.requests.length > 0 && f.requests.every(request => request.method === 'GET'));
});

function pauseAttachmentCheckpoint(t, f, checkpoint) {
  const staged = Promise.withResolvers();
  const publish = Promise.withResolvers();
  const events = join(releasePath(f.store, f.plan.id), 'events');
  const open = fs.open;
  const mocked = t.mock.method(fs, 'open', async (file, ...args) => {
    const handle = await open(file, ...args);
    if (typeof file === 'string' && file.startsWith(events + '/') && file.endsWith('.tmp')) {
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        await sync();
        const event = JSON.parse(await readFile(file, 'utf8'));
        if (event.state.checkpoints.ios['ios-attach']?.state === checkpoint) {
          staged.resolve();
          await publish.promise;
        }
      };
    }
    return handle;
  });
  syncBuiltinESMExports();
  return { events, staged: staged.promise, resume: publish.resolve,
    restore() { mocked.mock.restore(); syncBuiltinESMExports(); } };
}

test('managed attachment cannot commit a staged checkpoint after its parent returns', async t => {
  for (const checkpoint of ['intent', 'attached']) await t.test(checkpoint, async t => {
    const f = await attachFixture(t, { managed: true });
    const lifecycle = await enableResourceLifecycle(f, 'checks');
    const lease = await acquireActivity(lifecycle.coordinationAnchor, { operation: 'synthetic staged attachment' });
    const checkpointPause = pauseAttachmentCheckpoint(t, f, checkpoint);
    let attachment;
    try {
      await assert.rejects(lifecycle.run({ plan: f.plan, operation: 'execute', lease,
        execute: async resourceSession => {
          const runner = createRunner({ ...f.options, resourceSession });
          attachment = runner.attachBuild(f.plan, { versionId: 'manual-draft' });
          await Promise.race([checkpointPause.staged, attachment]);
          return { state: 'uploaded' };
        },
      }), { code: 'RESOURCE_OWNERSHIP', cleanupIncomplete: true });
      assert.equal(lease.retained, true);
      const tasks = Object.values((await readResourceLedger(f.store)).state.tasks);
      assert.deepEqual(tasks.map(task => task.state), ['active']);
    } finally {
      checkpointPause.resume();
      try { await assert.rejects(attachment, { code: 'RESOURCE_ADMISSION' }); }
      finally { checkpointPause.restore(); }
    }
    const saved = (await f.state()).checkpoints.ios['ios-attach'];
    assert.equal(saved?.state, checkpoint === 'intent' ? undefined : 'intent');
    assert.equal(f.requests.filter(request => request.method === 'PATCH').length, checkpoint === 'intent' ? 0 : 1);
    assert.ok((await readdir(checkpointPause.events)).every(file => !file.endsWith('.tmp')));
  });
});

test('cancelling managed attach before intent commit leaves no pending attachment', async t => {
  const f = await attachFixture(t, { managed: true });
  const lifecycle = await enableResourceLifecycle(f, 'checks');
  const lease = await acquireActivity(lifecycle.coordinationAnchor, { operation: 'synthetic attach cancellation' });
  f.options.resourceLifecycle = lifecycle;
  f.options.resourceLease = lease;
  const checkpointPause = pauseAttachmentCheckpoint(t, f, 'intent');
  const controller = new AbortController();
  const attachment = f.invoke([], controller.signal);
  try {
    await Promise.race([checkpointPause.staged, attachment]);
    controller.abort();
    checkpointPause.resume();
    assert.equal((await attachment).exit, 130);
    assert.equal((await f.state()).checkpoints.ios['ios-attach'], undefined);
    assert.ok(f.requests.length > 0 && f.requests.every(request => request.method === 'GET'));
    assert.ok((await readdir(checkpointPause.events)).every(file => !file.endsWith('.tmp')));
  } finally {
    checkpointPause.resume();
    checkpointPause.restore();
    await lease.release();
  }
});

test('cancelling the lifecycle signal alone stops attachment commit and transport', async t => {
  for (const dispatch of [false, true]) await t.test(dispatch ? 'transport' : 'intent', async t => {
    const f = await attachFixture(t, { managed: true });
    const controller = new AbortController();
    const lifecycle = await enableResourceLifecycle(f, 'checks', 8, controller.signal);
    const lease = await acquireActivity(lifecycle.coordinationAnchor, { operation: 'synthetic lifecycle cancellation' });
    const pause = dispatch ? null : pauseAttachmentCheckpoint(t, f, 'intent');
    const verified = Promise.withResolvers();
    const resume = Promise.withResolvers();
    if (dispatch) {
      const check = lease.assertOwnership;
      lease.assertOwnership = async options => {
        await check(options);
        if ((await f.state()).checkpoints.ios['ios-attach']?.state === 'intent') {
          verified.resolve();
          await resume.promise;
        }
      };
    }
    const attachment = lifecycle.run({ plan: f.plan, operation: 'execute', lease,
      execute: resourceSession => createRunner({ ...f.options, resourceSession })
        .attachBuild(f.plan, { versionId: 'manual-draft' }),
    });
    try {
      await Promise.race([pause?.staged ?? verified.promise, attachment]);
      controller.abort();
      pause?.resume();
      resume.resolve();
      await assert.rejects(attachment, { name: 'AbortError' });
      assert.equal((await f.state()).checkpoints.ios['ios-attach']?.state, dispatch ? 'intent' : undefined);
      assert.ok(f.requests.length > 0 && f.requests.every(request => request.method === 'GET'));
    } finally {
      pause?.resume();
      resume.resolve();
      pause?.restore();
      await lease.release();
    }
  });
});

test('after the parent returns attachment starts no further source or content command, journal append or PATCH', async t => {
  for (const phase of ['ls-remote', 'status', 'prepared content']) await t.test(phase, async t => {
    const f = await attachFixture(t, { managed: true, prepared: phase === 'prepared content' });
    const step = phase === 'ls-remote' ? 'ls-remote' : 'status';
    const lifecycle = await enableResourceLifecycle(f, 'checks');
    const lease = await acquireActivity(lifecycle.coordinationAnchor, { operation: 'synthetic deferred source verification' });
    const events = join(releasePath(f.store, f.plan.id), 'events');
    const before = (await readdir(events)).sort();
    const checked = Promise.withResolvers();
    const resume = Promise.withResolvers();
    const command = f.options.command;
    const commands = [];
    f.options.command = async (binary, args, options) => {
      commands.push(args[0]);
      const result = await command(binary, args, options);
      if (binary === 'git' && args[0] === step && (step !== 'status' || options.cwd.endsWith('/build-ios'))) {
        checked.resolve();
        await resume.promise;
      }
      return result;
    };
    let attachment;
    let commandCount;
    try {
      await assert.rejects(lifecycle.run({ plan: f.plan, operation: 'execute', lease,
        execute: async resourceSession => {
          const runner = createRunner({ ...f.options, resourceSession });
          attachment = runner.attachBuild(f.plan, { versionId: 'manual-draft' });
          await Promise.race([checked.promise, attachment]);
          commandCount = commands.length;
          return { state: 'uploaded' };
        },
      }), { code: 'RESOURCE_OWNERSHIP', cleanupIncomplete: true });
    } finally {
      resume.resolve();
      await assert.rejects(attachment, { code: 'RESOURCE_ADMISSION' });
    }
    assert.equal(commands.length, commandCount);
    assert.equal(lease.retained, true);
    assert.deepEqual(Object.values((await readResourceLedger(f.store)).state.tasks).map(task => task.state), ['active']);
    assert.deepEqual((await readdir(events)).sort(), before);
    assert.ok(f.requests.length > 0 && f.requests.every(request => request.method === 'GET'));
  });
});

test('managed attachment keeps confirmation but rejects success when its parent returns during lock cleanup', async t => {
  const f = await attachFixture(t, { managed: true });
  const lifecycle = await enableResourceLifecycle(f, 'checks');
  const lease = await acquireActivity(lifecycle.coordinationAnchor, { operation: 'synthetic attach teardown' });
  const releasing = Promise.withResolvers();
  const resume = Promise.withResolvers();
  const target = digest({ appId: 'example.synthetic', platform: 'ios', destination: 'app-store' });
  const path = join(f.store, 'locks', `target-${target}.lock`);
  const unlink = fs.unlink;
  const mocked = t.mock.method(fs, 'unlink', async file => {
    if (file === path) {
      releasing.resolve();
      await resume.promise;
    }
    return unlink(file);
  });
  syncBuiltinESMExports();
  let attachment;
  try {
    await assert.rejects(lifecycle.run({ plan: f.plan, operation: 'execute', lease,
      execute: async resourceSession => {
        const runner = createRunner({ ...f.options, resourceSession });
        attachment = runner.attachBuild(f.plan, { versionId: 'manual-draft' });
        await Promise.race([releasing.promise, attachment]);
        return { state: 'uploaded' };
      },
    }), { code: 'RESOURCE_OWNERSHIP', cleanupIncomplete: true });
    assert.equal((await f.state()).checkpoints.ios['ios-attach'].state, 'attached');
    assert.equal(lease.retained, true);
  } finally {
    resume.resolve();
    try { await assert.rejects(attachment, { code: 'RESOURCE_ADMISSION' }); }
    finally { mocked.mock.restore(); syncBuiltinESMExports(); }
  }
  assert.equal((await f.state()).checkpoints.ios['ios-attach'].state, 'attached');
  assert.equal(f.requests.filter(request => request.method === 'PATCH').length, 1);
});

test('attachment preserves the existing confirmed unsubmitted-upload handoff boundary', async t => {
  const variants = ['confirmed', 'cleared', 'pending', 'pending-terminal', 'replacement-draft',
    'stale-selection', 'stale-review-state', 'omitted-draft', 'deleted-draft', 'confirmed-terminal', 'stale-terminal'];
  for (const variant of variants) await t.test(variant, async t => {
    const f = await attachFixture(t);
    const pending = variant.startsWith('pending');
    if (pending) f.remote.onPatch = () => new Response(null, { status: 204 });
    assert.equal((await f.invoke()).exit, pending ? 2 : 0);
    if (variant === 'replacement-draft') f.remote.versionId = 'other-draft';
    if (variant === 'cleared') f.remote.selected = null;
    if (variant === 'stale-selection') f.remote.linkageSelected = 'another-build';
    if (variant === 'stale-review-state') f.remote.snapshotState = 'WAITING_FOR_REVIEW';
    if (variant === 'omitted-draft') {
      f.remote.inventoryMissing = true;
      f.remote.selected = 'another-build';
    }
    if (variant === 'deleted-draft') {
      f.remote.inventoryMissing = true;
      f.remote.draftDeleted = true;
      f.remote.selected = null;
    }
    const canSupersede = ['confirmed', 'cleared', 'deleted-draft'].includes(variant);
    const canHandOff = canSupersede || variant === 'confirmed-terminal';
    f.adapters.ios.status = statusStore;
    if (variant === 'pending-terminal') {
      f.remote.processing = 'INVALID';
      await f.cli(['status', f.plan.id, '--remote']);
      assert.equal((await f.state()).outcomes.ios.state, 'rejected');
    }
    if (['confirmed-terminal', 'stale-terminal'].includes(variant)) {
      f.remote.state = 'REJECTED';
      await f.cli(['status', f.plan.id, '--remote']);
      assert.equal((await f.state()).outcomes.ios.state, 'rejected');
      if (variant === 'stale-terminal') {
        f.remote.snapshotState = 'WAITING_FOR_REVIEW';
        const observed = await f.adapters.ios.status({
          platform: 'ios', artifact: (await f.state()).artifacts.ios, plan: f.plan,
          config: f.config, env: f.options.environment, previous: (await f.state()).checkpoints.ios,
        });
        assert.equal(observed.state, 'unknown');
      }
    }
    await runCommand('git', ['commit', '--allow-empty', '-qm', 'newer source'], { cwd: f.repo });
    const build = f.adapters.ios.build;
    f.adapters.ios.build = async ctx => ({ ...await build(ctx), buildNumber: '2' });
    const next = await createPlan({ repo: f.repo, ref: 'HEAD', platforms: ['ios'], config: f.config });
    const built = await f.runner().execute(next);
    await f.runner().execute(next, { acceptance: await f.receipts(built) });
    const readsBefore = f.requests.length;
    const result = await f.runner().execute(next, { uploadOnly: true });
    const previous = await f.state();
    if (f.remote.inventoryMissing)
      assert.ok(f.requests.slice(readsBefore).some(request =>
        request.method === 'GET' && request.path === '/v1/appStoreVersions/manual-draft'));

    if (canHandOff) {
      assert.equal(result.outcomes.ios.state, 'uploaded');
      if (canSupersede) {
        assert.equal(previous.supersededBy.ios.releaseId, next.id);
        assert.equal(result.supersessions[0].reason, 'confirmed-unsubmitted-upload');
      }
    } else {
      assert.equal(result.outcomes.ios.state, 'blocked');
      assert.equal(previous.supersededBy, undefined);
      assert.equal(result.checkpoints.ios?.['ios-upload'], undefined);
    }
    assert.equal(previous.checkpoints.ios['ios-attach'].state, pending ? 'intent' : 'attached');
    assert.equal(JSON.parse(await readFile(f.owner, 'utf8')).id, canHandOff ? next.id : f.plan.id);
    assert.equal(f.requests.filter(request => request.method === 'PATCH').length, 1);
  });
});

test('an interrupted attachment retains intent and a new command only reads back', async t => {
  const f = await attachFixture(t);
  const controller = new AbortController();
  f.remote.onPatch = () => {
    f.remote.selected = 'apple-build';
    controller.abort();
    return new Response(null, { status: 204 });
  };
  assert.equal((await f.invoke([], controller.signal)).exit, 130);
  assert.equal((await f.state()).checkpoints.ios['ios-attach'].state, 'intent');
  const reconciled = await f.invoke();
  assert.equal(reconciled.report.writeAttempted, false);
  assert.equal(reconciled.exit, 0);
  assert.equal(f.requests.filter(r => r.method === 'PATCH').length, 1);
});

test('attach refuses stale provider identity, inactive ownership and scope expansion before a write', async t => {
  const f = await attachFixture(t);
  const before = await f.state();
  for (const args of [['--publish'], ['--remote'], ['--executor', 'auto'], ['--acceptance', 'ios=fake.json'], ['--ref', 'HEAD']])
    await assert.rejects(f.invoke(args), /existing release ID, explicit draft/);
  assert.equal(f.requests.length, 0);
  for (const [field, invalid] of [['versionId', 'other-draft'], ['selected', 'different-build'],
      ['buildId', 'different-build'], ['state', 'WAITING_FOR_REVIEW'], ['processing', 'PROCESSING'],
      ['expired', true], ['releaseType', 'AFTER_APPROVAL']]) {
    const saved = f.remote[field];
    f.remote[field] = invalid;
    await assert.rejects(f.invoke(), /refusing to replace|exact manual draft|journaled upload build/);
    f.remote[field] = saved;
  }
  f.remote.relationshipMissing = true;
  await assert.rejects(f.invoke(), /relationship is unavailable/);
  f.remote.relationshipMissing = false;
  for (const [snapshot, selection] of [['apple-build', null], [null, 'apple-build']]) {
    f.remote.snapshotSelected = snapshot;
    f.remote.selected = selection;
    await assert.rejects(f.invoke(), /inconsistent/);
    assert.equal((await f.state()).checkpoints.ios['ios-attach'], undefined);
    assert.equal(f.requests.some(request => request.method !== 'GET'), false);
  }
  f.remote.snapshotSelected = undefined;
  for (const [listed, selection] of [['apple-build', null], [null, 'apple-build']]) {
    f.remote.inventorySelected = listed;
    f.remote.selected = selection;
    await assert.rejects(f.invoke(), /inventory and direct build relationship disagree/);
    assert.equal((await f.state()).checkpoints.ios['ios-attach'], undefined);
    assert.equal(f.requests.some(request => request.method !== 'GET'), false);
  }
  f.remote.inventorySelected = undefined;
  f.remote.selected = null;
  f.remote.onFreshBuild = () => { f.remote.selected = 'different-build'; };
  await assert.rejects(f.invoke(), /different build/);
  f.remote.selected = null;
  f.remote.onFreshBuild = () => runCommand('git', ['commit', '--allow-empty', '-qm', 'new default source'], { cwd: f.repo });
  await assert.rejects(f.invoke(), /must equal the current remote default branch head/);
  f.remote.onFreshBuild = null;
  await rm(f.owner);
  const count = f.requests.length;
  await assert.rejects(f.invoke(), /Existing publication target ownership/);
  assert.equal(f.requests.length, count);
  assert.equal(f.requests.some(r => r.method !== 'GET'), false);
  const blocked = await f.state();
  assert.deepEqual(blocked.checkpoints, before.checkpoints);
  assert.equal(blocked.publicationRequested, false);
});

test('upload CLI requires an existing accepted artifact and a distinct upload hook before admitting intent', async t => {
  const f = await fixture(t, ['ios']);
  boundedAdapter(f);
  await assert.rejects(f.cli(['upload', f.plan.id]), /Unknown release/);
  await f.runner().execute(f.plan);
  const before = await f.state();
  await assert.rejects(f.cli(['upload', f.plan.id]), /passing native acceptance/);
  assert.deepEqual(await f.state(), before);
  await acceptedIos(f);
  delete f.adapters.ios.upload;
  const accepted = await f.state();
  await assert.rejects(f.cli(['upload', f.plan.id]), /explicitly support upload/);
  assert.deepEqual(await f.state(), accepted);
  assert.equal(f.calls.includes('publish-ios'), false);
  assert.equal(f.calls.includes('upload-ios'), false);
  assert.equal(f.calls.filter(x => x === 'build-ios').length, 1);
});

test('bounded upload persists across ordinary resume and only explicit publish escalates', async t => {
  const f = await fixture(t, ['ios']);
  boundedAdapter(f);
  await acceptedIos(f);
  assert.equal(await f.cli(['upload', f.plan.id]), 0);
  const uploaded = await f.state();
  assert.equal(uploaded.uploadRequested, true);
  assert.equal(uploaded.publicationRequested, false);
  assert.equal(uploaded.outcomes.ios.state, 'uploaded');
  assert.equal(uploaded.stages['publish-ios'], undefined);
  assert.equal(uploaded.checkpoints.ios['ios-review'], undefined);
  assert.equal(await f.cli(['resume', f.plan.id]), 0);
  const resumed = await f.state();
  assert.equal(resumed.uploadRequested, true);
  assert.equal(resumed.publicationRequested, false);
  assert.equal(f.calls.includes('publish-ios'), false);
  assert.equal(f.calls.filter(x => x === 'build-ios').length, 1);
  f.adapters.ios.publish = async ctx => {
    assert.equal(ctx.publicationRequested, true);
    assert.equal(ctx.previous['ios-upload'].buildId, 'owned-build');
    f.calls.push('publish-ios');
    await ctx.checkpoint('ios-review', { state: 'submitted' });
    return { state: 'submitted' };
  };
  assert.equal(await f.cli(['resume', f.plan.id, '--publish']), 0);
  assert.equal((await f.state()).publicationRequested, true);
  assert.equal(f.calls.filter(x => x === 'publish-ios').length, 1);
  const before = await f.state();
  await assert.rejects(f.cli(['upload', f.plan.id]), /cannot narrow/);
  assert.deepEqual(await f.state(), before);
});

test('bounded upload failure preserves unknown checkpoint and ownership for reconciliation', async t => {
  const f = await fixture(t, ['ios']);
  await acceptedIos(f);
  let first = true;
  f.adapters.ios.upload = async ctx => {
    f.calls.push('upload-ios');
    if (first) {
      first = false;
      await ctx.checkpoint('ios-upload', { state: 'intent' });
      throw Error('lost upload response');
    }
    assert.deepEqual(ctx.previous['ios-upload'], { state: 'intent' });
    assert.equal(ctx.publicationRequested, false);
    await ctx.checkpoint('ios-upload', { state: 'uploaded', buildId: 'reconciled' });
    return { state: 'uploaded', buildId: 'reconciled' };
  };
  assert.equal(await f.cli(['upload', f.plan.id]), 2);
  const failed = await f.state();
  assert.equal(failed.uploadRequested, true);
  assert.equal(failed.stages['upload-ios'].status, 'unknown');
  assert.deepEqual(failed.checkpoints.ios['ios-upload'], { state: 'intent' });
  assert.equal((await readdir(join(f.store, 'targets'))).length, 1);
  assert.equal(await f.cli(['resume', f.plan.id]), 0);
  assert.equal((await f.state()).checkpoints.ios['ios-upload'].buildId, 'reconciled');
  assert.equal(f.calls.includes('publish-ios'), false);
});

test('upload command rejects unsupported scheduling, broad flags and platform selections', async t => {
  const f = await fixture(t, ['ios']);
  boundedAdapter(f);
  await acceptedIos(f);
  const before = await f.state();
  for (const flags of [['--publish'], ['--ui'], ['--remote'], ['--acceptance', 'ios=x'],
    ['--executor', 'github'], ['--executor', 'auto'], ['--ref', f.plan.source]]) {
    await assert.rejects(f.cli(['upload', f.plan.id, ...flags]));
    assert.deepEqual(await f.state(), before);
  }
  const both = await fixture(t);
  const built = await both.runner().execute(both.plan);
  await both.runner().execute(both.plan, { acceptance: await both.receipts(built) });
  await assert.rejects(both.cli(['upload', both.plan.id]), /exactly one iOS/);
});

test('upload and bounded resume preserve source, artifact and UI evidence gates', async t => {
  for (const variant of ['source', 'artifact', 'ui']) {
    const f = await fixture(t, ['ios']);
    boundedAdapter(f);
    const accepted = await acceptedIos(f);
    if (variant === 'source') {
      await writeFile(join(f.repo, 'new.txt'), 'new merged source');
      await runCommand('git', ['add', '.'], { cwd: f.repo });
      await runCommand('git', ['commit', '-qm', 'new source'], { cwd: f.repo });
    } else if (variant === 'artifact') {
      await writeFile(accepted.artifacts.ios.path, 'changed');
    } else {
      await writeFile(accepted.uiValidation.evidence.path, 'changed');
    }
    if (variant === 'ui') await assert.rejects(f.cli(['upload', f.plan.id]));
    else assert.equal(await f.cli(['upload', f.plan.id]), 2);
    const state = await f.state();
    assert.equal(state.publicationRequested, false);
    assert.equal(state.checkpoints.ios?.['ios-upload'], undefined);
    assert.equal(f.calls.includes('upload-ios'), false);
    assert.equal(f.calls.includes('publish-ios'), false);
    assert.equal(f.calls.filter(x => x === 'build-ios').length, 1);
  }
});

test('bounded native-acceptance replacement can fail and recover without granting publication', async t => {
  const f = await fixture(t, ['ios']);
  boundedAdapter(f);
  const accepted = await acceptedIos(f);
  await f.cli(['upload', f.plan.id]);
  const receipts = await f.receipts(accepted);
  const good = await readFile(receipts.ios, 'utf8');
  await writeFile(receipts.ios, '{}');
  assert.equal(await f.cli(['resume', f.plan.id, '--acceptance', `ios=${receipts.ios}`]), 2);
  assert.equal((await f.state()).acceptance.ios, undefined);
  const count = f.calls.filter(x => x === 'upload-ios').length;
  await writeFile(receipts.ios, good);
  assert.equal(await f.cli(['resume', f.plan.id, '--acceptance', `ios=${receipts.ios}`]), 0);
  assert.equal(f.calls.filter(x => x === 'upload-ios').length, count + 1);
  assert.equal((await f.state()).publicationRequested, false);
});

test('bounded resume refuses dispatch before creating a request', async t => {
  const f = await fixture(t, ['ios']);
  boundedAdapter(f);
  await acceptedIos(f);
  await f.cli(['upload', f.plan.id]);
  const policy = { schemaVersion: 1, repository: 'example/synthetic', controlRepository: f.repo,
    releaseConfig: f.configPath, stateDirectory: f.store,
    github: { enabled: false, workflow: 'release-local.yml', ref: 'main',
      runnerName: 'synthetic-mac', runnerLabel: 'release-example' } };
  const policyPath = join(f.base, 'executor.json');
  await writeFile(policyPath, JSON.stringify(policy));
  await assert.rejects(f.cli(['resume', f.plan.id, '--executor', 'auto', '--executor-config', policyPath]), /local-only/);
  const inventory = await inspectDispatchRequests({ stateDirectory: f.store });
  assert.equal(inventory.requests.length, 0);
});

test('upload stage fences content writes before provider intent', async t => {
  const f = await fixture(t, ['ios']);
  boundedAdapter(f);
  await acceptedIos(f);
  const state = await f.state();
  state.uploadRequested = true;
  state.stages['upload-ios'] = { status: 'unknown', startedAt: new Date().toISOString() };
  await saveState(releasePath(f.store, f.plan.id), state);
  await assert.rejects(f.runner().prepareContent(f.plan, { mode: 'apply', approval: '0'.repeat(64) }), /only store-observe/);
});


test('confirmed same-content draft with no binary intent can transfer to a newer accepted descendant', async t => {
  for (const variant of ['same', 'changed-content', 'changed-draft', 'unknown-step', 'upload-intent', 'not-prepared', 'live-draft', 'live-content', 'source-during-read']) {
    const f = await fixture(t, ['ios']);
    f.config.stores = { ios: { contentPath: 'content.json' } };
    const manifest = { schemaVersion: 1, platform: 'ios', version: '1.0.0',
      locales: [{ locale: 'en-US', fields: { whatsNew: 'Reviewed notes' }, screenshots: [] }] };
    await writeFile(join(f.repo, 'content.json'), JSON.stringify(manifest));
    await runCommand('git', ['add', '.'], { cwd: f.repo });
    await runCommand('git', ['commit', '-qm', 'reviewed content'], { cwd: f.repo });
    f.plan = await createPlan({ repo: f.repo, ref: 'HEAD', platforms: ['ios'], config: f.config });
    f.state = () => loadState(releasePath(f.store, f.plan.id));
    const accepted = await acceptedIos(f);
    const inputDigest = (await loadStoreContent({ root: f.repo, platform: 'ios', plan: f.plan,
      config: f.config, command: runCommand })).inputDigest;
    let liveDraft = 'draft-1', liveNotes = 'Reviewed notes', providerReads = 0, advanceSource = false;
    f.adapters.ios.contentSession = async () => ({
      cfg: { appId: '123', bundleId: f.plan.appIds.ios },
      async read() {
        providerReads++;
        if (advanceSource) {
          advanceSource = false;
          await writeFile(join(f.repo, 'later.txt'), 'new default source during provider read');
          await runCommand('git', ['add', '.'], { cwd: f.repo });
          await runCommand('git', ['commit', '-qm', 'later default source'], { cwd: f.repo });
        }
        return { data: { attributes: { bundleId: f.plan.appIds.ios } } };
      },
      async list(path) {
        providerReads++;
        if (path.includes('/appStoreVersions?')) return [{ id: liveDraft,
          attributes: { versionString: '1.0.0', appStoreState: 'PREPARE_FOR_SUBMISSION' } }];
        if (path.includes('/appStoreVersionLocalizations?')) return [{ id: 'en',
          attributes: { locale: 'en-US', whatsNew: liveNotes } }];
        return [];
      },
      async write() { assert.fail('Draft continuity must be read-only'); },
    });
    accepted.storePreparation = { ios: { inputDigest, status: 'prepared',
      steps: { draft: { state: 'confirmed' }, 'text:en': { state: 'confirmed' } },
      observation: { matches: true, remote: { target: { id: 'draft-1' } } } } };
    if (variant === 'unknown-step') accepted.storePreparation.ios.steps.draft.state = 'intent';
    if (variant === 'not-prepared') accepted.storePreparation.ios.status = 'applying';
    if (variant === 'upload-intent') accepted.checkpoints.ios = { 'ios-upload': { state: 'intent' } };
    await saveState(releasePath(f.store, f.plan.id), accepted);
    const key = digest({ appId: accepted.artifacts.ios.appId, platform: 'ios', destination: 'app-store' });
    await mkdir(join(f.store, 'targets'), { recursive: true });
    await writeFile(join(f.store, 'targets', `${key}.json`), JSON.stringify({ id: f.plan.id, source: f.plan.source }));
    await writeFile(join(f.repo, 'new.txt'), 'reviewed descendant');
    await runCommand('git', ['add', '.'], { cwd: f.repo });
    await runCommand('git', ['commit', '-qm', 'reviewed descendant'], { cwd: f.repo });
    const plan = await createPlan({ repo: f.repo, ref: 'HEAD', platforms: ['ios'], config: f.config });
    const build = f.adapters.ios.build;
    f.adapters.ios.build = async ctx => ({ ...await build(ctx), buildNumber: '2' });
    const built = await f.runner().execute(plan);
    await f.runner().execute(plan, { acceptance: await f.receipts(built) });
    const next = await loadState(releasePath(f.store, plan.id));
    next.storePreparation = { ios: { inputDigest: variant === 'changed-content' ? 'c'.repeat(64) : inputDigest,
      status: 'planned', steps: {}, proposal: { before: { target: { id: variant === 'changed-draft' ? 'draft-2' : 'draft-1' } } } } };
    await saveState(releasePath(f.store, plan.id), next);
    boundedAdapter(f);
    if (variant === 'live-draft') liveDraft = 'replacement-same-content';
    if (variant === 'live-content') liveNotes = 'External edit after saved snapshots';
    if (variant === 'source-during-read') advanceSource = true;
    const result = await f.runner().execute(plan, { uploadOnly: true });
    const old = await f.state();
    if (variant === 'same') {
      assert.equal(result.outcomes.ios.state, 'uploaded');
      assert.equal(old.outcomes.ios.state, 'superseded');
      assert.equal(old.supersededBy.ios.releaseId, plan.id);
      assert.equal(result.supersessions[0].reason, 'confirmed-prepared-draft-no-upload');
      assert.equal(result.supersessions[0].preparedContent.versionId, 'draft-1');
      assert.ok(providerReads > 0);
      assert.ok(result.supersessions[0].preparedContent.observedAt);
      assert.deepEqual(old.storePreparation, accepted.storePreparation);
      assert.equal(old.checkpoints.ios?.['ios-upload'], undefined);
      assert.equal((await f.runner().execute(f.plan)).outcomes.ios.state, 'blocked');
    } else {
      assert.equal(result.outcomes.ios.state, 'blocked', variant);
      assert.equal(old.supersededBy, undefined, variant);
      assert.equal(f.calls.includes('upload-ios'), false, variant);
      assert.deepEqual(old.storePreparation, accepted.storePreparation, variant);
      assert.equal(result.checkpoints.ios?.['ios-upload'], undefined, variant);
      if (variant.startsWith('live-') || variant === 'source-during-read') assert.ok(providerReads > 0);
      assert.equal(JSON.parse(await readFile(join(f.store, 'targets', `${key}.json`), 'utf8')).id, f.plan.id);
    }
    assert.equal(f.calls.includes('publish-ios'), false);
  }
});

test('prepared draft, bounded upload and attach retain one draft and separate provider effects', async t => {
  for (const driftAfterOwnership of [false, true]) {
    const f = await fixture(t, ['ios']);
    f.config.stores = { ios: { contentPath: 'content.json', metadataPath: 'metadata',
      appId: '123', bundleId: 'example.synthetic', apiKeyPathEnv: 'SYNTHETIC_STORE_KEY' } };
    await mkdir(join(f.repo, 'metadata'));
    await writeFile(join(f.repo, 'metadata', 'README.txt'), 'Synthetic saved listing');
    await writeFile(join(f.repo, 'content.json'), JSON.stringify({ schemaVersion: 1,
      platform: 'ios', version: '1.0.0', locales: [{ locale: 'en-US',
        fields: { whatsNew: 'Reviewed notes' }, screenshots: [] }] }));
    await runCommand('git', ['add', '.'], { cwd: f.repo });
    await runCommand('git', ['commit', '-qm', 'synthetic listing inputs'], { cwd: f.repo });
    f.plan = await createPlan({ repo: f.repo, ref: 'HEAD', platforms: ['ios'], config: f.config });
    const keyPath = join(f.base, 'synthetic-key.json');
    const key = generateKeyPairSync('ec', { namedCurve: 'prime256v1',
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey;
    await writeFile(keyPath, JSON.stringify({ key_id: 'synthetic', issuer_id: 'synthetic', key }));
    f.options.environment = { ...process.env, SYNTHETIC_STORE_KEY: keyPath };
    const remote = { notes: 'Old notes', uploaded: false, selection: null };
    let attachAllowed = false;
    const version = () => ({ id: 'retained-draft', type: 'appStoreVersions', attributes: {
      versionString: '1.0.0', appStoreState: 'PREPARE_FOR_SUBMISSION', releaseType: 'MANUAL', platform: 'IOS',
    }, relationships: { build: { data: remote.selection } } });
    const locale = () => ({ id: 'en', attributes: { locale: 'en-US', whatsNew: remote.notes,
      description: 'Saved description', keywords: 'synthetic', supportUrl: 'https://example.invalid' } });
    const sets = [{ id: 'saved-set', attributes: { screenshotDisplayType: 'APP_IPHONE_67' } }];
    const images = [{ id: 'saved-image', attributes: { assetDeliveryState: { state: 'COMPLETE' } } }];
    let successor, drifted = false;
    const effects = [], reads = [];
    const targetKey = digest({ appId: 'example.synthetic', platform: 'ios', destination: 'app-store' });
    const targetPath = join(f.store, 'targets', `${targetKey}.json`);
    const api = {
      cfg: { appId: '123', bundleId: 'example.synthetic' },
      async read(path) {
        assert.equal(path, '/v1/apps/123');
        return { data: { attributes: { bundleId: 'example.synthetic' } } };
      },
      async list(path) {
        reads.push(path);
        if (driftAfterOwnership && successor && !drifted &&
            JSON.parse(await readFile(targetPath, 'utf8')).id === successor.id) {
          remote.notes = 'External edit after ownership';
          drifted = true;
        }
        if (path.includes('/appStoreVersions?')) return [version()];
        if (path.includes('/appStoreVersionLocalizations?')) return [locale()];
        if (path.includes('/appInfos?')) return [];
        if (path.includes('/appScreenshotSets?')) return sets;
        if (path.includes('/appScreenshots?')) return images;
        throw Error(`Unexpected content read ${path}`);
      },
      async write(method, path, body) {
        assert.equal(method, 'PATCH');
        assert.equal(path, '/v1/appStoreVersionLocalizations/en');
        const owner = JSON.parse(await readFile(targetPath, 'utf8'));
        const state = await loadState(releasePath(f.store, owner.id));
        assert.equal(state.storePreparation.ios.steps['text:en-US'].state, 'intent');
        effects.push('listing-text');
        remote.notes = body.data.attributes.whatsNew;
        return null;
      },
    };
    f.adapters.ios.contentSession = async () => api;
    const provider = async (url, options) => {
      const pathname = new URL(url).pathname;
      const relationship = '/v1/appStoreVersions/retained-draft/relationships/build';
      if (options.method === 'PATCH' && attachAllowed) {
        assert.equal(pathname, relationship);
        const state = await loadState(releasePath(f.store, successor.id));
        assert.equal(state.checkpoints.ios['ios-attach'].state, 'intent');
        const data = JSON.parse(options.body).data;
        assert.deepEqual(data, { type: 'builds', id: 'uploaded-build' });
        effects.push('build-linkage');
        remote.selection = data;
        return new Response(null, { status: 204 });
      }
      assert.ok(!options.method || options.method === 'GET', 'only attach may write the build linkage');
      reads.push(url);
      const ok = (data, included = []) => ({ ok: true, status: 200, json: async () => ({ data, included }) });
      if (url.endsWith('/v1/apps/123')) return ok({ attributes: { bundleId: 'example.synthetic' } });
      if (pathname === relationship) return ok(remote.selection);
      if (pathname === '/v1/appStoreVersions/retained-draft') return ok(version());
      if (url.includes('/appStoreVersions?')) return ok([version()]);
      if (url.includes('/appInfos?')) return ok([]);
      if (url.includes('/appStoreVersionLocalizations?')) return ok([locale()]);
      if (url.includes('/appScreenshotSets?')) return ok(sets);
      if (url.includes('/appScreenshots?')) return ok(images);
      if (url.endsWith('/appStoreReviewDetail')) return ok({ attributes: { contactFirstName: 'Synthetic',
        contactLastName: 'Contact', contactPhone: '000', contactEmail: 'test@example.invalid', demoAccountRequired: false } });
      if (url.includes('/buildUploads?')) return ok([]);
      const build = { id: 'uploaded-build', type: 'builds',
        attributes: { version: '2', processingState: 'VALID', expired: false },
        relationships: { preReleaseVersion: { data: { id: 'pre-version' } } } };
      if (pathname === '/v1/builds/uploaded-build') return ok(build);
      if (url.includes('/v1/builds?')) return ok(remote.uploaded ? [build] : [],
        [{ id: 'pre-version', type: 'preReleaseVersions', attributes: { version: '1.0.0', platform: 'IOS' } }]);
      throw Error(`Unexpected upload read ${url}`);
    };
    f.options.command = async (binary, args, options) => {
      if (binary !== 'fastlane') return runCommand(binary, args, options);
      assert.deepEqual(args.slice(0, 2), ['pilot', 'upload']);
      const state = await loadState(releasePath(f.store, successor.id));
      assert.equal(state.storePreparation.ios.status, 'prepared');
      assert.equal(state.checkpoints.ios['ios-upload'].state, 'intent');
      assert.equal(state.checkpoints.ios['ios-review'], undefined);
      effects.push('binary-upload');
      remote.uploaded = true;
      return { code: 0 };
    };
    f.adapters.ios.upload = ctx => uploadStore({ ...ctx, fetch: provider, session: async () => api });
    await acceptedIos(f);
    const oldProposal = await f.runner().prepareContent(f.plan);
    await f.runner().prepareContent(f.plan, { mode: 'apply', approval: oldProposal.approval });
    const predecessor = await loadState(releasePath(f.store, f.plan.id));
    assert.equal(predecessor.storePreparation.ios.status, 'prepared');
    assert.equal(predecessor.storePreparation.ios.steps['text:en-US'].state, 'confirmed');
    await writeFile(join(f.repo, 'new.txt'), 'current higher-build descendant');
    await runCommand('git', ['add', '.'], { cwd: f.repo });
    await runCommand('git', ['commit', '-qm', 'synthetic descendant'], { cwd: f.repo });
    successor = await createPlan({ repo: f.repo, ref: 'HEAD', platforms: ['ios'], config: f.config });
    const build = f.adapters.ios.build;
    f.adapters.ios.build = async ctx => ({ ...await build(ctx), buildNumber: '2' });
    const built = await f.runner().execute(successor);
    await f.runner().execute(successor, { acceptance: await f.receipts(built) });
    const proposal = await f.runner().prepareContent(successor);
    if (driftAfterOwnership)
      await assert.rejects(f.runner().prepareContent(successor, { mode: 'apply', approval: proposal.approval }), /Remote content changed/);
    else {
      const prepared = await f.runner().prepareContent(successor, { mode: 'apply', approval: proposal.approval });
      assert.equal(prepared.status, 'prepared');
      assert.equal(prepared.observation.remote.target.id, 'retained-draft');
    }
    const result = await f.runner().execute(successor, { uploadOnly: true });
    const old = await loadState(releasePath(f.store, f.plan.id));
    assert.deepEqual(old.storePreparation, predecessor.storePreparation);
    assert.equal(old.supersededBy.ios.releaseId, successor.id);
    assert.equal(old.checkpoints.ios?.['ios-upload'], undefined);
    assert.equal(result.publicationRequested, false);
    assert.equal(result.checkpoints.ios?.['ios-review'], undefined);
    assert.ok(reads.length > 0);
    if (driftAfterOwnership) {
      assert.equal(result.outcomes.ios.state, 'blocked');
      assert.equal(result.checkpoints.ios?.['ios-upload'], undefined);
      assert.deepEqual(effects, ['listing-text']);
      assert.equal(drifted, true);
    } else {
      assert.equal(result.outcomes.ios.state, 'uploaded', JSON.stringify(result.outcomes.ios));
      assert.equal(result.checkpoints.ios['ios-upload'].buildId, 'uploaded-build');
      assert.equal(result.supersessions[0].preparedContent.versionId, 'retained-draft');
      assert.deepEqual(effects, ['listing-text', 'binary-upload']);

      t.mock.method(globalThis, 'fetch', provider);
      const runner = f.runner();
      await assert.rejects(runner.attachBuild(successor, { versionId: 'replacement-draft' }),
        /same recorded prepared draft/);
      remote.notes = 'Changed listing after upload';
      await assert.rejects(runner.attachBuild(successor, { versionId: 'retained-draft' }), /listing or screenshots changed/);
      const beforeAttach = await loadState(releasePath(f.store, successor.id));
      assert.equal(beforeAttach.checkpoints.ios['ios-attach'], undefined);
      assert.equal(remote.selection, null);
      assert.deepEqual(effects, ['listing-text', 'binary-upload']);
      remote.notes = 'Reviewed notes';
      attachAllowed = true;
      const attached = await runner.attachBuild(successor, { versionId: 'retained-draft' });
      assert.equal(attached.state, 'attached');
      assert.deepEqual(effects, ['listing-text', 'binary-upload', 'build-linkage']);
    }
  }
});
