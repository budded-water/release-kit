import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { openSync, writeSync, closeSync } from 'node:fs';
import { chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { privateDirectory } from './state.mjs';

// Raw tool output stays in a private diagnostic file, never in the release journal.
async function diagnosticLog(directory, limit = 16 * 1024 * 1024) {
  if (!directory) return null;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Invalid diagnostic log limit');
  await privateDirectory(directory);
  await chmod(directory, 0o700);
  const path = join(directory, `${Date.now()}-${randomUUID()}.log`);
  const descriptor = openSync(path, 'wx', 0o600);
  let bytes = 0;
  let truncated = false;
  return {
    path,
    write(chunk) {
      if (truncated) return;
      const remaining = limit - bytes;
      const content = chunk.subarray(0, remaining);
      // Regular file writes may be partial; retain each available diagnostic byte.
      for (let offset = 0; offset < content.length; )
        offset += writeSync(descriptor, content, offset, content.length - offset);
      bytes += content.length;
      if (chunk.length > remaining) {
        writeSync(descriptor, '\n[Diagnostic log truncated at its byte limit.]\n');
        truncated = true;
      }
    },
    close() {
      closeSync(descriptor);
    },
  };
}

function processGroupAlive(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

async function onlyZombieMembers(pid, timeout) {
  const output = await new Promise((resolve, reject) => {
    // A killed orphan can remain visible to kill(0) until the OS reaps it. Read
    // only group IDs and process states; never collect arguments or environment.
    execFile(
      '/bin/ps',
      ['-axo', 'pgid=,stat='],
      { timeout, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
  const members = [];
  for (const line of output.trim().split('\n')) {
    const match = /^\s*(\d+)\s+([A-Za-z+<>-]+)\s*$/.exec(line);
    if (!match) throw new Error('Unable to inspect command process group');
    if (Number(match[1]) === pid) members.push(match[2]);
  }
  return members.length > 0 && members.every((state) => state.startsWith('Z'));
}

async function settleProcessGroup(pid) {
  if (!pid || process.platform === 'win32') return { descendants: false, complete: true };
  try {
    if (!processGroupAlive(pid)) return { descendants: false, complete: true };
  } catch {
    // macOS can report EPERM for a group containing only unreaped zombies.
    // Neither that error nor a denied signal proves that live members stopped.
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (error) {
    if (error.code === 'ESRCH') return { descendants: true, complete: true };
  }
  const deadline = performance.now() + 5000;
  let inspectAfter = performance.now() + 100;
  while (true) {
    try {
      if (!processGroupAlive(pid)) return { descendants: true, complete: true };
    } catch {
      // Use the same bounded state inspection for unobservable groups.
    }
    const remaining = deadline - performance.now();
    if (remaining <= 0) return { descendants: true, complete: false };
    if (performance.now() >= inspectAfter) {
      try {
        if (await onlyZombieMembers(pid, Math.max(1, Math.min(1000, remaining))))
          return { descendants: true, complete: true };
      } catch {
        // A denied/failed process inspection proves nothing. A later ESRCH
        // can still establish settlement within the same bounded window.
      }
      inspectAfter = performance.now() + 250;
    }
    await delay(Math.min(25, Math.max(1, deadline - performance.now())));
  }
}

// Never use a shell or include arguments/environment in public error messages.
export async function runCommand(binary, args, options = {}) {
  if (options.signal?.aborted) throw new Error('Release execution interrupted');
  // Structured credential/environment reads must not persist their response bodies.
  const log =
    options.diagnostics === false
      ? null
      : await diagnosticLog(options.logDirectory, options.maxLogBytes);
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      log?.close();
      reject(new Error('Release execution interrupted'));
      return;
    }
    let child;
    try {
      child = spawn(binary, args, {
        cwd: options.cwd,
        env: options.env ?? process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      });
    } catch (error) {
      log?.close();
      reject(error);
      return;
    }
    const chunks = { stdout: [], stderr: [] };
    let bytes = 0;
    let stopped = false;
    let force;
    let logError;
    let startError;
    let killError = false;
    const kill = (signal) => {
      if (!child.pid) return;
      try {
        process.kill(process.platform === 'win32' ? child.pid : -child.pid, signal);
      } catch (error) {
        if (error.code !== 'ESRCH') killError = true;
      }
    };
    const stop = () => {
      if (stopped) return;
      stopped = true;
      kill('SIGTERM');
      force = setTimeout(() => kill('SIGKILL'), options.cleanupMs ?? 5000);
    };
    const timeout = setTimeout(stop, options.timeoutMs ?? options.timeout ?? 120000);
    const onInterrupt = () => stop();
    options.signal?.addEventListener('abort', onInterrupt, { once: true });
    process.once('SIGINT', onInterrupt);
    process.once('SIGTERM', onInterrupt);
    for (const stream of ['stdout', 'stderr'])
      child[stream].on('data', (chunk) => {
        try {
          log?.write(chunk);
        } catch {
          logError = true;
          stop();
        }
        bytes += chunk.length;
        if (bytes > (options.maxBuffer ?? 64 * 1024 * 1024)) stop();
        else chunks[stream].push(chunk);
      });
    const cleanup = () => {
      clearTimeout(timeout);
      clearTimeout(force);
      options.signal?.removeEventListener('abort', onInterrupt);
      process.removeListener('SIGINT', onInterrupt);
      process.removeListener('SIGTERM', onInterrupt);
    };
    child.once('error', (error) => {
      startError = error.code ?? 'tool error';
    });
    child.once('close', async (code, signal) => {
      // Direct-child close does not prove that redirected same-group descendants
      // stopped. Keep interruption handlers until settlement completes.
      clearTimeout(timeout);
      clearTimeout(force);
      const settlement = await settleProcessGroup(child.pid);
      cleanup();
      try {
        log?.close();
      } catch {
        logError = true;
      }
      const result = {
        code,
        exitCode: code,
        stdout: Buffer.concat(chunks.stdout).toString(),
        stderr: Buffer.concat(chunks.stderr).toString(),
        ...(log ? { logPath: log.path } : {}),
      };
      if (
        code === 0 &&
        !stopped &&
        !startError &&
        !logError &&
        !killError &&
        !settlement.descendants &&
        settlement.complete
      )
        resolve(result);
      else {
        const failure = !settlement.complete
          ? `${binary} process group cleanup could not be established`
          : settlement.descendants && !stopped
            ? `${binary} exited with surviving process group descendants`
            : killError
              ? `${binary} process group interruption failed`
              : startError
                ? `Unable to start ${binary}: ${startError}`
                : logError
                  ? `${binary} diagnostic logging failed`
                  : `${binary} ${stopped ? 'interrupted, timed out, or exceeded its output limit' : `failed (${signal ?? code})`}`;
        const error = new Error(
          `${failure}; ${log ? `private diagnostic log: ${log.path}` : 'inspect the tool locally before retrying'}`,
        );
        error.code = code;
        error.exitCode = code;
        error.interrupted = stopped;
        if (!settlement.complete) error.cleanupIncomplete = true;
        if (log) error.logPath = log.path;
        // Sensitive commands never attach captured tool output to thrown errors.
        if (!options.sensitive) {
          error.stdout = result.stdout;
          error.stderr = result.stderr;
        }
        reject(error);
      }
    });
  });
}
