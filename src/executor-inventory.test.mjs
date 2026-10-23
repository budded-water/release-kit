import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmod,
  link,
  lstat,
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
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createRequest,
  dispatchRequest,
  inspectDispatchRequests,
  runRequest,
} from './executor.mjs';
import { digest } from './state.mjs';

const head = 'a'.repeat(40);
const attestation = {
  available: true,
  workflowSha: 'b'.repeat(40),
  workflowDigest: 'c'.repeat(64),
  runnerId: 123,
};

async function fixture(t, operation = 'executor-check', ui = false) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'release-inventory-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const control = join(directory, 'control');
  await mkdir(control);
  const releaseConfig = join(directory, 'private-config.json');
  await writeFile(releaseConfig, '{"sensitive":"not-for-inventory"}');
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
  const command = async (name, args) => {
    assert.equal(name, 'git');
    assert.deepEqual(args, ['rev-parse', '--verify', 'HEAD^{commit}']);
    return { stdout: head };
  };
  const request = await createRequest({
    policy,
    operation,
    ui,
    command,
    plan: {
      id: `release-${'d'.repeat(24)}`,
      source: head,
      executor: 'local',
      platforms: ['ios'],
      configDigest: digest({}),
    },
  });
  const requestDir = join(policy.stateDirectory, 'dispatch', 'requests', request.id);
  const callbacks = { validate: async () => {}, execute: async () => ({ exitCode: 0 }) };
  const run = (options = {}) =>
    runRequest({
      policy,
      id: request.id,
      executor: 'local',
      command,
      ...callbacks,
      ...options,
    });
  const github = () =>
    dispatchRequest({
      policy,
      id: request.id,
      mode: 'github',
      command,
      ...callbacks,
      github: {
        available: async () => attestation,
        dispatch: async () => {
          await run({
            executor: 'github',
            worker: {
              runnerName: policy.github.runnerName,
              repository: policy.repository,
              workflowSha: attestation.workflowSha,
              runId: 12,
              runAttempt: 1,
            },
          });
          return { runId: 12, runUrl: 'https://github.com/example/app/actions/runs/12' };
        },
      },
    });
  return {
    directory,
    policy,
    request,
    requestDir,
    run,
    github,
    inspect: () => inspectDispatchRequests({ stateDirectory: policy.stateDirectory }),
  };
}

async function snapshot(path) {
  const records = [];
  for (const name of (await readdir(path)).sort()) {
    const child = join(path, name);
    const stat = await lstat(child);
    records.push({
      name,
      mode: stat.mode,
      links: stat.nlink,
      bytes: stat.isDirectory() ? await snapshot(child) : await readFile(child, 'base64'),
    });
  }
  return records;
}

async function rewrite(f, file, mutate, { repairClaimBinding = false } = {}) {
  const path = join(f.requestDir, file);
  const record = JSON.parse(await readFile(path, 'utf8'));
  mutate(record.value);
  record.sha256 = digest(record.value);
  await writeFile(path, JSON.stringify(record));
  if (repairClaimBinding)
    await rewrite(f, 'result.json', (result) => {
      result.claimDigest = record.sha256;
    });
}

async function assertBlocked(f, reason = 'invalid-request-history') {
  const before = await snapshot(f.policy.stateDirectory);
  const result = await f.inspect();
  assert.equal(result.clear, false);
  assert.ok(
    result.blockers.some((item) => item.reason === reason),
    JSON.stringify(result),
  );
  assert.equal(JSON.stringify(result).includes(f.directory), false);
  assert.equal(JSON.stringify(result).includes('not-for-inventory'), false);
  assert.deepEqual(await snapshot(f.policy.stateDirectory), before);
  return result;
}

test('inventory settles real local request completions for every operation and exit boundary', async (t) => {
  for (const [operation, exitCode, ui = false] of [
    ['executor-check', 0],
    ['validate', 1],
    ['validate', 0, true],
    ['run', 255],
    ['resume', 130],
  ]) {
    await t.test(`${operation}${ui ? ' --ui' : ''}: ${exitCode}`, async (t) => {
      const f = await fixture(t, operation, ui);
      await f.run({ execute: async () => ({ exitCode, summary: { private: f.directory } }) });
      await rm(f.policy.releaseConfig);
      await rm(f.policy.controlRepository, { recursive: true });
      const before = await snapshot(f.policy.stateDirectory);
      const result = await f.inspect();
      assert.match(result.requests[0].historyDigest, /^[a-f0-9]{64}$/);
      const { historyDigest, ...summary } = result.requests[0];
      assert.deepEqual(
        { ...result, requests: [summary] },
        {
          clear: true,
          requests: [
            {
              id: f.request.id,
              state: 'completed',
              operation,
              requestDigest: digest(f.request),
              executor: 'local',
              exitCode,
            },
          ],
          blockers: [],
        },
      );
      assert.deepEqual(await snapshot(f.policy.stateDirectory), before);
    });
  }
});

test('GitHub completion validates historical workflow bindings without requiring current policy/config', async (t) => {
  const f = await fixture(t);
  await f.github();
  const moved = join(f.directory, 'migrated-state');
  await rename(f.policy.stateDirectory, moved);
  await rm(f.policy.releaseConfig);
  await rm(f.policy.controlRepository, { recursive: true });
  const before = await snapshot(moved);
  const result = await inspectDispatchRequests({ stateDirectory: moved });
  assert.equal(result.clear, true);
  assert.equal(result.requests[0].executor, 'github');
  assert.equal(result.requests[0].state, 'completed');
  assert.deepEqual(await snapshot(moved), before);
});

test('refused request-only and a valid pending dispatch both block without changing original bytes', async (t) => {
  const f = await fixture(t);
  let result = await assertBlocked(f, 'request-pending');
  assert.equal(result.requests[0].state, 'pending');
  const stored = JSON.parse(await readFile(join(f.requestDir, 'request.json'), 'utf8'));
  const intent = {
    requestDigest: stored.sha256,
    createdAt: new Date().toISOString(),
    workflowSha: attestation.workflowSha,
    workflowDigest: attestation.workflowDigest,
    runnerId: '123',
  };
  await writeFile(
    join(f.requestDir, 'dispatch-intent.json'),
    JSON.stringify({ value: intent, sha256: digest(intent) }),
    { mode: 0o600 },
  );
  result = await assertBlocked(f, 'request-pending');
  assert.equal(result.requests[0].state, 'pending');
});

test('active owner blocks and later completion settles; an execution exception remains unknown', async (t) => {
  const f = await fixture(t);
  let finish;
  let started;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  const running = f.run({
    execute: async () => {
      started();
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  });
  await ready;
  await assertBlocked(f, 'request-running');
  finish({ exitCode: 0 });
  await running;
  assert.equal((await f.inspect()).clear, true);
  const unknown = await fixture(t);
  await unknown.run({
    execute: async () => {
      throw new Error('private token details');
    },
  });
  const result = await assertBlocked(unknown, 'request-unknown');
  assert.equal(result.requests[0].state, 'unknown');
  assert.equal(JSON.stringify(result).includes('private token'), false);
});

test('unknown GitHub dispatch response followed by permanent local completion is settled', async (t) => {
  const f = await fixture(t);
  await dispatchRequest({
    policy: f.policy,
    id: f.request.id,
    mode: 'auto',
    command: async () => ({ stdout: head }),
    validate: async () => {},
    execute: async () => ({ exitCode: 0 }),
    github: {
      available: async () => attestation,
      dispatch: async () => {
        throw new Error('lost response');
      },
    },
  });
  assert.equal((await f.inspect()).clear, true);
});

for (const [name, file, mutate, repairClaimBinding] of [
  [
    'non-UUID owner token',
    'claim.json',
    (v) => {
      v.token = 'unverifiable-owner';
    },
    true,
  ],
  [
    'zero owner pid',
    'claim.json',
    (v) => {
      v.pid = 0;
    },
    true,
  ],
  [
    'wrong owner host',
    'claim.json',
    (v) => {
      v.host = 'different-host';
    },
    true,
  ],
  [
    'invalid claim time',
    'claim.json',
    (v) => {
      v.createdAt = 'today';
    },
    true,
  ],
  [
    'unexpected claim field',
    'claim.json',
    (v) => {
      v.secret = 'private-token';
    },
    true,
  ],
  [
    'invalid completed exit',
    'result.json',
    (v) => {
      v.exitCode = 256;
    },
  ],
  [
    'completed result without exit',
    'result.json',
    (v) => {
      delete v.exitCode;
    },
  ],
  [
    'fractional completed exit',
    'result.json',
    (v) => {
      v.exitCode = 0.5;
    },
  ],
  [
    'wrong claim binding',
    'result.json',
    (v) => {
      v.claimDigest = 'e'.repeat(64);
    },
  ],
  [
    'wrong request binding',
    'result.json',
    (v) => {
      v.requestDigest = 'e'.repeat(64);
    },
  ],
  [
    'invalid result time',
    'result.json',
    (v) => {
      v.finishedAt = '2026-01-01';
    },
  ],
  [
    'result before claim',
    'result.json',
    (v) => {
      v.finishedAt = '2000-01-01T00:00:00.000Z';
    },
  ],
  [
    'unknown result shape',
    'result.json',
    (v) => {
      v.state = 'unknown';
      v.exitCode = 0;
    },
  ],
]) {
  test(`inventory blocks rehashed ${name}`, async (t) => {
    const f = await fixture(t);
    await f.run();
    await rewrite(f, file, mutate, { repairClaimBinding });
    await assertBlocked(f);
  });
}

for (const [name, file, mutate, repairClaimBinding] of [
  [
    'workflow identity',
    'claim.json',
    (v) => {
      v.worker.workflowSha = 'e'.repeat(40);
    },
    true,
  ],
  [
    'worker repository',
    'claim.json',
    (v) => {
      v.worker.repository = 'other/app';
    },
    true,
  ],
  [
    'worker run attempt',
    'claim.json',
    (v) => {
      v.worker.runAttempt = 0;
    },
    true,
  ],
  [
    'worker run identity',
    'claim.json',
    (v) => {
      v.worker.runId = '13';
    },
    true,
  ],
  [
    'workflow digest',
    'dispatch-intent.json',
    (v) => {
      v.workflowDigest = 'bad';
    },
  ],
  [
    'runner ID',
    'dispatch-intent.json',
    (v) => {
      v.runnerId = '';
    },
  ],
  [
    'response binding',
    'dispatch-response.json',
    (v) => {
      v.intentDigest = 'e'.repeat(64);
    },
  ],
  [
    'response state',
    'dispatch-response.json',
    (v) => {
      v.state = 'completed';
    },
  ],
  [
    'response timestamp',
    'dispatch-response.json',
    (v) => {
      v.observedAt = 'tomorrow';
    },
  ],
  [
    'response URL',
    'dispatch-response.json',
    (v) => {
      v.runUrl = 'https://github.com/other/app/actions/runs/12';
    },
  ],
]) {
  test(`inventory blocks corrupt GitHub ${name}`, async (t) => {
    const f = await fixture(t);
    await f.github();
    await rewrite(f, file, mutate, { repairClaimBinding });
    await assertBlocked(f);
  });
}

for (const [name, mutate] of [
  [
    'orphan result',
    async (f) => {
      await rm(join(f.requestDir, 'claim.json'));
    },
  ],
  [
    'orphan response',
    async (f) => {
      await rm(join(f.requestDir, 'dispatch-intent.json'));
    },
  ],
  [
    'missing request',
    async (f) => {
      await rm(join(f.requestDir, 'request.json'));
    },
  ],
  [
    'partial temporary record',
    async (f) => {
      await writeFile(join(f.requestDir, 'result.json.partial.tmp'), '{', { mode: 0o600 });
    },
  ],
  [
    'unexpected nested entry',
    async (f) => {
      await mkdir(join(f.requestDir, 'extra'), { mode: 0o700 });
    },
  ],
  [
    'malformed JSON',
    async (f) => {
      await writeFile(join(f.requestDir, 'result.json'), '{');
    },
  ],
  [
    'invalid envelope digest',
    async (f) => {
      const path = join(f.requestDir, 'result.json');
      const stored = JSON.parse(await readFile(path, 'utf8'));
      stored.sha256 = 'e'.repeat(64);
      await writeFile(path, JSON.stringify(stored));
    },
  ],
  [
    'extra envelope field',
    async (f) => {
      const path = join(f.requestDir, 'result.json');
      const stored = JSON.parse(await readFile(path, 'utf8'));
      stored.extra = 'do not expose';
      await writeFile(path, JSON.stringify(stored));
    },
  ],
  [
    'hardlinked result',
    async (f) => {
      await link(join(f.requestDir, 'result.json'), join(f.directory, 'result-copy'));
    },
  ],
  [
    'symlink result',
    async (f) => {
      const path = join(f.requestDir, 'result.json');
      await rename(path, join(f.directory, 'result-original'));
      await symlink(join(f.directory, 'result-original'), path);
    },
  ],
  [
    'nonregular result',
    async (f) => {
      await rm(join(f.requestDir, 'result.json'));
      await mkdir(join(f.requestDir, 'result.json'), { mode: 0o700 });
    },
  ],
  [
    'public result',
    async (f) => {
      await chmod(join(f.requestDir, 'result.json'), 0o644);
    },
  ],
  [
    'public request directory',
    async (f) => {
      await chmod(f.requestDir, 0o755);
    },
  ],
]) {
  test(`inventory refuses ${name} without repair or deletion`, async (t) => {
    const f = await fixture(t);
    await f.github();
    await mutate(f);
    await assertBlocked(f);
  });
}

test('inventory rejects noncanonical, missing and redirected storage; absent dispatch is empty', async (t) => {
  const f = await fixture(t);
  const missing = join(f.directory, 'absent');
  assert.deepEqual(await inspectDispatchRequests({ stateDirectory: missing }), {
    clear: false,
    requests: [],
    blockers: [{ reason: 'invalid-state-directory' }],
  });
  await assert.rejects(lstat(missing), { code: 'ENOENT' });
  const alias = join(f.directory, 'alias');
  await symlink(f.policy.stateDirectory, alias);
  assert.equal((await inspectDispatchRequests({ stateDirectory: alias })).clear, false);
  assert.equal(
    (await inspectDispatchRequests({ stateDirectory: `${f.policy.stateDirectory}/..` })).clear,
    false,
  );
  await rm(join(f.policy.stateDirectory, 'dispatch'), { recursive: true });
  assert.deepEqual(await f.inspect(), { clear: true, requests: [], blockers: [] });
  await mkdir(join(f.policy.stateDirectory, 'dispatch'), { mode: 0o700 });
  assert.deepEqual((await f.inspect()).blockers, [{ reason: 'invalid-dispatch-directory' }]);
});

test('inventory fails closed on unexpected request names without exposing their content', async (t) => {
  const f = await fixture(t);
  await f.run();
  await writeFile(
    join(f.policy.stateDirectory, 'dispatch', 'requests', 'secret-work-in-progress'),
    'private',
  );
  const result = await assertBlocked(f, 'unexpected-request-entry');
  assert.equal(JSON.stringify(result).includes('secret-work-in-progress'), false);
  assert.equal(result.requests[0].state, 'completed');
});

test('historyDigest survives moving original records but detects byte-only rewrites', async (t) => {
  const f = await fixture(t);
  await f.run({ execute: async () => ({ exitCode: 255 }) });
  const before = await f.inspect();
  const moved = join(f.directory, 'moved-state');
  await rename(f.policy.stateDirectory, moved);
  const inspect = () => inspectDispatchRequests({ stateDirectory: moved });
  assert.equal((await inspect()).requests[0].historyDigest, before.requests[0].historyDigest);
  const resultPath = join(moved, 'dispatch', 'requests', f.request.id, 'result.json');
  await writeFile(resultPath, `${await readFile(resultPath, 'utf8')}\n`);
  const changed = await inspect();
  assert.equal(changed.clear, true);
  assert.equal(changed.requests[0].exitCode, 255);
  assert.equal(changed.requests[0].requestDigest, before.requests[0].requestDigest);
  assert.notEqual(changed.requests[0].historyDigest, before.requests[0].historyDigest);
});

for (const [name, mutate] of [
  [
    'relative historical path',
    (v) => {
      v.releaseConfig = 'relative.json';
    },
  ],
  [
    'noncanonical historical path',
    (v) => {
      v.stateDirectory += '/nested/..';
    },
  ],
  [
    'missing host',
    (v) => {
      delete v.host;
    },
  ],
  [
    'invalid request timestamp',
    (v) => {
      v.createdAt = '2026-01-01';
    },
  ],
  [
    'invalid repository identity',
    (v) => {
      v.repository = 'secret\nrepository';
    },
  ],
  [
    'duplicate platforms',
    (v) => {
      v.plan.platforms = ['ios', 'ios'];
    },
  ],
  [
    'invalid plan configuration digest',
    (v) => {
      v.plan.configDigest = 'not-a-digest';
    },
  ],
  [
    'unknown manifest field',
    (v) => {
      v.retired = true;
    },
  ],
]) {
  test(`inventory checks original request syntax: ${name}`, async (t) => {
    const f = await fixture(t);
    const originalPath = join(f.requestDir, 'request.json');
    const stored = JSON.parse(await readFile(originalPath, 'utf8'));
    const { id: originalId, ...identity } = stored.value;
    mutate(identity);
    identity.planDigest = digest(identity.plan);
    const id = `request-${digest(identity).slice(0, 32)}`;
    const value = { id, ...identity };
    await writeFile(originalPath, JSON.stringify({ value, sha256: digest(value) }));
    await rename(f.requestDir, join(f.policy.stateDirectory, 'dispatch', 'requests', id));
    const result = await assertBlocked(f);
    assert.equal(result.requests[0].state, 'invalid');
    assert.equal(result.requests[0].id, id);
  });
}

test('a missing completion record remains a running owner rather than being treated as settled', async (t) => {
  const f = await fixture(t);
  await f.run();
  await rm(join(f.requestDir, 'result.json'));
  const result = await assertBlocked(f, 'request-running');
  assert.equal(result.requests[0].state, 'running');
});

test('empty request directories and redirected request roots fail closed', async (t) => {
  const f = await fixture(t);
  await rm(join(f.requestDir, 'request.json'));
  await assertBlocked(f);
  const requestRoot = join(f.policy.stateDirectory, 'dispatch', 'requests');
  const elsewhere = join(f.directory, 'original-requests');
  await rename(requestRoot, elsewhere);
  await symlink(elsewhere, requestRoot);
  assert.deepEqual((await f.inspect()).blockers, [{ reason: 'invalid-dispatch-directory' }]);
});
