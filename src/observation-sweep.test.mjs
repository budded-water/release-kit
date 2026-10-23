import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { atomicJson, digest } from './state.mjs';
import { createRequest, readRequestStatus, runRequest } from './executor.mjs';
import { observeTargets, validateObservationTargets } from './observation-sweep.mjs';

const source = 'a'.repeat(40);
const workflowSha = 'b'.repeat(40);
const secret = 'private-token-provider-body-and-credential-path';
const releaseId = (n) => `release-${n.toString(16).padStart(24, '0')}`;
const requestId = (n) => `request-${n.toString(16).padStart(32, '0')}`;
const envelope = (value) => ({ value, sha256: digest(value) });

async function snapshot(directory) {
  const files = {};
  async function visit(path, relative = '') {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const key = join(relative, entry.name);
      if (entry.isDirectory()) await visit(join(path, entry.name), key);
      else files[key] = (await readFile(join(path, entry.name))).toString('base64');
    }
  }
  await visit(directory);
  return files;
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'release-observation-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const control = join(directory, 'control');
  await mkdir(control);
  const releaseConfig = join(directory, 'release.json');
  await writeFile(releaseConfig, JSON.stringify({ schemaVersion: 1 }));
  const policy = {
    schemaVersion: 1,
    repository: 'example/app',
    controlRepository: control,
    releaseConfig,
    stateDirectory: join(directory, 'state'),
    github: {
      enabled: true,
      workflow: 'release-local.yml',
      ref: 'main',
      runnerName: 'release-mac',
      runnerLabel: 'release-example',
      startTimeoutSeconds: 1,
      pollSeconds: 1,
    },
  };
  const configDigest = digest({ schemaVersion: 1 });
  const command = async (binary, args) => {
    assert.equal(binary, 'git');
    assert.deepEqual(args, ['rev-parse', '--verify', 'HEAD^{commit}']);
    return { stdout: source };
  };
  let sequence = 0;
  const history = async ({
    dispatched = true,
    receiptId = '12',
    claimed = true,
    workerState = 'completed',
    exitCode = 0,
    ui = false,
  } = {}) => {
    sequence += 1;
    const request = await createRequest({
      policy,
      plan: {
        id: releaseId(sequence),
        source,
        executor: 'local',
        platforms: ['ios'],
        configDigest,
      },
      operation: ui ? 'validate' : 'executor-check',
      ui,
      command,
    });
    const path = join(policy.stateDirectory, 'dispatch', 'requests', request.id);
    const requestDigest = digest(request);
    if (dispatched) {
      const intent = {
        requestDigest,
        createdAt: new Date().toISOString(),
        workflowSha,
        workflowDigest: 'c'.repeat(64),
        runnerId: '123',
      };
      await atomicJson(join(path, 'dispatch-intent.json'), envelope(intent), { exclusive: true });
      await atomicJson(
        join(path, 'dispatch-response.json'),
        envelope({
          requestDigest,
          intentDigest: digest(intent),
          observedAt: new Date().toISOString(),
          state: 'accepted',
          ...(receiptId ? { runId: receiptId } : {}),
        }),
        { exclusive: true },
      );
    }
    if (claimed)
      await runRequest({
        policy,
        id: request.id,
        executor: dispatched ? 'github' : 'local',
        worker: {
          runnerName: policy.github.runnerName,
          repository: policy.repository,
          workflowSha,
          runId: '12',
          runAttempt: 2,
        },
        validate: async () => {},
        execute: async () => {
          if (workerState === 'unknown') throw new Error(secret);
          return { exitCode, summary: { privateDiagnostic: secret } };
        },
        command,
      });
    const status = await readRequestStatus({ policy, id: request.id });
    return { id: request.id, path, status };
  };
  const observe = (options) =>
    observeTargets({
      store: policy.stateDirectory,
      configDigest,
      control: source,
      policy,
      ...options,
    });
  return { directory, policy, history, observe, configDigest };
}

function githubResult(status = 'completed', conclusion = 'success') {
  return {
    ok: true,
    state: status === 'completed' ? 'completed' : 'pending',
    status,
    conclusion,
    runId: '12',
    runAttempt: 2,
    url: 'https://github.com/example/app/actions/runs/12/attempts/2',
  };
}

test('completed workers and GitHub states are reported independently without changing original history', async (t) => {
  const f = await fixture(t);
  const cases = [
    {
      name: 'queued after worker completion',
      outcome: githubResult('queued', null),
      agreement: 'pending',
      ok: true,
    },
    {
      name: 'provider failure after successful worker',
      outcome: githubResult('completed', 'failure'),
      agreement: 'different',
      ok: true,
    },
    {
      name: 'failed worker and failed workflow',
      exitCode: 2,
      outcome: githubResult('completed', 'failure'),
      agreement: 'consistent',
      ok: true,
    },
    {
      name: 'provider unavailable after worker completion',
      outcome: { ok: false, reason: 'github-run-unavailable' },
      agreement: 'unknown',
      ok: false,
    },
    {
      name: 'successful provider cannot resolve unknown worker',
      workerState: 'unknown',
      outcome: githubResult(),
      agreement: 'pending',
      ok: true,
    },
  ];
  for (const scenario of cases) {
    const h = await f.history(scenario);
    const before = await snapshot(h.path);
    const calls = [];
    const report = await f.observe({
      requests: [h.id],
      github: {
        observeRun: async (coordinates) => {
          calls.push(coordinates);
          return scenario.outcome;
        },
      },
    });
    assert.equal(calls.length, 1, scenario.name);
    assert.deepEqual(calls[0], { runId: '12', runAttempt: 2, workflowSha, signal: undefined });
    assert.equal(report.ok, scenario.ok, scenario.name);
    const observed = report.requests[h.id];
    assert.equal(observed.agreement, scenario.agreement, scenario.name);
    assert.equal(observed.worker.state, scenario.workerState ?? 'completed');
    assert.equal(observed.worker.executor, 'github');
    assert.equal(
      observed.worker.exitCode,
      scenario.workerState === 'unknown' ? undefined : (scenario.exitCode ?? 0),
    );
    assert.deepEqual(observed.workflow, scenario.outcome);
    assert.equal(observed.stateDigest, digest(h.status));
    assert.deepEqual(await snapshot(h.path), before);
    assert.deepEqual(await readRequestStatus({ policy: f.policy, id: h.id }), h.status);
    assert.ok(!JSON.stringify(report).includes(secret));
  }
});

test('schema-2 UI validation remains an immutable observation rather than a new execution', async (t) => {
  const f = await fixture(t);
  const h = await f.history({ ui: true, exitCode: 2 });
  const request = JSON.parse(await readFile(join(h.path, 'request.json'), 'utf8')).value;
  assert.equal(request.schemaVersion, 2);
  assert.equal(request.operation, 'validate');
  assert.equal(request.ui, true);
  const before = await snapshot(h.path);
  const report = await f.observe({
    requests: [h.id],
    github: { observeRun: async () => githubResult('completed', 'failure') },
  });
  assert.equal(report.ok, true);
  assert.equal(report.requests[h.id].worker.exitCode, 2);
  assert.equal(report.requests[h.id].agreement, 'consistent');
  assert.deepEqual(await snapshot(h.path), before);
  assert.deepEqual(await readRequestStatus({ policy: f.policy, id: h.id }), h.status);
});

test('claim/receipt conflicts and missing dispatched run IDs never query or guess a workflow', async (t) => {
  const f = await fixture(t);
  const conflict = await f.history({ receiptId: '13' });
  const missing = await f.history({ claimed: false, receiptId: null });
  let calls = 0;
  const report = await f.observe({
    requests: [conflict.id, missing.id],
    github: {
      observeRun: async () => {
        calls += 1;
        return githubResult();
      },
    },
  });
  assert.equal(calls, 0);
  assert.equal(report.ok, false);
  assert.equal(report.requests[conflict.id].workflow.reason, 'run-identity-conflict');
  assert.equal(report.requests[missing.id].workflow.reason, 'unresolved-run-id');
  assert.equal(report.requests[missing.id].worker.state, 'pending');
});

test('dispatch receipts select initial attempts while local-only workers have no GitHub observation', async (t) => {
  const f = await fixture(t);
  const pending = await f.history({ claimed: false });
  const local = await f.history({ dispatched: false });
  const calls = [];
  const report = await f.observe({
    requests: [pending.id, local.id],
    github: {
      observeRun: async (coordinates) => {
        calls.push(coordinates);
        return { ...githubResult('queued', null), runAttempt: 1 };
      },
    },
  });
  assert.deepEqual(calls, [{ runId: '12', runAttempt: 1, workflowSha, signal: undefined }]);
  assert.equal(report.requests[pending.id].agreement, 'pending');
  assert.equal(report.requests[local.id].agreement, 'not-applicable');
  assert.deepEqual(report.requests[local.id].worker, {
    state: 'completed',
    executor: 'local',
    exitCode: 0,
  });
  assert.equal(report.ok, true);
});

test('policy drift and corrupt history stop before provider access and redact source exceptions', async (t) => {
  const f = await fixture(t);
  const drifted = await f.history();
  const corrupt = await f.history();
  await writeFile(join(corrupt.path, 'result.json'), secret);
  const github = { observeRun: async () => assert.fail('Invalid history must not query GitHub') };
  const drift = await f.observe({
    requests: [drifted.id],
    policy: { ...f.policy, github: { ...f.policy.github, ref: 'advanced-policy' } },
    github,
  });
  const corrupted = await f.observe({ requests: [corrupt.id], github });
  for (const report of [drift, corrupted]) {
    assert.equal(report.ok, false);
    assert.ok(!JSON.stringify(report).includes(secret));
    assert.ok(!JSON.stringify(report).includes(f.policy.releaseConfig));
    const [result] = Object.values(report.requests);
    assert.equal(result.reason, 'observation-unavailable');
    assert.equal(result.workflow, undefined);
  }
});

test('one unavailable, unsupported, busy or mismatched release does not hide independent observations', async (t) => {
  const f = await fixture(t);
  const releases = Array.from({ length: 7 }, (_, i) => releaseId(i + 1));
  const observations = [
    { ios: { state: 'in_review' } },
    { android: { state: 'unavailable' } },
    { harmony: { state: 'unsupported' } },
    'OBSERVATION_BUSY',
    'CONFIGURATION_MISMATCH',
    'INVALID_RECORD',
    'UNRECOGNIZED_PRIVATE_ERROR',
  ];
  const calls = [];
  const report = await f.observe({
    releases,
    runner: {
      observe: async (id) => {
        calls.push(id);
        const value = observations[releases.indexOf(id)];
        if (typeof value === 'string') throw Object.assign(new Error(secret), { code: value });
        return { releaseId: id, source, observations: value };
      },
    },
  });
  assert.deepEqual(calls, releases);
  assert.equal(report.ok, false);
  assert.equal(report.releases[releases[0]].ok, true);
  assert.equal(report.releases[releases[0]].observations.ios.state, 'in_review');
  assert.equal(report.releases[releases[1]].ok, false);
  assert.equal(report.releases[releases[2]].ok, false);
  assert.deepEqual(
    releases.slice(3).map((id) => report.releases[id].reason),
    ['busy', 'configuration-mismatch', 'invalid-record', 'observation-unavailable'],
  );
  assert.ok(!JSON.stringify(report).includes(secret));
  assert.ok(!JSON.stringify(report).includes('UNRECOGNIZED_PRIVATE_ERROR'));
});

test('cancellation saves the partial report and skips every remaining release and request', async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  const calls = [];
  const report = await f.observe({
    releases: [releaseId(1), releaseId(2)],
    requests: [requestId(1)],
    signal: controller.signal,
    runner: {
      observe: async (id) => {
        calls.push(id);
        controller.abort(new Error(secret));
        return { observations: { ios: { state: 'available' } } };
      },
    },
    github: { observeRun: async () => assert.fail('Cancelled requests must not query GitHub') },
  });
  assert.deepEqual(calls, [releaseId(1)]);
  assert.equal(report.ok, false);
  assert.equal(report.interrupted, true);
  assert.equal(report.releases[releaseId(1)].reason, 'observation-interrupted');
  assert.equal(report.releases[releaseId(2)].reason, 'not-observed-interrupted');
  assert.equal(report.requests[requestId(1)].reason, 'not-observed-interrupted');
  const saved = JSON.parse(await readFile(report.reportPath, 'utf8'));
  assert.equal(saved.interrupted, true);
  assert.equal(saved.ok, false);
  assert.ok(!JSON.stringify(saved).includes(secret));
});

test('reports are private standalone immutable records outside dispatch and release journals', async (t) => {
  const f = await fixture(t);
  const h = await f.history();
  const journalDirectory = join(f.policy.stateDirectory, 'releases', releaseId(1), 'events');
  await mkdir(journalDirectory, { recursive: true });
  await writeFile(join(journalDirectory, '00000001.json'), 'unchanged release evidence');
  const dispatchBefore = await snapshot(join(f.policy.stateDirectory, 'dispatch'));
  const releasesBefore = await snapshot(join(f.policy.stateDirectory, 'releases'));
  const options = {
    requests: [h.id],
    github: { observeRun: async () => githubResult('queued', null) },
  };
  const first = await f.observe(options);
  const firstBytes = await readFile(first.reportPath);
  const second = await f.observe(options);
  assert.notEqual(first.reportPath, second.reportPath);
  assert.equal(dirname(first.reportPath), join(f.policy.stateDirectory, 'observations'));
  assert.equal((await stat(first.reportPath)).mode & 0o777, 0o600);
  assert.equal((await stat(dirname(first.reportPath))).mode & 0o777, 0o700);
  assert.deepEqual(await readFile(first.reportPath), firstBytes);
  assert.deepEqual(await snapshot(join(f.policy.stateDirectory, 'dispatch')), dispatchBefore);
  assert.deepEqual(await snapshot(join(f.policy.stateDirectory, 'releases')), releasesBefore);
  const saved = JSON.parse(firstBytes);
  const { reportPath, ...expected } = first;
  assert.deepEqual(saved, expected);
  assert.equal(saved.schemaVersion, 1);
  assert.equal(saved.operation, 'observe');
  assert.equal(saved.configDigest, f.configDigest);
  assert.equal(saved.control, source);
  assert.ok(Number.isFinite(Date.parse(saved.startedAt)));
  assert.ok(Date.parse(saved.finishedAt) >= Date.parse(saved.startedAt));
});

test('observation selection requires 1–20 explicit unique string IDs and rejects coercion or injection', () => {
  assert.doesNotThrow(() => validateObservationTargets([releaseId(1)], []));
  assert.doesNotThrow(() => validateObservationTargets([], [requestId(1)]));
  assert.doesNotThrow(() =>
    validateObservationTargets(
      Array.from({ length: 10 }, (_, i) => releaseId(i + 1)),
      Array.from({ length: 10 }, (_, i) => requestId(i + 1)),
    ),
  );
  const invalid = [
    [[], []],
    [Array.from({ length: 21 }, (_, i) => releaseId(i + 1)), []],
    [[releaseId(1), releaseId(1)], []],
    [[], [requestId(1), requestId(1)]],
    [null, []],
    [[], undefined],
    [[`../${releaseId(1)}`], []],
    [[], [`${requestId(1)}/../request`]],
    [[`${releaseId(1)}\n--publish`], []],
    [[], [`${requestId(1)};submit`]],
    [[requestId(1)], []],
    [[], [releaseId(1)]],
    [[1], []],
    [[], [null]],
    [[{ toString: () => releaseId(1) }], []],
    [[], [{ toString: () => requestId(1) }]],
  ];
  for (const [releases, requests] of invalid)
    assert.throws(
      () => validateObservationTargets(releases, requests),
      /1–20 unique explicit --release\/--request IDs/,
    );
});

test('invalid selection and missing required request observers produce no report or remote work', async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const github = {
    observeRun: async () => {
      calls += 1;
    },
  };
  await assert.rejects(f.observe({ requests: [requestId(1), requestId(1)], github }), /1–20/);
  await assert.rejects(f.observe({ requests: [requestId(1)] }), /requires an executor policy/);
  await assert.rejects(
    f.observe({ requests: [requestId(1)], policy: undefined, github }),
    /requires an executor policy/,
  );
  assert.equal(calls, 0);
  await assert.rejects(stat(join(f.policy.stateDirectory, 'observations')), { code: 'ENOENT' });
});
