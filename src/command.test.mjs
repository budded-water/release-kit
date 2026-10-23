import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, stat, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommand } from './command.mjs';

async function logs(t) {
  const root = await mkdtemp(join(tmpdir(), 'release-command-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return join(root, 'logs');
}

test('failed sensitive commands preserve private diagnostics without exposing output in errors', async (t) => {
  const logDirectory = await logs(t);
  await mkdir(logDirectory, { mode: 0o755 });
  let failure;
  try {
    await runCommand(
      process.execPath,
      [
        '-e',
        'console.log("compile stage"); console.error("private-token: pod failure"); process.exit(1)',
      ],
      { sensitive: true, logDirectory },
    );
  } catch (error) {
    failure = error;
  }
  assert.equal(failure.exitCode, 1);
  assert.equal(failure.stdout, undefined);
  assert.equal(failure.stderr, undefined);
  assert.doesNotMatch(failure.message, /private-token/);
  assert.ok(failure.message.includes(failure.logPath));
  assert.match(await readFile(failure.logPath, 'utf8'), /private-token/);
  assert.match(await readFile(failure.logPath, 'utf8'), /compile stage/);
  assert.equal((await stat(logDirectory)).mode & 0o777, 0o700);
  for (const name of await readdir(logDirectory))
    assert.equal((await stat(join(logDirectory, name))).mode & 0o777, 0o600);
});

test('success and timeout retain distinct logs, including output emitted before interruption', async (t) => {
  const logDirectory = await logs(t);
  const first = await runCommand(process.execPath, ['-e', 'console.log("built");'], {
    logDirectory,
  });
  assert.match(await readFile(first.logPath, 'utf8'), /built/);
  let failure;
  try {
    await runCommand(
      process.execPath,
      ['-e', 'console.error("last build stage"); setInterval(() => {}, 1000)'],
      { logDirectory, sensitive: true, timeout: 500 },
    );
  } catch (error) {
    failure = error;
  }
  assert.equal(failure.interrupted, true);
  assert.notEqual(failure.logPath, first.logPath);
  assert.match(await readFile(failure.logPath, 'utf8'), /last build stage/);
  assert.match(await readFile(first.logPath, 'utf8'), /built/);
});

test('diagnostic size is capped without losing the command result or stopping the tool', async (t) => {
  const logDirectory = await logs(t);
  const result = await runCommand(
    process.execPath,
    ['-e', 'process.stdout.write("x".repeat(4096))'],
    {
      logDirectory,
      maxLogBytes: 128,
    },
  );
  assert.equal(result.stdout.length, 4096);
  const content = await readFile(result.logPath, 'utf8');
  assert.ok(content.startsWith('x'.repeat(128)));
  assert.match(content, /truncated/);
  assert.ok(Buffer.byteLength(content) < 256);
});

test('redirected log directories are refused before launching a command', async (t) => {
  const logDirectory = await logs(t);
  const outside = `${logDirectory}-outside`;
  await mkdir(outside);
  await symlink(outside, logDirectory);
  await assert.rejects(
    runCommand(process.execPath, ['-e', 'process.exit(0)'], { logDirectory }),
    /symlinks/,
  );
  assert.deepEqual(await readdir(outside), []);
});

test('missing tools reject with a closed diagnostic log and never echo private arguments', async (t) => {
  const logDirectory = await logs(t);
  let failure;
  try {
    await runCommand('/release-tool-does-not-exist', ['private-password'], {
      logDirectory,
      sensitive: true,
    });
  } catch (error) {
    failure = error;
  }
  assert.match(failure.message, /Unable to start/);
  assert.doesNotMatch(failure.message, /private-password/);
  assert.ok(failure.logPath);
  assert.equal(await readFile(failure.logPath, 'utf8'), '');
});

test('structured environment reads can suppress persistence even with a release log directory', async (t) => {
  const logDirectory = await logs(t);
  const result = await runCommand(process.execPath, ['-e', 'console.log("REMOTE_PRIVATE_VALUE")'], {
    logDirectory,
    diagnostics: false,
    sensitive: true,
  });
  assert.match(result.stdout, /REMOTE_PRIVATE_VALUE/);
  assert.equal(result.logPath, undefined);
  await assert.rejects(stat(logDirectory), { code: 'ENOENT' });
});

async function descendantFixture(t, { exitCode = 0, waitForInterrupt = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'release-command-descendant-'));
  const ready = join(directory, 'ready');
  const mutated = join(directory, 'mutated');
  const childCode = `
    const { writeFileSync } = require('node:fs');
    process.on('SIGTERM', () => {});
    writeFileSync(${JSON.stringify(ready)}, String(process.pid));
    process.send('ready');
    setTimeout(() => writeFileSync(${JSON.stringify(mutated)}, 'late mutation'), 1500);
    setInterval(() => {}, 1000);
  `;
  const parentCode = `
    const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(childCode)}], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    child.once('message', () => {
      ${waitForInterrupt ? "process.on('SIGTERM', () => process.exit(0)); console.log('ready');" : `process.exit(${exitCode});`}
    });
  `;
  // Always clean the real orphan even if a regression makes runCommand return
  // before it is stopped. Tests never leave mutating child processes behind.
  t.after(async () => {
    try {
      process.kill(Number(await readFile(ready, 'utf8')), 'SIGKILL');
    } catch (error) {
      if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error;
    }
    await rm(directory, { recursive: true, force: true });
  });
  return { ready, mutated, parentCode };
}

for (const exitCode of [0, 7])
  test(
    `normal direct-child exit ${exitCode} fails and settles redirected same-group descendants`,
    { skip: process.platform === 'win32' },
    async (t) => {
      const fixture = await descendantFixture(t, { exitCode });
      await assert.rejects(runCommand(process.execPath, ['-e', fixture.parentCode]), (error) => {
        assert.equal(error.exitCode, exitCode);
        assert.equal(error.interrupted, false);
        assert.equal(error.cleanupIncomplete, undefined);
        assert.match(error.message, /surviving process group descendants/);
        return true;
      });
      await new Promise((resolve) => setTimeout(resolve, 1700));
      await assert.rejects(stat(fixture.mutated), { code: 'ENOENT' });
    },
  );

test(
  'interruption waits for same-group descendants after the direct child exits early',
  { skip: process.platform === 'win32' },
  async (t) => {
    const fixture = await descendantFixture(t, { waitForInterrupt: true });
    const abort = new AbortController();
    const logDirectory = await logs(t);
    const kill = process.kill.bind(process);
    let killAttempted;
    const attempted = new Promise((resolve) => {
      killAttempted = resolve;
    });
    let deliverKill;
    // Delay the OS boundary to prove that sending KILL alone is not settlement.
    // The child remains live and able to mutate until the real signal arrives.
    t.mock.method(process, 'kill', (pid, signal) => {
      if (pid < 0 && signal === 'SIGKILL') {
        deliverKill = setTimeout(() => {
          try {
            kill(pid, signal);
          } catch (error) {
            if (error.code !== 'ESRCH') throw error;
          }
        }, 300);
        killAttempted();
        return true;
      }
      return kill(pid, signal);
    });
    t.after(() => clearTimeout(deliverKill));
    let outcome;
    const execution = runCommand(process.execPath, ['-e', fixture.parentCode], {
      signal: abort.signal,
      logDirectory,
      cleanupMs: 500,
    }).then(
      (value) => {
        outcome = { value };
        return value;
      },
      (error) => {
        outcome = { error };
        throw error;
      },
    );
    const completion = assert.rejects(execution, (error) => {
      assert.equal(error.interrupted, true);
      assert.equal(error.exitCode, 0);
      assert.equal(error.cleanupIncomplete, undefined);
      return true;
    });
    try {
      // The parent's logged acknowledgement ensures its TERM handler is ready.
      const deadline = performance.now() + 5000;
      let acknowledged = false;
      while (performance.now() < deadline && !acknowledged) {
        for (const name of await readdir(logDirectory).catch(() => []))
          acknowledged ||= (await readFile(join(logDirectory, name), 'utf8')).includes('ready');
        if (!acknowledged) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(acknowledged, true, 'parent installed its interruption handler');
      abort.abort();
      await attempted;
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(outcome, undefined, 'command retains ownership while the child is live');
      await completion;
      await new Promise((resolve) => setTimeout(resolve, 1700));
      await assert.rejects(stat(fixture.mutated), { code: 'ENOENT' });
    } finally {
      abort.abort();
      await completion;
    }
  },
);

test(
  'unobservable process groups reject with cleanupIncomplete instead of reporting success',
  { skip: process.platform === 'win32' },
  async (t) => {
    const kill = process.kill.bind(process);
    t.mock.method(process, 'kill', (pid, signal) => {
      if (pid < 0) {
        const error = new Error('fixture denies process-group observation');
        error.code = 'EPERM';
        throw error;
      }
      return kill(pid, signal);
    });
    await assert.rejects(runCommand(process.execPath, ['-e', 'process.exit(0)']), (error) => {
      assert.equal(error.exitCode, 0);
      assert.equal(error.cleanupIncomplete, true);
      assert.match(error.message, /cleanup could not be established/);
      return true;
    });
  },
);
