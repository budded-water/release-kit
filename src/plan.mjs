import { access, readFile, lstat } from 'node:fs/promises';
import { resolve, isAbsolute, join } from 'node:path';
import { digest } from './state.mjs';
import { runCommand } from './command.mjs';

export const PLATFORMS = ['ios', 'android', 'harmony'];
export async function loadConfig(path) {
  const absolute = resolve(path);
  if (!(await lstat(absolute)).isFile())
    throw new Error('Release config must be a regular local JSON file');
  const config = JSON.parse(await readFile(absolute, 'utf8'));
  if (config.schemaVersion !== 1) throw new Error('Release config schemaVersion must be 1');
  return { config, configPath: absolute, configDigest: digest(config) };
}
export function selectPlatforms(value = 'ios,android,harmony') {
  const platforms = value.split(',');
  if (
    !platforms.length ||
    new Set(platforms).size !== platforms.length ||
    platforms.some((p) => !PLATFORMS.includes(p))
  )
    throw new Error('Platforms must be a unique comma-separated selection of ios,android,harmony');
  return PLATFORMS.filter((p) => platforms.includes(p));
}
export async function createPlan({
  repo,
  ref,
  platforms = PLATFORMS,
  config,
  configDigest = digest(config),
  command = runCommand,
}) {
  if (!ref || ref.startsWith('-')) throw new Error('Specify a commit/ref without leading options');
  const git = async (args) => (await command('git', args, { cwd: repo })).stdout.trim();
  const source = await git(['rev-parse', '--verify', `${ref}^{commit}`]);
  if (!/^[a-f0-9]{40}$/.test(source)) throw new Error('Unable to resolve a full source commit');
  const app = JSON.parse(await git(['show', `${source}:app.json`])).expo;
  const eas = JSON.parse(await git(['show', `${source}:eas.json`]));
  const repository = await git(['remote', 'get-url', 'origin']);
  if (!app?.version || app.runtimeVersion?.policy !== 'appVersion')
    throw new Error('Release planner requires the repository appVersion runtime policy');
  const metadata = {};
  for (const key of ['metadataPath', 'submissionInformationPath']) {
    const path = config.stores?.ios?.[key];
    if (!path) continue;
    if (isAbsolute(path) || path.split(/[\\/]/).includes('..') || path.startsWith('-'))
      throw new Error(`${key} must be a tracked repository-relative path`);
    metadata[key] = await git(['rev-parse', '--verify', `${source}:${path}`]);
  }
  for (const platform of platforms) {
    const contentPath = config.stores?.[platform]?.contentPath;
    if (!contentPath) continue;
    if (
      isAbsolute(contentPath) ||
      contentPath.split(/[\\/]/).includes('..') ||
      contentPath.startsWith('-')
    )
      throw new Error('contentPath must be a tracked repository-relative path');
    metadata[`${platform}Content`] = await git([
      'rev-parse',
      '--verify',
      `${source}:${contentPath}`,
    ]);
  }
  const identities = {
    schemaVersion: 1,
    source,
    repository,
    platforms,
    version: app.version,
    runtimeVersion: app.version,
    appIds: {
      ios: app.ios?.bundleIdentifier,
      android: app.android?.package,
      harmony: config.harmony?.appId ?? null,
    },
    destinations: {
      ios: 'app-store',
      android: 'production',
      harmony: config.harmony?.distribution ?? 'device',
    },
    configDigest,
    metadata,
  };
  return {
    ...identities,
    id: `release-${digest(identities).slice(0, 24)}`,
    buildProfile: 'production',
    executor: 'local',
    currentAndroidSubmitTrack: eas.submit?.production?.android?.track ?? null,
  };
}
export async function assertCheckout(root, source, command = runCommand) {
  const head = (await command('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();
  const changes = (
    await command('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: root })
  ).stdout.trim();
  if (head !== source || changes)
    throw new Error('Isolated source checkout differs from the release commit');
}
export async function assertProductionSource({ repo, root, plan, command = runCommand }) {
  const git = async (args) =>
    (await command('git', args, { cwd: repo, timeout: 120000 })).stdout.trim();
  if ((await git(['remote', 'get-url', 'origin'])) !== plan.repository)
    throw new Error('Release origin differs from the planned repository');
  // Resolve the live default branch rather than trusting local origin/HEAD or
  // assuming a particular branch name. Both remote operations must succeed.
  const advertised = await git(['ls-remote', '--symref', 'origin', 'HEAD']);
  const ref = advertised.match(/^ref: (refs\/heads\/[^\s]+)\s+HEAD$/m)?.[1];
  if (!ref) throw new Error('Cannot resolve the remote default branch for production release');
  await git(['check-ref-format', ref]);
  const tracking = `refs/remotes/origin/${ref.slice('refs/heads/'.length)}`;
  await git(['fetch', '--no-tags', '--no-write-fetch-head', 'origin', `+${ref}:${tracking}`]);
  const source = await git(['rev-parse', '--verify', `${tracking}^{commit}`]);
  if (source !== plan.source)
    throw new Error(
      'Production release source must equal the current remote default branch head; merge/replan and rebuild the affected artifact',
    );
  await assertCheckout(root, plan.source, command);
  return { source, ref, checkedAt: new Date().toISOString() };
}
export async function prepareCheckout({ repo, root, source, command = runCommand }) {
  try {
    await access(root);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await command('git', ['worktree', 'add', '--detach', root, source], { cwd: repo });
  }
  await assertCheckout(root, source, command);
  return root;
}
export function acceptanceConfig(config, platform) {
  const entry = config.acceptance?.[platform];
  if (
    entry?.command &&
    (!Array.isArray(entry.command) ||
      !entry.command.length ||
      entry.command.some((x) => typeof x !== 'string' || !x))
  )
    throw new Error('Acceptance command must be a nonempty argv array');
  return entry;
}
export async function readAcceptance(path, plan, artifact, expectedSha256) {
  const bytes = await readFile(path);
  const evidenceSha256 = digest(bytes);
  if (expectedSha256 !== undefined && evidenceSha256 !== expectedSha256)
    throw new Error('Acceptance receipt differs from the pinned dispatch evidence');
  const receipt = JSON.parse(bytes);
  const timestamp = Date.parse(receipt.checkedAt);
  const tested = receipt.testedBuild;
  const named = (value) =>
    typeof value === 'string' && value.trim().length > 0 && value.length < 4000;
  if (
    receipt.schemaVersion !== 1 ||
    receipt.kind !== 'native-acceptance' ||
    receipt.source !== plan.source ||
    receipt.platform !== artifact.platform ||
    receipt.artifactSha256 !== artifact.sha256 ||
    receipt.passed !== true ||
    !Number.isFinite(timestamp) ||
    timestamp > Date.now() + 60000 ||
    !Array.isArray(receipt.checks) ||
    !receipt.checks.length ||
    receipt.checks.some((c) => !named(c.name) || c.passed !== true) ||
    !['operator', 'automation'].includes(receipt.provenance)
  )
    throw new Error(
      'Acceptance receipt must identify this source, platform and exact artifact, include passed checks and valid provenance/time',
    );
  if (
    !tested ||
    tested.source !== plan.source ||
    !/^[a-f0-9]{64}$/.test(tested.sha256) ||
    !['artifact', 'counterpart'].includes(tested.kind) ||
    (tested.kind === 'artifact' && tested.sha256 !== artifact.sha256) ||
    (tested.kind === 'counterpart' &&
      (!named(tested.configurationRelationship) || !named(tested.limitations)))
  )
    throw new Error(
      'Acceptance must identify the tested build; a counterpart needs its source, hash, configuration relationship and limitations',
    );
  return {
    schemaVersion: 1,
    kind: receipt.kind,
    source: receipt.source,
    platform: receipt.platform,
    artifactSha256: receipt.artifactSha256,
    checkedAt: receipt.checkedAt,
    passed: true,
    provenance: receipt.provenance,
    checks: receipt.checks.map(({ name }) => ({ name, passed: true })),
    testedBuild: {
      kind: tested.kind,
      source: tested.source,
      sha256: tested.sha256,
      ...(tested.kind === 'counterpart'
        ? {
            configurationRelationship: tested.configurationRelationship,
            limitations: tested.limitations,
          }
        : {}),
    },
    evidenceSha256,
  };
}
