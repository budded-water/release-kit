import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCleanupGuard } from './cleanup.mjs';

async function fixture(t) {
  const store = await mkdtemp(join(tmpdir(), 'release-cleanup-'));
  t.after(() => rm(store, { recursive: true, force: true }));
  await mkdir(join(store, 'locks'));
  return { store, path: join(store, 'locks', 'cleanup-incomplete.lock') };
}

test('legacy stores remain usable; a captured cleanup failure fences future commands and preserves its first record', async t => {
  const { store, path } = await fixture(t);
  let calls = 0;
  const guard = createCleanupGuard(store, async () => ++calls);
  assert.equal(await guard.command('synthetic', []), 1);
  const error = Object.assign(new Error('Synthetic uncertainty'), { cleanupIncomplete: true });
  await guard.capture(error);
  const bytes = await readFile(path);
  await guard.capture(error);
  assert.deepEqual(await readFile(path), bytes);
  await assert.rejects(guard.command('synthetic', []), { cleanupIncomplete: true });
  await assert.rejects(createCleanupGuard(store, () => ++calls).command(), { cleanupIncomplete: true });
  assert.equal(calls, 1);
  // Removing the file cannot clear the current process's known uncertainty.
  await rm(path);
  await assert.rejects(guard.assertSafe(), { cleanupIncomplete: true });
});

test('partial and redirected cleanup fences block without reading or rewriting evidence', async t => {
  for (const variant of ['partial', 'directory', 'symlink']) {
    const { store, path } = await fixture(t);
    if (variant === 'partial') await writeFile(path, '{');
    if (variant === 'directory') await mkdir(path);
    if (variant === 'symlink') await symlink(join(store, 'absent'), path);
    let launched = false;
    const guard = createCleanupGuard(store, () => { launched = true; });
    await assert.rejects(guard.command(), { code: 'CLEANUP_INCOMPLETE' });
    assert.equal(launched, false);
    if (variant === 'partial') assert.equal(await readFile(path, 'utf8'), '{');
  }
});
