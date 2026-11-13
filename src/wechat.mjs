import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { acquireLock, atomicJson, canonicalPrivatePath, digest, loadState, privateDirectory, readJson, saveState } from './state.mjs';
import { runCommand } from './command.mjs';
import { createCleanupGuard } from './cleanup.mjs';

const states = ['prepared', 'upload-unknown', 'pending-confirmation', 'uploaded', 'uploaded-unverified', 'failed', 'cancelled', 'expired'];
const hash = /^[a-f0-9]{64}$/;
const idPattern = /^wechat-[a-f0-9]{24}$/;
const taskPattern = /^[A-Za-z0-9_-]{1,200}$/;
const validTask = (value) => typeof value === 'string' && taskPattern.test(value);
const versionPattern = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;
function compareVersions(a, b) {
  const left = a.split('.').map(BigInt), right = b.split('.').map(BigInt);
  return left.map((n, i) => n > right[i] ? 1 : n < right[i] ? -1 : 0).find((n) => n !== 0) ?? 0;
}
const strictKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).every((key) => keys.includes(key));
const bytesHash = (bytes) => createHash('sha256').update(bytes).digest('hex');
function repositoryIdentity(origin) {
  const invalid = () => new Error('Remote origin must use a credential-free Git URL without query or fragment values');
  if (typeof origin !== 'string' || origin.length > 2048 || /\s/.test(origin)) throw invalid();
  if (/^git@[A-Za-z0-9.-]+:[A-Za-z0-9._~/-]+$/.test(origin)) return origin;
  let url;
  try { url = new URL(origin); } catch { throw invalid(); }
  if (!['http:', 'https:', 'ssh:', 'git:'].includes(url.protocol) || !url.hostname || url.password || url.search || url.hash ||
      url.username && !(url.protocol === 'ssh:' && url.username === 'git')) throw invalid();
  return origin;
}
const inside = (root, path) => {
  const tail = relative(root, path);
  return tail && tail !== '..' && !tail.startsWith(`..${sep}`) && !isAbsolute(tail);
};

export function assertWechatVersionObservation(value, appId, version, now = Date.now()) {
  if (!strictKeys(value, ['appId', 'version', 'source', 'observedAt']) || value.appId !== appId ||
      !versionPattern.test(value.version) || !versionPattern.test(version) ||
      typeof value.version !== 'string' || typeof version !== 'string' ||
      !['owner', 'provider'].includes(value.source) || typeof value.observedAt !== 'string') {
    throw new Error('Current version requires an explicit owner/provider observation for this AppID');
  }
  const time = Date.parse(value.observedAt);
  // A bounded baseline prevents a historical local log from silently selecting a version.
  if (!Number.isFinite(time) || time > now || now - time > 24 * 60 * 60 * 1000) {
    throw new Error('Current-version observation must be from the last 24 hours');
  }
  if (compareVersions(version, value.version) <= 0) throw new Error('A new upload version must be newer than the observed version');
}

async function boundedFile(root, path, limit) {
  path = resolve(path);
  if (!inside(root, path)) throw new Error('Evidence must stay inside the selected checkout');
  let current = root;
  for (const part of relative(root, path).split(sep)) {
    current = join(current, part);
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || (current === path ? !stat.isFile() || stat.size > limit : !stat.isDirectory())) {
      throw new Error('Evidence must use bounded regular files without redirects');
    }
  }
  const bytes = await readFile(path);
  if (bytes.length > limit) throw new Error('Evidence exceeds its byte budget');
  return bytes;
}

export async function inspectWechatArtifact(root, directory, appId) {
  if (typeof directory !== 'string' || isAbsolute(directory) || directory.split(/[\\/]/).includes('..')) {
    throw new Error('Artifact directory must be checkout-relative');
  }
  const artifactRoot = resolve(root, directory);
  await boundedFile(root, join(artifactRoot, 'project.config.json'), 128 * 1024);
  const config = JSON.parse(await boundedFile(root, join(artifactRoot, 'project.config.json'), 128 * 1024));
  if (config.appid !== appId || config.compileType !== 'miniprogram') throw new Error('Artifact AppID/type differs from the trusted project');
  const entries = [];
  let total = 0, visited = 0;
  async function visit(path) {
    for (const name of (await readdir(path)).sort()) {
      if (++visited > 10000) throw new Error('Artifact exceeds entry budget');
      const child = join(path, name), stat = await lstat(child);
      if (stat.isDirectory() && !stat.isSymbolicLink()) await visit(child);
      else {
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32 * 1024 * 1024 || entries.length >= 10000) {
          throw new Error('Invalid or unbounded artifact entry');
        }
        const bytes = await boundedFile(root, child, 32 * 1024 * 1024);
        total += bytes.length;
        if (total > 100 * 1024 * 1024) throw new Error('Artifact exceeds total byte budget');
        entries.push({ path: relative(artifactRoot, child).split(sep).join('/'), bytes: bytes.length, sha256: bytesHash(bytes) });
      }
    }
  }
  await visit(artifactRoot);
  return { directory, digest: digest(entries), files: entries.length, bytes: total };
}

function requireProject(project) {
  if (project?.schemaVersion !== 1 || !/^wx[a-f0-9]{16}$/.test(project.appId) ||
      typeof project.policy !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(project.policy) ||
      !strictKeys(project.driver, ['binary', 'clientName', 'skillVersion']) ||
      !isAbsolute(project.driver?.binary ?? '') || typeof project.driver?.clientName !== 'string' || !/^[A-Za-z][A-Za-z0-9-]{0,39}$/.test(project.driver.clientName) ||
      !/^\d+\.\d+\.\d+$/.test(project.driver?.skillVersion) ||
      typeof project.validate !== 'function' || typeof project.revalidate !== 'function') {
    throw new Error('WeChat requires an explicit trusted version-1 project adapter');
  }
  return project;
}

async function metadataText(path) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192) throw new Error('Unsupported Git administration metadata');
  const value = await readFile(path, 'utf8');
  if (Buffer.byteLength(value) > 8192) throw new Error('Unbounded Git administration metadata');
  return value.trim();
}

// Git's own, unversioned administration directory is the bootstrap exclusion
// authority. Locating it uses filesystem reads only, before any child process.
async function initializationDirectory(root) {
  for (let current = root; ; current = dirname(current)) {
    const marker = join(current, '.git');
    let stat;
    try { stat = await lstat(marker); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (stat) {
      if (stat.isSymbolicLink()) throw new Error('Git administration metadata must not be redirected');
      let admin;
      if (stat.isDirectory()) admin = await realpath(marker);
      else {
        const pointer = (await metadataText(marker)).match(/^gitdir: (.+)$/);
        if (!pointer) throw new Error('A standard Git checkout or registered worktree is required');
        admin = await realpath(resolve(current, pointer[1]));
        const common = await realpath(resolve(admin, await metadataText(join(admin, 'commondir'))));
        if (basename(common).toLowerCase() !== '.git' || !inside(join(common, 'worktrees'), admin) ||
            await realpath(await metadataText(join(admin, 'gitdir'))) !== await realpath(marker)) throw new Error('A registered Git worktree is required');
      }
      await metadataText(join(admin, 'HEAD'));
      return join(admin, 'release-kit-wechat');
    }
    if (dirname(current) === current) throw new Error('A standard Git checkout or registered worktree is required');
  }
}

export function assertWechatState(state) {
  if (!strictKeys(state, ['schemaVersion', 'kind', 'plan', 'status', 'taskId', 'observation', 'updatedAt']) ||
      state.schemaVersion !== 1 || state.kind !== 'WechatUploadState' || !states.includes(state.status) ||
      !strictKeys(state.plan, ['id', 'source', 'repository', 'appId', 'version', 'current', 'artifact', 'validation', 'policy', 'driver', 'description', 'operation']) ||
      !idPattern.test(state.plan.id) || !/^[a-f0-9]{40}$/.test(state.plan.source) ||
      !/^wx[a-f0-9]{16}$/.test(state.plan.appId) || !versionPattern.test(state.plan.version) ||
      state.plan.operation !== 'developer-upload' || !hash.test(state.plan.artifact?.digest ?? '') ||
      !hash.test(state.plan.validation?.sha256 ?? '')) throw new Error('Invalid WeChat operation state');
  repositoryIdentity(state.plan.repository);
  const { id, ...identity } = state.plan;
  if (id !== `wechat-${digest(identity).slice(0, 24)}`) throw new Error('WeChat plan identity changed');
  if (state.taskId !== undefined && !validTask(state.taskId)) throw new Error('Invalid task identity');
  if (state.status === 'pending-confirmation' && !state.taskId) throw new Error('Pending confirmation needs its original task');
  if (state.status === 'uploaded' && state.observation?.status !== 'success') throw new Error('Uploaded needs a successful official observation');
  if (!strictKeys(state.observation, ['tool', 'status', 'taskId']) ||
      (state.observation.taskId !== undefined && state.observation.taskId !== state.taskId)) throw new Error('Observation differs from the original task');
  const expected = { prepared: 'prepared', 'upload-unknown': 'unknown', 'pending-confirmation': 'pending', uploaded: 'success',
    'uploaded-unverified': 'success', failed: 'failed', cancelled: 'cancelled', expired: 'expired' }[state.status];
  if (state.observation.status !== expected || !['prepare', 'upload', 'polling_task_result'].includes(state.observation.tool)) throw new Error('Current state contradicts its official observation');
}

export function summarizeWechat(state) {
  assertWechatState(state);
  return {
    id: state.plan.id, appId: state.plan.appId, version: state.plan.version, source: state.plan.source,
    artifactDigest: state.plan.artifact.digest, state: state.status, taskId: state.taskId ?? null,
    uploadCompleted: ['uploaded', 'uploaded-unverified'].includes(state.status), artifactVerified: state.status === 'uploaded',
    codeVerification: 'trusted-project-receipt', uiAcceptance: 'not-assessed-by-release-kit',
    experienceVersionSelected: false, reviewSubmitted: false, publiclyReleased: false,
    actionRequired: state.status === 'pending-confirmation' ? 'Confirm in DevTools, then resume this task once' :
      state.status === 'upload-unknown' ? 'Reconcile the original operation; do not upload again' :
      state.status === 'uploaded-unverified' ? 'Provider confirmed upload, but prepared source/artifact evidence could not be revalidated' : null,
  };
}

function decode(output, tool, clientName, taskId) {
  if (output.exitCode !== 0 || output.stdout.length > 1024 * 1024) throw new Error('Official command failed or returned unbounded output');
  let payload;
  try { payload = JSON.parse(output.stdout); } catch { throw new Error('Invalid official command envelope'); }
  if (payload.ok !== true || payload.tool !== tool || payload.clientName !== clientName) throw new Error('Official response is not bound to the requested tool/client');
  const value = payload.result;
  if (!value || typeof value !== 'object' || value.success !== true) throw new Error('Official response did not establish success');
  if (tool === 'check_wechatide_status') return value;
  if (taskId && value.taskId !== taskId) throw new Error('Official response differs from the original task');
  if (value.status === 'pending' && validTask(value.taskId)) return { status: 'pending-confirmation', taskId: value.taskId, observation: { tool, status: 'pending', taskId: value.taskId } };
  if (value.status === 'success' && value.result?.success === true) return { status: 'uploaded', ...(taskId ? { taskId } : {}), observation: { tool, status: 'success', ...(taskId ? { taskId } : {}) } };
  if (['failed', 'cancelled', 'expired'].includes(value.status)) return { status: value.status, ...(taskId ? { taskId } : {}), observation: { tool, status: value.status, ...(taskId ? { taskId } : {}) } };
  throw new Error('Unknown official operation outcome; reconciliation required');
}

/** Uses existing private atomic journals/locks; never reads a project module from saved state. */
export async function createWechatRunner({ repo, store, project, command = runCommand, signal, now = Date.now }) {
  project = requireProject(project);
  const root = await realpath(repo);
  if (!isAbsolute(store)) throw new Error('WeChat state must be an absolute private directory outside candidate source');
  store = await canonicalPrivatePath(store);
  if (store === root || inside(root, store) || inside(store, root)) throw new Error('WeChat state must be an absolute private directory outside candidate source without ancestor overlap');
  const directory = join(store, 'wechat');
  const activePath = join(directory, `active-${digest(project.appId)}.json`);
  const rawCommand = command;
  let activeInitialization;
  const cleanup = createCleanupGuard(store, (...args) => {
    if (!activeInitialization) throw new Error('WeChat command requires initialization admission');
    return activeInitialization.command(...args);
  });
  command = cleanup.command;
  const statePath = (id) => {
    if (!idPattern.test(id)) throw new Error('Invalid WeChat operation ID');
    return join(directory, 'operations', id);
  };
  const read = async (id) => {
    const state = await loadState(statePath(id));
    assertWechatState(state);
    if (state.plan.id !== id) throw new Error('Saved operation differs from requested operation ID');
    if (state.plan.appId !== project.appId || state.plan.policy !== project.policy ||
        digest(state.plan.driver) !== digest(project.driver)) throw new Error('Selected trusted project differs from saved operation');
    return state;
  };
  const activeOperation = async () => {
    let active;
    try { active = await readJson(activePath); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (!strictKeys(active, ['id']) || !idPattern.test(active.id)) throw new Error('Invalid active operation identity');
    const state = await loadState(statePath(active.id));
    assertWechatState(state);
    if (state.plan.id !== active.id || state.plan.appId !== project.appId) throw new Error('Active operation identity changed');
    return state;
  };
  const save = async (state) => {
    assertWechatState(state);
    await saveState(statePath(state.plan.id), state);
    await atomicJson(join(statePath(state.plan.id), 'summary.json'), summarizeWechat(state));
  };
  const locked = async (fn) => {
    signal?.throwIfAborted();
    const bootstrap = await initializationDirectory(root);
    await privateDirectory(bootstrap);
    const initialization = createCleanupGuard(bootstrap, rawCommand);
    const releaseInitialization = await acquireLock(join(bootstrap, 'initialization.lock'));
    activeInitialization = initialization;
    let releaseTarget;
    try {
      return await initialization.run(async () => {
        await cleanup.assertSafe();
        const checkout = await initialization.command('git', ['rev-parse', '--show-toplevel'], { cwd: root, timeout: 30000, signal, diagnostics: false });
        if (checkout.exitCode !== 0 || typeof checkout.stdout !== 'string' || checkout.stdout.length > 16384 ||
            !isAbsolute(checkout.stdout.trim()) || await realpath(checkout.stdout.trim()) !== root) throw new Error('WeChat repo must be the actual Git checkout root');
        await privateDirectory(directory);
        releaseTarget = await acquireLock(join(directory, `target-${digest(project.appId)}.lock`));
        return cleanup.run(fn);
      });
    } finally {
      activeInitialization = undefined;
      if (!cleanup.blocked && !initialization.blocked) {
        if (releaseTarget) await releaseTarget();
        await releaseInitialization();
      }
    }
  };
  const git = async (...args) => {
    const result = await command('git', args, { cwd: root, signal, diagnostics: false });
    if (result.exitCode !== 0 || typeof result.stdout !== 'string' || result.stdout.length > 1024 * 1024) throw new Error('Source identity could not be established');
    return result.stdout.trim();
  };
  const source = async (expected) => {
    const head = await git('rev-parse', 'HEAD');
    if (head !== expected || await git('status', '--porcelain')) throw new Error('Upload requires the exact clean prepared checkout');
  };
  const receipt = async (validation) => {
    if (!strictKeys(validation, ['path', 'sha256']) || typeof validation.path !== 'string' ||
        !hash.test(validation.sha256 ?? '') || bytesHash(await boundedFile(root, resolve(root, validation.path), 8 * 1024 * 1024)) !== validation.sha256) {
      throw new Error('Prepared validation receipt is missing or changed');
    }
  };
  const official = async (tool, args, taskId) => decode(await command(project.driver.binary,
    ['-c', project.driver.clientName, tool, ...args], { cwd: root, timeout: 120000, signal, diagnostics: false }), tool, project.driver.clientName, taskId);
  const revalidate = async (plan) => {
    await source(plan.source);
    await receipt(plan.validation);
    await project.revalidate({ root, source: plan.source, validation: plan.validation, command, signal });
    await source(plan.source);
    await receipt(plan.validation);
    if (digest(await inspectWechatArtifact(root, project.artifactDirectory, project.appId)) !== digest(plan.artifact)) throw new Error('Prepared artifact changed');
  };
  const recordObservedUpload = async (state) => {
    if (state.status !== 'uploaded') { await save(state); return state; }
    const provisional = { ...state, status: 'uploaded-unverified' };
    await save(provisional); // Preserve confirmation before any post-success hook.
    try { await revalidate(state.plan); }
    catch (error) {
      if (error?.cleanupIncomplete === true) {
        try { await cleanup.capture(error); }
        finally { await cleanup.assertSafe(); }
      }
      return provisional;
    }
    await save(state);
    return state;
  };

  return {
    async prepare({ ref, version, current, description = '' }) {
      assertWechatVersionObservation(current, project.appId, version, now());
      if (typeof description !== 'string' || description.length > 500) throw new Error('Upload description must be bounded');
      if (typeof ref !== 'string' || !ref || ref.startsWith('-')) throw new Error('Explicit source reference required');
      return locked(async () => {
        const active = await activeOperation();
        if (active && ['prepared', 'upload-unknown', 'pending-confirmation'].includes(active.status)) throw new Error('Active operation needs reconciliation before rebuilding its artifact');
        const commit = await git('rev-parse', '--verify', `${ref}^{commit}`);
        if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Invalid source commit');
        await source(commit);
        const repository = repositoryIdentity(await git('remote', 'get-url', 'origin'));
        const validation = await project.validate({ root, source: commit, command, signal });
        await receipt(validation);
        const artifact = await inspectWechatArtifact(root, project.artifactDirectory, project.appId);
        await source(commit);
        const identity = { source: commit, repository, appId: project.appId, version,
          current, artifact, validation, policy: project.policy, driver: project.driver, description, operation: 'developer-upload' };
        const plan = { id: `wechat-${digest(identity).slice(0, 24)}`, ...identity };
        if (await loadState(statePath(plan.id))) return read(plan.id);
        const state = { schemaVersion: 1, kind: 'WechatUploadState', plan, status: 'prepared',
          observation: { tool: 'prepare', status: 'prepared' }, updatedAt: new Date(now()).toISOString() };
        await save(state);
        return state;
      });
    },
    status: read,
    async upload(id, approval) {
      return locked(async () => {
        let state = await read(id);
        if (state.status !== 'prepared') return state; // Never replay any started operation.
        if (approval !== digest(state.plan)) throw new Error('Upload requires the exact prepared plan approval digest');
        assertWechatVersionObservation(state.plan.current, project.appId, state.plan.version, now());
        await revalidate(state.plan);
        const other = await activeOperation();
        if (other && other.plan.id !== id) {
          if (['prepared', 'upload-unknown', 'pending-confirmation'].includes(other.status)) throw new Error('Another operation for this AppID needs reconciliation first');
          if (other.plan.version === state.plan.version) throw new Error('This version already has an operation; inspect its original journal');
        }
        // Persisted successful operations remain authority even after a later failure
        // changes the active pointer. Read the append-only histories under this lock.
        const operations = await readdir(join(directory, 'operations'), { withFileTypes: true });
        if (operations.length > 10000) throw new Error('Operation history exceeds inspection budget');
        for (const entry of operations) {
          if (!entry.isDirectory() || !idPattern.test(entry.name)) throw new Error('Invalid operation history entry');
          const previous = await loadState(statePath(entry.name));
          assertWechatState(previous);
          if (previous.plan.id !== entry.name) throw new Error('Operation history identity changed');
          if (previous.plan.appId === project.appId && ['uploaded', 'uploaded-unverified'].includes(previous.status) &&
              compareVersions(state.plan.version, previous.plan.version) <= 0) throw new Error('A new upload version must be newer than all uploaded versions in this store');
        }
        const versionPath = join(directory, `version-${digest([project.appId, state.plan.version])}.json`);
        let owner;
        try { owner = await readJson(versionPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (owner && owner.id !== id) throw new Error('This version is already bound to another operation');
        const ready = await official('check_wechatide_status', ['--skill-version', project.driver.skillVersion]);
        if (ready.skillVersion !== project.driver.skillVersion || ready.versionRelation !== 'equal' || ready.loginExpired !== false ||
            ready.tokenRequired !== false || ready.cliTokenRequired === true) throw new Error('Official driver version/login/token is not ready');
        await atomicJson(activePath, { id });
        if (!owner) await atomicJson(versionPath, { id }, { exclusive: true });
        state = { ...state, status: 'upload-unknown', observation: { tool: 'upload', status: 'unknown' }, updatedAt: new Date(now()).toISOString() };
        await save(state); // Commit uncertainty before external mutation.
        try {
          const result = await official('upload', ['--project', resolve(root, project.artifactDirectory), '--upload-version', state.plan.version, '--desc', state.plan.description]);
          state = { ...state, ...result, updatedAt: new Date(now()).toISOString() };
          state = await recordObservedUpload(state);
        } catch (error) {
          if (error?.cleanupIncomplete === true) throw error;
          // Never log raw command output, credentials or an unbound failure message.
          throw new Error(`Upload outcome unknown; inspect operation ${id} before any new upload`);
        }
        return state;
      });
    },
    async resume(id) {
      return locked(async () => {
        const state = await read(id);
        if (state.status === 'uploaded-unverified') return recordObservedUpload({ ...state, status: 'uploaded', updatedAt: new Date(now()).toISOString() });
        if (state.status !== 'pending-confirmation') return state;
        // One explicit observation only; no background polling or upload retries.
        const result = await official('polling_task_result', ['--task-id', state.taskId], state.taskId);
        const next = await recordObservedUpload({ ...state, ...result, updatedAt: new Date(now()).toISOString() });
        return next;
      });
    },
  };
}
