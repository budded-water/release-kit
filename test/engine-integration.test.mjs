import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRunner } from '../src/engine.mjs';
import { createPlan } from '../src/plan.mjs';
import { runCommand } from '../src/command.mjs';
import { digest, loadState, releasePath } from '../src/state.mjs';
import { main } from '../src/cli.mjs';
import { createRequest, runRequest, inspectDispatchRequests } from '../src/executor.mjs';

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
      schemaVersion: 1, kind: 'native-acceptance', source: plan.source, platform,
      artifactSha256: state.artifacts[platform].sha256, passed: true,
      checkedAt: new Date().toISOString(), provenance: 'operator', checks: [{ name: 'synthetic', passed: true }],
      testedBuild: { kind: 'artifact', source: plan.source, sha256: state.artifacts[platform].sha256 },
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
