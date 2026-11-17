import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRunner } from '../src/engine.mjs';
import { createPlan } from '../src/plan.mjs';
import { runCommand } from '../src/command.mjs';
import { digest, loadState, releasePath, saveState } from '../src/state.mjs';
import { main } from '../src/cli.mjs';
import { createRequest, dispatchRequest, runRequest, readRequestStatus, inspectDispatchRequests } from '../src/executor.mjs';
import { workerMain } from '../src/worker.mjs';

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
  for (const variant of ['same', 'changed-content', 'changed-draft', 'unknown-step', 'upload-intent', 'not-prepared']) {
    const f = await fixture(t, ['ios']);
    const accepted = await acceptedIos(f);
    const inputDigest = 'b'.repeat(64);
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
    const result = await f.runner().execute(plan, { uploadOnly: true });
    const old = await f.state();
    if (variant === 'same') {
      assert.equal(result.outcomes.ios.state, 'uploaded');
      assert.equal(old.outcomes.ios.state, 'superseded');
      assert.equal(old.supersededBy.ios.releaseId, plan.id);
      assert.equal(result.supersessions[0].reason, 'confirmed-prepared-draft-no-upload');
      assert.equal(result.supersessions[0].preparedContent.versionId, 'draft-1');
      assert.deepEqual(old.storePreparation, accepted.storePreparation);
      assert.equal(old.checkpoints.ios?.['ios-upload'], undefined);
      assert.equal((await f.runner().execute(f.plan)).outcomes.ios.state, 'blocked');
    } else {
      assert.equal(result.outcomes.ios.state, 'blocked', variant);
      assert.equal(old.supersededBy, undefined, variant);
      assert.equal(f.calls.includes('upload-ios'), false, variant);
    }
    assert.equal(f.calls.includes('publish-ios'), false);
  }
});
