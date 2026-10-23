import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import { runCommand } from './command.mjs';
import { createPlan, loadConfig, selectPlatforms } from './plan.mjs';
import { digest, loadState, releasePath } from './state.mjs';
import { createRunner } from './engine.mjs';
import {
  createRequest,
  dispatchRequest,
  loadExecutorPolicy,
  readRequestStatus,
  runRequest,
} from './executor.mjs';
import { createGithubExecutor } from './github-executor.mjs';
import { assertExecutionPaths, dispatchExitCode, executionHandlers } from './execution.mjs';
import { waitForReleaseStatus } from './polling.mjs';
import { inspectProviders } from './inspection.mjs';
import { observeTargets, validateObservationTargets } from './observation-sweep.mjs';
import { summarizeStatus } from './summary.mjs';

const defaultRoot = process.cwd();
const help = `Release CLI (one designated Mac and state store)

doctor --config <private.json> [--platforms ios,android,harmony] [--publish]
provider-inspect --config <private.json> [--platforms ios,android]
store-plan --config <private.json> --ref <commit> --platforms ios|android
store-apply <release-id> --config <private.json> --approve <content-plan-digest>
store-observe <release-id> --config <private.json>
observe --config <private.json> [--release <release-id>] [--request <request-id>]
plan --config <private.json> --ref <commit> [--platforms ...]
validate --config <private.json> --ref <commit> [--platforms ...] [--ui]
run --config <private.json> --ref <commit> [--platforms ...] [--publish]
resume <release-id> --config <private.json> [--publish]
status <release-id> [--remote --config <private.json> [--wait <seconds> --poll-interval <seconds>]]
executor-doctor --executor-config <private-policy.json>
executor-check --executor-config <private-policy.json> [--executor local|auto|github]
dispatch-status <request-id> --executor-config <private-policy.json>
dispatch-resume <request-id> --executor-config <private-policy.json>

Options: --state-dir <absolute-directory>, --executor local|auto|github,
         --summary (status/dispatch-status only; progress, not acceptance evidence),
         --executor-config <private-policy.json> (or RELEASE_KIT_EXECUTOR_CONFIG)
         --acceptance <platform=receipt.json> (repeatable)
         resume only: --retry-build <platform> --reconciled <reason>
         observe only: --release / --request repeatable (1–20 exact IDs)
         provider-inspect/observe: --timeout-seconds <1–300> (default 120)

Run builds and records acceptance; --publish also authorizes the recorded plan's
distribution after its gates. Resume retains that publication intent. No upload
is performed by doctor, plan, or status. Validate records isolated source checks
through the trusted project adapter. Add --ui for the same project UI gate used
by run, including any preparation declared by that adapter. Validation never builds store artifacts or
executes platform acceptance, provider preflight or publication. Auto/GitHub
dispatch validate/run/resume through
the same Mac/state store. Auto falls back only while a request is unclaimed;
dispatch-resume claims an unstarted request locally, never a running one.
Executor-check records dispatch/claim/completion only and requires an executor
policy even locally. It does not run native tools, release gates or publication.
Hosted build machines and paid hosted-runner selection are not implemented.
Remote status --wait has a deadline of up to 3600 seconds (30-second polling by
default), then awaits cancellation cleanup. It never uploads or submits.
Processing/review are not availability.
Provider-inspect reads store versions without a release, artifact, native tools
or publication policy approval; success means endpoint visibility only. Observe
writes separate reports under state/observations without changing release or
dispatch history. Both are local, bounded observations; neither advances a release.
`;
export async function main({
  args = process.argv.slice(2),
  repo = defaultRoot,
  command: executeCommand = runCommand,
  platformAdapters,
  project,
  providerInspector,
  githubExecutor,
  dispatchBinding,
  signal,
  environment = process.env,
  output = console.log,
} = {}) {
  if (signal?.aborted) return 130;
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      config: { type: 'string' },
      approve: { type: 'string' },
      ref: { type: 'string' },
      platforms: { type: 'string' },
      'state-dir': { type: 'string' },
      executor: { type: 'string', default: 'local' },
      'executor-config': { type: 'string' },
      publish: { type: 'boolean', default: false },
      ui: { type: 'boolean', default: false },
      remote: { type: 'boolean', default: false },
      wait: { type: 'string' },
      'poll-interval': { type: 'string' },
      acceptance: { type: 'string', multiple: true },
      help: { type: 'boolean' },
      summary: { type: 'boolean', default: false },
      'retry-build': { type: 'string' },
      reconciled: { type: 'string' },
      release: { type: 'string', multiple: true },
      request: { type: 'string', multiple: true },
      'timeout-seconds': { type: 'string' },
    },
  });
  if (values.help || !positionals.length) {
    output(help);
    return 0;
  }
  const operation = positionals[0];
  let waitMs;
  let pollIntervalMs;
  if (values.wait !== undefined || values['poll-interval'] !== undefined) {
    if (operation !== 'status' || !values.remote || values.wait === undefined)
      throw new Error('--wait and --poll-interval require status --remote --wait <seconds>');
    const seconds = (value, max, name) => {
      if (!/^[1-9]\d*$/.test(value) || Number(value) > max)
        throw new Error(`${name} must be an integer between 1 and ${max} seconds`);
      return Number(value) * 1000;
    };
    waitMs = seconds(values.wait, 3600, '--wait');
    pollIntervalMs = seconds(values['poll-interval'] ?? '30', 300, '--poll-interval');
  }
  if (
    ![
      'doctor',
      'provider-inspect',
      'store-plan',
      'store-apply',
      'store-observe',
      'observe',
      'plan',
      'validate',
      'run',
      'resume',
      'status',
      'executor-doctor',
      'executor-check',
      'dispatch-status',
      'dispatch-resume',
    ].includes(operation)
  )
    throw new Error(help);
  const contentOperation = ['store-plan', 'store-apply', 'store-observe'].includes(operation);
  if (values.summary) {
    if (!['status', 'dispatch-status'].includes(operation))
      throw new Error(
        '--summary is only valid for status/dispatch-status; review full plans before approval',
      );
    const emit = output;
    output = (json) => emit(JSON.stringify(summarizeStatus(operation, JSON.parse(json)), null, 2));
  }
  if (
    values.approve !== undefined &&
    (operation !== 'store-apply' || !/^[a-f0-9]{64}$/.test(values.approve))
  )
    throw new Error('--approve requires store-apply and a SHA256 plan digest');
  if (
    contentOperation &&
    (values.publish ||
      values.ui ||
      values.remote ||
      values.acceptance ||
      values['retry-build'] ||
      values.reconciled)
  )
    throw new Error('Content preparation does not accept publication, build or acceptance options');
  if (operation === 'store-plan' && !['ios', 'android'].includes(values.platforms))
    throw new Error('store-plan requires exactly one explicit iOS/Android platform');
  const inspection = operation === 'provider-inspect';
  const observing = operation === 'observe';
  const readOnlyProvider = inspection || observing;
  if ((values.release || values.request) && !observing)
    throw new Error('--release/--request are only valid for observe');
  if (values['timeout-seconds'] !== undefined && !readOnlyProvider)
    throw new Error('--timeout-seconds is only valid for provider-inspect/observe');
  const timeoutSeconds = values['timeout-seconds'] ?? '120';
  if (readOnlyProvider && (!/^[1-9]\d*$/.test(timeoutSeconds) || Number(timeoutSeconds) > 300))
    throw new Error('Observation timeout must be an integer from 1 to 300 seconds');
  if (
    readOnlyProvider &&
    (values.ref !== undefined ||
      values.publish ||
      values.acceptance !== undefined ||
      values.remote ||
      values['retry-build'] !== undefined ||
      values.reconciled !== undefined ||
      (observing && values.platforms !== undefined))
  )
    throw new Error(
      'Observation does not accept release execution, publication or recovery options',
    );
  if (observing) validateObservationTargets(values.release ?? [], values.request ?? []);
  if (values.ui && operation !== 'validate') throw new Error('--ui is only valid for validate');
  if (!['local', 'auto', 'github'].includes(values.executor))
    throw new Error('Executor must be local, auto or github');
  if (
    values.executor !== 'local' &&
    !['validate', 'run', 'resume', 'executor-check'].includes(operation)
  )
    throw new Error('Executor selection is only valid for validate/run/resume/executor-check');
  if (
    operation === 'validate' &&
    (values.publish ||
      values.acceptance !== undefined ||
      values.remote ||
      values['retry-build'] !== undefined ||
      values.reconciled !== undefined)
  )
    throw new Error(
      'Source validation does not accept publication, acceptance or recovery options',
    );
  if (
    operation === 'executor-check' &&
    (values.ref !== undefined ||
      values.platforms !== undefined ||
      values.publish ||
      values.acceptance !== undefined ||
      values.remote ||
      values['retry-build'] !== undefined ||
      values.reconciled !== undefined)
  )
    throw new Error('Executor check does not accept release, publication or recovery options');
  const dispatchOperation = ['dispatch-status', 'dispatch-resume'].includes(operation);
  const needsId =
    ['resume', 'status', 'store-apply', 'store-observe'].includes(operation) || dispatchOperation;
  if (positionals.length !== (needsId ? 2 : 1)) throw new Error('Invalid positional arguments');
  if (
    (values.publish || values.acceptance?.length) &&
    !['run', 'resume', 'doctor'].includes(operation)
  )
    throw new Error('Publication/acceptance options are not valid for this read-only command');
  if (values.remote && operation !== 'status') throw new Error('--remote is only valid for status');
  if (needsId && (values.ref || values.platforms))
    throw new Error('Resume/status use the recorded source and platform selection');
  if (operation === 'executor-doctor' && (values.ref || values.platforms))
    throw new Error('Executor doctor checks its configured runner and workflow');
  if (
    (values['retry-build'] || values.reconciled) &&
    (operation !== 'resume' || !values['retry-build'] || !values.reconciled)
  )
    throw new Error(
      'Use resume --retry-build <platform> --reconciled <reason> after confirming the old tools stopped and remote version allocation is reconciled',
    );
  const usesPolicy =
    values.executor !== 'local' ||
    dispatchOperation ||
    (observing && Boolean(values.request?.length)) ||
    ['executor-doctor', 'executor-check'].includes(operation);
  const policyFile = values['executor-config'] ?? environment.RELEASE_KIT_EXECUTOR_CONFIG;
  if (usesPolicy && !policyFile)
    throw new Error(
      'Provide --executor-config <private-policy.json> for dispatch; see config/release-executor.example.json',
    );
  if (!usesPolicy && values['executor-config'])
    throw new Error('--executor-config requires auto/github execution or a dispatch command');
  let policy = null;
  try {
    if (usesPolicy) policy = await loadExecutorPolicy(resolve(policyFile));
  } catch (error) {
    if (observing) throw new Error('Observation executor policy is unavailable or invalid');
    throw error;
  }
  if (signal?.aborted) return 130;
  const configPath = values.config ?? policy?.releaseConfig;
  const store = resolve(values['state-dir'] ?? policy?.stateDirectory ?? join(repo, '.release'));
  if (policy) assertExecutionPaths(policy, { repo, configPath, store });
  if (operation === 'dispatch-status') {
    output(JSON.stringify(await readRequestStatus({ policy, id: positionals[1] }), null, 2));
    return 0;
  }
  const existing =
    needsId && !dispatchOperation ? await loadState(releasePath(store, positionals[1])) : null;
  if (signal?.aborted) return 130;
  if (needsId && !dispatchOperation && !existing) throw new Error('Unknown release ID');
  if (operation === 'status' && !values.remote) {
    output(JSON.stringify(existing, null, 2));
    return 0;
  }
  if (!configPath)
    throw new Error('Provide --config <private.json>; see config/release.example.json');
  let config, configDigest;
  try {
    ({ config, configDigest } =
      dispatchOperation || operation === 'executor-doctor' ? {} : await loadConfig(configPath));
  } catch (error) {
    if (readOnlyProvider)
      throw new Error(
        'Observation configuration must be a readable regular schemaVersion 1 JSON file',
      );
    throw error;
  }
  if (signal?.aborted) return 130;
  if (existing && existing.plan.configDigest !== configDigest)
    throw new Error(
      'Configuration differs from the saved plan; resume requires the original configuration',
    );
  const abort = new AbortController();
  let interrupted = false;
  const stop = () => {
    interrupted = true;
    abort.abort();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  signal?.addEventListener('abort', stop, { once: true });
  if (signal?.aborted) stop();
  let diagnosticsDirectory;
  const command = (binary, argv, options = {}) =>
    executeCommand(binary, argv, {
      ...options,
      signal: options.signal ? AbortSignal.any([abort.signal, options.signal]) : abort.signal,
      logDirectory: diagnosticsDirectory ?? options.logDirectory,
    });
  try {
    if (abort.signal.aborted) return 130;
    if (readOnlyProvider) {
      const deadline = AbortSignal.timeout(Number(timeoutSeconds) * 1000);
      const observationSignal = AbortSignal.any([abort.signal, deadline]);
      if (inspection) {
        try {
          const report = await inspectProviders({
            repo,
            config,
            platforms: selectPlatforms(values.platforms ?? 'ios,android'),
            environment,
            inspector: providerInspector,
            signal: observationSignal,
          });
          output(JSON.stringify(report, null, 2));
          return report.ok ? 0 : 2;
        } catch (error) {
          if (!observationSignal.aborted) throw error;
          output(
            JSON.stringify(
              {
                schemaVersion: 1,
                operation,
                ok: false,
                reason: interrupted ? 'interrupted' : 'timeout',
                publicationReadiness: 'not-evaluated',
              },
              null,
              2,
            ),
          );
          return interrupted ? 130 : 2;
        }
      }
      try {
        const observationCommand = (binary, argv, options = {}) =>
          command(binary, argv, {
            ...options,
            signal: options.signal
              ? AbortSignal.any([observationSignal, options.signal])
              : observationSignal,
          });
        const source = (
          await observationCommand('git', ['rev-parse', 'HEAD'], {
            cwd: repo,
            sensitive: true,
            diagnostics: false,
          })
        ).stdout.trim();
        if (!/^[a-f0-9]{40}$/.test(source))
          throw new Error('Observation control commit is unavailable');
        const dirty = Boolean(
          (
            await observationCommand('git', ['status', '--porcelain', '--untracked-files=normal'], {
              cwd: repo,
              sensitive: true,
              diagnostics: false,
            })
          ).stdout.trim(),
        );
        const adapters = platformAdapters ?? {};
        const runner = createRunner({
          repo,
          store,
          config,
          command: observationCommand,
          adapters,
          project,
          environment,
          signal: observationSignal,
        });
        const report = await observeTargets({
          releases: values.release ?? [],
          requests: values.request ?? [],
          store,
          configDigest,
          control: { source, workingTreeDirty: dirty },
          runner,
          policy,
          github: policy
            ? (githubExecutor ??
              createGithubExecutor({ policy, command: observationCommand, environment }))
            : undefined,
          signal: observationSignal,
        });
        output(JSON.stringify(report, null, 2));
        return interrupted ? 130 : report.ok ? 0 : 2;
      } catch {
        output(
          JSON.stringify(
            {
              schemaVersion: 1,
              operation,
              ok: false,
              reason: interrupted
                ? 'interrupted'
                : deadline.aborted
                  ? 'timeout'
                  : 'observation-setup-or-report-unavailable',
            },
            null,
            2,
          ),
        );
        return interrupted ? 130 : 2;
      }
    }
    if (operation === 'executor-doctor') {
      const github = githubExecutor ?? createGithubExecutor({ policy, command, environment });
      const availability = await github.available();
      output(
        JSON.stringify(
          {
            repository: policy.repository,
            github: availability,
            scope:
              'workflow and designated runner visibility only; no native build, credentials, release or dispatch claim',
          },
          null,
          2,
        ),
      );
      return availability.available ? 0 : 2;
    }
    const handlers = policy
      ? executionHandlers({
          policy,
          command,
          localMain: main,
          environment,
          platformAdapters,
          project,
          signal: abort.signal,
        })
      : null;
    if (operation === 'dispatch-resume') {
      const status = await runRequest({
        policy,
        id: positionals[1],
        executor: 'local',
        command,
        signal: abort.signal,
        ...handlers,
      });
      output(JSON.stringify(status, null, 2));
      return interrupted ? 130 : dispatchExitCode(status);
    }
    const plan =
      existing?.plan ??
      (await createPlan({
        repo,
        ref: values.ref ?? (['doctor', 'executor-check'].includes(operation) ? 'HEAD' : undefined),
        platforms: selectPlatforms(values.platforms),
        config,
        configDigest,
        command,
      }));
    if (dispatchBinding && digest(plan) !== dispatchBinding.planDigest)
      throw new Error('Execution plan differs from the immutable dispatch request');
    if (operation === 'plan') {
      output(JSON.stringify(plan, null, 2));
      return 0;
    }
    if (operation === 'executor-check') {
      const request = await createRequest({ policy, plan, operation, command });
      try {
        await handlers.validate(request);
        const options = {
          policy,
          id: request.id,
          command,
          signal: abort.signal,
          ...handlers,
        };
        const status =
          values.executor === 'local'
            ? await runRequest({ ...options, executor: 'local' })
            : await dispatchRequest({
                ...options,
                mode: values.executor,
                github: githubExecutor ?? createGithubExecutor({ policy, command, environment }),
              });
        output(JSON.stringify(status, null, 2));
        return interrupted ? 130 : dispatchExitCode(status);
      } catch (error) {
        error.message = `${error.message}; dispatch request: ${request.id}`;
        throw error;
      }
    }
    diagnosticsDirectory = join(releasePath(store, plan.id), 'logs');
    const adapters =
      platformAdapters ??
      {};
    if (operation === 'doctor') {
      if (values.ref)
        throw new Error('Doctor checks the current checkout; use plan to inspect another ref');
      const results = {};
      for (const platform of plan.platforms)
        results[platform] = await adapters[platform].doctor({
          root: repo,
          repoRoot: repo,
          platform,
          plan,
          config,
          env: environment,
          command,
          publicationRequested: values.publish,
        });
      output(
        JSON.stringify(
          {
            plan,
            results,
            diagnosticsDirectory,
            scope:
              'tool/configuration prerequisites, EAS environment and (iOS --publish) read-only listing audit; no content approval or device acceptance claim',
          },
          null,
          2,
        ),
      );
      return Object.values(results).every((result) => result.checks.every((check) => check.ok))
        ? 0
        : 2;
    }
    const runner = createRunner({
      repo,
      store,
      config,
      command,
      adapters,
      project,
      environment,
      signal: abort.signal,
    });
    if (contentOperation) {
      const report = await runner.prepareContent(plan, {
        mode: operation.slice('store-'.length),
        approval: values.approve,
      });
      output(JSON.stringify(report, null, 2));
      return interrupted
        ? 130
        : operation === 'store-apply' && report.status !== 'prepared'
          ? 2
          : 0;
    }
    if (operation === 'status') {
      if (waitMs !== undefined) {
        const waited = await waitForReleaseStatus({
          observe: (observationSignal) =>
            runner.status(plan.id, { remote: true, observationSignal }),
          timeoutMs: waitMs,
          intervalMs: pollIntervalMs,
          signal: abort.signal,
        });
        output(JSON.stringify({ ...waited.state, statusPolling: waited.polling }, null, 2));
        return interrupted ? 130 : waited.polling.reason === 'available' ? 0 : 2;
      }
      output(JSON.stringify(await runner.status(plan.id, { remote: true }), null, 2));
      return 0;
    }
    const acceptance = {};
    for (const value of values.acceptance ?? []) {
      const at = value.indexOf('=');
      const platform = value.slice(0, at);
      if (
        at < 1 ||
        !plan.platforms.includes(platform) ||
        !value.slice(at + 1) ||
        acceptance[platform]
      )
        throw new Error('Acceptance must be a unique selected-platform=receipt-path pair');
      acceptance[platform] = resolve(value.slice(at + 1));
    }
    if (values.executor !== 'local') {
      const request = await createRequest({
        policy,
        plan,
        operation,
        ui: values.ui,
        publish: values.publish,
        acceptance,
        retryBuild: values['retry-build']
          ? { platform: values['retry-build'], reason: values.reconciled }
          : undefined,
        command,
      });
      try {
        await handlers.validate(request);
        const status = await dispatchRequest({
          policy,
          id: request.id,
          mode: values.executor,
          github: githubExecutor ?? createGithubExecutor({ policy, command, environment }),
          command,
          signal: abort.signal,
          ...handlers,
        });
        output(JSON.stringify(status, null, 2));
        return interrupted ? 130 : dispatchExitCode(status);
      } catch (error) {
        error.message = `${error.message}; dispatch request: ${request.id}`;
        throw error;
      }
    }
    if (operation === 'validate') {
      const state = await runner.validate(plan, { ui: values.ui });
      output(
        JSON.stringify(
          {
            operation,
            releaseId: plan.id,
            source: plan.source,
            scope: values.ui ? `source-checks-and-${project.uiScope}` : 'source-checks',
            validation: state.sourceValidation,
            ...(values.ui ? { uiValidation: state.uiValidation } : {}),
            publicationRequested: Boolean(state.publicationRequested),
            recordDirectory: releasePath(store, plan.id),
            diagnosticsDirectory,
          },
          null,
          2,
        ),
      );
      return interrupted ? 130 : 0;
    }
    const state = await runner.execute(plan, {
      publish: values.publish,
      acceptance,
      acceptanceDigests: dispatchBinding?.acceptanceDigests,
      retryBuild: values['retry-build']
        ? { platform: values['retry-build'], reason: values.reconciled }
        : undefined,
    });
    output(
      JSON.stringify(
        {
          releaseId: plan.id,
          source: plan.source,
          publicationRequested: state.publicationRequested,
          outcomes: state.outcomes,
          recordDirectory: releasePath(store, plan.id),
          diagnosticsDirectory,
        },
        null,
        2,
      ),
    );
    return interrupted
      ? 130
      : Object.values(state.outcomes).some((result) =>
            [
              'blocked',
              'unknown',
              'unavailable',
              'rejected',
              'failed',
              'awaiting_acceptance',
              'pending_operator',
              'pending-release',
            ].includes(result.state),
          )
        ? 2
        : 0;
  } finally {
    signal?.removeEventListener('abort', stop);
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 2;
    });
}
