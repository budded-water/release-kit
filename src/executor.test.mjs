import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  stat,
  symlink,
  rename,
  readdir,
} from 'node:fs/promises';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { runCommand } from './command.mjs';
import { atomicJson, digest } from './state.mjs';
import {
  createRequest,
  dispatchRequest,
  loadExecutorPolicy,
  readRequestStatus,
  runRequest,
} from './executor.mjs';

const attestation = {
  available: true,
  workflowSha: 'b'.repeat(40),
  workflowDigest: 'c'.repeat(64),
  runnerId: 123,
};

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture(t, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'release-executor-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repo = join(directory, 'repo');
  await mkdir(repo);
  const git = (args) => runCommand('git', args, { cwd: repo });
  await git(['init', '-q', '--initial-branch=main']);
  await git(['config', 'user.email', 'release-test@example.invalid']);
  await git(['config', 'user.name', 'Release test']);
  await git(['config', 'core.hooksPath', '/dev/null']);
  await writeFile(join(repo, 'source.txt'), 'source');
  await git(['add', '.']);
  await git(['commit', '-qm', 'fixture']);
  const head = (await git(['rev-parse', 'HEAD'])).stdout.trim();
  const releaseConfig = join(directory, 'release.json');
  await writeFile(releaseConfig, JSON.stringify({ schemaVersion: 1 }));
  const policyPath = join(directory, 'executor.json');
  const input = {
    schemaVersion: 1,
    repository: 'example/app',
    controlRepository: repo,
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
      ...overrides,
    },
  };
  await writeFile(policyPath, JSON.stringify(input));
  const policy = await loadExecutorPolicy(policyPath);
  const plan = {
    id: `release-${'a'.repeat(24)}`,
    source: head,
    executor: 'local',
    platforms: ['ios'],
    configDigest: digest({ schemaVersion: 1 }),
  };
  const request = await createRequest({ policy, plan, operation: 'run' });
  const requestDir = join(policy.stateDirectory, 'dispatch', 'requests', request.id);
  let executions = 0;
  let validations = 0;
  const callbacks = {
    validate: async () => {
      validations++;
    },
    execute: async () => {
      executions++;
      return { exitCode: 0, summary: { state: 'accepted' } };
    },
  };
  const worker = {
    runnerName: policy.github.runnerName,
    repository: policy.repository,
    workflowSha: attestation.workflowSha,
    runId: 12,
    runAttempt: 1,
  };
  return {
    directory,
    repo,
    git,
    head,
    input,
    policyPath,
    policy,
    plan,
    request,
    requestDir,
    callbacks,
    worker,
    executions: () => executions,
    validations: () => validations,
    run: (options = {}) =>
      runRequest({ policy, id: request.id, executor: 'local', ...callbacks, ...options }),
    dispatch: (options = {}) =>
      dispatchRequest({
        policy,
        id: request.id,
        mode: 'auto',
        ...callbacks,
        github: { available: async () => attestation, dispatch: async () => ({}) },
        ...options,
      }),
    status: () => readRequestStatus({ policy, id: request.id }),
  };
}

async function rewrite(path, mutate) {
  const stored = JSON.parse(await readFile(path, 'utf8'));
  mutate(stored.value);
  stored.sha256 = digest(stored.value);
  await writeFile(path, JSON.stringify(stored));
}

test('policy defaults are bounded and accept only the dedicated workflow/runner contract', async (t) => {
  const f = await fixture(t);
  const input = structuredClone(f.input);
  delete input.github.startTimeoutSeconds;
  delete input.github.pollSeconds;
  await writeFile(f.policyPath, JSON.stringify(input));
  const defaults = await loadExecutorPolicy(f.policyPath);
  assert.equal(defaults.github.startTimeoutSeconds, 60);
  assert.equal(defaults.github.pollSeconds, 2);
  for (const mutate of [
    (p) => {
      p.token = 'secret';
    },
    (p) => {
      p.releaseConfig = './relative';
    },
    (p) => {
      p.github.runnerLabel = 'self-hosted';
    },
    (p) => {
      p.github.workflow = 'arbitrary.yml';
    },
    (p) => {
      p.github.ref = 'main\nother';
    },
    (p) => {
      p.github.startTimeoutSeconds = 301;
    },
    (p) => {
      p.github.pollSeconds = 0;
    },
  ]) {
    const invalid = structuredClone(input);
    mutate(invalid);
    await writeFile(f.policyPath, JSON.stringify(invalid));
    await assert.rejects(loadExecutorPolicy(f.policyPath));
  }
});

test('request pins the original local plan, publication intent, source, receipts, and private paths', async (t) => {
  const f = await fixture(t);
  const receipt = join(f.directory, 'acceptance.json');
  await writeFile(receipt, '{"passed":true}');
  const request = await createRequest({
    policy: f.policy,
    plan: f.plan,
    operation: 'resume',
    publish: true,
    acceptance: { ios: receipt },
    retryBuild: { platform: 'ios', reason: 'Processes stopped and remote version reconciled' },
  });
  assert.deepEqual(request.plan, f.plan);
  assert.equal(request.plan.executor, 'local');
  assert.equal(request.controlHead, f.head);
  assert.equal(request.host, hostname());
  assert.equal(request.publish, true);
  assert.equal(request.acceptance.ios.sha256, digest(await readFile(receipt)));
  const directory = join(f.policy.stateDirectory, 'dispatch', 'requests', request.id);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.equal((await stat(join(directory, 'request.json'))).mode & 0o777, 0o600);
  assert.notEqual(request.id, f.request.id);
});

test('concurrent local contenders execute once and duplicate requests retain the permanent completion', async (t) => {
  const f = await fixture(t);
  const results = await Promise.all(Array.from({ length: 8 }, () => f.run()));
  assert.equal(f.executions(), 1);
  assert.ok(results.every((r) => ['running', 'completed'].includes(r.state)));
  const completed = await f.run({ validate: () => assert.fail('duplicate must not revalidate') });
  assert.equal(completed.state, 'completed');
  assert.equal(completed.result.exitCode, 0);
  assert.equal((await stat(join(f.requestDir, 'claim.json'))).mode & 0o777, 0o600);
  assert.equal((await stat(join(f.requestDir, 'result.json'))).mode & 0o777, 0o600);
});

test('disabled or unverifiable GitHub auto mode executes locally without granting remote capacity', async (t) => {
  for (const disabled of [true, false]) {
    const f = await fixture(t, { enabled: !disabled });
    let calls = 0;
    const result = await f.dispatch({
      github: {
        available: async () => {
          calls++;
          throw new Error('private auth response');
        },
        dispatch: async () => assert.fail('unavailable cannot dispatch'),
      },
    });
    assert.equal(result.executor, 'local');
    assert.equal(result.state, 'completed');
    assert.equal(calls, disabled ? 0 : 1);
    assert.equal(f.executions(), 1);
  }
});

test('explicit GitHub unavailable and queue deadline never execute locally', async (t) => {
  const unavailable = await fixture(t, { enabled: false });
  assert.equal((await unavailable.dispatch({ mode: 'github' })).state, 'unavailable');
  assert.equal(unavailable.executions(), 0);
  const queued = await fixture(t);
  let posts = 0;
  const github = {
    available: async () => attestation,
    dispatch: async () => {
      posts++;
    },
  };
  assert.equal((await queued.dispatch({ mode: 'github', github })).state, 'pending');
  assert.equal((await queued.dispatch({ mode: 'github', github })).state, 'pending');
  assert.equal(posts, 1);
  assert.equal(queued.executions(), 0);
});

test('remote claim wins before deadline, and workflow reruns cannot execute again', async (t) => {
  const f = await fixture(t);
  const finish = deferred();
  let remote;
  let calls = 0;
  const github = {
    available: async () => attestation,
    dispatch: async () => {
      // The attested intent is already durable when the provider is called.
      assert.equal((await f.status()).dispatch.intent.workflowSha, attestation.workflowSha);
      remote = f.run({
        executor: 'github',
        worker: f.worker,
        execute: async () => {
          calls++;
          await finish.promise;
          return { exitCode: 7 };
        },
      });
      while (!(await f.status()).claim) await delay(5);
      return { runId: 12, runUrl: 'https://github.com/example/app/actions/runs/12' };
    },
  };
  const selected = await f.dispatch({ github });
  assert.equal(selected.state, 'running');
  assert.equal(selected.executor, 'github');
  assert.equal(f.executions(), 0);
  assert.equal((await f.dispatch({ github })).executor, 'github');
  finish.resolve();
  assert.equal((await remote).result.exitCode, 7);
  assert.equal(
    (await f.run({ executor: 'github', worker: { ...f.worker, runAttempt: 2 } })).state,
    'completed',
  );
  assert.equal(calls, 1);
});

test('concurrent GitHub and local workers race on the same durable claim', async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  await assert.rejects(
    f.dispatch({
      signal: controller.signal,
      github: {
        available: async () => attestation,
        dispatch: async () => {
          controller.abort();
        },
      },
    }),
    { name: 'AbortError' },
  );
  const results = await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      f.run({
        executor: index % 2 ? 'github' : 'local',
        worker: f.worker,
        validate: async () => {
          await delay(15);
        },
      }),
    ),
  );
  assert.equal(f.executions(), 1);
  const completed = await f.status();
  assert.equal(completed.state, 'completed');
  assert.ok(results.every((result) => result.executor === completed.executor));
});

test('lost dispatch response and a late GitHub job compete with one local claim', async (t) => {
  const f = await fixture(t);
  const startRemote = deferred();
  let remote;
  let remoteExecutions = 0;
  const github = {
    available: async () => attestation,
    dispatch: async () => {
      remote = startRemote.promise.then(() =>
        f.run({
          executor: 'github',
          worker: f.worker,
          execute: async () => {
            remoteExecutions++;
            return { exitCode: 0 };
          },
        }),
      );
      throw new Error('Response lost, with sensitive provider details');
    },
  };
  const result = await f.dispatch({ github });
  assert.equal(result.executor, 'local');
  assert.equal(result.dispatch.response.state, 'unknown');
  startRemote.resolve();
  assert.equal((await remote).executor, 'local');
  assert.equal(f.executions(), 1);
  assert.equal(remoteExecutions, 0);
  assert.ok(!JSON.stringify(result).includes('sensitive provider'));
});

test('dispatch API ambiguity cannot replace a worker that already owns execution', async (t) => {
  const f = await fixture(t);
  const finish = deferred();
  let remote;
  const result = await f.dispatch({
    github: {
      available: async () => attestation,
      dispatch: async () => {
        remote = f.run({
          executor: 'github',
          worker: f.worker,
          execute: async () => {
            await finish.promise;
            throw new Error('Worker lost subprocess acknowledgement');
          },
        });
        while (!(await f.status()).claim) await delay(5);
        throw new Error('Unknown POST response');
      },
    },
  });
  assert.equal(result.executor, 'github');
  assert.equal(result.state, 'running');
  assert.equal(f.executions(), 0);
  finish.resolve();
  assert.equal((await remote).state, 'unknown');
  assert.equal((await f.dispatch()).state, 'unknown');
  assert.equal(f.executions(), 0);
});

test('a permanent claim without a completion is never stolen after a crash', async (t) => {
  const f = await fixture(t);
  await f.run();
  await rm(join(f.requestDir, 'result.json'));
  const claimBefore = await readFile(join(f.requestDir, 'claim.json'), 'utf8');
  const result = await f.dispatch({
    github: {
      available: () => assert.fail('already claimed'),
      dispatch: () => assert.fail('already claimed'),
    },
  });
  assert.equal(result.state, 'running');
  assert.equal(f.executions(), 1);
  assert.equal(await readFile(join(f.requestDir, 'claim.json'), 'utf8'), claimBefore);
});

test('validation failure does not claim, and a later validated local recovery can claim once', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.run({
      validate: async () => {
        throw new Error('Control checkout dirty');
      },
    }),
    /dirty/,
  );
  assert.equal((await f.status()).state, 'pending');
  assert.equal(f.executions(), 0);
  assert.equal((await f.run()).state, 'completed');
  assert.equal(f.executions(), 1);
});

test('publication intent tampering is refused even with a recomputed envelope checksum', async (t) => {
  const f = await fixture(t);
  await rewrite(join(f.requestDir, 'request.json'), (request) => {
    request.publish = true;
  });
  await assert.rejects(f.run(), /manifest/);
  assert.equal(f.executions(), 0);
});

test('check-only request creation rejects release authorization before writing a manifest', async (t) => {
  for (const operation of ['executor-check', 'validate']) {
    await t.test(operation, async (t) => {
      const f = await fixture(t);
      const evidence = join(f.directory, 'acceptance.json');
      await writeFile(evidence, '{"passed":true}');
      const directory = join(f.policy.stateDirectory, 'dispatch', 'requests');
      const before = await readdir(directory);
      const forbidden = [
        { publish: true },
        { acceptance: { ios: evidence } },
        { retryBuild: { platform: 'ios', reason: 'Confirmed prior tool stopped' } },
      ];
      if (operation === 'executor-check')
        forbidden.push({ plan: { ...f.plan, source: 'f'.repeat(40) } });
      for (const options of forbidden)
        await assert.rejects(
          createRequest({ policy: f.policy, plan: f.plan, operation, ...options }),
          /check|validation|manifest/i,
        );
      assert.deepEqual(await readdir(directory), before);
      assert.equal(f.executions(), 0);
    });
  }
});

test('validate manifests pin a different source without granting publication', async (t) => {
  const f = await fixture(t);
  await f.git(['commit', '--allow-empty', '-qm', 'control advanced']);
  const controlHead = (await f.git(['rev-parse', 'HEAD'])).stdout.trim();
  const request = await createRequest({ policy: f.policy, plan: f.plan, operation: 'validate' });
  assert.equal(request.plan.source, f.head);
  assert.equal(request.controlHead, controlHead);
  assert.notEqual(request.plan.source, request.controlHead);
  assert.equal(request.publish, false);
  assert.deepEqual(request.acceptance, {});
  assert.equal(request.retryBuild, null);
  const status = await readRequestStatus({ policy: f.policy, id: request.id });
  assert.equal(request.operation, 'validate');
  assert.equal(status.releaseId, f.plan.id);
  assert.equal(status.state, 'pending');
});

test('UI request schema is explicit and cannot be downgraded or combined with delivery authorization', async (t) => {
  const f = await fixture(t);
  const sourceOnly = await createRequest({ policy: f.policy, plan: f.plan, operation: 'validate' });
  assert.equal(sourceOnly.schemaVersion, 1);
  assert.equal(Object.hasOwn(sourceOnly, 'ui'), false);
  const request = await createRequest({
    policy: f.policy,
    plan: f.plan,
    operation: 'validate',
    ui: true,
  });
  assert.equal(request.schemaVersion, 2);
  assert.equal(request.ui, true);
  assert.equal((await readRequestStatus({ policy: f.policy, id: request.id })).state, 'pending');
  const forbidden = [
    { schemaVersion: 1 },
    { schemaVersion: 2, ui: false },
    { schemaVersion: 2, ui: undefined },
    { schemaVersion: 3 },
    { operation: 'run' },
    { operation: 'resume' },
    { operation: 'executor-check' },
    { publish: true },
    { acceptance: { ios: { path: join(f.directory, 'receipt.json'), sha256: 'f'.repeat(64) } } },
    { retryBuild: { platform: 'ios', reason: 'Confirmed prior process stopped' } },
  ];
  for (const mutation of forbidden) {
    const { id, ...identity } = { ...request, ...mutation };
    // Persist the actual JSON representation, including omission of undefined.
    const normalized = JSON.parse(JSON.stringify(identity));
    const forged = { id: `request-${digest(normalized).slice(0, 32)}`, ...normalized };
    const directory = join(f.policy.stateDirectory, 'dispatch', 'requests', forged.id);
    await mkdir(directory);
    await atomicJson(join(directory, 'request.json'), { value: forged, sha256: digest(forged) });
    await assert.rejects(
      runRequest({ policy: f.policy, id: forged.id, executor: 'local', ...f.callbacks }),
      /manifest/,
    );
    assert.deepEqual(await readdir(directory), ['request.json']);
  }
  const before = await readdir(join(f.policy.stateDirectory, 'dispatch', 'requests'));
  for (const options of [
    { operation: 'run', ui: true },
    { operation: 'executor-check', ui: true },
    { operation: 'validate', ui: 'true' },
    { operation: 'validate', ui: true, publish: true },
  ])
    await assert.rejects(
      createRequest({ policy: f.policy, plan: f.plan, ...options }),
      /validation/i,
    );
  assert.deepEqual(await readdir(join(f.policy.stateDirectory, 'dispatch', 'requests')), before);
  assert.equal(f.executions(), 0);
  assert.equal(f.validations(), 0);
});

test('recomputed check-only manifest identities cannot authorize release operations', async (t) => {
  for (const operation of ['executor-check', 'validate']) {
    const kinds = [
      'publish',
      'acceptance',
      'retry',
      ...(operation === 'executor-check' ? ['source'] : []),
    ];
    for (const kind of kinds) {
      await t.test(`${operation}: ${kind}`, async (t) => {
        const f = await fixture(t);
        const request = await createRequest({ policy: f.policy, plan: f.plan, operation });
        const { id: originalId, ...identity } = request;
        if (kind === 'publish') identity.publish = true;
        if (kind === 'acceptance')
          identity.acceptance = {
            ios: { path: join(f.directory, 'acceptance.json'), sha256: 'f'.repeat(64) },
          };
        if (kind === 'retry')
          identity.retryBuild = {
            platform: 'ios',
            reason: 'Confirmed prior tool stopped',
          };
        if (kind === 'source') {
          identity.plan.source = 'f'.repeat(40);
          identity.planDigest = digest(identity.plan);
        }
        const forged = { id: `request-${digest(identity).slice(0, 32)}`, ...identity };
        const directory = join(f.policy.stateDirectory, 'dispatch', 'requests', forged.id);
        assert.notEqual(forged.id, originalId);
        await mkdir(directory);
        await atomicJson(join(directory, 'request.json'), {
          value: forged,
          sha256: digest(forged),
        });
        await assert.rejects(
          runRequest({ policy: f.policy, id: forged.id, executor: 'local', ...f.callbacks }),
          /manifest/,
        );
        assert.equal(f.validations(), 0, 'Manifest rejection must precede execution validation');
        assert.equal(f.executions(), 0);
      });
    }
  }
});

test('receipt and configuration bytes cannot change before execution or during validation', async (t) => {
  const f = await fixture(t);
  const receipt = join(f.directory, 'acceptance.json');
  await writeFile(receipt, '{"passed":true}');
  const request = await createRequest({
    policy: f.policy,
    plan: f.plan,
    operation: 'resume',
    acceptance: { ios: receipt },
  });
  await writeFile(receipt, '{"passed":false}');
  await assert.rejects(
    runRequest({ policy: f.policy, id: request.id, executor: 'local', ...f.callbacks }),
    /receipt changed/,
  );
  await assert.rejects(
    f.run({
      validate: async () => {
        await writeFile(f.policy.releaseConfig, '{}');
      },
    }),
    /configuration changed/,
  );
  assert.equal(f.executions(), 0);
  assert.equal((await f.status()).state, 'pending');
});

test('control checkout movement, another store, or changed execution policy cannot use a request', async (t) => {
  const f = await fixture(t);
  await f.git(['commit', '--allow-empty', '-qm', 'advance']);
  await assert.rejects(f.run(), /Control checkout changed/);
  await assert.rejects(
    readRequestStatus({ policy: { ...f.policy, repository: 'other/app' }, id: f.request.id }),
    /another policy/,
  );
  const alternateStore = join(f.directory, 'other-state');
  await mkdir(join(alternateStore, 'dispatch', 'requests'), { recursive: true });
  await rename(f.requestDir, join(alternateStore, 'dispatch', 'requests', f.request.id));
  await assert.rejects(
    readRequestStatus({
      policy: { ...f.policy, stateDirectory: alternateStore },
      id: f.request.id,
    }),
    /another policy/,
  );
  assert.equal(f.executions(), 0);
});

test('redirected receipts and request records are refused', async (t) => {
  const f = await fixture(t);
  const receipt = join(f.directory, 'receipt.json');
  const alias = join(f.directory, 'alias.json');
  await writeFile(receipt, '{}');
  await symlink(receipt, alias);
  await assert.rejects(
    createRequest({ policy: f.policy, plan: f.plan, operation: 'run', acceptance: { ios: alias } }),
    /symlinks/,
  );
  const target = join(f.directory, 'redirected-request.json');
  await rename(join(f.requestDir, 'request.json'), target);
  await symlink(target, join(f.requestDir, 'request.json'));
  await assert.rejects(f.status(), /symlinks/);
});

test('corrupt completion and mismatched record references cannot authorize a retry', async (t) => {
  const f = await fixture(t);
  await f.run();
  await rewrite(join(f.requestDir, 'result.json'), (result) => {
    result.claimDigest = 'f'.repeat(64);
  });
  await assert.rejects(f.dispatch(), /execution history/);
  assert.equal(f.executions(), 1);
});

test('an execution exception is unknown and never leaks raw failure or repeats', async (t) => {
  const f = await fixture(t);
  const result = await f.run({
    execute: async () => {
      throw new Error('secret credential in provider output');
    },
  });
  assert.equal(result.state, 'unknown');
  assert.ok(!JSON.stringify(result).includes('secret credential'));
  assert.equal((await f.run()).state, 'unknown');
  assert.equal(f.executions(), 0);
});

test('interruption before or during availability does not launch a local fallback or dispatch', async (t) => {
  for (const initiallyAborted of [true, false]) {
    const f = await fixture(t);
    const controller = new AbortController();
    if (initiallyAborted) controller.abort();
    await assert.rejects(
      f.dispatch({
        signal: controller.signal,
        github: {
          available: async () => {
            controller.abort();
            return attestation;
          },
          dispatch: () => assert.fail('aborted dispatch'),
        },
      }),
      { name: 'AbortError' },
    );
    assert.equal(f.executions(), 0);
    assert.equal((await f.status()).state, 'pending');
    assert.equal((await f.status()).dispatch, undefined);
  }
});

test('interrupted queued dispatch retains intent and can recover locally without another POST', async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  let posts = 0;
  const github = {
    available: async () => attestation,
    dispatch: async () => {
      posts++;
    },
  };
  await assert.rejects(
    f.dispatch({
      signal: controller.signal,
      github,
      wait: async () => {
        controller.abort();
      },
    }),
    { name: 'AbortError' },
  );
  assert.equal(posts, 1);
  assert.equal(f.executions(), 0);
  assert.equal((await f.run()).executor, 'local');
  assert.equal((await f.dispatch({ github })).state, 'completed');
  assert.equal(posts, 1);
});

test('GitHub execution requires the persisted workflow attestation and matching runner identity', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.run({ executor: 'github', worker: f.worker }), /does not match/);
  const controller = new AbortController();
  await assert.rejects(
    f.dispatch({
      signal: controller.signal,
      github: {
        available: async () => attestation,
        dispatch: async () => {
          controller.abort();
        },
      },
    }),
    { name: 'AbortError' },
  );
  for (const worker of [
    { ...f.worker, workflowSha: 'd'.repeat(40) },
    { ...f.worker, runnerName: 'other-mac' },
    { ...f.worker, repository: 'other/app' },
  ])
    await assert.rejects(f.run({ executor: 'github', worker }), /does not match/);
  assert.equal(f.executions(), 0);
  assert.equal((await f.run({ executor: 'github', worker: f.worker })).executor, 'github');
});

test('a foreign request result with a valid checksum is rejected', async (t) => {
  const f = await fixture(t);
  await f.run();
  const result = JSON.parse(await readFile(join(f.requestDir, 'result.json'), 'utf8')).value;
  result.requestDigest = 'f'.repeat(64);
  await atomicJson(join(f.requestDir, 'result.json'), { value: result, sha256: digest(result) });
  await assert.rejects(f.status(), /different request/);
});
