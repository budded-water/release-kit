import { playReadSession } from './stores.mjs';
import { inspectAgc, listAgcReleases } from './agc.mjs';
import { runCommand } from './command.mjs';
import { observeStoreRead } from './store-read-observation.mjs';

const need = (condition, message) => { if (!condition) throw new Error(message); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const packageName = value => typeof value === 'string' && value.length <= 255 && /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/.test(value);
const versionCode = value => typeof value === 'string' && /^[1-9]\d{0,9}$/.test(value) && BigInt(value) <= 2100000000n;
const versionId = value => typeof value === 'string' && /^\d{1,32}$/.test(value);
const trackName = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(value);

function playTransport(options, target, signal) {
  const resource = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(target.packageName)}/tracks/${encodeURIComponent(target.track)}/releases`;
  const auth = options.store.auth;
  const authentication = auth?.type === 'gcloud-impersonation'
    ? `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(auth.serviceAccount)}:generateAccessToken`
    : 'https://oauth2.googleapis.com/token';
  let calls = 0;
  return async (url, init = {}) => {
    signal.throwIfAborted();
    need(++calls <= 4 && ((url === resource && (init.method ?? 'GET') === 'GET') ||
      (url === authentication && init.method === 'POST')), 'Play read refused an unexpected request');
    const requestSignal = init.signal ? AbortSignal.any([signal, init.signal]) : signal;
    const response = await (options.fetch ?? fetch)(url, { ...init, method: init.method ?? 'GET', signal: requestSignal, redirect: 'error' });
    requestSignal.throwIfAborted();
    const chunks = []; let bytes = 0;
    try {
      if (response.body) for await (const chunk of response.body) {
        requestSignal.throwIfAborted(); bytes += chunk.length;
        need(bytes <= 4 * 1024 * 1024, 'Play read response exceeded its byte limit');
        chunks.push(chunk);
      }
    } catch (error) { await response.body?.cancel().catch(() => {}); throw error; }
    requestSignal.throwIfAborted();
    return new Response(bytes ? Buffer.concat(chunks) : null, { status: response.status, headers: response.headers });
  };
}

const playStates = {
  RELEASE_LIFECYCLE_STATE_DRAFT: ['not-submitted', 'unknown'],
  RELEASE_LIFECYCLE_STATE_NOT_SENT_FOR_REVIEW: ['not-submitted', 'unknown'],
  RELEASE_LIFECYCLE_STATE_IN_REVIEW: ['in-review', 'unknown'],
  RELEASE_LIFECYCLE_STATE_APPROVED_NOT_PUBLISHED: ['approved', 'pending-release'],
  RELEASE_LIFECYCLE_STATE_NOT_APPROVED: ['rejected', 'unknown'],
  RELEASE_LIFECYCLE_STATE_PUBLISHED: ['unknown', 'published'],
};

function playReleases(response, track) {
  need(object(response), 'Invalid Play release response');
  const releases = response.releases === undefined ? [] : response.releases;
  need(Array.isArray(releases) && releases.length <= 20, 'Invalid bounded Play release inventory');
  return releases.map(entry => {
    need(object(entry) && entry.track === track, 'Play returned a different track');
    const rawState = entry.releaseLifecycleState;
    need((typeof rawState === 'string' && /^[A-Z][A-Z0-9_]{0,99}$/.test(rawState)) ||
      (Number.isInteger(rawState) && rawState >= 0 && rawState <= 2147483647), 'Play lifecycle missing or malformed');
    const artifacts = entry.activeArtifacts === undefined ? [] : entry.activeArtifacts;
    need(Array.isArray(artifacts) && artifacts.length <= 1000, 'Invalid Play artifact inventory');
    const versionCodes = artifacts.map(artifact => {
      const code = artifact?.versionCode;
      need((typeof code === 'string' || Number.isSafeInteger(code)) && versionCode(String(code)), 'Invalid Play versionCode');
      return String(code);
    });
    need(new Set(versionCodes).size === versionCodes.length, 'Duplicate Play artifact');
    const [reviewState, publicationState] = playStates[rawState] ?? ['unknown', 'unknown'];
    return { track, versionCodes, rawState, reviewState, publicationState };
  });
}

async function readPlay(options, exact) {
  need(object(options.store) && packageName(options.store.packageName), 'Expected Google Play packageName');
  need(trackName(options.track), 'Expected explicit Play track');
  need(!exact || versionCode(options.versionCode), 'Expected decimal Play versionCode');
  const target = { provider: 'google-play', platform: 'ANDROID', packageName: options.store.packageName, track: options.track };
  return observeStoreRead(options, target, async signal => {
    let releases = [], errors = [];
    try {
      const api = await (options.session ?? playReadSession)({ platform: 'android',
        plan: { appIds: { android: target.packageName } }, config: { stores: { android: options.store } },
        env: options.environment ?? process.env, signal, command: options.command ?? runCommand,
        fetch: playTransport(options, target, signal) });
      signal.throwIfAborted();
      releases = playReleases(await api.releases(target.track), target.track);
      signal.throwIfAborted();
    } catch (error) {
      if (error?.cleanupIncomplete) throw error;
      signal.throwIfAborted();
      errors = [{ code: 'release-summary', reason: error?.status === 401 ? 'authentication' : error?.status === 403 ? 'forbidden' : 'read-unavailable' }];
    }
    const coverage = 'selected-track-nonobsolete-max20';
    if (!exact) return { operation: 'store-versions', coverage, releases, errors };
    const matches = releases.filter(release => release.versionCodes.includes(options.versionCode));
    return { operation: 'store-status', coverage, versionCode: options.versionCode, releases, errors,
      resolution: errors.length ? 'unavailable' : matches.length === 1 ? 'found' : matches.length ? 'ambiguous' : 'not-observed',
      ...(matches.length === 1 ? { release: matches[0] } : {}),
      interpretationScope: 'Selected track lifecycle only; not complete history, artifact ownership, full rollout or installation.' };
  });
}

export const listPlayReleases = options => readPlay(options, false);
export const getPlayRelease = options => readPlay(options, true);

function harmonyState(app) {
  const formal = app.releaseType === 1;
  const rawState = app.releaseState ?? null;
  const review = { 0: 'approved', 1: 'rejected', 3: 'approved', 4: 'in-review', 7: 'not-submitted',
    11: 'withdrawn', 12: 'in-review', 13: 'rejected', ...(formal ? { 5: 'in-review', 8: 'rejected' } : {}) };
  const publication = formal
    ? { 0: 'published', 2: 'removed', 3: 'pending-release', 10: 'removed' }
    : { 0: 'testing', 2: 'expired', 3: 'pending-test', 10: 'expired' };
  const reviewState = review[rawState] ?? 'unknown';
  return { rawState, rawReviewState: app.reviewState ?? null,
    reviewState: reviewState === 'in-review' && app.reviewState === 1 ? 'waiting' : reviewState,
    publicationState: publication[rawState] ?? 'unknown' };
}

function harmonyTarget(store) {
  need(object(store) && versionId(store.appId) && packageName(store.bundleId), 'Expected Harmony app and bundle identity');
  return { provider: 'appgallery-connect', platform: 'HARMONY', appId: store.appId, bundleId: store.bundleId, region: 'CN' };
}

function harmonyContext(options, signal) {
  return { plan: { appIds: { harmony: options.store.bundleId } },
    config: { stores: { harmony: options.store } }, env: options.environment ?? process.env,
    signal, fetch: options.fetch };
}

export async function listHarmonyReleases(options) {
  const target = harmonyTarget(options.store);
  return observeStoreRead(options, target, async signal => {
    const result = await listAgcReleases(harmonyContext(options, signal));
    const versions = result.ok ? result.versions.map(({ releaseState, ...version }) => ({
      ...version, ...harmonyState({ releaseType: version.releaseType, releaseState }),
    })) : [];
    return { operation: 'store-versions', coverage: 'cn-harmony-returned-formal-test-versions',
      versions, excludedReleaseCount: result.excludedReleaseCount ?? null,
      errors: result.ok ? [] : [{ code: result.code, reason: 'read-unavailable' }] };
  });
}

export async function getHarmonyRelease(options) {
  const { store, releaseType, versionId: candidate } = options;
  const target = { ...harmonyTarget(store), releaseType, versionId: candidate };
  need([1, 6].includes(releaseType) && versionId(candidate), 'Expected Harmony releaseType 1/6 and exact versionId');
  need(!store.versionId || store.versionId === candidate, 'Configured Harmony version differs from the requested version');
  return observeStoreRead(options, target, async signal => {
    const result = await inspectAgc(harmonyContext(options, signal),
      { releaseType, versionId: candidate, preflight: options.preflight === true });
    signal.throwIfAborted();
    const errors = result.ok ? [] : result.checks.filter(check => !check.ok).map(check => ({ code: check.code, reason: 'read-unavailable' }));
    if (result.ok && result.app.releaseState === undefined) errors.push({ code: 'release-state', reason: 'missing-state' });
    return { operation: 'store-status', coverage: 'exact-selected-version', errors,
      resolution: result.ok ? 'found' : 'unavailable',
      ...(result.ok ? { release: { versionId: candidate, versionCode: result.app.versionCode,
        version: result.app.versionNumber, ...harmonyState(result.app) },
        ...(result.metadata ? { metadata: result.metadata } : {}) } : {}),
      interpretationScope: 'Selected CN formal/test version only; testing is not formal publication or installation.' };
  });
}
