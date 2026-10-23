import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { atomicJson, digest, privateDirectory } from './state.mjs';
import { readRequestStatus } from './executor.mjs';

export function validateObservationTargets(releases, requests) {
  if (
    !Array.isArray(releases) ||
    !Array.isArray(requests) ||
    releases.length + requests.length < 1 ||
    releases.length + requests.length > 20 ||
    new Set(releases).size !== releases.length ||
    new Set(requests).size !== requests.length ||
    releases.some((id) => typeof id !== 'string' || !/^release-[a-f0-9]{24}$/.test(id)) ||
    requests.some((id) => typeof id !== 'string' || !/^request-[a-f0-9]{32}$/.test(id))
  )
    throw new Error('Observe requires 1–20 unique explicit --release/--request IDs');
}

async function observeRequest({ policy, id, github, signal }) {
  signal?.throwIfAborted();
  const snapshot = await readRequestStatus({ policy, id });
  signal?.throwIfAborted();
  const worker = {
    state: snapshot.state,
    ...(snapshot.executor ? { executor: snapshot.executor } : {}),
    ...(snapshot.result?.state === 'completed' ? { exitCode: snapshot.result.exitCode } : {}),
  };
  const report = { requestId: id, stateDigest: digest(snapshot), worker };
  const claim = snapshot.claim?.executor === 'github' ? snapshot.claim.worker : null;
  const receiptId = snapshot.dispatch?.response?.runId;
  const workflowSha = snapshot.dispatch?.intent?.workflowSha;
  if (
    claim &&
    (claim.workflowSha !== workflowSha ||
      claim.repository !== policy.repository ||
      (receiptId && receiptId !== claim.runId))
  )
    return {
      ...report,
      ok: false,
      workflow: { ok: false, reason: 'run-identity-conflict' },
      agreement: 'unknown',
    };
  const runId = claim?.runId ?? receiptId;
  if (!runId) {
    const dispatched = Boolean(snapshot.dispatch || claim);
    return {
      ...report,
      ok: !dispatched,
      workflow: { ok: !dispatched, reason: dispatched ? 'unresolved-run-id' : 'not-applicable' },
      agreement: dispatched ? 'unknown' : 'not-applicable',
    };
  }
  const workflow = await github.observeRun({
    runId,
    runAttempt: claim?.runAttempt ?? 1,
    workflowSha,
    signal,
  });
  signal?.throwIfAborted();
  const workerDone = worker.state === 'completed';
  const workflowDone = workflow.ok && workflow.status === 'completed';
  const agreement = !workflow.ok
    ? 'unknown'
    : !workerDone || !workflowDone
      ? 'pending'
      : (worker.exitCode === 0) === (workflow.conclusion === 'success')
        ? 'consistent'
        : 'different';
  return { ...report, ok: workflow.ok === true, workflow, agreement };
}

// A scheduler may call this once per interval. This never advances a release or
// rewrites execution history: reports are separate, immutable observations.
export async function observeTargets({
  releases = [],
  requests = [],
  store,
  configDigest,
  control,
  runner,
  policy,
  github,
  signal,
}) {
  validateObservationTargets(releases, requests);
  if (requests.length && (!policy || !github?.observeRun))
    throw new Error('Request observation requires an executor policy and GitHub observer');
  const directory = join(store, 'observations');
  await privateDirectory(directory);
  const report = {
    schemaVersion: 1,
    operation: 'observe',
    startedAt: new Date().toISOString(),
    configDigest,
    control,
    scope:
      'Independent observations only; release outcomes, publication ownership and dispatch history are unchanged.',
    releases: {},
    requests: {},
  };
  for (const [kind, ids] of [
    ['releases', releases],
    ['requests', requests],
  ]) {
    for (const id of ids) {
      if (signal?.aborted) {
        report[kind][id] = { ok: false, reason: 'not-observed-interrupted' };
        continue;
      }
      try {
        if (kind === 'releases') {
          const observation = await runner.observe(id);
          signal?.throwIfAborted();
          report.releases[id] = {
            ...observation,
            ok: Object.values(observation.observations).every(
              (v) => !['unavailable', 'unsupported'].includes(v.state),
            ),
          };
        } else report.requests[id] = await observeRequest({ policy, id, github, signal });
      } catch (error) {
        // Exceptions may contain credential paths, command output or private
        // journal data. The source journal remains available for operator audit.
        const reason =
          {
            OBSERVATION_BUSY: 'busy',
            CONFIGURATION_MISMATCH: 'configuration-mismatch',
            INVALID_RECORD: 'invalid-record',
          }[error.code] ?? 'observation-unavailable';
        report[kind][id] = {
          ok: false,
          reason: signal?.aborted ? 'observation-interrupted' : reason,
          message:
            'Check the original record, configuration binding and active lock; no recovery was attempted.',
        };
      }
    }
  }
  report.finishedAt = new Date().toISOString();
  report.interrupted = Boolean(signal?.aborted);
  report.ok =
    !report.interrupted &&
    [...Object.values(report.releases), ...Object.values(report.requests)].every(
      (r) => r.ok === true,
    );
  const reportPath = join(directory, `${Date.now()}-${randomUUID()}.json`);
  await atomicJson(reportPath, report, { exclusive: true });
  return { ...report, reportPath };
}
