import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCleanupGuard } from './cleanup.mjs';
import { runCommand } from './command.mjs';

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

test('legacy temporary fences block admission without migrating or deleting evidence', async t => {
  const { store, path } = await fixture(t);
  await writeFile(`${path}.legacy.tmp`, '{');
  await assert.rejects(createCleanupGuard(store, () => assert.fail('Must not launch')).command(), {
    cleanupIncomplete: true,
  });
  assert.equal(await readFile(`${path}.legacy.tmp`, 'utf8'), '{');
});

for (const mode of ['write-failure', 'crash-after-open', 'crash-after-sync']) {
  test(`cleanup fence survives ${mode} and blocks another process`, async t => {
    const { store, path } = await fixture(t);
    // Fault injection lives in a separate process so built-in module overrides
    // cannot affect the test runner or other tests.
    const child = `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const [store, mode, moduleUrl] = process.argv.slice(1);
      const originalOpen = fs.promises.open;
      fs.promises.open = async (...args) => {
        const handle = await originalOpen(...args);
        if (String(args[0]).includes('cleanup-incomplete.lock') && args[1] === 'wx') {
          if (mode === 'crash-after-open') process.exit(77);
          if (mode === 'write-failure') handle.writeFile = async () => {
            throw Object.assign(new Error('Synthetic full disk'), { code: 'ENOSPC' });
          };
          if (mode === 'crash-after-sync') {
            const sync = handle.sync.bind(handle);
            handle.sync = async () => { await sync(); process.exit(77); };
          }
        }
        return handle;
      };
      syncBuiltinESMExports();
      const { createCleanupGuard } = await import(moduleUrl);
      const guard = createCleanupGuard(store);
      try {
        await guard.capture(Object.assign(new Error('Synthetic unsettled process'), { cleanupIncomplete: true }));
      } catch (error) {
        if (error.cleanupIncomplete !== true || !guard.blocked) throw error;
        process.stdout.write('blocked');
      }
    `;
    const action = runCommand(process.execPath, ['--input-type=module', '-e', child, store, mode, new URL('./cleanup.mjs', import.meta.url).href]);
    if (mode.startsWith('crash-')) await assert.rejects(action, error => error.exitCode === 77);
    else assert.equal((await action).stdout, 'blocked');
    // The admission authority exists even when diagnostic JSON is incomplete.
    const bytes = await readFile(path);
    if (mode !== 'crash-after-sync') assert.equal(bytes.length, 0);
    await assert.rejects(createCleanupGuard(store, () => assert.fail('Must not launch')).command(), {
      cleanupIncomplete: true,
    });
  });
}
