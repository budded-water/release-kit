import { resolve } from 'node:path';
import { digest, loadState, releasePath } from './state.mjs';
import { assertCheckout, createPlan, loadConfig } from './plan.mjs';

export function assertExecutionPaths(policy, { repo, configPath, store }) {
  if (
    resolve(repo) !== policy.controlRepository ||
    resolve(configPath) !== policy.releaseConfig ||
    resolve(store) !== policy.stateDirectory
  )
    throw new Error(
      'Dispatch must use the executor policy control checkout, release config and state directory',
    );
}

async function assertRepository(origin, repository, command, cwd) {
  const mismatch = () =>
    new Error('Planned origin does not match the executor policy GitHub repository');
  let name;
  let ssh;
  try {
    if (/^https:\/\//.test(origin)) {
      const url = new URL(origin);
      if (
        url.hostname !== 'github.com' ||
        url.port ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw mismatch();
      name = url.pathname.slice(1);
    } else if (/^ssh:\/\//.test(origin)) {
      const url = new URL(origin);
      if (
        url.username !== 'git' ||
        url.password ||
        url.search ||
        url.hash ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(url.hostname)
      )
        throw mismatch();
      name = url.pathname.slice(1);
      ssh = { host: url.hostname, port: url.port };
    } else {
      const match = origin.match(/^git@([A-Za-z0-9][A-Za-z0-9._-]*):(.+)$/);
      if (!match) throw mismatch();
      name = match[2];
      ssh = { host: match[1] };
    }
    if (name.replace(/\.git$/, '').toLowerCase() !== repository.toLowerCase()) throw mismatch();
    if (ssh) {
      // Resolve trusted user SSH aliases without opening a network connection.
      // The effective hostname matters: a matching owner/repo on another Git
      // server must never be scheduled under this GitHub repository identity.
      const result = await command(
        'ssh',
        ['-G', '-l', 'git', ...(ssh.port ? ['-p', ssh.port] : []), ssh.host],
        { cwd, sensitive: true, diagnostics: false },
      );
      const settings = result.stdout.split(/\r?\n/);
      const hostnames = settings.filter((line) => line.startsWith('hostname '));
      const users = settings.filter((line) => line.startsWith('user '));
      if (
        hostnames.length !== 1 ||
        hostnames[0].slice('hostname '.length).toLowerCase() !== 'github.com' ||
        users.length !== 1 ||
        users[0].slice('user '.length) !== 'git'
      )
        throw mismatch();
    }
  } catch {
    // SSH config output may contain private key and proxy paths.
    throw mismatch();
  }
}

export function executionHandlers({
  policy,
  command,
  localMain,
  environment,
  platformAdapters,
  project,
  signal,
}) {
  return {
    async validate(request) {
      await assertRepository(
        request.plan.repository,
        policy.repository,
        command,
        policy.controlRepository,
      );
      await assertCheckout(policy.controlRepository, request.controlHead, command);
      const { config, configDigest } = await loadConfig(policy.releaseConfig);
      const fresh = await createPlan({
        repo: policy.controlRepository,
        ref: request.plan.source,
        platforms: request.plan.platforms,
        config,
        configDigest,
        command,
      });
      if (digest(fresh) !== request.planDigest)
        throw new Error('Dispatch plan no longer matches its source and release configuration');
      // A connectivity check uses the plan only as an identity binding. It is
      // independent of any release journal for that source/configuration.
      if (request.operation === 'executor-check') return;
      const existing = await loadState(releasePath(policy.stateDirectory, fresh.id));
      if (
        (request.operation === 'resume' && !existing) ||
        (existing && digest(existing.plan) !== request.planDigest)
      )
        throw new Error('Dispatch resume does not match the existing release journal');
    },
    async execute(request) {
      if (request.operation === 'executor-check')
        return {
          exitCode: 0,
          summary: {
            schemaVersion: 1,
            kind: 'executor-check',
            source: request.plan.source,
            controlHead: request.controlHead,
            nodeVersion: process.version,
            scope:
              'dispatch request identity, permanent claim and execution completion only; no native tools, builds, UI-eval, device acceptance or publication',
          },
        };
      const args = [request.operation];
      if (request.operation === 'resume') args.push(request.plan.id);
      else args.push('--ref', request.plan.source, '--platforms', request.plan.platforms.join(','));
      args.push(
        '--config',
        policy.releaseConfig,
        '--state-dir',
        policy.stateDirectory,
        '--executor',
        'local',
      );
      if (request.ui === true) args.push('--ui');
      if (request.publish) args.push('--publish');
      for (const [platform, receipt] of Object.entries(request.acceptance))
        args.push('--acceptance', `${platform}=${receipt.path}`);
      if (request.retryBuild)
        args.push(
          '--retry-build',
          request.retryBuild.platform,
          '--reconciled',
          request.retryBuild.reason,
        );
      let summary;
      const exitCode = await localMain({
        args,
        repo: policy.controlRepository,
        dispatchBinding: {
          planDigest: request.planDigest,
          acceptanceDigests: Object.fromEntries(
            Object.entries(request.acceptance).map(([platform, receipt]) => [
              platform,
              receipt.sha256,
            ]),
          ),
        },
        command,
        platformAdapters,
        project,
        signal,
        environment,
        output(value) {
          // Local CLI output is structured release status, never native tool logs.
          summary = JSON.parse(value);
        },
      });
      return { exitCode, summary };
    },
  };
}

export function githubWorkerIdentity(policy, environment) {
  const ref = `refs/heads/${policy.github.ref}`;
  if (
    environment.GITHUB_ACTIONS !== 'true' ||
    environment.GITHUB_EVENT_NAME !== 'workflow_dispatch' ||
    environment.GITHUB_REPOSITORY !== policy.repository ||
    environment.GITHUB_REF !== ref ||
    environment.GITHUB_WORKFLOW_REF !==
      `${policy.repository}/.github/workflows/${policy.github.workflow}@${ref}` ||
    environment.RUNNER_NAME !== policy.github.runnerName ||
    environment.RUNNER_ENVIRONMENT !== 'self-hosted' ||
    environment.RUNNER_OS !== 'macOS' ||
    !/^[a-f0-9]{40}$/.test(environment.GITHUB_SHA ?? '') ||
    environment.GITHUB_WORKFLOW_SHA !== environment.GITHUB_SHA ||
    !/^[1-9]\d*$/.test(environment.GITHUB_RUN_ID ?? '') ||
    !/^[1-9]\d*$/.test(environment.GITHUB_RUN_ATTEMPT ?? '')
  )
    throw new Error(
      'Release worker requires the configured manual workflow on the designated self-hosted Mac',
    );
  return {
    repository: environment.GITHUB_REPOSITORY,
    runnerName: environment.RUNNER_NAME,
    workflowSha: environment.GITHUB_SHA,
    runId: environment.GITHUB_RUN_ID,
    runAttempt: Number(environment.GITHUB_RUN_ATTEMPT),
  };
}

export function dispatchExitCode(status) {
  if (status.state === 'completed') return status.result.exitCode;
  return status.state === 'running' ? 0 : 2;
}
