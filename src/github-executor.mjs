import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runCommand } from './command.mjs';
import { dedicatedRunnerLabel } from './runner-policy.mjs';

const workflowName = 'release-local.yml';
const workflowPath = `.github/workflows/${workflowName}`;
const apiVersion = '2026-03-10';
const requestPattern = /^request-[a-f0-9]{32}$/;
const shaPattern = /^[a-f0-9]{40}$/;
const pendingRunStatuses = new Set(['queued', 'in_progress', 'requested', 'waiting', 'pending']);
const runConclusions = new Set([
  'action_required',
  'cancelled',
  'failure',
  'neutral',
  'skipped',
  'stale',
  'success',
  'timed_out',
]);

const digest = (value) => createHash('sha256').update(value).digest('hex');

function unavailable(reason) {
  return { available: false, reason };
}

function validPolicy(policy) {
  return (
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(policy?.repository ?? '') &&
    typeof policy.controlRepository === 'string' &&
    policy.github?.workflow === workflowName &&
    dedicatedRunnerLabel(policy.github.runnerLabel) &&
    typeof policy.github.runnerName === 'string' &&
    policy.github.runnerName.length > 0 &&
    typeof policy.github.ref === 'string' &&
    policy.github.ref.length > 0 &&
    !/[\s\x00-\x1f\x7f]/.test(policy.github.ref)
  );
}

function positiveInteger(value) {
  if (!['string', 'number'].includes(typeof value) || !/^[1-9]\d*$/.test(String(value)))
    return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

// This client schedules only the designated Mac. It never selects a paid hosted
// runner, installs a runner, guesses billing balance, or sends release credentials.
export function createGithubExecutor({ policy, command = runCommand, environment = process.env }) {
  let verified;
  const endpoint = (suffix = '') => `repos/${policy.repository}${suffix}`;
  const api = async (path, { method = 'GET', fields = [], signal } = {}) => {
    const result = await command(
      'gh',
      [
        'api',
        '--hostname',
        'github.com',
        '--method',
        method,
        '-H',
        'Accept: application/vnd.github+json',
        '-H',
        `X-GitHub-Api-Version: ${apiVersion}`,
        path,
        ...fields.flatMap(([key, value]) => ['-f', `${key}=${value}`]),
      ],
      {
        cwd: policy.controlRepository,
        env: { ...environment, GH_PROMPT_DISABLED: '1' },
        sensitive: true,
        diagnostics: false,
        timeoutMs: 30000,
        maxBuffer: 4 * 1024 * 1024,
        signal,
      },
    );
    return result.stdout.trim();
  };
  const read = async (path) => JSON.parse(await api(path));
  const head = async () => {
    const path = policy.github.ref.split('/').map(encodeURIComponent).join('/');
    const result = await read(endpoint(`/git/ref/heads/${path}`));
    if (
      result?.ref !== `refs/heads/${policy.github.ref}` ||
      result.object?.type !== 'commit' ||
      !shaPattern.test(result.object.sha ?? '')
    )
      throw new Error('Invalid branch head');
    return result.object.sha;
  };

  async function available() {
    verified = undefined;
    if (policy?.github?.enabled !== true) return unavailable('github-disabled');
    if (!validPolicy(policy)) return unavailable('invalid-github-policy');
    try {
      const repository = await read(endpoint());
      if (
        typeof repository?.full_name !== 'string' ||
        repository.full_name.toLowerCase() !== policy.repository.toLowerCase() ||
        repository.private !== true ||
        repository.default_branch !== policy.github.ref ||
        repository.archived !== false ||
        repository.disabled !== false
      )
        return unavailable('repository-policy-mismatch');
      const workflow = await read(endpoint(`/actions/workflows/${workflowName}`));
      if (workflow?.state !== 'active' || workflow.path !== workflowPath)
        return unavailable('workflow-unavailable');

      const workflowSha = await head();
      const remote = await read(endpoint(`/contents/${workflowPath}?ref=${workflowSha}`));
      if (
        remote?.type !== 'file' ||
        remote.path !== workflowPath ||
        remote.encoding !== 'base64' ||
        typeof remote.content !== 'string' ||
        !/^[A-Za-z0-9+/=\r\n]*$/.test(remote.content)
      )
        return unavailable('workflow-content-unavailable');
      const local = await readFile(join(policy.controlRepository, workflowPath));
      const workflowDigest = digest(local);
      if (digest(Buffer.from(remote.content, 'base64')) !== workflowDigest)
        return unavailable('workflow-content-mismatch');

      // Read all pages: a second eligible runner must not silently route a request
      // to a machine without the local state/claim store, even if currently offline.
      const runners = [];
      let expectedCount;
      for (let page = 1; page <= 100; page += 1) {
        const result = await read(endpoint(`/actions/runners?per_page=100&page=${page}`));
        if (
          !Number.isSafeInteger(result?.total_count) ||
          result.total_count < 0 ||
          result.total_count > 10000 ||
          !Array.isArray(result.runners) ||
          result.runners.length > 100 ||
          (expectedCount !== undefined && result.total_count !== expectedCount)
        )
          return unavailable('runner-inventory-unavailable');
        expectedCount = result.total_count;
        runners.push(...result.runners);
        if (runners.length >= expectedCount) break;
        if (result.runners.length < 100) return unavailable('runner-inventory-unavailable');
      }
      if (
        runners.length !== expectedCount ||
        runners.some((runner) => !Number.isSafeInteger(runner?.id) || runner.id < 1) ||
        new Set(runners.map((runner) => runner.id)).size !== runners.length
      )
        return unavailable('runner-inventory-unavailable');
      if (
        runners.some(
          (runner) =>
            !Array.isArray(runner.labels) ||
            runner.labels.some((label) => typeof label?.name !== 'string'),
        )
      )
        return unavailable('runner-inventory-unavailable');
      const labelled = runners.filter((runner) =>
        runner.labels.some((label) => label.name.toLowerCase() === policy.github.runnerLabel.toLowerCase()),
      );
      if (labelled.length !== 1) return unavailable('runner-label-not-unique');
      const runner = labelled[0];
      const labels = runner.labels.map((label) => label.name.toLowerCase());
      if (
        runner.name !== policy.github.runnerName ||
        runner.os?.toLowerCase() !== 'macos' ||
        !labels.includes('self-hosted') ||
        !labels.includes('macos')
      )
        return unavailable('runner-policy-mismatch');
      if (runner.status !== 'online' || runner.busy !== false)
        return unavailable('runner-not-idle');
      if ((await head()) !== workflowSha) return unavailable('workflow-ref-changed');
      verified = { workflowSha, workflowDigest, runnerId: runner.id };
      return { available: true, reason: 'designated-mac-ready', ...verified };
    } catch {
      // Provider/CLI output may contain account or credential data. Availability
      // uncertainty is a local fallback decision, never a raw response in a journal.
      return unavailable('github-availability-unknown');
    }
  }

  async function dispatch(requestId) {
    if (typeof requestId !== 'string' || !requestPattern.test(requestId))
      throw new Error('Invalid release request ID');
    if (!verified) throw new Error('GitHub dispatch requires successful availability verification');
    const attestation = verified;
    // Each successful availability attestation permits at most one POST. Lost
    // responses require the durable same-machine claim, never a resend here.
    verified = undefined;
    let current;
    try {
      current = await head();
    } catch {
      throw new Error('GitHub dispatch preflight is unavailable; no request was sent');
    }
    if (current !== attestation.workflowSha)
      throw new Error('GitHub workflow ref changed; no request was sent');
    let response;
    try {
      response = await api(endpoint(`/actions/workflows/${workflowName}/dispatches`), {
        method: 'POST',
        fields: [
          ['ref', policy.github.ref],
          ['inputs[request_id]', requestId],
        ],
      });
      // Older API deployments may still return the historical 204 empty body.
      if (!response) return { workflowSha: attestation.workflowSha };
      const parsed = JSON.parse(response);
      if (
        !Number.isSafeInteger(parsed?.workflow_run_id) ||
        parsed.workflow_run_id < 1 ||
        parsed.html_url !==
          `https://github.com/${policy.repository}/actions/runs/${parsed.workflow_run_id}`
      )
        throw new Error('Unrecognized response');
      return {
        runId: parsed.workflow_run_id,
        runUrl: parsed.html_url,
        workflowSha: attestation.workflowSha,
      };
    } catch {
      throw new Error('GitHub dispatch response is unknown; reconcile the durable local request');
    }
  }

  // The caller must resolve these coordinates from validated immutable request
  // history. Observing an existing attempt does not require an idle runner, a
  // currently enabled dispatcher, or the branch to still point at workflowSha.
  async function observeRun({ runId, runAttempt = 1, workflowSha, signal } = {}) {
    if (!validPolicy(policy)) return { ok: false, reason: 'invalid-github-policy' };
    const id = positiveInteger(runId);
    const attempt = positiveInteger(runAttempt);
    if (!id || !attempt || !shaPattern.test(workflowSha ?? ''))
      return { ok: false, reason: 'invalid-github-observation' };
    const identity = {
      runId: String(id),
      runAttempt: attempt,
      url: `https://github.com/${policy.repository}/actions/runs/${id}/attempts/${attempt}`,
    };
    const failed = (reason) => ({ ok: false, reason, ...identity });
    if (signal?.aborted) return failed('github-observation-interrupted');
    let body;
    try {
      body = await api(endpoint(`/actions/runs/${id}/attempts/${attempt}`), { signal });
    } catch {
      // HTTP/CLI failures are deliberately indistinguishable here: gh can include
      // credentials, account data or provider bodies in its exception/output.
      return failed(signal?.aborted ? 'github-observation-interrupted' : 'github-run-unavailable');
    }
    if (signal?.aborted) return failed('github-observation-interrupted');
    let run;
    try {
      run = JSON.parse(body);
    } catch {
      return failed('github-run-response-invalid');
    }
    const sameRepository = (value) =>
      typeof value === 'string' && value.toLowerCase() === policy.repository.toLowerCase();
    // GitHub documents the path both with and without a ref suffix. Accept only
    // this workflow's pinned branch spelling, never an arbitrary workflow URL.
    const paths = [
      workflowPath,
      `${workflowPath}@${policy.github.ref}`,
      `${workflowPath}@refs/heads/${policy.github.ref}`,
    ];
    if (
      !run ||
      Array.isArray(run) ||
      run.id !== id ||
      run.run_attempt !== attempt ||
      !sameRepository(run.repository?.full_name) ||
      !sameRepository(run.head_repository?.full_name) ||
      !paths.includes(run.path) ||
      run.head_branch !== policy.github.ref ||
      run.head_sha !== workflowSha ||
      run.event !== 'workflow_dispatch'
    )
      return failed('github-run-identity-mismatch');
    const completed = run.status === 'completed' && runConclusions.has(run.conclusion);
    const pending = pendingRunStatuses.has(run.status) && run.conclusion === null;
    if (!completed && !pending) return failed('github-run-state-unknown');
    return {
      ok: true,
      state: completed ? 'completed' : 'pending',
      status: run.status,
      conclusion: run.conclusion,
      ...identity,
    };
  }

  return { available, dispatch, observeRun };
}
