import { lstat } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { atomicJson } from './state.mjs';

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
      if (error.code === 'ENOENT') return;
      throw error;
    }
    // Even a partial, malformed or redirected fence blocks admission.
    blocked = true;
    throw failure();
  }
  async function capture(error) {
    if (error?.cleanupIncomplete !== true) return;
    blocked = true;
    try {
      await atomicJson(path, {
        schemaVersion: 1,
        kind: 'cleanup-incomplete',
        pid: process.pid,
        host: hostname(),
        createdAt: new Date().toISOString(),
      }, { exclusive: true });
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
