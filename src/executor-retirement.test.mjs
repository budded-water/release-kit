import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireActivity, acquireMaintenance } from './coordination.mjs';
import {
  createRequest,
  dispatchRequest,
  inspectDispatchRequests,
  readRequestStatus,
  retireDispatchRequest,
  runRequest,
} from './executor.mjs';
import { atomicJson, digest } from './state.mjs';
import { dispatchExitCode } from './execution.mjs';

const head = 'a'.repeat(40);
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
async function fixture(t, operation = 'executor-check', publish = false, ui = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'release-retirement-')));
  await chmod(root, 0o700);
  const handles = [];
  t.after(async () => {
    for (const handle of handles) await handle.release();
    await rm(root, { recursive: true, force: true });
  });
  const controlRepository = join(root, 'control');
  const anchor = join(root, 'anchor');
  await mkdir(controlRepository, { mode: 0o700 });
  await mkdir(anchor, { mode: 0o700 });
  const releaseConfig = join(root, 'config.json');
  await writeFile(releaseConfig, '{}', { mode: 0o600 });
  const policy = {
    schemaVersion: 1,
    repository: 'example/app',
    controlRepository,
    releaseConfig,
    stateDirectory: join(root, 'state'),
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
  const command = async () => ({ stdout: head });
  const request = await createRequest({
    policy,
    command,
    operation,
    publish,
    ui,
    plan: {
      id: `release-${'d'.repeat(24)}`,
      source: head,
      executor: 'local',
      platforms: ['ios'],
      configDigest: digest({}),
    },
  });
  const requestDir = join(policy.stateDirectory, 'dispatch', 'requests', request.id);
  const inspect = () => inspectDispatchRequests({ stateDirectory: policy.stateDirectory });
  const run = (options = {}) =>
    runRequest({
      policy,
      id: request.id,
      executor: 'local',
      command,
      validate: async () => {},
      execute: async () => ({ exitCode: 0 }),
      ...options,
    });
  const evidencePath = join(root, 'evidence.json');
  const evidence = Buffer.from(
    '{"observation":"operator reconciliation of terminal runs and stopped children"}\n',
  );
  await writeFile(evidencePath, evidence, { mode: 0o600 });
  let maintenance;
  const admit = async () => {
    const handle = await acquireMaintenance(anchor, { operation: 'reconcile dispatch request' });
    maintenance = { anchor, owner: handle.owner };
    handles.push(handle);
    return handle;
  };
  const receipt = async (mutate = () => {}) => {
    const summary = (await inspect()).requests[0];
    const value = {
      schemaVersion: 1,
      kind: 'dispatch-retirement-reconciliation',
      requestId: request.id,
      requestDigest: summary.requestDigest,
      historyDigest: summary.originalHistoryDigest ?? summary.historyDigest,
      host: hostname(),
      operation,
      disposition: summary.state === 'unknown' ? 'interrupted' : 'unclaimed',
      observedAt: new Date().toISOString(),
      reason: 'Historical nonpublication request was reconciled by the operator.',
      attestations: {
        legacyEntriesStopped: true,
        executorAndChildrenStopped: true,
        workflowRunsTerminal: true,
        noPublicationOperations: true,
      },
      evidence: [{ path: evidencePath, sha256: digest(evidence) }],
    };
    mutate(value);
    const path = join(root, `receipt-${randomUUID()}.json`);
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    return { value, path, raw: await readFile(path, 'utf8') };
  };
  return {
    root,
    anchor,
    policy,
    request,
    requestDir,
    command,
    inspect,
    run,
    evidencePath,
    admit,
    receipt,
    retire: (path, options = {}) =>
      retireDispatchRequest({
        stateDirectory: policy.stateDirectory,
        receiptPath: path,
        maintenance,
        ...options,
      }),
    status: (override = policy) => readRequestStatus({ policy: override, id: request.id }),
  };
}
async function bytes(directory) {
  return Object.fromEntries(
    await Promise.all(
      (await readdir(directory))
        .sort()
        .map(async (name) => [name, await readFile(join(directory, name), 'utf8')]),
    ),
  );
}
async function writeRecord(path, value) {
  await atomicJson(path, { value, sha256: digest(value) }, { exclusive: true });
}
async function rewriteRecord(path, mutate) {
  const original = JSON.parse(await readFile(path, 'utf8'));
  mutate(original.value);
  original.sha256 = digest(original.value);
  await writeFile(path, `${JSON.stringify(original)}\n`);
}
async function reserve(f, receipt) {
  await writeRecord(join(f.requestDir, 'claim.json'), {
    schemaVersion: 1,
    kind: 'retirement-reservation',
    requestDigest: digest(f.request),
    token: randomUUID(),
    receiptDigest: digest(receipt.raw),
    createdAt: new Date().toISOString(),
  });
}

test('pending nonpublication requests retire with exact immutable history and replay without execution', async (t) => {
  for (const [operation, ui] of [
    ['executor-check', false],
    ['validate', false],
    ['validate', true],
  ])
    await t.test(`${operation}${ui ? ' --ui' : ''}`, async (t) => {
      const f = await fixture(t, operation, false, ui);
      const original = await bytes(f.requestDir);
      const before = (await f.inspect()).requests[0];
      const receipt = await f.receipt();
      await f.admit();
      const status = await f.retire(receipt.path);
      assert.equal(status.state, 'retired');
      assert.equal(status.originalState, 'pending');
      assert.equal(status.reconciliation, 'operator-attestation');
      assert.notEqual(dispatchExitCode(status), 0);
      const after = await bytes(f.requestDir);
      for (const [name, content] of Object.entries(original)) assert.equal(after[name], content);
      const inventory = await f.inspect();
      assert.equal(inventory.clear, true);
      assert.equal(inventory.requests[0].originalHistoryDigest, before.historyDigest);
      assert.notEqual(inventory.requests[0].historyDigest, before.historyDigest);
      assert.equal(Object.hasOwn(inventory.requests[0], 'exitCode'), false);
      const fail = () =>
        assert.fail('retired replay must have no validation, command, or dispatch effects');
      assert.deepEqual(await f.run({ command: fail, validate: fail, execute: fail }), status);
      assert.deepEqual(
        await dispatchRequest({
          policy: f.policy,
          id: f.request.id,
          mode: 'github',
          github: { available: fail, dispatch: fail },
          command: fail,
          validate: fail,
          execute: fail,
        }),
        status,
      );
      assert.deepEqual(await f.retire(receipt.path), status);
      assert.deepEqual(await bytes(f.requestDir), after);
    });
});

test('unknown requests retain original failed result and execution claim byte for byte', async (t) => {
  const f = await fixture(t, 'validate');
  await f.run({
    execute: async () => {
      throw new Error('interrupted');
    },
  });
  const original = await bytes(f.requestDir);
  const receipt = await f.receipt();
  await f.admit();
  const status = await f.retire(receipt.path);
  assert.equal(status.originalState, 'unknown');
  const after = await bytes(f.requestDir);
  assert.deepEqual(
    Object.keys(after).filter((name) => !Object.hasOwn(original, name)),
    ['retirement.json'],
  );
  for (const [name, content] of Object.entries(original)) assert.equal(after[name], content);
  assert.equal(JSON.parse(after['result.json']).value.state, 'unknown');
  assert.equal((await f.inspect()).clear, true);
  assert.equal((await f.status()).state, 'retired');
});

test('retirement wins the real claim race after worker validation and prevents execute', async (t) => {
  const f = await fixture(t);
  const entered = deferred();
  const resume = deferred();
  const worker = f.run({
    validate: async () => {
      entered.resolve();
      await resume.promise;
    },
    execute: () => assert.fail('retirement won claim'),
  });
  await entered.promise;
  const receipt = await f.receipt();
  await f.admit();
  const retired = await f.retire(receipt.path);
  resume.resolve();
  assert.deepEqual(await worker, retired);
  assert.equal(
    JSON.parse(await readFile(join(f.requestDir, 'claim.json'), 'utf8')).value.kind,
    'retirement-reservation',
  );
});

test('retirement during GitHub availability check prevents dispatch intent and POST', async (t) => {
  const f = await fixture(t);
  const entered = deferred();
  const resume = deferred();
  const pending = dispatchRequest({
    policy: f.policy,
    id: f.request.id,
    mode: 'github',
    github: {
      available: async () => {
        entered.resolve();
        await resume.promise;
        return {
          available: true,
          workflowSha: 'b'.repeat(40),
          workflowDigest: 'c'.repeat(64),
          runnerId: '1',
        };
      },
      dispatch: () => assert.fail('retired request must not POST'),
    },
    command: () => assert.fail('retired request must not call command'),
    validate: () => assert.fail('retired request must not validate'),
    execute: () => assert.fail('retired request must not execute'),
  });
  await entered.promise;
  const receipt = await f.receipt();
  await f.admit();
  const retired = await f.retire(receipt.path);
  resume.resolve();
  assert.deepEqual(await pending, retired);
  assert.equal(
    (await readdir(f.requestDir)).some((name) => name.startsWith('dispatch-')),
    false,
  );
});

test('worker wins the real claim race and retirement cannot stop or falsely settle it', async (t) => {
  const f = await fixture(t);
  const receipt = await f.receipt();
  await f.admit();
  const entered = deferred();
  const resume = deferred();
  const worker = f.run({
    execute: async () => {
      entered.resolve();
      await resume.promise;
      return { exitCode: 0 };
    },
  });
  await entered.promise;
  const original = await bytes(f.requestDir);
  await assert.rejects(f.retire(receipt.path), /exact eligible request history/);
  assert.deepEqual(await bytes(f.requestDir), original);
  resume.resolve();
  assert.equal((await worker).state, 'completed');
  assert.equal((await f.inspect()).clear, true);
});

test('crash after reservation stays blocked and resumes only with the exact same receipt bytes', async (t) => {
  const f = await fixture(t);
  const receipt = await f.receipt();
  await f.admit();
  await reserve(f, receipt);
  const claim = await readFile(join(f.requestDir, 'claim.json'), 'utf8');
  const partial = await f.inspect();
  assert.equal(partial.clear, false);
  assert.equal(partial.requests[0].state, 'retirement-incomplete');
  assert.notEqual(partial.requests[0].historyDigest, receipt.value.historyDigest);
  await assert.rejects(f.status(), /reservation is incomplete/);
  await assert.rejects(
    f.run({ validate: () => assert.fail('cannot validate') }),
    /reservation is incomplete/,
  );
  const other = await f.receipt();
  await assert.rejects(f.retire(other.path), /different receipt/);
  const changed = join(f.root, 'same-json-new-bytes.json');
  await writeFile(changed, JSON.stringify(receipt.value), { mode: 0o600 });
  await assert.rejects(f.retire(changed), /different receipt/);
  assert.equal((await f.retire(receipt.path)).state, 'retired');
  assert.equal(await readFile(join(f.requestDir, 'claim.json'), 'utf8'), claim);
});

test('retired replay tolerates old policy and removed paths while binding the actual private store and repository', async (t) => {
  const f = await fixture(t);
  const receipt = await f.receipt();
  await f.admit();
  await f.retire(receipt.path);
  await rm(f.policy.controlRepository, { recursive: true });
  await rm(f.policy.releaseConfig);
  const moved = join(f.root, 'migrated');
  await rename(f.policy.stateDirectory, moved);
  const policy = {
    ...f.policy,
    stateDirectory: moved,
    controlRepository: join(f.root, 'different-control'),
    releaseConfig: join(f.root, 'different-config'),
    github: { ...f.policy.github, runnerName: 'new-runner', enabled: false },
  };
  assert.equal((await f.status(policy)).state, 'retired');
  assert.equal((await inspectDispatchRequests({ stateDirectory: moved })).clear, true);
  const fail = () => assert.fail('old retired request cannot execute');
  assert.equal(
    (
      await runRequest({
        policy,
        id: f.request.id,
        executor: 'github',
        validate: fail,
        execute: fail,
        command: fail,
      })
    ).state,
    'retired',
  );
  assert.equal(
    (
      await dispatchRequest({
        policy,
        id: f.request.id,
        mode: 'auto',
        github: { available: fail, dispatch: fail },
        validate: fail,
        execute: fail,
        command: fail,
      })
    ).state,
    'retired',
  );
  await assert.rejects(f.status({ ...policy, repository: 'other/app' }), /another repository/);
  const alias = join(f.root, 'alias');
  await symlink(moved, alias);
  await assert.rejects(f.status({ ...policy, stateDirectory: alias }), /symlink|Noncanonical/);
});

for (const kind of ['late-intent', 'late-response', 'original-whitespace', 'retirement-tamper']) {
  test(`retirement inventory fails closed after ${kind}`, async (t) => {
    const f = await fixture(t);
    let intent;
    if (kind === 'late-response') {
      intent = {
        requestDigest: digest(f.request),
        createdAt: new Date().toISOString(),
        workflowSha: 'b'.repeat(40),
        workflowDigest: 'c'.repeat(64),
        runnerId: '1',
      };
      await writeRecord(join(f.requestDir, 'dispatch-intent.json'), intent);
    }
    const receipt = await f.receipt();
    await f.admit();
    await f.retire(receipt.path);
    if (kind === 'late-intent')
      await writeRecord(join(f.requestDir, 'dispatch-intent.json'), {
        requestDigest: digest(f.request),
        createdAt: new Date().toISOString(),
        workflowSha: 'b'.repeat(40),
        workflowDigest: 'c'.repeat(64),
        runnerId: '1',
      });
    if (kind === 'late-response')
      await writeRecord(join(f.requestDir, 'dispatch-response.json'), {
        requestDigest: digest(f.request),
        intentDigest: digest(intent),
        observedAt: new Date().toISOString(),
        state: 'accepted',
        runId: '2',
      });
    if (kind === 'original-whitespace') {
      const path = join(f.requestDir, 'request.json');
      await writeFile(path, `${await readFile(path, 'utf8')}\n`);
    }
    if (kind === 'retirement-tamper')
      await rewriteRecord(join(f.requestDir, 'retirement.json'), (value) => {
        value.originalHistoryDigest = 'f'.repeat(64);
      });
    const snapshot = await bytes(f.requestDir);
    assert.equal((await f.inspect()).clear, false);
    await assert.rejects(f.status());
    await assert.rejects(
      f.run({
        validate: () => assert.fail('cannot validate'),
        execute: () => assert.fail('cannot execute'),
      }),
    );
    assert.deepEqual(await bytes(f.requestDir), snapshot);
  });
}

for (const [name, mutate] of [
  [
    'wrong request digest',
    (r) => {
      r.requestDigest = 'f'.repeat(64);
    },
  ],
  [
    'wrong history digest',
    (r) => {
      r.historyDigest = 'f'.repeat(64);
    },
  ],
  [
    'wrong host',
    (r) => {
      r.host = 'another-machine';
    },
  ],
  [
    'wrong operation',
    (r) => {
      r.operation = 'validate';
    },
  ],
  [
    'wrong disposition',
    (r) => {
      r.disposition = 'interrupted';
    },
  ],
  [
    'extra field',
    (r) => {
      r.force = true;
    },
  ],
  [
    'missing field',
    (r) => {
      delete r.reason;
    },
  ],
  [
    'empty reason',
    (r) => {
      r.reason = ' ';
    },
  ],
  [
    'false attestation',
    (r) => {
      r.attestations.workflowRunsTerminal = false;
    },
  ],
  [
    'extra attestation',
    (r) => {
      r.attestations.machineProven = true;
    },
  ],
  [
    'empty evidence',
    (r) => {
      r.evidence = [];
    },
  ],
  [
    'bad evidence digest',
    (r) => {
      r.evidence[0].sha256 = 'f'.repeat(64);
    },
  ],
  [
    'relative evidence path',
    (r) => {
      r.evidence[0].path = 'file';
    },
  ],
  [
    'future observation',
    (r) => {
      r.observedAt = '2999-01-01T00:00:00.000Z';
    },
  ],
])
  test(`refuses ${name} without appending anything`, async (t) => {
    const f = await fixture(t);
    const receipt = await f.receipt(mutate);
    await f.admit();
    const original = await bytes(f.requestDir);
    await assert.rejects(f.retire(receipt.path));
    assert.deepEqual(await bytes(f.requestDir), original);
  });

for (const kind of [
  'receipt-public',
  'receipt-symlink',
  'evidence-public',
  'evidence-symlink',
  'evidence-hardlink',
  'evidence-changed',
]) {
  test(`refuses unsafe ${kind} without reserving the request`, async (t) => {
    const f = await fixture(t);
    const receipt = await f.receipt();
    await f.admit();
    if (kind === 'receipt-public') await chmod(receipt.path, 0o644);
    if (kind === 'receipt-symlink') {
      const file = receipt.path;
      receipt.path = join(f.root, 'receipt-alias');
      await symlink(file, receipt.path);
    }
    if (kind === 'evidence-public') await chmod(f.evidencePath, 0o644);
    if (kind === 'evidence-symlink') {
      const file = `${f.evidencePath}.original`;
      await rename(f.evidencePath, file);
      await symlink(file, f.evidencePath);
    }
    if (kind === 'evidence-hardlink') await link(f.evidencePath, `${f.evidencePath}.copy`);
    if (kind === 'evidence-changed') await writeFile(f.evidencePath, 'changed');
    const original = await bytes(f.requestDir);
    await assert.rejects(f.retire(receipt.path));
    assert.deepEqual(await bytes(f.requestDir), original);
  });
}

test('completed, run, resume, publishing and malformed histories cannot be retired', async (t) => {
  for (const kind of ['completed', 'run', 'resume', 'publishing', 'malformed'])
    await t.test(kind, async (t) => {
      const f = await fixture(
        t,
        ['run', 'resume', 'publishing'].includes(kind)
          ? kind === 'resume'
            ? 'resume'
            : 'run'
          : 'executor-check',
        kind === 'publishing',
      );
      if (kind === 'completed') await f.run();
      const receipt = await f.receipt();
      await f.admit();
      if (kind === 'malformed')
        await writeFile(join(f.requestDir, 'result.json'), '{}', { mode: 0o600 });
      const original = await bytes(f.requestDir);
      await assert.rejects(f.retire(receipt.path));
      assert.deepEqual(await bytes(f.requestDir), original);
    });
});

test('retirement requires current process exclusive maintenance and checks cancellation before append', async (t) => {
  const f = await fixture(t);
  const receipt = await f.receipt();
  const original = await bytes(f.requestDir);
  await assert.rejects(f.retire(receipt.path));
  const activity = await acquireActivity(f.anchor, { operation: 'worker' });
  await assert.rejects(
    f.retire(receipt.path, { maintenance: { anchor: f.anchor, owner: activity.owner } }),
  );
  await activity.release();
  const handle = await f.admit();
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(f.retire(receipt.path, { signal: abort.signal }), { name: 'AbortError' });
  await assert.rejects(
    f.retire(receipt.path, {
      maintenance: { anchor: f.anchor, owner: { ...handle.owner, token: randomUUID() } },
    }),
  );
  await handle.release();
  await assert.rejects(f.retire(receipt.path));
  assert.deepEqual(await bytes(f.requestDir), original);
});

test('retired history remains inspectable after external evidence expires and copied receipt remains exact', async (t) => {
  const f = await fixture(t);
  const receipt = await f.receipt();
  await f.admit();
  await f.retire(receipt.path);
  const seal = JSON.parse(await readFile(join(f.requestDir, 'retirement.json'), 'utf8')).value;
  assert.equal(seal.receipt, receipt.raw);
  assert.equal(seal.receiptDigest, digest(receipt.raw));
  await rm(f.evidencePath);
  await rm(receipt.path);
  assert.equal((await f.inspect()).clear, true);
  assert.equal((await f.status()).state, 'retired');
});
