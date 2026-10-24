import { lstat, open, readdir } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { privateDirectory } from './state.mjs';

// A failed process-group cleanup is not an ordinary retryable stage failure.
// The fence is installation state, separate from append-only release history.
export function createCleanupGuard(store, command) {
  const path = join(store, 'locks', 'cleanup-incomplete.lock');
  let blocked = false;
  const failure = () => Object.assign(new Error(
    'Process cleanup is unconfirmed. Preserve locks and reconcile the owning process and children before operator recovery.',
  ), { code: 'CLEANUP_INCOMPLETE', cleanupIncomplete: true });
  async function assertSafe() {
    if (blocked) throw failure();
    try {
      await lstat(path);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      // Earlier writers could stop after creating a temporary fence. Preserve
      // that evidence too; its missing final link is not proof of safe cleanup.
      let entries;
      try {
        entries = await readdir(join(store, 'locks'));
      } catch (readError) {
        if (readError.code === 'ENOENT') return;
        throw readError;
      }
      if (!entries.some(name => name.startsWith('cleanup-incomplete.lock.') && name.endsWith('.tmp'))) return;
    }
    // Even a partial, malformed or redirected fence blocks admission.
    blocked = true;
    throw failure();
  }
  async function capture(error) {
    if (error?.cleanupIncomplete !== true) return;
    blocked = true;
    try {
      const directory = join(store, 'locks');
      await privateDirectory(directory);
      // Establish admission exclusion before writing optional diagnostics. An
      // empty/partial file survives a failed write or a writer process crash.
      const file = await open(path, 'wx', 0o600);
      try {
        const parent = await open(directory, 'r');
        try { await parent.sync(); } finally { await parent.close(); }
        await file.writeFile(JSON.stringify({
          schemaVersion: 1,
          kind: 'cleanup-incomplete',
          pid: process.pid,
          host: hostname(),
          createdAt: new Date().toISOString(),
        }, null, 2) + '\n');
        await file.sync();
      } finally {
        await file.close();
      }
    } catch (writeError) {
      if (writeError.code !== 'EEXIST') throw failure();
    }
  }
  async function run(task) {
    await assertSafe();
    try {
      const output = await task();
      // An adapter may catch a command error to record an unknown provider result.
      // It still cannot turn an unsettled process into completed execution.
      await assertSafe();
      return output;
    } catch (error) {
      await capture(error);
      if (blocked && error?.cleanupIncomplete !== true) throw failure();
      throw error;
    }
  }
  return {
    get blocked() { return blocked; },
    assertSafe,
    capture,
    run,
    command: (...args) => run(() => command(...args)),
  };
}
