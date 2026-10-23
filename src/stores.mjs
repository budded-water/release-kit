import { createHash, sign } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { access, lstat, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AppleListingError, auditAppleListing } from './apple-readiness.mjs';

const APPLE = 'https://api.appstoreconnect.apple.com';
const GOOGLE = 'https://androidpublisher.googleapis.com';
const OAUTH = 'https://oauth2.googleapis.com/token';
const now = () => new Date().toISOString();
const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const segment = (value) => encodeURIComponent(String(value));

class StoreError extends Error {
  constructor(message, status, providerError) {
    super(message);
    this.status = status;
    this.providerError = providerError;
  }
}

function identitySettings(ctx) {
  const cfg = ctx.config?.stores?.[ctx.platform];
  if (!cfg || !['ios', 'android'].includes(ctx.platform))
    throw new StoreError('Store configuration is missing.');
  const appId = ctx.platform === 'ios' ? cfg.bundleId : cfg.packageName;
  if (!appId || appId !== ctx.plan.appIds[ctx.platform])
    throw new StoreError('Store app identity does not match the release plan.');
  if (ctx.platform === 'ios' && !/^\d+$/.test(String(cfg.appId)))
    throw new StoreError('App Store Connect numeric appId is required.');
  return cfg;
}

function requirePlayPublishingPolicy(cfg) {
  if (cfg.managedPublishingDisabled !== true)
    throw new StoreError(
      'Confirm managed publishing is disabled before automatic Play publication.',
    );
}

function settings(ctx) {
  const cfg = identitySettings(ctx);
  if (ctx.platform === 'android') requirePlayPublishingPolicy(cfg);
  return cfg;
}

function secretPath(ctx, cfg) {
  const name = ctx.platform === 'ios' ? cfg.apiKeyPathEnv : cfg.serviceAccountPathEnv;
  const value = ctx.env?.[name];
  if (!name || !value || !path.isAbsolute(value))
    throw new StoreError(
      'Store credential environment reference must resolve to an absolute file path.',
    );
  return value;
}

async function sourcePath(ctx, value, directory = false) {
  if (!value || path.isAbsolute(value))
    throw new StoreError('Store metadata must use a path relative to the pinned checkout.');
  const resolved = path.resolve(ctx.root, value);
  if (!resolved.startsWith(path.resolve(ctx.root) + path.sep))
    throw new StoreError('Store metadata path escapes the pinned checkout.');
  let current = path.resolve(ctx.root);
  for (const component of ['', ...path.relative(current, resolved).split(path.sep)]) {
    current = path.join(current, component);
    const info = await lstat(current);
    if (info.isSymbolicLink())
      throw new StoreError('Store metadata paths must not contain symbolic links.');
    if (current !== resolved && !info.isDirectory())
      throw new StoreError('Store metadata path contains a non-directory component.');
    if (current === resolved && (directory ? !info.isDirectory() : !info.isFile()))
      throw new StoreError('Store metadata path has the wrong file type.');
  }
  if (directory) {
    const pending = [resolved];
    while (pending.length > 0) {
      const dir = pending.pop();
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const location = path.join(dir, entry.name);
        // lstat again instead of following a symlink that appeared after readdir.
        const info = await lstat(location);
        if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory()))
          throw new StoreError(
            'Store metadata trees must contain only regular files and directories, without symbolic links.',
          );
        if (info.isDirectory()) pending.push(location);
      }
    }
  }
  return resolved;
}

function identity(ctx) {
  const a = ctx.artifact;
  if (
    !a ||
    a.platform !== ctx.platform ||
    a.appId !== ctx.plan.appIds[ctx.platform] ||
    a.version !== ctx.plan.version ||
    !/^\d+(\.\d+)*$/.test(String(a.buildNumber)) ||
    !/^[a-f0-9]{64}$/.test(a.sha256)
  ) {
    throw new StoreError('Inspected artifact identity does not match the release plan.');
  }
  if (
    ctx.platform === 'android' &&
    (!/^\d+$/.test(a.buildNumber) ||
      BigInt(a.buildNumber) < 1n ||
      BigInt(a.buildNumber) > 2100000000n)
  )
    throw new StoreError('Android versionCode is invalid.');
  return {
    appId: a.appId,
    version: a.version,
    buildNumber: String(a.buildNumber),
    sha256: a.sha256,
  };
}

async function verifyFile(ctx) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(ctx.artifact.path)) hash.update(chunk);
  if (hash.digest('hex') !== ctx.artifact.sha256)
    throw new StoreError('Artifact changed after inspection.');
}

function previous(ctx, name) {
  const value = ctx.previous?.[name];
  if (value && JSON.stringify(value.identity) !== JSON.stringify(identity(ctx)))
    throw new StoreError('Stored operation belongs to a different artifact.');
  return value;
}

function ownedPlayRelease(ctx) {
  return previous(ctx, 'android-upload') || previous(ctx, 'android-commit');
}

async function save(ctx, name, value) {
  // Confirmed results may still be journaled during cancellation. Never start a
  // new operation intent after the operator has stopped the release.
  if (value.state === 'intent') {
    ctx.signal?.throwIfAborted();
    await ctx.assertPublicationSource?.();
    ctx.signal?.throwIfAborted();
  }
  const data = { ...value, identity: identity(ctx), recordedAt: now() };
  await ctx.checkpoint(name, data);
  ctx.previous ??= {};
  ctx.previous[name] = data;
  return data;
}

function result(ctx, state, values = {}) {
  return {
    state,
    provider: ctx.platform === 'ios' ? 'app-store-connect' : 'google-play',
    destination: ctx.platform === 'ios' ? 'app-store' : 'production',
    observedAt: now(),
    ...values,
  };
}

async function request(ctx, url, token, options = {}) {
  ctx.signal?.throwIfAborted();
  const origin = new URL(url).origin;
  if (![APPLE, GOOGLE, new URL(OAUTH).origin].includes(origin))
    throw new StoreError('Provider URL is outside the allowed origins.');
  const bearer = typeof token === 'function' ? token() : token;
  const headers = { ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}), ...options.headers };
  let response;
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 60000);
  const signal = ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout;
  try {
    response = await (ctx.fetch ?? fetch)(url, {
      ...options,
      headers,
      redirect: 'error',
      signal,
    });
    // Some transport boundaries may resolve after their abort event. A late
    // response must not authorize the next track/review/commit operation.
    signal.throwIfAborted();
  } catch {
    options.body?.destroy?.();
    throw new StoreError('Provider request did not return a confirmed result.');
  }
  if (!response.ok) {
    let providerError;
    try {
      const body = await response.json();
      signal.throwIfAborted();
      const error = body?.error;
      const info = Array.isArray(error?.details)
        ? error.details.find(
            (item) =>
              item?.['@type'] === 'type.googleapis.com/google.rpc.ErrorInfo' &&
              item.domain === 'googleapis.com',
          )
        : undefined;
      // Retain only structured codes. Provider messages/metadata can contain
      // account details or credentials and must not enter the release journal.
      const code = (value) =>
        typeof value === 'string' && /^[A-Z][A-Z_]{0,79}$/.test(value) ? value : undefined;
      providerError = {
        httpStatus: response.status,
        code: Number.isInteger(error?.code) ? error.code : undefined,
        status: code(error?.status),
        reason: code(info?.reason),
      };
    } catch {
      // An absent, malformed or interrupted error body cannot authorize retry.
    }
    throw new StoreError(
      `Provider returned HTTP ${response.status}; reconcile before retrying.`,
      response.status,
      providerError,
    );
  }
  if (response.status === 204) return null;
  try {
    const data = await response.json();
    signal.throwIfAborted();
    return data;
  } catch {
    throw new StoreError('Provider response was not valid JSON.');
  }
}

async function credentials(ctx, cfg) {
  try {
    return JSON.parse(await readFile(secretPath(ctx, cfg), 'utf8'));
  } catch {
    throw new StoreError('Store credential file is unavailable or invalid.');
  }
}

async function appleToken(ctx, cfg) {
  const key = await credentials(ctx, cfg);
  if (!key.key_id || !key.issuer_id || !key.key || key.in_house === true)
    throw new StoreError(
      'An App Store Connect team API key JSON with key_id, issuer_id and key is required.',
    );
  let token,
    expires = 0;
  // Upload may take longer than the JWT lifetime. Refresh before each new ASC
  // request, without replaying any provider request or upload as an auth retry.
  return () => {
    const issued = Math.floor((ctx.now?.() ?? Date.now()) / 1000);
    if (token && issued < expires - 60) return token;
    const unsigned = `${encode({ alg: 'ES256', kid: key.key_id, typ: 'JWT' })}.${encode({ iss: key.issuer_id, iat: issued, exp: issued + 600, aud: 'appstoreconnect-v1' })}`;
    try {
      token = `${unsigned}.${sign('sha256', Buffer.from(unsigned), { key: key.is_key_content_base64 ? Buffer.from(key.key, 'base64') : key.key, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
      expires = issued + 600;
      return token;
    } catch {
      throw new StoreError('App Store Connect signing key is invalid.');
    }
  };
}

async function googleToken(ctx, cfg) {
  const key = await credentials(ctx, cfg);
  if (!key.client_email || !key.private_key)
    throw new StoreError('Google service account JSON is incomplete.');
  const issued = Math.floor(Date.now() / 1000);
  const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iss: key.client_email, scope: 'https://www.googleapis.com/auth/androidpublisher', aud: OAUTH, iat: issued, exp: issued + 3600 })}`;
  let assertion;
  try {
    assertion = `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), key.private_key).toString('base64url')}`;
  } catch {
    throw new StoreError('Google service account signing key is invalid.');
  }
  const response = await request(ctx, OAUTH, null, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }).toString(),
  });
  if (!response.access_token) throw new StoreError('Google did not return an access token.');
  return response.access_token;
}

async function appleList(ctx, token, endpoint) {
  const data = [],
    included = [];
  let url = new URL(endpoint, APPLE).href;
  const visited = new Set();
  while (url) {
    if (new URL(url).origin !== APPLE || visited.has(url) || visited.size >= 100)
      throw new StoreError('App Store pagination could not be verified.');
    visited.add(url);
    const page = await request(ctx, url, token);
    if (!Array.isArray(page.data)) throw new StoreError('App Store list response is invalid.');
    data.push(...page.data);
    included.push(...(page.included ?? []));
    url = page.links?.next;
  }
  return { data, included };
}

async function appleListing(ctx, cfg, token, metadata) {
  try {
    return await auditAppleListing({
      metadata,
      metadataWillUpload: !cfg.contentPath,
      appId: cfg.appId,
      version: ctx.plan.version,
      list: (endpoint) => appleList(ctx, token, endpoint),
      read: (endpoint) => request(ctx, new URL(endpoint, APPLE).href, token),
    });
  } catch (error) {
    if (error instanceof StoreError) throw error;
    if (error instanceof AppleListingError) throw new StoreError(error.message);
    throw new StoreError('App Store listing preflight could not be completed.');
  }
}

async function appleUpload(ctx, cfg, token) {
  const params = new URLSearchParams({
    'filter[cfBundleShortVersionString]': ctx.artifact.version,
    'filter[cfBundleVersion]': String(ctx.artifact.buildNumber),
    'filter[platform]': 'IOS',
    limit: '200',
  });
  const uploads = await appleList(
    ctx,
    token,
    `/v1/apps/${segment(cfg.appId)}/buildUploads?${params}`,
  );
  if (uploads.data.length > 1) throw new StoreError('Exact App Store build upload is ambiguous.');
  const upload = uploads.data[0];
  if (!upload) return;
  const a = upload.attributes;
  if (
    upload.type !== 'buildUploads' ||
    !upload.id ||
    a?.platform !== 'IOS' ||
    a.cfBundleShortVersionString !== ctx.artifact.version ||
    String(a.cfBundleVersion) !== String(ctx.artifact.buildNumber)
  )
    throw new StoreError('Remote App Store build upload identity does not match.');
  // Retain diagnostic counts, not free-text messages which may contain secrets.
  const state = a.state;
  return {
    id: upload.id,
    state: state?.state,
    errorCount: Array.isArray(state?.errors) ? state.errors.length : 0,
    warningCount: Array.isArray(state?.warnings) ? state.warnings.length : 0,
  };
}

function compareVersion(a, b) {
  if (!/^\d+(\.\d+)*$/.test(a) || !/^\d+(\.\d+)*$/.test(b))
    throw new StoreError('Store version cannot be compared safely.');
  const left = a.split('.').map(BigInt),
    right = b.split('.').map(BigInt);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    if ((left[i] ?? 0n) !== (right[i] ?? 0n)) return (left[i] ?? 0n) > (right[i] ?? 0n) ? 1 : -1;
  }
  return 0;
}

async function observeApple(ctx, cfg, token, { allowRejectedReplacement = false } = {}) {
  const app = await request(ctx, `${APPLE}/v1/apps/${segment(cfg.appId)}`, token);
  if (app.data?.attributes?.bundleId !== cfg.bundleId)
    throw new StoreError('Remote App Store app has a different bundle identifier.');
  const versions = await appleList(
    ctx,
    token,
    `/v1/apps/${segment(cfg.appId)}/appStoreVersions?filter[platform]=IOS&include=build&limit=200`,
  );
  if (
    versions.data.some((v) => compareVersion(v.attributes.versionString, ctx.artifact.version) > 0)
  )
    throw new StoreError('A newer App Store version supersedes this release. Replan explicitly.');
  const targets = versions.data.filter((v) => v.attributes.versionString === ctx.artifact.version);
  const target = targets[0];
  const selectedId = target?.relationships?.build?.data?.id;
  const selected = versions.included.find((b) => b.type === 'builds' && b.id === selectedId);
  if (selectedId && !selected)
    throw new StoreError('Selected App Store build could not be inspected.');
  if (selected && compareVersion(selected.attributes.version, String(ctx.artifact.buildNumber)) > 0)
    throw new StoreError('A newer App Store build supersedes this release.');
  const params = new URLSearchParams({
    'filter[app]': String(cfg.appId),
    'filter[version]': String(ctx.artifact.buildNumber),
    'filter[preReleaseVersion.version]': ctx.artifact.version,
    'filter[preReleaseVersion.platform]': 'IOS',
    include: 'preReleaseVersion',
    limit: '200',
  });
  const builds = await appleList(ctx, token, `/v1/builds?${params}`);
  if (builds.data.length > 1) throw new StoreError('Exact App Store build is ambiguous.');
  const build = builds.data[0];
  if (
    build &&
    (String(build.attributes.version) !== String(ctx.artifact.buildNumber) ||
      !builds.included.some(
        (v) =>
          v.type === 'preReleaseVersions' &&
          v.id === build.relationships?.preReleaseVersion?.data?.id &&
          v.attributes.version === ctx.artifact.version &&
          v.attributes.platform === 'IOS',
      ))
  )
    throw new StoreError('Remote App Store build identity does not match.');
  const appleState = target?.attributes?.appVersionState ?? target?.attributes?.appStoreState;
  const states = {
    WAITING_FOR_REVIEW: 'in-review',
    IN_REVIEW: 'in-review',
    REJECTED: 'rejected',
    METADATA_REJECTED: 'rejected',
    INVALID_BINARY: 'rejected',
    DEVELOPER_REJECTED: 'rejected',
    PENDING_DEVELOPER_RELEASE: 'pending-release',
    PENDING_APPLE_RELEASE: 'processing',
    PROCESSING_FOR_APP_STORE: 'processing',
    PROCESSING_FOR_DISTRIBUTION: 'processing',
    READY_FOR_SALE: 'released',
    READY_FOR_DISTRIBUTION: 'released',
    REMOVED_FROM_SALE: 'unavailable',
    DEVELOPER_REMOVED_FROM_SALE: 'unavailable',
  };
  // A corrected successor may retain the marketing version after rejection.
  // Only publication may replace that selected build, and only when it is
  // strictly older. Read-only observations must never attribute its rejection
  // to an intended build that is not selected yet.
  const replacesRejectedBuild =
    allowRejectedReplacement &&
    states[appleState] === 'rejected' &&
    selectedId &&
    selected &&
    compareVersion(selected.attributes.version, String(ctx.artifact.buildNumber)) < 0;
  if (
    states[appleState] &&
    (!selectedId || !build?.id || selectedId !== build.id) &&
    !replacesRejectedBuild
  )
    throw new StoreError(
      'The App Store version is attached to a different build; refusing to replace it.',
    );
  const state = replacesRejectedBuild
    ? undefined
    : (states[appleState] ??
      (appleState && appleState !== 'PREPARE_FOR_SUBMISSION' ? 'unknown' : undefined));
  const observation = {
    build,
    target,
    targetCount: targets.length,
    state,
    appleState: replacesRejectedBuild ? undefined : appleState,
    buildId: build?.id,
    versionId: target?.id,
    ...(replacesRejectedBuild ? { replacesRejectedBuildId: selectedId } : {}),
  };
  if (!build) observation.upload = await appleUpload(ctx, cfg, token);
  if (state === 'released') {
    // A historical released version alone does not establish current availability.
    try {
      const availability = await request(
        ctx,
        `${APPLE}/v1/apps/${segment(cfg.appId)}/appAvailabilityV2`,
        token,
      );
      if (!availability.data?.id) throw new StoreError('App availability identity is missing.');
      const territories = await appleList(
        ctx,
        token,
        `/v2/appAvailabilities/${segment(availability.data.id)}/territoryAvailabilities?include=territory&limit=200`,
      );
      observation.availableTerritories = territories.data
        .filter(
          (t) =>
            t.attributes?.available === true &&
            t.attributes.contentStatuses?.length === 1 &&
            t.attributes.contentStatuses[0] === 'AVAILABLE',
        )
        .map((t) => t.relationships?.territory?.data?.id)
        .filter(Boolean)
        .sort();
      if (observation.availableTerritories.length > 0) observation.state = 'available';
    } catch {
      observation.availabilityMessage = 'Territory availability could not be observed.';
    }
  }
  return observation;
}

function appleResult(ctx, observed) {
  const upload = previous(ctx, 'ios-upload');
  const selected = observed.target?.relationships?.build?.data;
  // This is evidence for local ownership handoff, never permission to submit
  // the stale binary. Missing/unknown provider fields do not prove no review.
  const unsubmittedUpload =
    /^[a-f0-9]{40}$/.test(ctx.plan.source) &&
    upload?.state === 'uploaded' &&
    !previous(ctx, 'ios-review') &&
    observed.build?.type === 'builds' &&
    observed.buildId &&
    (upload.buildId === undefined || upload.buildId === observed.buildId) &&
    ['VALID', 'PROCESSING'].includes(observed.build.attributes.processingState) &&
    observed.targetCount <= 1 &&
    (!observed.target ||
      (observed.target.type === 'appStoreVersions' &&
        observed.appleState === 'PREPARE_FOR_SUBMISSION' &&
        (selected === null || selected?.id === observed.buildId)))
      ? {
          source: ctx.plan.source,
          artifactSha256: ctx.artifact.sha256,
          buildId: observed.buildId,
          buildNumber: String(ctx.artifact.buildNumber),
          version: ctx.artifact.version,
          versionId: observed.versionId ?? null,
          versionState: observed.appleState ?? null,
          selectedBuildId: selected?.id ?? null,
          buildProcessingState: observed.build.attributes.processingState,
        }
      : undefined;
  return result(
    ctx,
    observed.state ??
      (observed.build
        ? observed.build.attributes.processingState === 'VALID'
          ? 'uploaded'
          : ['FAILED', 'INVALID'].includes(observed.build.attributes.processingState)
            ? 'rejected'
            : 'processing'
        : observed.upload?.state === 'FAILED'
          ? 'rejected'
          : ['PROCESSING', 'COMPLETE'].includes(observed.upload?.state)
            ? 'processing'
            : 'unknown'),
    {
      buildId: observed.buildId,
      versionId: observed.versionId,
      providerState: observed.state
        ? observed.appleState
        : (observed.build?.attributes.processingState ??
          observed.upload?.state ??
          observed.appleState),
      ...(observed.upload ? { buildUpload: observed.upload } : {}),
      availabilityVerified: observed.state === 'available',
      ...(unsubmittedUpload ? { unsubmittedUpload } : {}),
      ...(observed.availableTerritories
        ? { availableTerritories: observed.availableTerritories }
        : {}),
      ...(observed.state === 'released'
        ? {
            message:
              'App Store reports released; territory availability and installation have not been verified.',
          }
        : {}),
      ...(observed.state === 'available'
        ? {
            message:
              'App Store reports the exact version released and available in the listed territories. Device installation has not been verified.',
          }
        : {}),
    },
  );
}

async function fastlaneWorkspace(action) {
  // Never load an operator Deliverfile or Fastfile. Fastlane initializes before
  // reading --metadata_path; a comment-only bootstrap avoids local option files.
  // The inherited Fastlane environment remains effective. mkdtemp uses mode 0700.
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'release-kit-store-'));
  try {
    await writeFile(
      path.join(cwd, 'Deliverfile'),
      '# This bootstrap defines no release options.\n',
      { mode: 0o600 },
    );
    return await action(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

async function fastlane(ctx, args, cwd) {
  const response = await ctx.command('fastlane', args, {
    cwd,
    env: {
      ...ctx.env,
      CI: 'true',
      FASTLANE_SKIP_UPDATE_CHECK: '1',
      FASTLANE_HIDE_CHANGELOG: '1',
      FASTLANE_OPT_OUT_USAGE: '1',
    },
    sensitive: true,
    timeoutMs: 60 * 60 * 1000,
  });
  if (
    (response?.exitCode !== undefined && response.exitCode !== 0) ||
    (response?.code !== undefined && response.code !== 0)
  )
    throw new StoreError('Fastlane did not confirm completion.');
}

async function prepareAppleReleasePolicy(ctx, token, versionId) {
  if (!versionId) throw new StoreError('Editable version identity is missing.');
  const endpoint = `${APPLE}/v1/appStoreVersions/${segment(versionId)}`;
  const readVersion = () => request(ctx, endpoint, token);
  const current = await readVersion();
  if (current.data?.id !== versionId)
    throw new StoreError('Release policy version identity differs.');
  if (current.data.attributes?.releaseType !== 'AFTER_APPROVAL') {
    if (previous(ctx, 'ios-release-policy'))
      throw new StoreError('A prior release policy update is unresolved; it was not repeated.');
    await save(ctx, 'ios-release-policy', { state: 'intent', versionId });
    await request(ctx, endpoint, token, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        data: {
          type: 'appStoreVersions',
          id: versionId,
          attributes: { releaseType: 'AFTER_APPROVAL' },
        },
      }),
    });
    const verified = await readVersion();
    if (
      verified.data?.id !== versionId ||
      verified.data.attributes?.releaseType !== 'AFTER_APPROVAL'
    )
      throw new StoreError('Automatic release policy has not been confirmed.');
    await save(ctx, 'ios-release-policy', { state: 'confirmed', versionId });
  }
  const readPhased = async () => {
    try {
      return (await request(ctx, `${endpoint}/appStoreVersionPhasedRelease`, token)).data;
    } catch (error) {
      if (error.status === 404) return null;
      throw error;
    }
  };
  const phased = await readPhased();
  if (phased) {
    if (!phased.id || phased.type !== 'appStoreVersionPhasedReleases')
      throw new StoreError('Phased release identity is invalid.');
    if (previous(ctx, 'ios-phased-release'))
      throw new StoreError('A prior phased release removal is unresolved; it was not repeated.');
    await save(ctx, 'ios-phased-release', { state: 'intent', versionId, phasedId: phased.id });
    await request(ctx, `${APPLE}/v1/appStoreVersionPhasedReleases/${segment(phased.id)}`, token, {
      method: 'DELETE',
    });
    if (await readPhased()) throw new StoreError('Phased release removal has not been confirmed.');
    await save(ctx, 'ios-phased-release', { state: 'confirmed', versionId, phasedId: phased.id });
  }
}

async function publishApple(ctx, cfg) {
  const metadata = await sourcePath(ctx, cfg.metadataPath, true);
  const informationPath = await sourcePath(ctx, cfg.submissionInformationPath);
  let information;
  try {
    information = JSON.parse(await readFile(informationPath, 'utf8'));
  } catch {
    throw new StoreError('Review submission information is missing or invalid.');
  }
  if (!information || Array.isArray(information) || typeof information !== 'object')
    throw new StoreError('Review submission information must be a JSON object.');
  const token = await appleToken(ctx, cfg);
  let observed = await observeApple(ctx, cfg, token, { allowRejectedReplacement: true });
  const upload = previous(ctx, 'ios-upload');
  if (observed.build && !upload)
    throw new StoreError(
      'This App Store build already exists without a matching upload journal. Its artifact ownership cannot be established.',
    );
  if (observed.upload && !upload)
    throw new StoreError('This App Store build upload exists without a matching upload journal.');
  if (observed.state) return appleResult(ctx, observed);
  if (observed.upload) return appleResult(ctx, observed);
  if (cfg.contentPath) {
    const { verifyPreparedAppleContent } = await import('./store-content.mjs');
    await verifyPreparedAppleContent(ctx);
  }
  if (!observed.build) {
    if (upload)
      return result(ctx, upload.state === 'uploaded' ? 'processing' : 'unknown', {
        message: 'The journaled upload is not yet visible. It will not be uploaded again.',
      });
    await appleListing(ctx, cfg, token, metadata);
    const fresh = await observeApple(ctx, cfg, token, { allowRejectedReplacement: true });
    if (fresh.build || fresh.upload)
      throw new StoreError(
        'An App Store build appeared during preflight without an upload journal.',
      );
    if (fresh.state) return appleResult(ctx, fresh);
    const failed = await fastlaneWorkspace(async (cwd) => {
      await save(ctx, 'ios-upload', { state: 'intent' });
      try {
        await fastlane(
          ctx,
          [
            'pilot',
            'upload',
            '--api_key_path',
            secretPath(ctx, cfg),
            '--ipa',
            ctx.artifact.path,
            '--app_identifier',
            cfg.bundleId,
            '--apple_id',
            String(cfg.appId),
            '--skip_submission',
            'true',
            '--skip_waiting_for_build_processing',
            'true',
          ],
          cwd,
        );
        await save(ctx, 'ios-upload', { state: 'uploaded' });
      } catch {
        await save(ctx, 'ios-upload', { state: 'unknown' });
        return result(ctx, 'unknown', {
          message:
            'Upload result is unknown. Resume reconciles the exact build before any further action.',
        });
      }
    });
    if (failed) return failed;
    observed = await observeApple(ctx, cfg, token, { allowRejectedReplacement: true });
    if (!observed.build)
      return observed.upload
        ? appleResult(ctx, observed)
        : result(ctx, 'processing', {
            message: 'Upload completed; waiting for the exact build to appear.',
          });
  }
  const processing = observed.build.attributes.processingState;
  if (['FAILED', 'INVALID'].includes(processing))
    return result(ctx, 'rejected', { buildId: observed.buildId, providerState: processing });
  if (processing !== 'VALID') return appleResult(ctx, observed);
  await save(ctx, 'ios-upload', { state: 'uploaded', buildId: observed.buildId });
  if (previous(ctx, 'ios-review'))
    return result(ctx, 'unknown', {
      buildId: observed.buildId,
      message:
        'An earlier review submission is not confirmed by App Store Connect. No duplicate submission was sent.',
    });
  // The upload can be long-running; verify the tree again before Fastlane reads it.
  await sourcePath(ctx, cfg.metadataPath, true);
  await sourcePath(ctx, cfg.submissionInformationPath);
  await appleListing(ctx, cfg, token, metadata);
  // Reconcile again immediately before selecting/changing the store version.
  observed = await observeApple(ctx, cfg, token, { allowRejectedReplacement: true });
  if (observed.state) return appleResult(ctx, observed);
  if (!observed.build || observed.build.attributes.processingState !== 'VALID')
    return appleResult(ctx, observed);
  const reviewIdentity = {
    buildId: observed.buildId,
    ...(observed.replacesRejectedBuildId
      ? { replacesRejectedBuildId: observed.replacesRejectedBuildId }
      : {}),
  };
  return fastlaneWorkspace(async (cwd) => {
    if (cfg.contentPath) {
      const { verifyPreparedAppleContent } = await import('./store-content.mjs');
      await verifyPreparedAppleContent(ctx);
      await prepareAppleReleasePolicy(ctx, token, observed.versionId);
    }
    await save(ctx, 'ios-review', { state: 'intent', ...reviewIdentity });
    try {
      await fastlane(
        ctx,
        [
          'deliver',
          '--api_key_path',
          secretPath(ctx, cfg),
          '--app_identifier',
          cfg.bundleId,
          '--app_version',
          ctx.artifact.version,
          '--build_number',
          String(ctx.artifact.buildNumber),
          '--platform',
          'ios',
          '--skip_binary_upload',
          'true',
          '--skip_screenshots',
          'true',
          '--skip_metadata',
          cfg.contentPath ? 'true' : 'false',
          '--metadata_path',
          metadata,
          '--submission_information',
          JSON.stringify(information),
          '--submit_for_review',
          'true',
          '--automatic_release',
          'true',
          '--phased_release',
          'false',
          '--force',
          'true',
          '--precheck_include_in_app_purchases',
          'false',
        ],
        cwd,
      );
      await save(ctx, 'ios-review', { state: 'submitted', ...reviewIdentity });
    } catch {
      await save(ctx, 'ios-review', { state: 'unknown', ...reviewIdentity });
      return result(ctx, 'unknown', {
        buildId: observed.buildId,
        message: 'Review submission result is unknown; resume will only reconcile it.',
      });
    }
    return result(ctx, 'submitted', {
      buildId: observed.buildId,
      availabilityVerified: false,
      message:
        'App Review submission completed; Apple processing, review and publication remain external.',
    });
  });
}

function playBase(cfg) {
  return `${GOOGLE}/androidpublisher/v3/applications/${segment(cfg.packageName)}`;
}

function playReviewConflict(error) {
  return (
    error?.httpStatus === 400 &&
    error.code === 400 &&
    error.status === 'FAILED_PRECONDITION' &&
    error.reason === 'CHANGES_ALREADY_IN_REVIEW'
  );
}

function retryablePlayCommit(commit) {
  return (
    commit?.state === 'not-committed' &&
    commit.retryable === true &&
    playReviewConflict(commit.providerError)
  );
}

function pendingPlayCommit(ctx, commit) {
  return result(ctx, 'blocked', {
    editId: commit.editId,
    retryable: retryablePlayCommit(commit),
    providerError: commit.providerError,
    message:
      commit.state === 'failed'
        ? 'The uncommitted Play edit expired or was invalidated. Reconcile it in Play Console before replanning; no replacement edit or upload was created.'
        : 'Play confirmed this edit was not committed because other changes are in review. Resume after that review completes to revalidate and retry the same edit.',
  });
}

async function observePlay(ctx, cfg, token) {
  const response = await request(ctx, `${playBase(cfg)}/tracks/production/releases`, token);
  const releases = response.releases ?? [];
  if (!Array.isArray(releases) || releases.some((r) => r.track !== 'production'))
    throw new StoreError('Play returned a different destination track.');
  const code = BigInt(ctx.artifact.buildNumber);
  if (releases.some((r) => r.activeArtifacts?.some((a) => BigInt(a.versionCode) > code)))
    throw new StoreError(
      'A newer Play production version supersedes this release. Replan explicitly.',
    );
  const matches = releases.filter((r) =>
    r.activeArtifacts?.some((a) => String(a.versionCode) === String(ctx.artifact.buildNumber)),
  );
  if (matches.length > 1) throw new StoreError('Play release identity is ambiguous.');
  const release = matches[0];
  if (!release) return undefined;
  const states = {
    RELEASE_LIFECYCLE_STATE_DRAFT: 'prepared',
    RELEASE_LIFECYCLE_STATE_NOT_SENT_FOR_REVIEW: 'pending-review',
    RELEASE_LIFECYCLE_STATE_IN_REVIEW: 'in-review',
    RELEASE_LIFECYCLE_STATE_APPROVED_NOT_PUBLISHED: 'pending-release',
    RELEASE_LIFECYCLE_STATE_NOT_APPROVED: 'rejected',
    RELEASE_LIFECYCLE_STATE_PUBLISHED: 'available',
  };
  return result(ctx, states[release.releaseLifecycleState] ?? 'unknown', {
    versionCode: String(ctx.artifact.buildNumber),
    providerState: release.releaseLifecycleState,
    availabilityVerified: release.releaseLifecycleState === 'RELEASE_LIFECYCLE_STATE_PUBLISHED',
    message:
      release.releaseLifecycleState === 'RELEASE_LIFECYCLE_STATE_PUBLISHED'
        ? 'Play reports this version available on production; this API also includes partial or halted releases and does not attest full rollout or device installation.'
        : 'Play release lifecycle observed through the read-only releases API.',
  });
}

async function observePendingPlayEdit(ctx, cfg, token) {
  const edit = previous(ctx, 'android-edit');
  const upload = previous(ctx, 'android-upload');
  const track = previous(ctx, 'android-track');
  const commit = previous(ctx, 'android-commit');
  const beforeUpload = ['android-upload', 'android-track', 'android-commit'].every(
    (name) => !Object.hasOwn(ctx.previous ?? {}, name),
  );
  if (
    !/^[a-f0-9]{40}$/.test(ctx.plan.source) ||
    edit?.state !== 'created' ||
    !edit.id ||
    (!beforeUpload &&
      (upload?.state !== 'uploaded' ||
        upload.editId !== edit.id ||
        (Object.hasOwn(ctx.previous ?? {}, 'android-track') &&
          (track?.state !== 'selected' || track?.editId !== edit.id)) ||
        (Object.hasOwn(ctx.previous ?? {}, 'android-commit') &&
          (!retryablePlayCommit(commit) || commit?.editId !== edit.id))))
  )
    return undefined;
  const endpoint = `${playBase(cfg)}/edits/${segment(edit.id)}`;
  const current = await request(ctx, endpoint, token);
  if (current.id !== edit.id) return undefined;
  const withinCurrentCode = (code) =>
    /^[1-9]\d*$/.test(String(code)) &&
    (beforeUpload
      ? BigInt(code) < BigInt(ctx.artifact.buildNumber)
      : BigInt(code) <= BigInt(ctx.artifact.buildNumber));
  const { bundles } = await request(ctx, `${endpoint}/bundles`, token);
  if (!Array.isArray(bundles) || bundles.some((bundle) => !withinCurrentCode(bundle.versionCode)))
    return undefined;
  const matches = bundles.filter(
    (bundle) => String(bundle.versionCode) === String(ctx.artifact.buildNumber),
  );
  if (
    !beforeUpload &&
    (matches.length !== 1 || matches[0].sha256?.toLowerCase() !== ctx.artifact.sha256)
  )
    return undefined;
  const target = await request(ctx, `${endpoint}/tracks/production`, token);
  if (
    target.track !== 'production' ||
    !Array.isArray(target.releases) ||
    target.releases.some(
      (release) =>
        !['draft', 'inProgress', 'halted', 'completed'].includes(release.status) ||
        !Array.isArray(release.versionCodes) ||
        release.versionCodes.length === 0 ||
        release.versionCodes.some((code) => !withinCurrentCode(code)),
    )
  )
    return undefined;
  const editIdentity = {
    source: ctx.plan.source,
    artifactSha256: ctx.artifact.sha256,
    editId: edit.id,
    versionCode: String(ctx.artifact.buildNumber),
    version: ctx.artifact.version,
    track: 'production',
  };
  // A created edit without an upload intent is a distinct recovery boundary.
  // Its artifact hash is only local identity; the remote reads above prove
  // the planned version is absent, rather than attest an uploaded artifact.
  return beforeUpload
    ? { unuploadedEdit: { ...editIdentity, uploadState: 'absent' } }
    : { uncommittedEdit: { ...editIdentity, commitState: commit?.state ?? 'absent' } };
}

async function publishPlay(ctx, cfg) {
  const token = await googleToken(ctx, cfg);
  const observed = await observePlay(ctx, cfg, token);
  if (observed) {
    if (!ownedPlayRelease(ctx))
      throw new StoreError(
        'This Play version already exists without a matching upload journal. Its artifact ownership cannot be established.',
      );
    return observed;
  }
  const commit = previous(ctx, 'android-commit');
  if (commit?.state === 'failed') return pendingPlayCommit(ctx, commit);
  if (commit && !retryablePlayCommit(commit))
    return result(ctx, 'unknown', {
      message:
        'A previous commit is not visible in the read-only release API. No duplicate commit was sent.',
    });
  let edit = previous(ctx, 'android-edit');
  if (ctx.config.stores.android.contentPath) {
    const { verifyPreparedPlayContent } = await import('./store-content.mjs');
    const prepared = ctx.preparation?.edit;
    await verifyPreparedPlayContent(ctx, edit ?? prepared ?? {});
    if (!edit)
      edit = await save(ctx, 'android-edit', {
        state: 'created',
        ...prepared,
        contentApproval: ctx.preparation.approval,
      });
  }

  if (commit && (!edit?.id || commit.editId !== edit.id))
    throw new StoreError('The uncommitted Play operation does not match the journaled edit.');
  if (!edit?.id) {
    if (edit)
      return result(ctx, 'unknown', {
        message:
          'Edit creation was interrupted before its ID was recorded. Inspect Play Console before replanning.',
      });
    await save(ctx, 'android-edit', { state: 'intent' });
    try {
      const created = await request(ctx, `${playBase(cfg)}/edits`, token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      if (!created.id) throw new StoreError('Play did not return the edit ID.');
      edit = await save(ctx, 'android-edit', {
        state: 'created',
        id: created.id,
        expiryTimeSeconds: created.expiryTimeSeconds,
      });
    } catch {
      return result(ctx, 'unknown', {
        message: 'Edit creation is unconfirmed; no upload was attempted.',
      });
    }
  }
  const endpoint = `${playBase(cfg)}/edits/${segment(edit.id)}`;
  try {
    const currentEdit = await request(ctx, endpoint, token);
    if (currentEdit.id !== edit.id)
      throw new StoreError('Play returned a different edit than the journaled operation.');
  } catch (error) {
    if ([404, 410].includes(error.status)) {
      if (retryablePlayCommit(commit)) {
        const failed = await save(ctx, 'android-commit', {
          state: 'failed',
          editId: edit.id,
          retryable: false,
          failureReason: 'EDIT_EXPIRED_OR_INVALIDATED',
          providerError: commit.providerError,
        });
        return pendingPlayCommit(ctx, failed);
      }
      return result(ctx, 'unknown', {
        message:
          'The journaled Play edit expired or was invalidated. No automatic replacement edit or upload was created.',
      });
    }
    throw error;
  }
  const bundles = (await request(ctx, `${endpoint}/bundles`, token)).bundles ?? [];
  if (bundles.some((b) => BigInt(b.versionCode) > BigInt(ctx.artifact.buildNumber)))
    throw new StoreError('A newer uploaded Play bundle supersedes this release.');
  let bundle = bundles.find((b) => String(b.versionCode) === String(ctx.artifact.buildNumber));
  if (bundle && bundle.sha256?.toLowerCase() !== ctx.artifact.sha256)
    throw new StoreError('The remote Play versionCode belongs to different artifact bytes.');
  if (bundle && !previous(ctx, 'android-upload'))
    await save(ctx, 'android-upload', { state: 'uploaded', editId: edit.id, reconciled: true });
  if (!bundle) {
    if (previous(ctx, 'android-upload'))
      return result(ctx, 'unknown', {
        editId: edit.id,
        message: 'A previous upload is not visible in this edit. It was not repeated.',
      });
    await save(ctx, 'android-upload', { state: 'intent', editId: edit.id });
    try {
      const size = (await stat(ctx.artifact.path)).size;
      bundle = await request(
        ctx,
        `${GOOGLE}/upload/androidpublisher/v3/applications/${segment(cfg.packageName)}/edits/${segment(edit.id)}/bundles?uploadType=media`,
        token,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(size) },
          body: createReadStream(ctx.artifact.path),
          duplex: 'half',
          timeoutMs: 30 * 60 * 1000,
        },
      );
      if (
        String(bundle.versionCode) !== String(ctx.artifact.buildNumber) ||
        bundle.sha256?.toLowerCase() !== ctx.artifact.sha256
      )
        throw new StoreError('Play upload receipt does not match artifact identity.');
      await save(ctx, 'android-upload', { state: 'uploaded', editId: edit.id });
    } catch {
      return result(ctx, 'unknown', {
        editId: edit.id,
        message: 'Play upload result is unconfirmed; resume reconciles the edit and exact SHA256.',
      });
    }
  }
  const current = await observePlay(ctx, cfg, token);
  if (current) return current;
  const target = await request(ctx, `${endpoint}/tracks/production`, token);
  if (target.track !== 'production')
    throw new StoreError('Play edit has the wrong destination track.');
  if (
    target.releases?.some((r) =>
      r.versionCodes?.some((v) => BigInt(v) > BigInt(ctx.artifact.buildNumber)),
    )
  )
    throw new StoreError('A newer Play edit release supersedes this release.');
  const alreadySelected =
    target.releases?.length === 1 &&
    target.releases[0].status === 'completed' &&
    target.releases[0].versionCodes?.length === 1 &&
    String(target.releases[0].versionCodes[0]) === String(ctx.artifact.buildNumber);
  if (!alreadySelected) {
    if (previous(ctx, 'android-track') || retryablePlayCommit(commit))
      return result(ctx, 'unknown', {
        editId: edit.id,
        message: 'A previous track update could not be reconciled. It was not repeated.',
      });
    await save(ctx, 'android-track', { state: 'intent', editId: edit.id });
    try {
      await request(ctx, `${endpoint}/tracks/production`, token, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          track: 'production',
          releases: [
            {
              name: ctx.artifact.version,
              versionCodes: [String(ctx.artifact.buildNumber)],
              status: 'completed',
            },
          ],
        }),
      });
      await save(ctx, 'android-track', { state: 'selected', editId: edit.id });
    } catch {
      return result(ctx, 'unknown', {
        editId: edit.id,
        message: 'Play track update is unconfirmed; resume will reconcile it.',
      });
    }
  }
  if (ctx.config.stores.android.contentPath) {
    const { verifyPreparedPlayContent } = await import('./store-content.mjs');
    await verifyPreparedPlayContent(ctx, edit);
  }
  await save(ctx, 'android-commit', { state: 'intent', editId: edit.id });
  try {
    await request(
      ctx,
      `${endpoint}:commit?changesNotSentForReview=false&changesInReviewBehavior=ERROR_IF_IN_REVIEW`,
      token,
      { method: 'POST' },
    );
    await save(ctx, 'android-commit', { state: 'submitted', editId: edit.id });
  } catch (error) {
    if (playReviewConflict(error.providerError)) {
      // ERROR_IF_IN_REVIEW explicitly leaves this edit valid and uncommitted.
      // A later invocation may retry only after rechecking the same edit,
      // bundle hash and production selection above. All ambiguous errors keep
      // the intent checkpoint and remain reconciliation-only.
      const blocked = await save(ctx, 'android-commit', {
        state: 'not-committed',
        editId: edit.id,
        retryable: true,
        providerError: error.providerError,
      });
      return pendingPlayCommit(ctx, blocked);
    }
    return result(ctx, 'unknown', {
      editId: edit.id,
      message:
        'Play commit is unconfirmed. Resume will use the read-only release API; it will not commit again.',
    });
  }
  return result(ctx, 'submitted', {
    editId: edit.id,
    versionCode: String(ctx.artifact.buildNumber),
    availabilityVerified: false,
    message: 'Production edit committed for review. Publication has not yet been observed.',
  });
}

export async function doctorStore(ctx) {
  const checks = [];
  try {
    const cfg = identitySettings(ctx);
    if (ctx.platform === 'android') {
      try {
        requirePlayPublishingPolicy(cfg);
        checks.push({
          name: 'android managed publishing',
          ok: true,
          message:
            'Local configuration asserts managed publishing is disabled; the Play Console setting has not been verified.',
        });
      } catch (error) {
        checks.push({ name: 'android managed publishing', ok: false, message: error.message });
      }
      try {
        const file = secretPath(ctx, cfg);
        if (!(await stat(file)).isFile())
          throw new StoreError('Store credential reference must resolve to a regular file.');
        await access(file, constants.R_OK);
        checks.push({
          name: 'android store credentials',
          ok: true,
          message:
            'Credential file is locally readable; its contents and remote permissions have not been tested.',
        });
      } catch (error) {
        checks.push({
          name: 'android store credentials',
          ok: false,
          message:
            error instanceof StoreError
              ? error.message
              : 'Store credential file reference is unavailable or unreadable.',
        });
      }
      return { checks };
    }
    await access(secretPath(ctx, cfg));
    checks.push({
      name: `${ctx.platform} store credentials`,
      ok: true,
      message: 'Credential file reference is readable; remote permissions have not been tested.',
    });
    if (ctx.platform === 'ios') {
      if (ctx.previous?.['ios-review']) {
        previous(ctx, 'ios-review');
        checks.push({
          name: 'iOS review reconciliation',
          ok: true,
          message:
            'Existing review intent is reconciliation-only; new-operation listing and Fastlane checks are skipped.',
        });
        return { checks };
      }
      await sourcePath(ctx, cfg.metadataPath, true);
      await sourcePath(ctx, cfg.submissionInformationPath);
      await fastlaneWorkspace((cwd) => fastlane(ctx, ['deliver', '--help'], cwd));
      const cfgMetadata = await sourcePath(ctx, cfg.metadataPath, true);
      const token = await appleToken(ctx, cfg);
      const app = await request(ctx, `${APPLE}/v1/apps/${segment(cfg.appId)}`, token);
      if (app.data?.attributes?.bundleId !== cfg.bundleId)
        throw new StoreError('Remote App Store app has a different bundle identifier.');
      const listing = await appleListing(ctx, cfg, token, cfgMetadata);
      checks.push({
        name: 'iOS review metadata and Fastlane',
        ok: true,
        message:
          'Read-only listing audit and isolated Fastlane help passed; content, declarations, native acceptance and Apple approval remain separate gates.',
        listing,
      });
    }
  } catch (error) {
    checks.push({
      name: `${ctx.platform} store preflight`,
      ok: false,
      message:
        error instanceof StoreError
          ? error.message
          : 'A required store tool or metadata file is unavailable.',
    });
  }
  return { checks };
}

export async function publishStore(ctx) {
  ctx.signal?.throwIfAborted();
  const cfg = settings(ctx);
  identity(ctx);
  await verifyFile(ctx);
  return ctx.platform === 'ios' ? publishApple(ctx, cfg) : publishPlay(ctx, cfg);
}

export async function statusStore(ctx) {
  try {
    const cfg = settings(ctx);
    identity(ctx);
    if (ctx.platform === 'ios') {
      const observed = await observeApple(ctx, cfg, await appleToken(ctx, cfg));
      if ((observed.build || observed.upload) && !previous(ctx, 'ios-upload'))
        throw new StoreError(
          'Remote build identity has no matching upload journal; artifact ownership is unverified.',
        );
      return appleResult(ctx, observed);
    }
    const token = await googleToken(ctx, cfg);
    const observed = await observePlay(ctx, cfg, token);
    if (observed && !ownedPlayRelease(ctx))
      throw new StoreError(
        'Remote Play version has no matching upload journal; artifact ownership is unverified.',
      );
    if (observed) return observed;
    const pendingEdit = await observePendingPlayEdit(ctx, cfg, token);
    const commit = previous(ctx, 'android-commit');
    const output =
      retryablePlayCommit(commit) || commit?.state === 'failed'
        ? pendingPlayCommit(ctx, commit)
        : result(
            ctx,
            pendingEdit?.uncommittedEdit
              ? 'uploaded'
              : pendingEdit?.unuploadedEdit
                ? 'prepared'
                : 'unknown',
            {
              message: pendingEdit?.uncommittedEdit
                ? 'The exact uploaded bundle is present in a live, uncommitted Play edit.'
                : pendingEdit?.unuploadedEdit
                  ? 'The confirmed Play edit is live; no upload was started and the planned version is absent from its bundles and production track.'
                  : 'The exact version is not present in the current production release list.',
            },
          );
    return { ...output, ...pendingEdit };
  } catch (error) {
    return result(ctx, 'unavailable', {
      message: error instanceof StoreError ? error.message : 'Provider observation is unavailable.',
      availabilityVerified: false,
    });
  }
}

const INSPECTION_APPLE_STATES = new Set([
  'PREPARE_FOR_SUBMISSION',
  'READY_FOR_REVIEW',
  'WAITING_FOR_REVIEW',
  'IN_REVIEW',
  'REJECTED',
  'METADATA_REJECTED',
  'INVALID_BINARY',
  'DEVELOPER_REJECTED',
  'PENDING_DEVELOPER_RELEASE',
  'PENDING_APPLE_RELEASE',
  'PROCESSING_FOR_APP_STORE',
  'PROCESSING_FOR_DISTRIBUTION',
  'READY_FOR_SALE',
  'READY_FOR_DISTRIBUTION',
  'REMOVED_FROM_SALE',
  'DEVELOPER_REMOVED_FROM_SALE',
  'WAITING_FOR_EXPORT_COMPLIANCE',
  'PENDING_CONTRACT',
]);
const INSPECTION_PLAY_STATES = new Set([
  'RELEASE_LIFECYCLE_STATE_DRAFT',
  'RELEASE_LIFECYCLE_STATE_NOT_SENT_FOR_REVIEW',
  'RELEASE_LIFECYCLE_STATE_IN_REVIEW',
  'RELEASE_LIFECYCLE_STATE_APPROVED_NOT_PUBLISHED',
  'RELEASE_LIFECYCLE_STATE_NOT_APPROVED',
  'RELEASE_LIFECYCLE_STATE_PUBLISHED',
]);
const INSPECTION_BUILD_STATES = new Set(['PROCESSING', 'FAILED', 'INVALID', 'VALID']);

function inspectionValue(value, pattern) {
  if (typeof value !== 'string' || !pattern.test(value))
    throw new StoreError('Provider inspection response has an invalid identifier or version.');
  return value;
}

function inspectionState(value, known) {
  if (typeof value !== 'string' || !value)
    throw new StoreError('Provider inspection response is missing a lifecycle state.');
  return known.has(value) ? value : 'UNKNOWN';
}

function inspectionVersions(response) {
  if (
    response.included.some((entry) => !entry || typeof entry !== 'object' || Array.isArray(entry))
  )
    throw new StoreError('App Store inspection returned invalid included resources.');
  const identifiers = new Set();
  return response.data.map((entry) => {
    const id = inspectionValue(entry?.id, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/);
    if (entry.type !== 'appStoreVersions' || identifiers.has(id))
      throw new StoreError('App Store inspection returned an invalid or duplicate version.');
    identifiers.add(id);
    const version = inspectionValue(
      entry.attributes?.versionString,
      /^(?=.{1,64}$)\d+(?:\.\d+){0,3}$/,
    );
    const state = inspectionState(
      entry.attributes?.appVersionState ?? entry.attributes?.appStoreState,
      INSPECTION_APPLE_STATES,
    );
    const relationship = entry.relationships?.build;
    if (
      relationship !== undefined &&
      (!relationship || typeof relationship !== 'object' || !Object.hasOwn(relationship, 'data'))
    )
      throw new StoreError('App Store selected-build relationship is invalid.');
    const selected = relationship?.data;
    let selectedBuild = null;
    if (selected !== undefined && selected !== null) {
      const buildId = inspectionValue(selected.id, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/);
      const matches = response.included.filter(
        (item) => item?.type === 'builds' && item.id === buildId,
      );
      // JSON:API included resources can repeat across separate pagination pages.
      if (
        selected.type !== 'builds' ||
        !matches.length ||
        matches.some(
          (item) =>
            item.attributes?.version !== matches[0].attributes?.version ||
            item.attributes?.processingState !== matches[0].attributes?.processingState,
        )
      )
        throw new StoreError('App Store selected build could not be consistently inspected.');
      selectedBuild = {
        id: buildId,
        buildNumber: inspectionValue(
          matches[0].attributes?.version,
          /^(?=.{1,64}$)\d+(?:\.\d+){0,3}$/,
        ),
        processingState: inspectionState(
          matches[0].attributes?.processingState,
          INSPECTION_BUILD_STATES,
        ),
      };
    }
    return { id, version, state, selectedBuild };
  });
}

function inspectionReleases(response) {
  if (!response || typeof response !== 'object' || Array.isArray(response))
    throw new StoreError('Play inspection returned an invalid bounded release list.');
  // ProtoJSON serializers omit default empty repeated fields:
  // https://protobuf.dev/programming-guides/json/#presence-and-default-values
  // The endpoint has no pagination and returns at most 20 nonobsolete releases:
  // https://developers.google.com/android-publisher/api-ref/rest/v3/applications.tracks.releases/list
  // Explicit null is not serializer output; retain rejection of malformed fields.
  const releases = Object.hasOwn(response, 'releases') ? response.releases : [];
  if (!Array.isArray(releases) || releases.length > 20)
    throw new StoreError('Play inspection returned an invalid bounded release list.');
  return releases.map((entry) => {
    if (entry?.track !== 'production')
      throw new StoreError('Play inspection returned a different destination track.');
    const state = inspectionState(entry.releaseLifecycleState, INSPECTION_PLAY_STATES);
    const artifacts = entry.activeArtifacts === undefined ? [] : entry.activeArtifacts;
    if (!Array.isArray(artifacts))
      throw new StoreError('Play inspection returned invalid artifact identifiers.');
    const versionCodes = artifacts.map((artifact) => {
      const code = artifact?.versionCode;
      if (
        !['string', 'number'].includes(typeof code) ||
        !/^[1-9]\d{0,9}$/.test(String(code)) ||
        BigInt(code) > 2100000000n
      )
        throw new StoreError('Play inspection returned an invalid version code.');
      return String(code);
    });
    if (new Set(versionCodes).size !== versionCodes.length)
      throw new StoreError('Play inspection returned duplicate artifact identifiers.');
    return { state, versionCodes };
  });
}

/** Account visibility only: never use this result to authorize publication. */
export async function inspectStore(ctx) {
  const report = {
    supported: ['ios', 'android'].includes(ctx.platform),
    ok: false,
    provider:
      ctx.platform === 'ios'
        ? 'app-store-connect'
        : ctx.platform === 'android'
          ? 'google-play'
          : null,
    observedAt: now(),
    checks: [],
    publicationReadiness: 'not-evaluated',
    limitations: [
      'Provider reads do not establish upload or review permission, artifact ownership, or installation availability.',
      ctx.platform === 'ios'
        ? 'Listing assets, review access, agreements and compliance declarations are not inspected.'
        : 'Managed publishing, listing assets, policy declarations and production eligibility are not inspected.',
    ],
  };
  let checkName = 'store identity';
  try {
    ctx.signal?.throwIfAborted();
    if (!report.supported)
      throw new StoreError('Provider inspection supports only iOS and Google Play Android.');
    const configured = ctx.config?.stores?.[ctx.platform];
    const configuredId = ctx.platform === 'ios' ? configured?.bundleId : configured?.packageName;
    const expectedId = ctx.plan?.appIds?.[ctx.platform];
    const appIdPattern =
      ctx.platform === 'ios'
        ? /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/
        : /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/;
    if (
      [configuredId, expectedId].some(
        (value) => typeof value !== 'string' || value.length > 255 || !appIdPattern.test(value),
      ) ||
      (ctx.platform === 'ios' &&
        (typeof configured?.appId !== 'string' || !/^\d{1,30}$/.test(configured.appId)))
    )
      throw new StoreError('Provider inspection requires valid string app identifiers.');
    const cfg = identitySettings(ctx);
    report.checks.push({
      name: checkName,
      ok: true,
      message: 'Configured app matches the supplied project identity.',
    });
    checkName = 'provider read';
    const credential = secretPath(ctx, cfg);
    let credentialInfo;
    try {
      credentialInfo = await stat(credential);
      await access(credential, constants.R_OK);
    } catch {
      throw new StoreError('Store credential file reference is unavailable or unreadable.');
    }
    if (!credentialInfo.isFile())
      throw new StoreError('Store credential reference must resolve to a regular file.');
    if (credentialInfo.size > 1024 * 1024)
      throw new StoreError('Store credential file exceeds the inspection limit of 1 MiB.');
    ctx.signal?.throwIfAborted();
    const transport = ctx.fetch ?? fetch;
    let requests = 0;
    const readContext = {
      ...ctx,
      fetch: async (url, options = {}) => {
        ctx.signal?.throwIfAborted();
        const method = options.method ?? 'GET';
        const origin = new URL(url).origin;
        if (
          ++requests > 101 ||
          !(
            (method === 'GET' && [APPLE, GOOGLE].includes(origin)) ||
            (method === 'POST' && url === OAUTH)
          )
        )
          throw new StoreError(
            'Provider inspection refused a non-read operation or exceeded its request limit.',
          );
        return transport(url, { ...options, redirect: 'error' });
      },
    };
    if (ctx.platform === 'ios') {
      const token = await appleToken(readContext, cfg);
      const app = await request(readContext, `${APPLE}/v1/apps/${segment(cfg.appId)}`, token);
      if (
        app.data?.type !== 'apps' ||
        app.data?.id !== String(cfg.appId) ||
        app.data?.attributes?.bundleId !== cfg.bundleId
      )
        throw new StoreError('Remote App Store app identity does not match the configured app.');
      const versions = await appleList(
        readContext,
        token,
        `/v1/apps/${segment(cfg.appId)}/appStoreVersions?filter[platform]=IOS&include=build&limit=200`,
      );
      report.versions = inspectionVersions(versions);
    } else {
      const token = await googleToken(readContext, cfg);
      const releases = await request(
        readContext,
        `${playBase(cfg)}/tracks/production/releases`,
        token,
      );
      report.releases = inspectionReleases(releases);
      report.track = 'production';
      report.inventoryScope = 'bounded-nonobsolete-max20';
      report.limitations.push(
        'The provider returns at most 20 nonobsolete releases; this is not complete release history.',
      );
    }
    ctx.signal?.throwIfAborted();
    report.checks.push({
      name: checkName,
      ok: true,
      message: 'Authenticated provider reads completed; publication readiness was not evaluated.',
    });
    report.ok = true;
  } catch (error) {
    ctx.signal?.throwIfAborted();
    report.checks.push({
      name: checkName,
      ok: false,
      message:
        error instanceof StoreError ? error.message : 'Provider inspection could not be completed.',
    });
  }
  return report;
}

// Shared authentication/transport for draft content preparation. Publication
// retains its artifact and policy gates; this session cannot select a build.
export async function contentSession(ctx) {
  const cfg = identitySettings(ctx);
  const token = ctx.platform === 'ios' ? await appleToken(ctx, cfg) : await googleToken(ctx, cfg);
  const base = ctx.platform === 'ios' ? APPLE : playBase(cfg);
  return {
    cfg,
    read: (endpoint) => request(ctx, new URL(endpoint, base + '/').href, token),
    list: (endpoint) => appleList(ctx, token, endpoint).then((result) => result.data),
    write: (method, endpoint, body, headers) =>
      request(ctx, new URL(endpoint, base + '/').href, token, {
        method,
        headers: headers ?? { 'Content-Type': 'application/json' },
        ...(body === undefined
          ? {}
          : { body: Buffer.isBuffer(body) ? body : JSON.stringify(body) }),
      }),
  };
}
