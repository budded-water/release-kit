import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { main as localMain } from './cli.mjs';
import { runCommand } from './command.mjs';
import { loadExecutorPolicy, runRequest } from './executor.mjs';
import {
  assertExecutionPaths,
  dispatchExitCode,
  executionHandlers,
  githubWorkerIdentity,
} from './execution.mjs';

export async function workerMain({
  args = process.argv.slice(2),
  repo = process.cwd(),
  environment = process.env,
  command = runCommand,
  invoke = localMain,
  platformAdapters,
  project,
  signal,
  output = console.log,
} = {}) {
  if (signal?.aborted) return 130;
  const { values } = parseArgs({
    args,
    strict: true,
    options: { request: { type: 'string' }, 'executor-config': { type: 'string' } },
  });
  if (!values.request || !values['executor-config'])
    throw new Error(
      'Worker requires --request <request-id> and --executor-config <private-policy.json>',
    );
  const policy = await loadExecutorPolicy(resolve(values['executor-config']));
  if (signal?.aborted) return 130;
  assertExecutionPaths(policy, {
    repo,
    configPath: policy.releaseConfig,
    store: policy.stateDirectory,
  });
  const worker = githubWorkerIdentity(policy, environment);
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  signal?.addEventListener('abort', stop, { once: true });
  if (signal?.aborted) stop();
  const executeCommand = (binary, argv, options = {}) =>
    command(binary, argv, {
      ...options,
      signal: options.signal ? AbortSignal.any([abort.signal, options.signal]) : abort.signal,
    });
  try {
    if (abort.signal.aborted) return 130;
    const status = await runRequest({
      policy,
      id: values.request,
      executor: 'github',
      worker,
      command: executeCommand,
      signal: abort.signal,
      ...executionHandlers({
        policy,
        command: executeCommand,
        localMain: invoke,
        environment,
        platformAdapters,
        project,
        signal: abort.signal,
      }),
    });
    output(JSON.stringify(status, null, 2));
    // A rerun can encounter an orphaned permanent claim after an earlier crash.
    // Acknowledging that claim is not successful workflow execution.
    return abort.signal.aborted ? 130 : status.state === 'running' ? 2 : dispatchExitCode(status);
  } finally {
    signal?.removeEventListener('abort', stop);
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  workerMain()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 2;
    });
}
