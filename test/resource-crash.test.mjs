import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resourceHarness, plan } from './fixtures/resource-harness.mjs';
import { acquireMaintenance, inspectCoordination } from '../src/coordination.mjs';
import { readResourceLedger } from '../src/resource-ledger.mjs';
import { releasePath, saveState } from '../src/state.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'resource-crash-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const f = { root, ...resourceHarness(root) };
  await mkdir(f.store, { mode: 0o700 });
  await mkdir(f.anchor, { mode: 0o700 });
  const lease = await acquireMaintenance(f.anchor, { operation: 'synthetic activation' });
  await f.lifecycle.activate({ lease });
  await lease.release();
  await saveState(releasePath(f.store, plan.id), { schemaVersion: 1, plan,
    stages: { checks: { status: 'succeeded' } }, checkpoints: { ios: { upload: { state: 'intent' } } } });
  f.history = await readFile(join(releasePath(f.store, plan.id), 'events/00000001.json'));
  return f;
}

async function participant(t, f, point) {
  const child = fork(new URL('./fixtures/resource-crash-child.mjs', import.meta.url), [f.root, point],
    { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], execArgv: [] });
  let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  const exited = once(child, 'exit');
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
  const message = await Promise.race([
    once(child, 'message').then(([message]) => message),
    exited.then(() => { throw new Error(`Participant exited before boundary: ${stderr}`); }),
  ]);
  return { child, exited, message };
}

// Only this controlled child existed; the parent has observed its terminal exit.
// This models explicit operator recovery in a scratch root, never PID-based
// automatic takeover in production. Validate the exact owner before removal.
async function recoverChildOwner(f, child) {
  const files = (await readdir(f.anchor)).filter(name => name === 'maintenance.json' || name.startsWith('activity-'));
  assert.ok(files.length >= 1 && files.length <= 2);
  assert.ok(child.signalCode === 'SIGKILL' || child.exitCode === 0);
  const owners = await Promise.all(files.map(name => readFile(join(f.anchor, name), 'utf8').then(JSON.parse)));
  assert.ok(owners.every(owner => owner.pid === child.pid));
  assert.equal(new Set(owners.map(owner => owner.token)).size, 1);
  const gate = join(f.anchor, '.admission');
  try {
    const owner = JSON.parse(await readFile(join(gate, 'owner.json'), 'utf8'));
    assert.equal(owner.pid, child.pid);
    assert.deepEqual(await readdir(gate), ['owner.json']);
    await unlink(join(gate, 'owner.json'));
    await rmdir(gate);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const name of files) await unlink(join(f.anchor, name));
  return acquireMaintenance(f.anchor, { operation: 'explicit synthetic child recovery' });
}

async function attestTask(f, lease) {
  const ledger = await readResourceLedger(f.store);
  const taskId = Object.keys(ledger.state.tasks)[0];
  await f.lifecycle.reconcileTask({ lease, receipt: { schemaVersion: 1, kind: 'resource-task-settlement',
    taskId, policy: f.lifecycle.policyIdentity, historyDigest: ledger.previous,
    childrenSettled: true, sessionsSettled: true, evidenceVerified: true,
    reason: 'Parent observed the only synthetic participant exit and retained release evidence' } });
}

test('SIGKILL across allocation boundaries retains ownership and never adopts unknown cache generations', { timeout: 60000 }, async t => {
  for (const point of ['after-reservation', 'during-admission-handoff', 'after-phase-reservation', 'before-registration', 'after-registration',
    'after-directory-creation', 'after-confirmation', 'after-pending-disposition', 'during-settlement-handoff']) {
    await t.test(point, async t => {
      const f = await fixture(t);
      const running = await participant(t, f, point);
      assert.deepEqual(running.message, { type: 'boundary', point });
      const before = await readResourceLedger(f.store);
      assert.equal(Object.values(before.state.tasks)[0].reservedBytes, point === 'after-phase-reservation' ? 2 : 1);
      if (point === 'after-confirmation') {
        const competing = await participant(t, f, 'competitor');
        assert.deepEqual(competing.message, { type: 'error', code: 'COORDINATION_BUSY' });
        await competing.exited;
        assert.equal((await readResourceLedger(f.store)).previous, before.previous);
      }
      running.child.kill('SIGKILL');
      await running.exited;
      await assert.rejects(f.lifecycle.run({ plan, operation: 'validate', execute: async () => assert.fail('Stale owner must block') }),
        { code: 'COORDINATION_BUSY' });
      assert.deepEqual(await readFile(join(releasePath(f.store, plan.id), 'events/00000001.json')), f.history);
      const lease = await recoverChildOwner(f, running.child);
      try {
        await attestTask(f, lease);
        const report = await f.lifecycle.reclaim({ lease });
        if (point === 'after-directory-creation') {
          assert.equal(report.outcome, 'incomplete');
          assert.ok(report.resources[0].reasons.includes('creation-unconfirmed'));
          assert.equal((await stat(f.cache)).isDirectory(), true);
        } else {
          assert.equal(report.outcome, 'complete', JSON.stringify(report));
          if (point !== 'before-registration') await assert.rejects(stat(f.cache), { code: 'ENOENT' });
        }
      } finally { if (!lease.retained) await lease.release(); }
    });
  }
});

test('SIGKILL after durable reclaim intent, partial removal, absence and completion resumes idempotently', { timeout: 60000 }, async t => {
  for (const point of ['after-reclaim-intent', 'after-partial-deletion', 'after-deletion', 'after-reclaim-completion']) {
    await t.test(point, async t => {
      const f = await fixture(t);
      await f.lifecycle.run({ plan, operation: 'validate', execute: async session => {
        await session.prepareCache('compiler', f.workspace);
        await writeFile(join(f.cache, 'first.o'), '1');
        await writeFile(join(f.cache, 'second.o'), '2');
      } });
      await writeFile(join(f.cache, 'first.o'), '0123456789abcdef');
      const running = await participant(t, f, point);
      assert.deepEqual(running.message, { type: 'boundary', point });
      const interrupted = Object.values((await readResourceLedger(f.store)).state.resources)[0];
      assert.equal(interrupted.reuseRevoked, true);
      assert.equal(interrupted.state, point === 'after-reclaim-completion' ? 'reclaimed' : 'reclaiming');
      if (point === 'after-partial-deletion') assert.equal((await readdir(f.cache)).length, 1);
      running.child.kill('SIGKILL');
      await running.exited;
      await assert.rejects(acquireMaintenance(f.anchor, { operation: 'must not steal after crash' }), { code: 'COORDINATION_BUSY' });
      const lease = await recoverChildOwner(f, running.child);
      try {
        const report = await f.lifecycle.reclaim({ lease });
        assert.equal(report.outcome, 'complete', JSON.stringify(report));
        await assert.rejects(stat(f.cache), { code: 'ENOENT' });
        const completed = Object.values((await readResourceLedger(f.store)).state.resources)[0];
        assert.equal(completed.generation, interrupted.generation);
        assert.equal(completed.state, 'reclaimed');
        const settled = (await readResourceLedger(f.store)).previous;
        assert.equal((await f.lifecycle.reclaim({ lease })).outcome, 'complete');
        assert.equal((await readResourceLedger(f.store)).previous, settled);
        assert.deepEqual(await readFile(join(releasePath(f.store, plan.id), 'events/00000001.json')), f.history);
      } finally { if (!lease.retained) await lease.release(); }
      await f.lifecycle.run({ plan, operation: 'validate', execute: async session => {
        assert.equal(await session.reuseAvailable('checks'), false);
        await session.prepareCache('compiler', f.workspace);
      } });
      assert.notEqual(Object.values((await readResourceLedger(f.store)).state.resources)[0].generation, interrupted.generation);
    });
  }
});

test('ENOSPC after removal retains intent and ownership until completion is explicitly recovered', async t => {
  const f = await fixture(t);
  await f.lifecycle.run({ plan, operation: 'validate', execute: async session => {
    await session.prepareCache('compiler', f.workspace);
    await writeFile(join(f.cache, 'first.o'), 'kept');
  } });
  await writeFile(join(f.cache, 'first.o'), '0123456789abcdef');
  const running = await participant(t, f, 'fail-reclaim-completion');
  assert.deepEqual(running.message, { type: 'maintenance', outcome: 'incomplete', errors: ['ENOSPC'], ownershipRetained: true });
  await running.exited;
  await assert.rejects(stat(f.cache), { code: 'ENOENT' });
  assert.equal(Object.values((await readResourceLedger(f.store)).state.resources)[0].state, 'reclaiming');
  await assert.rejects(acquireMaintenance(f.anchor, { operation: 'must retain failed completion' }), { code: 'COORDINATION_BUSY' });
  const lease = await recoverChildOwner(f, running.child);
  try {
    const report = await f.lifecycle.reclaim({ lease });
    assert.equal(report.outcome, 'complete');
    assert.equal(Object.values((await readResourceLedger(f.store)).state.resources)[0].state, 'reclaimed');
    assert.deepEqual(await readFile(join(releasePath(f.store, plan.id), 'events/00000001.json')), f.history);
  } finally { if (!lease.retained) await lease.release(); }
});

test('filesystem ENOSPC at session or task settlement preserves original error, tears down sessions and protects cache', async t => {
  for (const point of ['fail-session-pending', 'fail-task-settlement']) {
    await t.test(point, async t => {
      const f = await fixture(t);
      const running = await participant(t, f, point);
      assert.deepEqual(running.message, { type: 'error', code: 'ENOSPC' });
      await running.exited;
      assert.equal(await readFile(join(f.root, 'session-stopped'), 'utf8'), 'verified synthetic settlement');
      assert.equal(await readFile(join(f.cache, 'first.o'), 'utf8'), '01234567');
      assert.equal((await inspectCoordination(f.anchor)).activities.length, 0);
      const ledger = await readResourceLedger(f.store);
      assert.equal(Object.values(ledger.state.sessions)[0].state, 'released');
      if (point === 'fail-session-pending') assert.equal(Object.values(ledger.state.tasks)[0].outcome, 'failed');
      else assert.equal(Object.values(ledger.state.tasks)[0].state, 'active');
      assert.deepEqual(await readFile(join(releasePath(f.store, plan.id), 'events/00000001.json')), f.history);
    });
  }
});
