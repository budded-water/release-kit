import test from 'node:test';
import assert from 'node:assert/strict';
import { createGithubExecutor } from './github-executor.mjs';

const repository = 'example/app';
const workflowSha = 'b'.repeat(40);
const workflowPath = '.github/workflows/release-local.yml';
const runId = 456;
const runAttempt = 2;
const secret = 'private-provider-token-and-account-detail';
const coordinates = { runId: String(runId), runAttempt, workflowSha };

function fixture({ run = {}, raw, error, policy: overrides = {}, respond } = {}) {
  const policy = {
    repository,
    controlRepository: '/private/release-control',
    github: {
      enabled: true,
      workflow: 'release-local.yml',
      ref: 'main',
      runnerName: 'release-mac',
      runnerLabel: 'release-example',
    },
    ...overrides,
  };
  const calls = [];
  const response = {
    id: runId,
    run_attempt: runAttempt,
    repository: { full_name: repository },
    head_repository: { full_name: repository },
    path: workflowPath,
    head_branch: 'main',
    head_sha: workflowSha,
    event: 'workflow_dispatch',
    status: 'completed',
    conclusion: 'success',
    html_url: `https://untrusted.example/${secret}`,
    actor: { login: secret },
    ...run,
  };
  const environment = { PATH: '/tools', GH_TOKEN: secret };
  const command = async (binary, args, options) => {
    calls.push({ binary, args, options });
    assert.equal(binary, 'gh');
    assert.equal(args[args.indexOf('--hostname') + 1], 'github.com');
    assert.equal(args[args.indexOf('--method') + 1], 'GET');
    assert.ok(args.includes('X-GitHub-Api-Version: 2026-03-10'));
    assert.equal(options.sensitive, true);
    assert.equal(options.diagnostics, false);
    assert.equal(options.timeoutMs, 30000);
    assert.equal(options.maxBuffer, 4 * 1024 * 1024);
    assert.equal(options.env.GH_PROMPT_DISABLED, '1');
    assert.equal(options.cwd, policy.controlRepository);
    assert.ok(!args.includes('-f'));
    assert.ok(!JSON.stringify(args).includes(secret));
    if (respond) return respond(options);
    if (error) throw error;
    return { stdout: raw ?? JSON.stringify(response) };
  };
  return { executor: createGithubExecutor({ policy, command, environment }), calls, policy };
}

test('historical exact attempts are GET-only and independent of current branch, runner and dispatch readiness', async () => {
  const f = fixture();
  f.policy.github.enabled = false;
  // No current branch/runner lookups are supplied: history remains observable
  // after main advances, the runner becomes busy, or dispatch is disabled.
  const result = await f.executor.observeRun(coordinates);
  assert.deepEqual(result, {
    ok: true,
    state: 'completed',
    status: 'completed',
    conclusion: 'success',
    runId: String(runId),
    runAttempt,
    url: `https://github.com/${repository}/actions/runs/${runId}/attempts/${runAttempt}`,
  });
  assert.equal(f.calls.length, 1);
  assert.equal(
    f.calls[0].args.at(-1),
    `repos/${repository}/actions/runs/${runId}/attempts/${runAttempt}`,
  );
  assert.ok(!JSON.stringify(result).includes(secret));
  await assert.rejects(
    f.executor.dispatch(`request-${'a'.repeat(32)}`),
    /availability verification/,
  );
  assert.equal(f.calls.length, 1);
});

test('a receipt without worker attempt selects initial attempt rather than the latest rerun', async () => {
  const f = fixture({ run: { run_attempt: 1, status: 'queued', conclusion: null } });
  const result = await f.executor.observeRun({ runId, workflowSha });
  assert.equal(result.ok, true);
  assert.equal(result.state, 'pending');
  assert.equal(result.runAttempt, 1);
  assert.equal(f.calls[0].args.at(-1), `repos/${repository}/actions/runs/${runId}/attempts/1`);
});

test('repository spelling and documented workflow ref suffixes preserve the same pinned identity', async () => {
  for (const path of [workflowPath, `${workflowPath}@main`, `${workflowPath}@refs/heads/main`]) {
    const f = fixture({
      run: {
        path,
        repository: { full_name: 'Example/App' },
        head_repository: { full_name: 'EXAMPLE/APP' },
      },
    });
    assert.equal((await f.executor.observeRun(coordinates)).ok, true);
  }
});

test('provider identity conflicts never become workflow completion evidence', async () => {
  const mismatches = [
    { id: runId + 1 },
    { id: String(runId) },
    { run_attempt: 1 },
    { run_attempt: String(runAttempt) },
    { repository: { full_name: 'other/app' } },
    { repository: null },
    { head_repository: { full_name: 'fork/app' } },
    { head_repository: null },
    { path: '.github/workflows/another.yml' },
    { path: `${workflowPath}@different` },
    { path: `${workflowPath}@refs/tags/main` },
    { head_branch: 'different' },
    { head_sha: 'c'.repeat(40) },
    { event: 'push' },
  ];
  for (const run of mismatches) {
    const result = await fixture({ run }).executor.observeRun(coordinates);
    assert.equal(result.ok, false, JSON.stringify(run));
    assert.equal(result.reason, 'github-run-identity-mismatch');
    assert.equal(result.status, undefined);
    assert.equal(result.conclusion, undefined);
  }
});

test('invalid caller coordinates and unsupported policies make no provider calls', async () => {
  for (const changed of [
    { runId: undefined },
    { runId: 0 },
    { runId: -1 },
    { runId: 1.5 },
    { runId: '0456' },
    { runId: '../runs/456' },
    { runId: Number.MAX_SAFE_INTEGER + 1 },
    { runId: String(Number.MAX_SAFE_INTEGER + 1) },
    { runAttempt: 0 },
    { runAttempt: '02' },
    { runAttempt: 1.1 },
    { runAttempt: Number.MAX_SAFE_INTEGER + 1 },
    { workflowSha: 'main' },
    { workflowSha: undefined },
  ]) {
    const f = fixture();
    assert.deepEqual(await f.executor.observeRun({ ...coordinates, ...changed }), {
      ok: false,
      reason: 'invalid-github-observation',
    });
    assert.equal(f.calls.length, 0);
  }
  const f = fixture({ policy: { repository: `other/app\n${secret}` } });
  assert.deepEqual(await f.executor.observeRun(coordinates), {
    ok: false,
    reason: 'invalid-github-policy',
  });
  assert.equal(f.calls.length, 0);
});

test('known pending states and terminal conclusions remain distinct, including failures', async () => {
  for (const status of ['queued', 'in_progress', 'requested', 'waiting', 'pending']) {
    const f = fixture({ run: { status, conclusion: null } });
    const result = await f.executor.observeRun(coordinates);
    assert.equal(result.ok, true);
    assert.equal(result.state, 'pending');
    assert.equal(result.status, status);
    assert.equal(result.conclusion, null);
  }
  for (const conclusion of [
    'action_required',
    'cancelled',
    'failure',
    'neutral',
    'skipped',
    'stale',
    'success',
    'timed_out',
  ]) {
    const f = fixture({ run: { conclusion } });
    const result = await f.executor.observeRun(coordinates);
    assert.equal(result.ok, true);
    assert.equal(result.state, 'completed');
    assert.equal(result.conclusion, conclusion);
  }
});

test('unknown or contradictory provider states cannot imply success or leak raw values', async () => {
  for (const run of [
    { status: secret },
    { conclusion: secret },
    { status: 'completed', conclusion: null },
    { status: 'queued', conclusion: 'success' },
    { status: 'queued', conclusion: undefined },
  ]) {
    const result = await fixture({ run }).executor.observeRun(coordinates);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'github-run-state-unknown');
    assert.ok(!JSON.stringify(result).includes(secret));
  }
});

test('404, transport failures and malformed responses are bounded and redacted', async () => {
  for (const status of [404, 401, 503]) {
    const error = Object.assign(new Error(`HTTP ${status} ${secret}`), {
      status,
      stdout: secret,
      stderr: secret,
    });
    const result = await fixture({ error }).executor.observeRun(coordinates);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'github-run-unavailable');
    assert.ok(!JSON.stringify(result).includes(secret));
  }
  const malformed = await fixture({ raw: `${secret}{broken` }).executor.observeRun(coordinates);
  assert.equal(malformed.reason, 'github-run-response-invalid');
  assert.ok(!JSON.stringify(malformed).includes(secret));
  for (const raw of ['null', '[]', '42', JSON.stringify({ message: secret })]) {
    const result = await fixture({ raw }).executor.observeRun(coordinates);
    assert.equal(result.reason, 'github-run-identity-mismatch');
    assert.ok(!JSON.stringify(result).includes(secret));
  }
});

test('an already aborted observation sends nothing and does not expose the abort reason', async () => {
  const controller = new AbortController();
  controller.abort(new Error(secret));
  const f = fixture();
  const result = await f.executor.observeRun({ ...coordinates, signal: controller.signal });
  assert.equal(result.reason, 'github-observation-interrupted');
  assert.equal(f.calls.length, 0);
  assert.ok(!JSON.stringify(result).includes(secret));
});

test('cancellation reaches the bounded CLI and cannot yield late success', async () => {
  for (const reject of [true, false]) {
    const controller = new AbortController();
    const f = fixture({
      respond: async ({ signal }) => {
        assert.equal(signal, controller.signal);
        controller.abort(new Error(secret));
        if (reject) throw new Error(secret);
        return { stdout: secret };
      },
    });
    const result = await f.executor.observeRun({ ...coordinates, signal: controller.signal });
    assert.equal(result.reason, 'github-observation-interrupted');
    assert.ok(!JSON.stringify(result).includes(secret));
  }
});
