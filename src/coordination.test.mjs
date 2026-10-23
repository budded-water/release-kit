import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
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
import { test } from 'node:test';
import {
  acquireActivity,
  acquireMaintenance,
  assertMaintenanceOwner,
  inspectCoordination,
} from './coordination.mjs';

const moduleUrl = new URL('./coordination.mjs', import.meta.url).href;
const busy = { code: 'COORDINATION_BUSY' };
const invalid = { code: 'COORDINATION_INVALID' };
const activityFile = (anchor, owner) => join(anchor, `activity-${owner.token}.json`);

async function fixture(t) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'release-coordination-'));
  await chmod(root, 0o700);
  const anchor = join(root, 'anchor');
  await mkdir(anchor, { mode: 0o700 });
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, anchor };
}

async function replaceRecord(path, owner) {
  await writeFile(path, `${JSON.stringify(owner)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

async function ownershipSnapshot(anchor) {
  return Promise.all(
    (await readdir(anchor)).sort().map(async (name) => {
      const path = join(anchor, name);
      const stat = await lstat(path);
      return {
        name,
        bytes: await readFile(path, 'base64'),
        device: stat.dev,
        inode: stat.ino,
        mode: stat.mode,
        links: stat.nlink,
      };
    }),
  );
}

const participantCode = `
  const { acquireActivity, acquireMaintenance } = await import(process.argv[1]);
  const anchor = process.argv[2];
  const kind = process.argv[3];
  let handle;
  process.on('message', async (message) => {
    if (message === 'start') {
      try {
        handle = await (kind === 'maintenance' ? acquireMaintenance : acquireActivity)(anchor, { operation: 'child ' + kind });
        process.send({ type: 'acquired', owner: handle.owner });
      } catch (error) { process.send({ type: 'refused', code: error.code, message: error.message }); }
    } else if (message === 'release') {
      try {
        await handle?.release();
        process.send({ type: 'released' }, () => process.exit(0));
      } catch (error) {
        process.send({ type: 'release-error', code: error.code, message: error.message }, () => process.exit(1));
      }
    }
  });
  process.send({ type: 'ready' });
`;

async function participant(t, anchor, kind) {
  const child = spawn(
    process.execPath,
    ['--input-type=module', '-e', participantCode, moduleUrl, anchor, kind],
    {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    },
  );
  const messages = [];
  const waiting = [];
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (value) => {
    stderr += value;
  });
  child.on('message', (message) => {
    const waiter = waiting.shift();
    if (waiter) waiter.resolve(message);
    else messages.push(message);
  });
  const exited = new Promise((resolve) =>
    child.once('exit', (code, signal) => resolve({ code, signal })),
  );
  const next = () => {
    if (messages.length) return Promise.resolve(messages.shift());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Child coordination response timed out: ${stderr}`)),
        6000,
      );
      waiting.push({
        resolve: (message) => {
          clearTimeout(timer);
          resolve(message);
        },
      });
    });
  };
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  });
  assert.equal((await next()).type, 'ready');
  return {
    child,
    next,
    exited,
    async start() {
      child.send('start');
      return next();
    },
    async release() {
      child.send('release');
      assert.equal((await next()).type, 'released');
      assert.deepEqual(await exited, { code: 0, signal: null });
    },
  };
}

test('multiple shared activities coexist, block maintenance, and release only their own records', async (t) => {
  const { anchor } = await fixture(t);
  const first = await acquireActivity(anchor, { operation: 'dispatcher' });
  const second = await acquireActivity(anchor, { operation: 'worker' });
  assert.notEqual(first.owner.token, second.owner.token);
  assert.equal((await inspectCoordination(anchor)).activities.length, 2);
  await assert.rejects(acquireMaintenance(anchor, { operation: 'update control' }), busy);
  assert.equal((await lstat(activityFile(anchor, first.owner))).mode & 0o777, 0o600);
  await first.release();
  assert.deepEqual((await inspectCoordination(anchor)).activities, [second.owner]);
  await first.release();
  await second.release();
  assert.deepEqual(await inspectCoordination(anchor), {
    anchor,
    activities: [],
    maintenance: null,
  });
  assert.deepEqual(await readdir(anchor), []);
});

test('maintenance excludes activity and other maintenance until released', async (t) => {
  const { anchor } = await fixture(t);
  const handle = await acquireMaintenance(anchor, { operation: 'migrate state' });
  assert.deepEqual((await inspectCoordination(anchor)).maintenance, handle.owner);
  await assert.rejects(acquireActivity(anchor, { operation: 'delayed worker' }), busy);
  await assert.rejects(acquireMaintenance(anchor, { operation: 'second migration' }), busy);
  await handle.release();
  const next = await acquireActivity(anchor, { operation: 'post-maintenance check' });
  await next.release();
  assert.deepEqual(await readdir(anchor), []);
});

test('reconciliation accepts only the current same-process exclusive owner without changing evidence', async (t) => {
  const { anchor } = await fixture(t);
  const handle = await acquireMaintenance(anchor, { operation: 'reconcile historical request' });
  const before = await ownershipSnapshot(anchor);
  await assertMaintenanceOwner(anchor, handle.owner);
  await assertMaintenanceOwner(anchor, structuredClone(handle.owner));
  assert.deepEqual(await ownershipSnapshot(anchor), before);
  await assert.rejects(
    acquireActivity(anchor, { operation: 'worker after ownership check' }),
    busy,
  );
  assert.deepEqual(await ownershipSnapshot(anchor), before);
  await handle.release();
});

test('shared activity cannot authorize reconciliation or alter its ownership evidence', async (t) => {
  const { anchor } = await fixture(t);
  const handle = await acquireActivity(anchor, { operation: 'source validation' });
  const before = await ownershipSnapshot(anchor);
  await assert.rejects(assertMaintenanceOwner(anchor, handle.owner), invalid);
  await assert.rejects(
    assertMaintenanceOwner(anchor, { ...handle.owner, kind: 'maintenance' }),
    invalid,
  );
  assert.deepEqual(await ownershipSnapshot(anchor), before);
  await handle.release();
});

test('another process cannot borrow the exact current maintenance owner to reconcile', async (t) => {
  const { anchor } = await fixture(t);
  const child = await participant(t, anchor, 'maintenance');
  const acquired = await child.start();
  assert.equal(acquired.type, 'acquired');
  assert.notEqual(acquired.owner.pid, process.pid);
  const before = await ownershipSnapshot(anchor);
  await assert.rejects(assertMaintenanceOwner(anchor, acquired.owner), invalid);
  assert.deepEqual(await ownershipSnapshot(anchor), before);
  await child.release();
});

test('mismatched maintenance credentials cannot authorize reconciliation or replace the real owner', async (t) => {
  const { anchor } = await fixture(t);
  const handle = await acquireMaintenance(anchor, { operation: 'reconcile historical request' });
  const before = await ownershipSnapshot(anchor);
  for (const owner of [
    undefined,
    { ...handle.owner, token: randomUUID() },
    { ...handle.owner, operation: 'different maintenance operation' },
    { ...handle.owner, createdAt: '2000-01-01T00:00:00.000Z' },
    { ...handle.owner, host: `${handle.owner.host}-other` },
    { ...handle.owner, uid: handle.owner.uid + 1 },
  ]) {
    await assert.rejects(assertMaintenanceOwner(anchor, owner), invalid);
    assert.deepEqual(await ownershipSnapshot(anchor), before);
  }
  await assertMaintenanceOwner(anchor, handle.owner);
  await handle.release();
});

test('released maintenance credentials cannot reconcile or disturb a subsequent owner', async (t) => {
  const { anchor } = await fixture(t);
  const old = await acquireMaintenance(anchor, { operation: 'earlier reconciliation' });
  await old.release();
  await assert.rejects(assertMaintenanceOwner(anchor, old.owner), invalid);
  assert.deepEqual(await readdir(anchor), []);

  const current = await acquireMaintenance(anchor, { operation: 'current reconciliation' });
  const before = await ownershipSnapshot(anchor);
  await assert.rejects(assertMaintenanceOwner(anchor, old.owner), invalid);
  assert.deepEqual(await ownershipSnapshot(anchor), before);
  await assertMaintenanceOwner(anchor, current.owner);
  await current.release();
});

test('same-handle concurrent releases are idempotent without deleting other ownership', async (t) => {
  const { anchor } = await fixture(t);
  const first = await acquireActivity(anchor, { operation: 'first' });
  const second = await acquireActivity(anchor, { operation: 'second' });
  await Promise.all([first.release(), first.release()]);
  assert.deepEqual((await inspectCoordination(anchor)).activities, [second.owner]);
  await second.release();
});

test('anchor must exist and be absolute, canonical, private, and not redirected', async (t) => {
  const { root, anchor } = await fixture(t);
  await assert.rejects(acquireActivity(join(root, 'missing'), { operation: 'run' }), {
    code: 'ENOENT',
  });
  await assert.rejects(lstat(join(root, 'missing')), { code: 'ENOENT' });
  for (const path of ['relative', `${anchor}/`, `${anchor}/../anchor`])
    await assert.rejects(acquireActivity(path, { operation: 'run' }), invalid);
  await chmod(anchor, 0o755);
  await assert.rejects(acquireActivity(anchor, { operation: 'run' }), invalid);
  await chmod(anchor, 0o700);
  const alias = join(root, 'alias');
  await symlink(anchor, alias);
  await assert.rejects(acquireActivity(alias, { operation: 'run' }), invalid);
  await mkdir(join(anchor, 'nested'), { mode: 0o700 });
  await assert.rejects(acquireMaintenance(join(alias, 'nested'), { operation: 'run' }), invalid);
  assert.deepEqual(await readdir(anchor), ['nested']);
});

test('invalid operation descriptions do not create records', async (t) => {
  const { anchor } = await fixture(t);
  for (const operation of [undefined, '', ' ', ' run', 'run\nnext', 'x'.repeat(201)])
    await assert.rejects(acquireActivity(anchor, { operation }), invalid);
  assert.deepEqual(await readdir(anchor), []);
});

test('record token replacement prevents cleanup and preserves changed ownership', async (t) => {
  const { anchor } = await fixture(t);
  const handle = await acquireMaintenance(anchor, { operation: 'update' });
  const path = join(anchor, 'maintenance.json');
  const replacement = { ...handle.owner, token: randomUUID() };
  await replaceRecord(path, replacement);
  await assert.rejects(handle.release(), invalid);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), replacement);
  await assert.rejects(acquireActivity(anchor, { operation: 'run' }), busy);
});

test('same token with changed operation or inode cannot authorize cleanup', async (t) => {
  const { anchor } = await fixture(t);
  const handle = await acquireActivity(anchor, { operation: 'run' });
  const path = activityFile(anchor, handle.owner);
  await replaceRecord(path, { ...handle.owner, operation: 'different operation' });
  await assert.rejects(handle.release(), invalid);
  const replacement = join(anchor, 'replacement');
  await replaceRecord(replacement, handle.owner);
  await rename(replacement, path);
  await assert.rejects(handle.release(), invalid);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), handle.owner);
});

test('redirected owner record is never followed or removed during cleanup', async (t) => {
  const { root, anchor } = await fixture(t);
  const handle = await acquireMaintenance(anchor, { operation: 'migrate' });
  const path = join(anchor, 'maintenance.json');
  const target = join(root, 'original-owner.json');
  await rename(path, target);
  await symlink(target, path);
  await assert.rejects(handle.release(), invalid);
  assert.equal((await lstat(path)).isSymbolicLink(), true);
  assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), handle.owner);
});

test('replaced anchor identity cannot acquire cleanup ownership in a new domain', async (t) => {
  const { root, anchor } = await fixture(t);
  const handle = await acquireActivity(anchor, { operation: 'run' });
  const moved = join(root, 'moved');
  await rename(anchor, moved);
  await mkdir(anchor, { mode: 0o700 });
  await assert.rejects(handle.release(), invalid);
  assert.deepEqual(await readdir(anchor), []);
  assert.deepEqual(
    JSON.parse(await readFile(activityFile(moved, handle.owner), 'utf8')),
    handle.owner,
  );
});

for (const variant of [
  'json',
  'filename',
  'uid',
  'permission',
  'symlink',
  'hardlink',
  'directory',
  'kind',
  'oversized',
]) {
  test(`malformed existing activity (${variant}) blocks new activity and maintenance without altering evidence`, async (t) => {
    const { root, anchor } = await fixture(t);
    const handle = await acquireActivity(anchor, { operation: 'original' });
    const path = activityFile(anchor, handle.owner);
    if (variant === 'json') await writeFile(path, '{');
    if (variant === 'filename') await rename(path, join(anchor, 'activity-corrupt.json'));
    if (variant === 'uid')
      await replaceRecord(path, { ...handle.owner, uid: handle.owner.uid + 1 });
    if (variant === 'permission') await chmod(path, 0o644);
    if (variant === 'kind') await replaceRecord(path, { ...handle.owner, kind: 'maintenance' });
    if (variant === 'oversized') await writeFile(path, 'x'.repeat(20 * 1024));
    if (variant === 'symlink') {
      const target = join(root, 'outside.json');
      await rename(path, target);
      await symlink(target, path);
    }
    if (variant === 'hardlink') await link(path, join(root, 'outside.json'));
    if (variant === 'directory') {
      await rm(path);
      await mkdir(path, { mode: 0o700 });
    }
    const before = await readdir(anchor);
    await assert.rejects(acquireActivity(anchor, { operation: 'new' }), invalid);
    await assert.rejects(acquireMaintenance(anchor, { operation: 'migrate' }), invalid);
    await assert.rejects(inspectCoordination(anchor), invalid);
    assert.deepEqual(await readdir(anchor), before);
  });
}

test('partially written maintenance record blocks all admission and inspection', async (t) => {
  const { anchor } = await fixture(t);
  const path = join(anchor, 'maintenance.json');
  await writeFile(path, '{', { mode: 0o600 });
  await assert.rejects(acquireActivity(anchor, { operation: 'new' }), invalid);
  await assert.rejects(acquireMaintenance(anchor, { operation: 'migrate' }), invalid);
  await assert.rejects(inspectCoordination(anchor), invalid);
  assert.equal(await readFile(path, 'utf8'), '{');
  assert.deepEqual(await readdir(anchor), ['maintenance.json']);
});

test('conflicting activity and maintenance ownership is retained and rejected', async (t) => {
  const { anchor } = await fixture(t);
  const handle = await acquireActivity(anchor, { operation: 'run' });
  const maintenance = {
    ...handle.owner,
    kind: 'maintenance',
    token: randomUUID(),
    operation: 'inconsistent migration',
  };
  await replaceRecord(join(anchor, 'maintenance.json'), maintenance);
  await assert.rejects(acquireActivity(anchor, { operation: 'new' }), invalid);
  await assert.rejects(acquireMaintenance(anchor, { operation: 'migrate' }), invalid);
  await assert.rejects(inspectCoordination(anchor), invalid);
  assert.deepEqual(
    JSON.parse(await readFile(activityFile(anchor, handle.owner), 'utf8')),
    handle.owner,
  );
  assert.deepEqual(
    JSON.parse(await readFile(join(anchor, 'maintenance.json'), 'utf8')),
    maintenance,
  );
});

test('ancient host and pid evidence is never expired or treated as a dead owner', async (t) => {
  const { anchor } = await fixture(t);
  const handle = await acquireActivity(anchor, { operation: 'ancient operation' });
  const path = activityFile(anchor, handle.owner);
  const ancient = {
    ...handle.owner,
    pid: 2147483647,
    host: 'retired-host',
    createdAt: '1970-01-01T00:00:00.000Z',
  };
  await replaceRecord(path, ancient);
  await assert.rejects(acquireMaintenance(anchor, { operation: 'migrate' }), busy);
  assert.deepEqual((await inspectCoordination(anchor)).activities, [ancient]);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), ancient);
});

test('stranded partial admission gate is retained and bounded waits never steal it', async (t) => {
  const { anchor } = await fixture(t);
  const gate = join(anchor, '.admission');
  await mkdir(gate, { mode: 0o700 });
  const before = Date.now();
  await assert.rejects(acquireActivity(anchor, { operation: 'run' }), busy);
  assert.ok(Date.now() - before < 5000, 'bounded admission wait');
  await assert.rejects(acquireMaintenance(anchor, { operation: 'migrate' }), busy);
  await assert.rejects(inspectCoordination(anchor), busy);
  assert.deepEqual(await readdir(gate), []);
  assert.deepEqual(await readdir(anchor), ['.admission']);
});

test('a malformed completed admission record is preserved without takeover', async (t) => {
  const { anchor } = await fixture(t);
  const gate = join(anchor, '.admission');
  await mkdir(gate, { mode: 0o700 });
  await writeFile(join(gate, 'owner.json'), '{broken', { mode: 0o600 });
  await assert.rejects(acquireActivity(anchor, { operation: 'run' }), busy);
  assert.equal(await readFile(join(gate, 'owner.json'), 'utf8'), '{broken');
});

test('redirected admission directory is rejected without touching its target', async (t) => {
  const { root, anchor } = await fixture(t);
  const target = join(root, 'target');
  await mkdir(target, { mode: 0o700 });
  await symlink(target, join(anchor, '.admission'));
  await assert.rejects(acquireActivity(anchor, { operation: 'run' }), invalid);
  assert.deepEqual(await readdir(target), []);
});

test('separate dispatcher and worker processes hold shared ownership together', async (t) => {
  const { anchor } = await fixture(t);
  const dispatcher = await participant(t, anchor, 'activity');
  const worker = await participant(t, anchor, 'activity');
  assert.equal((await dispatcher.start()).type, 'acquired');
  assert.equal((await worker.start()).type, 'acquired');
  assert.equal((await inspectCoordination(anchor)).activities.length, 2);
  await assert.rejects(acquireMaintenance(anchor, { operation: 'migrate' }), busy);
  await dispatcher.release();
  await assert.rejects(acquireMaintenance(anchor, { operation: 'migrate' }), busy);
  await worker.release();
  const maintenance = await acquireMaintenance(anchor, { operation: 'migrate' });
  await maintenance.release();
  assert.deepEqual(await readdir(anchor), []);
});

test('separate delayed worker is refused while maintenance owns admission and can run afterward', async (t) => {
  const { anchor } = await fixture(t);
  const maintenance = await participant(t, anchor, 'maintenance');
  const worker = await participant(t, anchor, 'activity');
  assert.equal((await maintenance.start()).type, 'acquired');
  assert.equal((await worker.start()).code, 'COORDINATION_BUSY');
  assert.equal((await inspectCoordination(anchor)).activities.length, 0);
  await maintenance.release();
  assert.equal((await worker.start()).type, 'acquired');
  await worker.release();
});

test('real processes racing for maintenance and activity produce only legal admission orderings', async (t) => {
  const { anchor } = await fixture(t);
  for (let round = 0; round < 4; round++) {
    const processes = await Promise.all([
      participant(t, anchor, 'activity'),
      participant(t, anchor, 'activity'),
      participant(t, anchor, 'maintenance'),
    ]);
    const outcomes = await Promise.all(processes.map((child) => child.start()));
    assert.ok(
      outcomes.every((value) => value.type === 'acquired' || value.code === 'COORDINATION_BUSY'),
    );
    const maintenanceWon = outcomes[2].type === 'acquired';
    assert.equal(
      outcomes.slice(0, 2).some((value) => value.type === 'acquired'),
      !maintenanceWon,
    );
    if (maintenanceWon) assert.ok(outcomes.slice(0, 2).every((value) => value.type === 'refused'));
    else assert.ok(outcomes.slice(0, 2).every((value) => value.type === 'acquired'));
    const status = await inspectCoordination(anchor);
    assert.equal(Boolean(status.maintenance), maintenanceWon);
    assert.equal(status.activities.length, maintenanceWon ? 0 : 2);
    await Promise.all(processes.map((child) => child.release()));
    assert.deepEqual(await readdir(anchor), []);
  }
});

for (const kind of ['activity', 'maintenance']) {
  test(`SIGKILL of ${kind} owner leaves durable evidence that blocks maintenance`, async (t) => {
    const { anchor } = await fixture(t);
    const child = await participant(t, anchor, kind);
    const acquired = await child.start();
    assert.equal(acquired.type, 'acquired');
    child.child.kill('SIGKILL');
    assert.deepEqual(await child.exited, { code: null, signal: 'SIGKILL' });
    await assert.rejects(acquireMaintenance(anchor, { operation: 'migrate after crash' }), busy);
    const status = await inspectCoordination(anchor);
    if (kind === 'activity') assert.deepEqual(status.activities, [acquired.owner]);
    else {
      assert.deepEqual(status.maintenance, acquired.owner);
      await assert.rejects(acquireActivity(anchor, { operation: 'new release' }), busy);
    }
  });
}
