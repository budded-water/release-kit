import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join } from 'node:path';
import { resourceHarness, plan } from './resource-harness.mjs';
import { acquireMaintenance } from '../../src/coordination.mjs';

const [root, point] = process.argv.slice(2);
const original = { mkdir: fs.mkdir, open: fs.open, link: fs.link, unlink: fs.unlink, rmdir: fs.rmdir };
const send = value => new Promise((resolve, reject) => process.send(value, error => error ? reject(error) : resolve()));
async function pause() {
  setInterval(() => {}, 1000);
  await send({ type: 'boundary', point });
  await new Promise(() => {});
}
const f = resourceHarness(root, {
  toolchain: async () => {
    if (point === 'before-registration') await pause();
    return 'e'.repeat(64);
  },
  releaseSession: async () => fs.writeFile(join(root, 'session-stopped'), 'verified synthetic settlement'),
});
const events = join(f.store, 'resources/events');
let event, failed = false;
fs.mkdir = async (path, ...args) => {
  if (path === f.cache && point === 'after-registration') await pause();
  const result = await original.mkdir(path, ...args);
  if (path === f.cache && point === 'after-directory-creation') await pause();
  return result;
};
fs.link = async (temporary, path) => {
  if (dirname(path) === events) {
    event = JSON.parse(await fs.readFile(temporary, 'utf8')).state;
    const fails = point === 'fail-session-pending' && Object.values(event.sessions).some(x => x.state === 'release-pending') ||
      point === 'fail-task-settlement' && Object.values(event.tasks).some(x => x.state === 'settled') ||
      point === 'fail-reclaim-completion' && Object.values(event.resources).some(x => x.state === 'reclaimed');
    if (fails && !failed) {
      failed = true;
      throw Object.assign(new Error('Synthetic filesystem full at durable settlement'), { code: 'ENOSPC' });
    }
  }
  return original.link(temporary, path);
};
fs.open = async (path, ...args) => {
  const handle = await original.open(path, ...args);
  if (path === events && args[0] === 'r') {
    const sync = handle.sync.bind(handle);
    handle.sync = async () => {
      await sync();
      const resources = Object.values(event?.resources ?? {});
      if (point === 'after-reservation' && Object.values(event?.tasks ?? {}).some(x => x.state === 'active') ||
          point === 'after-reclaim-intent' && resources.some(x => x.state === 'reclaiming') ||
          point === 'after-reclaim-completion' && resources.some(x => x.state === 'reclaimed') ||
          point === 'after-pending-disposition' && resources.some(x => x.state === 'pending')) await pause();
    };
  }
  return handle;
};
fs.unlink = async path => {
  if (point === 'during-admission-handoff' && path === join(f.anchor, 'maintenance.json') ||
      point === 'during-settlement-handoff' && path.startsWith(join(f.anchor, 'activity-'))) await pause();
  const result = await original.unlink(path);
  if (dirname(path) === f.cache && point === 'after-partial-deletion') await pause();
  return result;
};
fs.rmdir = async path => {
  const result = await original.rmdir(path);
  if (path === f.cache && point === 'after-deletion') await pause();
  return result;
};
syncBuiltinESMExports();

try {
  let finished = { type: 'finished' };
  if (point.startsWith('after-reclaim') || ['after-partial-deletion', 'after-deletion', 'fail-reclaim-completion'].includes(point)) {
    const lease = await acquireMaintenance(f.anchor, { operation: 'synthetic collector' });
    const report = await f.lifecycle.reclaim({ lease });
    if (!lease.retained) await lease.release();
    if (point === 'fail-reclaim-completion') finished = { type: 'maintenance',
      outcome: report.outcome, errors: report.errors, ownershipRetained: report.ownershipRetained };
  } else {
    await f.lifecycle.run({ plan, operation: 'validate', execute: async session => {
      if (point === 'competitor') return 'unexpected admission';
      if (point === 'after-phase-reservation') { await session.checkCapacity('execute'); await pause(); }
      const cache = await session.prepareCache('compiler', f.workspace);
      await fs.writeFile(join(cache, 'first.o'), '01234567');
      await fs.writeFile(join(cache, 'second.o'), '89abcdef');
      if (point.startsWith('fail-'))
        await session.registerSession('synthetic-session', { owner: 'known synthetic session' });
      if (point === 'after-confirmation') await pause();
    } });
  }
  await send(finished);
} catch (error) {
  await send({ type: 'error', code: error.code });
  process.exitCode = 2;
} finally { process.disconnect(); }
