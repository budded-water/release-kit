import { randomBytes, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { chmod, lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { atomicJson, digest, privateDirectory, readJson } from './state.mjs';
import { runCommand } from './command.mjs';
import { assertMaintenanceOwner } from './coordination.mjs';
import { dedicatedRunnerLabel } from './runner-policy.mjs';

const SHA = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const REQUEST = /^request-[a-f0-9]{32}$/;
const PLATFORMS = ['ios', 'android', 'harmony'];
const now = () => new Date().toISOString();
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
const keys = (value, allowed) =>
  object(value) && Object.keys(value).every((key) => allowed.includes(key));

function absolute(value, name) {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0'))
    throw new Error(`${name} must be an absolute local path`);
  return resolve(value);
}

function normalizePolicy(value) {
  if (
    !keys(value, [
      'schemaVersion',
      'repository',
      'controlRepository',
      'releaseConfig',
      'stateDirectory',
      'github',
    ]) ||
    value.schemaVersion !== 1 ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value.repository ?? '')
  )
    throw new Error('Executor policy must identify schemaVersion 1 and owner/repository');
  const github = value.github;
  if (
    !keys(github, [
      'enabled',
      'workflow',
      'ref',
      'runnerName',
      'runnerLabel',
      'startTimeoutSeconds',
      'pollSeconds',
    ]) ||
    typeof github.enabled !== 'boolean' ||
    github.workflow !== 'release-local.yml' ||
    typeof github.ref !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(github.ref) ||
    /\.\.|\/\/|\/$|\.$|\.lock(?:\/|$)/.test(github.ref) ||
    typeof github.runnerName !== 'string' ||
    !github.runnerName.trim() ||
    github.runnerName.length > 255 ||
    /[\r\n\0]/.test(github.runnerName) ||
    !dedicatedRunnerLabel(github.runnerLabel)
  )
    throw new Error(
      'Executor GitHub policy must identify the supported workflow and dedicated runner',
    );
  const startTimeoutSeconds = github.startTimeoutSeconds ?? 60;
  const pollSeconds = github.pollSeconds ?? 2;
  if (
    !Number.isInteger(startTimeoutSeconds) ||
    startTimeoutSeconds < 1 ||
    startTimeoutSeconds > 300 ||
    !Number.isInteger(pollSeconds) ||
    pollSeconds < 1 ||
    pollSeconds > 10
  )
    throw new Error('Executor start timeout must be 1–300 seconds and poll interval 1–10 seconds');
  return {
    schemaVersion: 1,
    repository: value.repository,
    controlRepository: absolute(value.controlRepository, 'controlRepository'),
    releaseConfig: absolute(value.releaseConfig, 'releaseConfig'),
    stateDirectory: absolute(value.stateDirectory, 'stateDirectory'),
    github: {
      enabled: github.enabled,
      workflow: github.workflow,
      ref: github.ref,
      runnerName: github.runnerName,
      runnerLabel: github.runnerLabel,
      startTimeoutSeconds,
      pollSeconds,
    },
  };
}

async function unredirected(path) {
  for (let current = resolve(path); ; current = dirname(current)) {
    const stat = await lstat(current);
    const systemAlias =
      stat.isSymbolicLink() &&
      process.platform === 'darwin' &&
      ['/var', '/tmp'].includes(current) &&
      (await realpath(current)) === `/private${current}`;
    if (stat.isSymbolicLink() && !systemAlias)
      throw new Error('Dispatch inputs and records must not traverse symlinks');
    if (dirname(current) === current) return;
  }
}

async function fileHash(path) {
  await unredirected(path);
  if (!(await lstat(path)).isFile()) throw new Error('Pinned input must be a regular local file');
  return digest(await readFile(path));
}

export async function loadExecutorPolicy(path) {
  const file = absolute(path, 'Executor policy');
  await unredirected(file);
  if (!(await lstat(file)).isFile())
    throw new Error('Executor policy must be a regular local JSON file');
  return normalizePolicy(JSON.parse(await readFile(file, 'utf8')));
}

function requestDirectory(policy, id) {
  if (!REQUEST.test(id)) throw new Error('Invalid dispatch request ID');
  return join(policy.stateDirectory, 'dispatch', 'requests', id);
}

async function privateRequestDirectory(policy, id) {
  const directory = requestDirectory(policy, id);
  await privateDirectory(directory);
  for (const path of [
    join(policy.stateDirectory, 'dispatch'),
    join(policy.stateDirectory, 'dispatch', 'requests'),
    directory,
  ])
    await chmod(path, 0o700);
  return directory;
}

const envelope = (value) => ({ value, sha256: digest(value) });
async function record(path, value) {
  await atomicJson(path, envelope(value), { exclusive: true });
}
async function readRecord(path, optional = false) {
  let data;
  try {
    await unredirected(path);
    data = await readJson(path);
  } catch (error) {
    if (optional && error.code === 'ENOENT') return null;
    throw error;
  }
  if (!object(data?.value) || data.sha256 !== digest(data.value))
    throw new Error('Dispatch record integrity mismatch');
  return data;
}

function validateRequestShape(request) {
  const { id, ...identity } = request;
  if (
    !(
      (request.schemaVersion === 1 && !Object.hasOwn(request, 'ui')) ||
      (request.schemaVersion === 2 && request.operation === 'validate' && request.ui === true)
    ) ||
    !REQUEST.test(request.id) ||
    request.id !== `request-${digest(identity).slice(0, 32)}` ||
    !/^[a-f0-9]{32}$/.test(request.nonce ?? '') ||
    !COMMIT.test(request.controlHead) ||
    !SHA.test(request.releaseConfigSha256) ||
    !SHA.test(request.policyDigest) ||
    !Number.isFinite(Date.parse(request.createdAt)) ||
    !object(request.plan) ||
    !/^release-[a-f0-9]{24}$/.test(request.plan.id ?? '') ||
    !COMMIT.test(request.plan.source ?? '') ||
    request.plan.executor !== 'local' ||
    request.planDigest !== digest(request.plan) ||
    !['validate', 'run', 'resume', 'executor-check'].includes(request.operation) ||
    typeof request.publish !== 'boolean' ||
    !object(request.acceptance) ||
    Object.entries(request.acceptance).some(
      ([platform, entry]) =>
        !PLATFORMS.includes(platform) ||
        !request.plan.platforms?.includes(platform) ||
        !object(entry) ||
        typeof entry.path !== 'string' ||
        !isAbsolute(entry.path) ||
        !SHA.test(entry.sha256),
    ) ||
    (['validate', 'executor-check'].includes(request.operation) &&
      (request.publish !== false ||
        Object.keys(request.acceptance).length !== 0 ||
        request.retryBuild !== null)) ||
    (request.operation === 'executor-check' && request.plan.source !== request.controlHead) ||
    (request.retryBuild !== null &&
      (!object(request.retryBuild) ||
        request.operation !== 'resume' ||
        !request.plan.platforms?.includes(request.retryBuild.platform) ||
        typeof request.retryBuild.reason !== 'string' ||
        !request.retryBuild.reason.trim() ||
        request.retryBuild.reason.length > 4000))
  )
    throw new Error('Invalid dispatch request manifest');
}

async function requestRecord(policy, id) {
  const stored = await readRecord(join(requestDirectory(policy, id), 'request.json'));
  const request = stored.value;
  validateRequestShape(request);
  if (
    request.id !== id ||
    request.repository !== policy.repository ||
    request.controlRepository !== policy.controlRepository ||
    request.releaseConfig !== policy.releaseConfig ||
    request.stateDirectory !== policy.stateDirectory ||
    request.policyDigest !== digest(policy) ||
    request.host !== hostname()
  )
    throw new Error('Dispatch request belongs to another policy, store, or machine');
  return stored;
}

export async function createRequest({
  policy: inputPolicy,
  plan,
  operation,
  ui = false,
  publish = false,
  acceptance = {},
  retryBuild,
  command = runCommand,
}) {
  const policy = normalizePolicy(inputPolicy);
  if (typeof ui !== 'boolean' || (ui && operation !== 'validate'))
    throw new Error('UI validation is only supported for validate requests');
  if (
    ['validate', 'executor-check'].includes(operation) &&
    (publish !== false ||
      !object(acceptance) ||
      Object.keys(acceptance).length !== 0 ||
      (retryBuild !== undefined && retryBuild !== null))
  )
    throw new Error(
      `${operation === 'validate' ? 'Source validation' : 'Executor check'} cannot request publication, acceptance or build recovery`,
    );
  const receipts = {};
  for (const [platform, path] of Object.entries(acceptance)) {
    const file = absolute(path, 'Acceptance receipt');
    receipts[platform] = { path: file, sha256: await fileHash(file) };
  }
  await unredirected(policy.controlRepository);
  const controlHead = (
    await command('git', ['rev-parse', '--verify', 'HEAD^{commit}'], {
      cwd: policy.controlRepository,
    })
  ).stdout.trim();
  const identity = {
    // Older workers must reject UI validation instead of silently running checks only.
    schemaVersion: ui ? 2 : 1,
    ...(ui ? { ui: true } : {}),
    nonce: randomBytes(16).toString('hex'),
    createdAt: now(),
    repository: policy.repository,
    controlRepository: policy.controlRepository,
    controlHead,
    releaseConfig: policy.releaseConfig,
    releaseConfigSha256: await fileHash(policy.releaseConfig),
    stateDirectory: policy.stateDirectory,
    host: hostname(),
    plan: structuredClone(plan),
    planDigest: digest(plan),
    operation,
    publish,
    acceptance: receipts,
    retryBuild: retryBuild ? structuredClone(retryBuild) : null,
    policyDigest: digest(policy),
  };
  const id = `request-${digest(identity).slice(0, 32)}`;
  const request = { id, ...identity };
  validateRequestShape(request);
  const directory = await privateRequestDirectory(policy, id);
  await record(join(directory, 'request.json'), request);
  return request;
}

async function stateRecords(policy, stored) {
  const retired = await retiredRequestStatus(policy, stored.value.id);
  if (retired) return { retirement: retired };
  const request = stored.value;
  const directory = requestDirectory(policy, request.id);
  // Read dependents before their prerequisites: a concurrent writer can add a
  // result after our snapshot, but cannot make a visible result precede its claim.
  const response = await readRecord(join(directory, 'dispatch-response.json'), true);
  const result = await readRecord(join(directory, 'result.json'), true);
  const claim = await readRecord(join(directory, 'claim.json'), true);
  const intent = await readRecord(join(directory, 'dispatch-intent.json'), true);
  for (const item of [claim, result, intent, response]) {
    if (item && item.value.requestDigest !== stored.sha256)
      throw new Error('Dispatch record references a different request');
  }
  if (
    (claim &&
      (!['local', 'github'].includes(claim.value.executor) ||
        typeof claim.value.token !== 'string' ||
        claim.value.host !== request.host ||
        !Number.isFinite(Date.parse(claim.value.createdAt)))) ||
    (result &&
      (!claim ||
        result.value.claimDigest !== claim.sha256 ||
        !['completed', 'unknown'].includes(result.value.state) ||
        (result.value.state === 'completed' &&
          (!Number.isInteger(result.value.exitCode) ||
            result.value.exitCode < 0 ||
            result.value.exitCode > 255)))) ||
    (intent &&
      (!COMMIT.test(intent.value.workflowSha ?? '') ||
        !SHA.test(intent.value.workflowDigest ?? '') ||
        !Number.isFinite(Date.parse(intent.value.createdAt)))) ||
    (response && (!intent || response.value.intentDigest !== intent.sha256)) ||
    (claim?.value.executor === 'github' &&
      (!intent ||
        claim.value.worker?.workflowSha !== intent.value.workflowSha ||
        claim.value.worker?.runnerName !== policy.github.runnerName ||
        claim.value.worker?.repository !== policy.repository))
  )
    throw new Error('Invalid dispatch execution history');
  return { claim, result, intent, response };
}

function status(stored, records) {
  if (records.retirement) return records.retirement;
  const { claim, result, intent, response } = records;
  return {
    id: stored.value.id,
    ...(stored.value.operation === 'executor-check'
      ? { operation: 'executor-check' }
      : { releaseId: stored.value.plan.id }),
    state: result?.value.state ?? (claim ? 'running' : 'pending'),
    ...(claim ? { executor: claim.value.executor, claim: claim.value } : {}),
    ...(result ? { result: result.value } : {}),
    ...(intent ? { dispatch: { intent: intent.value, response: response?.value ?? null } } : {}),
  };
}

export async function readRequestStatus({ policy: inputPolicy, id }) {
  const policy = normalizePolicy(inputPolicy);
  const retired = await retiredRequestStatus(policy, id);
  if (retired) return retired;
  const stored = await requestRecord(policy, id);
  return status(stored, await stateRecords(policy, stored));
}

const inventoryFiles = [
  'request.json',
  'claim.json',
  'result.json',
  'dispatch-intent.json',
  'dispatch-response.json',
  'retirement.json',
];
const inventoryTimestamp = (value) =>
  typeof value === 'string' &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;
const inventoryName = (value) =>
  typeof value === 'string' &&
  value.trim().length > 0 &&
  value.length <= 255 &&
  !/[\r\n\0]/.test(value);
const inventoryPath = (value) =>
  typeof value === 'string' &&
  isAbsolute(value) &&
  !value.includes('\0') &&
  resolve(value) === value;
const inventoryNumber = (value) => typeof value === 'string' && /^[1-9]\d*$/.test(value);

function inventoryPrivate(stat, directory) {
  if (
    (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) ||
    (stat.mode & 0o077) !== 0 ||
    (typeof process.getuid === 'function' && stat.uid !== process.getuid())
  )
    throw new Error('Invalid private dispatch storage');
}

async function inventoryDirectory(path) {
  await unredirected(path);
  inventoryPrivate(await lstat(path), true);
}

async function inventoryRecord(directory, name, names) {
  if (!names.includes(name)) return null;
  const path = join(directory, name);
  const before = await lstat(path);
  inventoryPrivate(before, false);
  await unredirected(path);
  const bytes = await readFile(path);
  const data = JSON.parse(bytes.toString('utf8'));
  const bytesSha256 = digest(bytes);
  const after = await lstat(path);
  inventoryPrivate(after, false);
  if (
    !keys(data, ['value', 'sha256']) ||
    !object(data.value) ||
    data.sha256 !== digest(data.value) ||
    before.ino !== after.ino ||
    before.dev !== after.dev ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs
  )
    throw new Error('Invalid dispatch record snapshot');
  return { ...data, bytesSha256 };
}

function inventoryRequest(stored, id) {
  const request = stored?.value;
  if (!object(request)) throw new Error('Missing dispatch request');
  validateRequestShape(request);
  if (
    !keys(request, [
      'id',
      'schemaVersion',
      'ui',
      'nonce',
      'createdAt',
      'repository',
      'controlRepository',
      'controlHead',
      'releaseConfig',
      'releaseConfigSha256',
      'stateDirectory',
      'host',
      'plan',
      'planDigest',
      'operation',
      'publish',
      'acceptance',
      'retryBuild',
      'policyDigest',
    ]) ||
    request.id !== id ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(request.repository ?? '') ||
    !['controlRepository', 'releaseConfig', 'stateDirectory'].every((key) =>
      inventoryPath(request[key]),
    ) ||
    !inventoryName(request.host) ||
    !inventoryTimestamp(request.createdAt) ||
    !Array.isArray(request.plan.platforms) ||
    !request.plan.platforms.length ||
    new Set(request.plan.platforms).size !== request.plan.platforms.length ||
    request.plan.platforms.some((platform) => !PLATFORMS.includes(platform)) ||
    !SHA.test(request.plan.configDigest ?? '') ||
    Object.values(request.acceptance).some(
      (entry) => !keys(entry, ['path', 'sha256']) || !inventoryPath(entry.path),
    ) ||
    (request.retryBuild !== null && !keys(request.retryBuild, ['platform', 'reason']))
  )
    throw new Error('Invalid historical dispatch request');
  return request;
}

function inventoryHistory(stored, { claim, result, intent, response }) {
  const request = stored.value;
  const claimed = claim?.value;
  const finished = result?.value;
  const dispatched = intent?.value;
  const received = response?.value;
  for (const item of [claim, result, intent, response]) {
    if (item && item.value.requestDigest !== stored.sha256)
      throw new Error('Invalid request binding');
  }
  if (
    (claimed &&
      (!keys(claimed, [
        'requestDigest',
        'token',
        'executor',
        'host',
        'pid',
        'createdAt',
        'worker',
      ]) ||
        !['local', 'github'].includes(claimed.executor) ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
          claimed.token ?? '',
        ) ||
        claimed.host !== request.host ||
        !Number.isSafeInteger(claimed.pid) ||
        claimed.pid < 1 ||
        !inventoryTimestamp(claimed.createdAt) ||
        claimed.createdAt < request.createdAt ||
        (claimed.executor === 'local' && Object.hasOwn(claimed, 'worker')))) ||
    (dispatched &&
      (!keys(dispatched, [
        'requestDigest',
        'createdAt',
        'workflowSha',
        'workflowDigest',
        'runnerId',
      ]) ||
        !COMMIT.test(dispatched.workflowSha ?? '') ||
        !SHA.test(dispatched.workflowDigest ?? '') ||
        !inventoryNumber(dispatched.runnerId) ||
        !inventoryTimestamp(dispatched.createdAt) ||
        dispatched.createdAt < request.createdAt)) ||
    (finished &&
      (!claimed ||
        !keys(finished, [
          'requestDigest',
          'claimDigest',
          'finishedAt',
          'state',
          'exitCode',
          'summary',
          'message',
        ]) ||
        finished.claimDigest !== claim.sha256 ||
        !inventoryTimestamp(finished.finishedAt) ||
        finished.finishedAt < claimed.createdAt ||
        !['completed', 'unknown'].includes(finished.state) ||
        (finished.state === 'completed' &&
          (!Number.isInteger(finished.exitCode) ||
            finished.exitCode < 0 ||
            finished.exitCode > 255 ||
            Object.hasOwn(finished, 'message'))) ||
        (finished.state === 'unknown' &&
          (finished.exitCode !== null ||
            typeof finished.message !== 'string' ||
            !finished.message.trim() ||
            Object.hasOwn(finished, 'summary'))))) ||
    (received &&
      (!dispatched ||
        !keys(received, [
          'requestDigest',
          'intentDigest',
          'observedAt',
          'state',
          'runId',
          'runUrl',
          'message',
        ]) ||
        received.intentDigest !== intent.sha256 ||
        !inventoryTimestamp(received.observedAt) ||
        received.observedAt < dispatched.createdAt ||
        !['accepted', 'unknown'].includes(received.state) ||
        (received.state === 'accepted' &&
          (Object.hasOwn(received, 'message') ||
            (Object.hasOwn(received, 'runId') && !inventoryNumber(received.runId)) ||
            (Object.hasOwn(received, 'runUrl') &&
              (typeof received.runUrl !== 'string' ||
                !received.runUrl.startsWith(
                  `https://github.com/${request.repository}/actions/runs/`,
                ) ||
                !/^[1-9]\d*$/.test(received.runUrl.split('/actions/runs/')[1] ?? '') ||
                (received.runId && !received.runUrl.endsWith(`/runs/${received.runId}`)))))) ||
        (received.state === 'unknown' &&
          (typeof received.message !== 'string' ||
            !received.message.trim() ||
            Object.hasOwn(received, 'runId') ||
            Object.hasOwn(received, 'runUrl')))))
  )
    throw new Error('Invalid dispatch execution history');
  if (claimed?.executor === 'github') {
    const worker = claimed.worker;
    if (
      !dispatched ||
      !keys(worker, ['runnerName', 'repository', 'workflowSha', 'runId', 'runAttempt']) ||
      !inventoryName(worker.runnerName) ||
      worker.repository !== request.repository ||
      worker.workflowSha !== dispatched.workflowSha ||
      !inventoryNumber(worker.runId) ||
      !Number.isSafeInteger(worker.runAttempt) ||
      worker.runAttempt < 1 ||
      claimed.createdAt < dispatched.createdAt ||
      (received?.runId && received.runId !== worker.runId)
    )
      throw new Error('Invalid historical worker identity');
  }
}

const exactKeys = (value, fields) =>
  keys(value, fields) && fields.every((key) => Object.hasOwn(value, key));
const TOKEN = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const historyEntries = [
  ['claim', 'claim.json'],
  ['result', 'result.json'],
  ['intent', 'dispatch-intent.json'],
  ['response', 'dispatch-response.json'],
];
const historyDigest = (stored, records) =>
  digest({
    request: stored.bytesSha256,
    ...Object.fromEntries(historyEntries.map(([key]) => [key, records[key]?.bytesSha256 ?? null])),
  });

async function privateFileBytes(path) {
  if (!inventoryPath(path) || (await realpath(path)) !== path)
    throw new Error('Reconciliation evidence must use canonical absolute private files');
  await unredirected(path);
  const before = await lstat(path);
  inventoryPrivate(before, false);
  const bytes = await readFile(path);
  const after = await lstat(path);
  inventoryPrivate(after, false);
  if (
    before.ino !== after.ino ||
    before.dev !== after.dev ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs
  )
    throw new Error('Reconciliation evidence changed while reading');
  return bytes;
}

function receiptValue(raw) {
  if (typeof raw !== 'string') throw new Error('Invalid retirement reconciliation receipt');
  const receipt = JSON.parse(raw);
  if (
    !exactKeys(receipt, [
      'schemaVersion',
      'kind',
      'requestId',
      'requestDigest',
      'historyDigest',
      'host',
      'operation',
      'disposition',
      'observedAt',
      'reason',
      'attestations',
      'evidence',
    ]) ||
    receipt.schemaVersion !== 1 ||
    receipt.kind !== 'dispatch-retirement-reconciliation' ||
    !REQUEST.test(receipt.requestId ?? '') ||
    !SHA.test(receipt.requestDigest ?? '') ||
    !SHA.test(receipt.historyDigest ?? '') ||
    !inventoryName(receipt.host) ||
    !['validate', 'executor-check'].includes(receipt.operation) ||
    !['unclaimed', 'interrupted'].includes(receipt.disposition) ||
    !inventoryTimestamp(receipt.observedAt) ||
    typeof receipt.reason !== 'string' ||
    !receipt.reason.trim() ||
    receipt.reason.length > 4000 ||
    !exactKeys(receipt.attestations, [
      'legacyEntriesStopped',
      'executorAndChildrenStopped',
      'workflowRunsTerminal',
      'noPublicationOperations',
    ]) ||
    Object.values(receipt.attestations).some((value) => value !== true) ||
    !Array.isArray(receipt.evidence) ||
    !receipt.evidence.length ||
    receipt.evidence.some(
      (item) =>
        !exactKeys(item, ['path', 'sha256']) ||
        !inventoryPath(item.path) ||
        !SHA.test(item.sha256 ?? ''),
    ) ||
    new Set(receipt.evidence.map((item) => item.path)).size !== receipt.evidence.length
  )
    throw new Error('Invalid retirement reconciliation receipt');
  return receipt;
}

function validateReservation(reservation, stored) {
  if (!reservation) return;
  const value = reservation.value;
  if (
    !exactKeys(value, [
      'schemaVersion',
      'kind',
      'requestDigest',
      'token',
      'receiptDigest',
      'createdAt',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'retirement-reservation' ||
    value.requestDigest !== stored.sha256 ||
    !TOKEN.test(value.token ?? '') ||
    !SHA.test(value.receiptDigest ?? '') ||
    !inventoryTimestamp(value.createdAt) ||
    value.createdAt < stored.value.createdAt
  )
    throw new Error('Invalid retirement reservation');
}

function bindReceipt(receipt, snapshot) {
  const { stored, records, originalState, originalHistoryDigest } = snapshot;
  const request = stored.value;
  if (
    !['validate', 'executor-check'].includes(request.operation) ||
    request.publish !== false ||
    !['pending', 'unknown'].includes(originalState) ||
    receipt.requestId !== request.id ||
    receipt.requestDigest !== stored.sha256 ||
    receipt.historyDigest !== originalHistoryDigest ||
    receipt.host !== request.host ||
    receipt.operation !== request.operation ||
    receipt.disposition !== (originalState === 'pending' ? 'unclaimed' : 'interrupted') ||
    receipt.observedAt < request.createdAt ||
    Object.values(records).some(
      (item) =>
        item &&
        ['createdAt', 'observedAt', 'finishedAt'].some(
          (key) => item.value[key] && receipt.observedAt < item.value[key],
        ),
    )
  )
    throw new Error('Retirement receipt does not reconcile the exact eligible request history');
}

async function requestSnapshot(stateDirectory, id) {
  if (!inventoryPath(stateDirectory) || (await realpath(stateDirectory)) !== stateDirectory)
    throw new Error('Noncanonical state directory');
  const directory = requestDirectory({ stateDirectory }, id);
  for (const path of [
    stateDirectory,
    join(stateDirectory, 'dispatch'),
    join(stateDirectory, 'dispatch', 'requests'),
    directory,
  ])
    await inventoryDirectory(path);
  const names = (await readdir(directory)).sort();
  if (names.some((name) => !inventoryFiles.includes(name)))
    throw new Error('Unexpected dispatch record');
  const stored = await inventoryRecord(directory, 'request.json', names);
  inventoryRequest(stored, id);
  const records = {};
  for (const [key, file] of historyEntries)
    records[key] = await inventoryRecord(directory, file, names);
  const reservation = records.claim?.value.kind === 'retirement-reservation' ? records.claim : null;
  if (reservation) records.claim = null;
  validateReservation(reservation, stored);
  inventoryHistory(stored, records);
  const originalState = records.result?.value.state ?? (records.claim ? 'running' : 'pending');
  const snapshot = {
    directory,
    stored,
    records,
    reservation,
    originalState,
    originalHistoryDigest: historyDigest(stored, records),
  };
  const retirement = await inventoryRecord(directory, 'retirement.json', names);
  if (retirement) {
    const value = retirement.value;
    const binding = reservation ? 'reservationDigest' : 'claimDigest';
    if (
      !exactKeys(value, [
        'schemaVersion',
        'kind',
        'requestDigest',
        'originalHistoryDigest',
        'originalState',
        binding,
        'receipt',
        'receiptDigest',
        'retiredAt',
      ]) ||
      value.schemaVersion !== 1 ||
      value.kind !== 'dispatch-retirement' ||
      value.requestDigest !== stored.sha256 ||
      value.originalHistoryDigest !== snapshot.originalHistoryDigest ||
      value.originalState !== originalState ||
      value[binding] !== (reservation ?? records.claim)?.sha256 ||
      !SHA.test(value.receiptDigest ?? '') ||
      value.receiptDigest !== digest(value.receipt) ||
      !inventoryTimestamp(value.retiredAt) ||
      (originalState === 'pending' && !reservation) ||
      (originalState === 'unknown' && reservation)
    )
      throw new Error('Invalid retirement history seal');
    const receipt = receiptValue(value.receipt);
    bindReceipt(receipt, snapshot);
    if (
      receipt.observedAt > value.retiredAt ||
      (reservation &&
        (reservation.value.receiptDigest !== value.receiptDigest ||
          reservation.value.createdAt > value.retiredAt ||
          reservation.value.createdAt < receipt.observedAt))
    )
      throw new Error('Invalid retirement receipt binding');
  }
  if (JSON.stringify((await readdir(directory)).sort()) !== JSON.stringify(names))
    throw new Error('Dispatch history changed during snapshot');
  return { ...snapshot, retirement };
}

function retiredStatus(snapshot) {
  const { stored, retirement, originalState, originalHistoryDigest } = snapshot;
  return {
    id: stored.value.id,
    operation: stored.value.operation,
    state: 'retired',
    originalState,
    originalHistoryDigest,
    retirementDigest: retirement.sha256,
    reconciliation: 'operator-attestation',
  };
}

async function retiredRequestStatus(policy, id) {
  const directory = requestDirectory(policy, id);
  const retirement = await readRecord(join(directory, 'retirement.json'), true);
  const claim = await readRecord(join(directory, 'claim.json'), true);
  if (!retirement && claim?.value.kind !== 'retirement-reservation') return null;
  const snapshot = await requestSnapshot(policy.stateDirectory, id);
  if (
    snapshot.stored.value.repository !== policy.repository ||
    snapshot.stored.value.host !== hostname()
  )
    throw new Error('Retired request belongs to another repository or machine');
  if (!snapshot.retirement)
    throw new Error('Retirement reservation is incomplete; reconcile using the identical receipt');
  return retiredStatus(snapshot);
}

/**
 * Append operator reconciliation under current exclusive admission. It is not
 * machine proof of quiescence and never changes original execution records.
 */
export async function retireDispatchRequest({
  stateDirectory,
  receiptPath,
  maintenance,
  signal,
} = {}) {
  interrupted(signal);
  await assertMaintenanceOwner(maintenance?.anchor, maintenance?.owner);
  const receiptBytes = await privateFileBytes(receiptPath);
  const raw = receiptBytes.toString('utf8');
  if (!Buffer.from(raw).equals(receiptBytes)) throw new Error('Receipt must contain UTF-8 JSON');
  const receipt = receiptValue(raw);
  const receiptDigest = digest(receiptBytes);
  if (receipt.host !== hostname() || receipt.observedAt > now())
    throw new Error('Receipt must reconcile this machine at an observed time');
  let snapshot = await requestSnapshot(stateDirectory, receipt.requestId);
  bindReceipt(receipt, snapshot);
  if (snapshot.retirement) {
    if (snapshot.retirement.value.receiptDigest !== receiptDigest)
      throw new Error('Request was retired with a different receipt');
    return retiredStatus(snapshot);
  }
  for (const evidence of receipt.evidence) {
    if (digest(await privateFileBytes(evidence.path)) !== evidence.sha256)
      throw new Error('Reconciliation evidence bytes do not match the receipt');
  }
  if (snapshot.reservation && snapshot.reservation.value.receiptDigest !== receiptDigest)
    throw new Error('Retirement reservation belongs to a different receipt');
  await assertMaintenanceOwner(maintenance?.anchor, maintenance?.owner);
  if (snapshot.originalState === 'pending' && !snapshot.reservation) {
    try {
      // Shares the execution claim slot: old and new workers cannot win once this
      // reservation exists. A crash here remains blocked until exact reconciliation.
      interrupted(signal);
      await record(join(snapshot.directory, 'claim.json'), {
        schemaVersion: 1,
        kind: 'retirement-reservation',
        requestDigest: snapshot.stored.sha256,
        token: randomUUID(),
        receiptDigest,
        createdAt: now(),
      });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  snapshot = await requestSnapshot(stateDirectory, receipt.requestId);
  bindReceipt(receipt, snapshot);
  if (
    (snapshot.originalState === 'pending' && !snapshot.reservation) ||
    (snapshot.reservation && snapshot.reservation.value.receiptDigest !== receiptDigest)
  )
    throw new Error('Another worker or retirement operation owns this request');
  await assertMaintenanceOwner(maintenance?.anchor, maintenance?.owner);
  interrupted(signal);
  if (snapshot.retirement) {
    if (snapshot.retirement.value.receiptDigest !== receiptDigest)
      throw new Error('Request was retired with a different receipt');
    return retiredStatus(snapshot);
  }
  const value = {
    schemaVersion: 1,
    kind: 'dispatch-retirement',
    requestDigest: snapshot.stored.sha256,
    originalHistoryDigest: snapshot.originalHistoryDigest,
    originalState: snapshot.originalState,
    ...(snapshot.reservation
      ? { reservationDigest: snapshot.reservation.sha256 }
      : { claimDigest: snapshot.records.claim.sha256 }),
    receipt: raw,
    receiptDigest,
    retiredAt: now(),
  };
  try {
    await record(join(snapshot.directory, 'retirement.json'), value);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  // A late legacy writer cannot silently change what this receipt settled.
  const sealed = await requestSnapshot(stateDirectory, receipt.requestId);
  if (sealed.retirement?.value.receiptDigest !== receiptDigest)
    throw new Error('Request was retired with a different receipt');
  return retiredStatus(sealed);
}

/**
 * Read-only maintenance inventory. The caller must already own installation-wide
 * exclusive admission: no process/policy lookup can prove queued work is settled.
 * Historical input paths and policy digests are checked as syntax, never resolved
 * against today's configuration. A completed execution or valid immutable operator
 * retirement settles a request; age and unclaimed status alone never settle it.
 */
export async function inspectDispatchRequests({ stateDirectory } = {}) {
  const requests = [];
  const blockers = [];
  try {
    if (!inventoryPath(stateDirectory) || (await realpath(stateDirectory)) !== stateDirectory)
      throw new Error('Noncanonical state directory');
    await inventoryDirectory(stateDirectory);
  } catch {
    return { clear: false, requests, blockers: [{ reason: 'invalid-state-directory' }] };
  }
  const dispatch = join(stateDirectory, 'dispatch');
  try {
    await lstat(dispatch);
  } catch (error) {
    if (error.code === 'ENOENT') return { clear: true, requests, blockers };
    return { clear: false, requests, blockers: [{ reason: 'invalid-dispatch-directory' }] };
  }
  let names;
  const directory = join(dispatch, 'requests');
  try {
    await inventoryDirectory(dispatch);
    if ((await readdir(dispatch)).some((name) => name !== 'requests'))
      throw new Error('Unexpected dispatch entry');
    await inventoryDirectory(directory);
    names = (await readdir(directory)).sort();
  } catch {
    return { clear: false, requests, blockers: [{ reason: 'invalid-dispatch-directory' }] };
  }
  for (const id of names) {
    if (!REQUEST.test(id)) {
      blockers.push({ reason: 'unexpected-request-entry' });
      continue;
    }
    let summary = { id, state: 'invalid' };
    try {
      const snapshot = await requestSnapshot(stateDirectory, id);
      const { stored, records, reservation, retirement, originalState, originalHistoryDigest } =
        snapshot;
      summary = {
        ...summary,
        operation: stored.value.operation,
        requestDigest: stored.sha256,
        historyDigest: originalHistoryDigest,
        state: originalState,
      };
      if (retirement || reservation) {
        summary.historyDigest = digest({
          request: stored.bytesSha256,
          ...Object.fromEntries(
            historyEntries.map(([key]) => [
              key,
              (key === 'claim' && reservation ? reservation : records[key])?.bytesSha256 ?? null,
            ]),
          ),
          retirement: retirement?.bytesSha256 ?? null,
        });
        summary.originalHistoryDigest = originalHistoryDigest;
      }
      if (retirement) {
        summary = { ...summary, ...retiredStatus(snapshot) };
      } else if (reservation) {
        summary.state = 'retirement-incomplete';
        summary.originalState = originalState;
        blockers.push({ id, reason: 'request-retirement-incomplete' });
      } else {
        if (records.claim) summary.executor = records.claim.value.executor;
        if (summary.state === 'completed') summary.exitCode = records.result.value.exitCode;
        else blockers.push({ id, reason: `request-${summary.state}` });
      }
    } catch {
      blockers.push({ id, reason: 'invalid-request-history' });
    }
    requests.push(summary);
  }
  return { clear: blockers.length === 0, requests, blockers };
}

async function validateInputs(request, command) {
  await unredirected(request.controlRepository);
  if ((await fileHash(request.releaseConfig)) !== request.releaseConfigSha256)
    throw new Error('Release configuration changed after dispatch request creation');
  for (const receipt of Object.values(request.acceptance)) {
    if ((await fileHash(receipt.path)) !== receipt.sha256)
      throw new Error('Acceptance receipt changed after dispatch request creation');
  }
  const head = (
    await command('git', ['rev-parse', '--verify', 'HEAD^{commit}'], {
      cwd: request.controlRepository,
    })
  ).stdout.trim();
  if (head !== request.controlHead)
    throw new Error('Control checkout changed after dispatch request creation');
}

function workerIdentity(worker, policy, intent) {
  if (
    !policy.github.enabled ||
    !intent ||
    !object(worker) ||
    worker.runnerName !== policy.github.runnerName ||
    worker.repository !== policy.repository ||
    worker.workflowSha !== intent.value.workflowSha ||
    !/^\d+$/.test(String(worker.runId ?? '')) ||
    !Number.isInteger(Number(worker.runAttempt)) ||
    Number(worker.runAttempt) < 1
  )
    throw new Error('GitHub worker does not match the dispatched workflow and dedicated runner');
  return {
    runnerName: worker.runnerName,
    repository: worker.repository,
    workflowSha: worker.workflowSha,
    runId: String(worker.runId),
    runAttempt: Number(worker.runAttempt),
  };
}

export async function runRequest({
  policy: inputPolicy,
  id,
  executor,
  validate,
  execute,
  worker,
  command = runCommand,
  signal,
}) {
  const policy = normalizePolicy(inputPolicy);
  if (!['local', 'github'].includes(executor)) throw new Error('Invalid request executor');
  const retired = await retiredRequestStatus(policy, id);
  if (retired) return retired;
  const stored = await requestRecord(policy, id);
  let records = await stateRecords(policy, stored);
  if (records.retirement) return status(stored, records);
  const identity = executor === 'github' ? workerIdentity(worker, policy, records.intent) : null;
  if (records.claim) return status(stored, records);
  interrupted(signal);
  if (typeof validate !== 'function' || typeof execute !== 'function')
    throw new Error('Dispatch execution requires validation and execution callbacks');
  await validateInputs(stored.value, command);
  await validate(structuredClone(stored.value));
  // The callback can take time. Recheck all pinned bytes before competing for the claim.
  if ((await requestRecord(policy, id)).sha256 !== stored.sha256)
    throw new Error('Dispatch manifest changed during validation');
  await validateInputs(stored.value, command);
  interrupted(signal);
  const directory = requestDirectory(policy, id);
  const claim = {
    requestDigest: stored.sha256,
    token: randomUUID(),
    executor,
    host: hostname(),
    pid: process.pid,
    createdAt: now(),
    ...(identity ? { worker: identity } : {}),
  };
  try {
    await record(join(directory, 'claim.json'), claim);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    return readRequestStatus({ policy, id });
  }
  let result;
  try {
    interrupted(signal);
    const outcome = await execute(structuredClone(stored.value));
    if (
      !object(outcome) ||
      !Number.isInteger(outcome.exitCode) ||
      outcome.exitCode < 0 ||
      outcome.exitCode > 255
    )
      throw new Error('Execution did not return a valid exit code');
    result = {
      state: 'completed',
      exitCode: outcome.exitCode,
      ...(outcome.summary !== undefined ? { summary: outcome.summary } : {}),
    };
  } catch {
    // An exception is not proof that the child or provider had no effects.
    result = {
      state: 'unknown',
      exitCode: null,
      message:
        stored.value.operation === 'executor-check'
          ? 'Executor check did not confirm completion; inspect the owning process before creating a new check request'
          : stored.value.operation === 'validate'
            ? `Validation did not confirm completion; inspect the release journal and owning process before a new validate${stored.value.ui ? ' --ui' : ''} request with the same source, platforms, configuration and state directory`
            : 'Execution did not confirm completion; inspect the release journal and owning process before a new resume request',
    };
  }
  await record(join(directory, 'result.json'), {
    requestDigest: stored.sha256,
    claimDigest: digest(claim),
    finishedAt: now(),
    ...result,
  });
  records = await stateRecords(policy, stored);
  return status(stored, records);
}

function interrupted(signal) {
  if (signal?.aborted) {
    const error = new Error('Release dispatch interrupted; inspect this request before continuing');
    error.name = 'AbortError';
    throw error;
  }
}

function availability(value) {
  if (
    value?.available !== true ||
    !COMMIT.test(value.workflowSha ?? '') ||
    !SHA.test(value.workflowDigest ?? '') ||
    !/^\d+$/.test(String(value.runnerId ?? ''))
  )
    return null;
  return {
    workflowSha: value.workflowSha,
    workflowDigest: value.workflowDigest,
    runnerId: String(value.runnerId),
  };
}

export async function dispatchRequest({
  policy: inputPolicy,
  id,
  mode,
  github,
  validate,
  execute,
  signal,
  wait = (milliseconds, abortSignal) => delay(milliseconds, undefined, { signal: abortSignal }),
  command = runCommand,
}) {
  const policy = normalizePolicy(inputPolicy);
  if (!['auto', 'github'].includes(mode)) throw new Error('Dispatch mode must be auto or github');
  const retired = await retiredRequestStatus(policy, id);
  if (retired) return retired;
  const stored = await requestRecord(policy, id);
  let records = await stateRecords(policy, stored);
  if (records.claim || records.retirement) return status(stored, records);
  interrupted(signal);
  const local = () =>
    runRequest({ policy, id, executor: 'local', validate, execute, signal, command });
  if (!records.intent) {
    let available = null;
    if (policy.github.enabled) {
      try {
        available = availability(await github.available());
      } catch {
        // API/auth/network failure proves neither capacity nor a running worker.
      }
    }
    interrupted(signal);
    records = await stateRecords(policy, stored);
    if (records.claim || records.retirement) return status(stored, records);
    if (!records.intent) {
      if (!available)
        return mode === 'auto'
          ? local()
          : {
              ...status(stored, records),
              state: 'unavailable',
              reason:
                'GitHub execution is disabled or its designated runner/workflow could not be verified',
            };
      const directory = requestDirectory(policy, id);
      const intent = {
        requestDigest: stored.sha256,
        createdAt: now(),
        ...available,
      };
      let owner = false;
      try {
        await record(join(directory, 'dispatch-intent.json'), intent);
        owner = true;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
      if (owner) {
        // A retirement reservation can win after availability was checked.
        // Never POST after detecting it; any concurrent intent append invalidates
        // the sealed history and requires explicit reconciliation.
        records = await stateRecords(policy, stored);
        if (records.claim || records.retirement) return status(stored, records);
        interrupted(signal);
        let response;
        try {
          const remote = await github.dispatch(id);
          response = {
            state: 'accepted',
            ...(/^\d+$/.test(String(remote?.runId ?? '')) ? { runId: String(remote.runId) } : {}),
            ...(typeof remote?.runUrl === 'string' && /^https:\/\/github\.com\//.test(remote.runUrl)
              ? { runUrl: remote.runUrl }
              : {}),
          };
        } catch {
          response = {
            state: 'unknown',
            message: 'Dispatch response was not confirmed; the workflow may still start',
          };
        }
        await record(join(directory, 'dispatch-response.json'), {
          requestDigest: stored.sha256,
          intentDigest: digest(intent),
          observedAt: now(),
          ...response,
        });
      }
      records = await stateRecords(policy, stored);
    }
  }
  const deadline =
    Date.parse(records.intent.value.createdAt) + policy.github.startTimeoutSeconds * 1000;
  while (true) {
    interrupted(signal);
    records = await stateRecords(policy, stored);
    if (records.claim || records.retirement) return status(stored, records);
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await wait(Math.min(remaining, policy.github.pollSeconds * 1000), signal);
  }
  interrupted(signal);
  return mode === 'auto' ? local() : status(stored, await stateRecords(policy, stored));
}
