import { contentSession } from './stores.mjs';
const need = (condition, message) => { if (!condition) throw new Error(message); };

const present = value => typeof value === 'string' && value.trim().length > 0;
const segment = value => encodeURIComponent(value);
const webUrl = value => {
  try { return ['https:', 'http:'].includes(new URL(value).protocol); } catch { return false; }
};

// The shared session owns authentication, pagination and request timeouts. This
// boundary additionally refuses writes, redirects and unbounded read inventories.
export function readOnlyTransport(transport = fetch, limit = 200) {
  let requests = 0;
  return (url, options = {}) => {
    need((options.method ?? 'GET') === 'GET' && new URL(url).origin === 'https://api.appstoreconnect.apple.com', 'Only ASC GET is allowed');
    need(++requests <= limit, 'App Store preflight request budget exceeded');
    return transport(url, { ...options, redirect: 'error' });
  };
}

export async function inspectAppStore({ appId, bundleId, candidateVersion, apiKeyPathEnv,
  environment = process.env, signal, session = contentSession, expectedAppleBuildId }) {
  need(typeof appId === 'string' && /^\d{1,30}$/.test(appId), 'Expected numeric ASC app ID');
  need(typeof bundleId === 'string' && bundleId.length <= 255 && /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(bundleId), 'Expected bundle ID');
  need(typeof apiKeyPathEnv === 'string' && /^[A-Z][A-Z0-9_]+$/.test(apiKeyPathEnv), 'Expected credential environment reference');
  need(candidateVersion === undefined || (typeof candidateVersion === 'string' && candidateVersion.length <= 100 && present(candidateVersion)), 'Expected candidate version');
  need(expectedAppleBuildId === undefined || (typeof expectedAppleBuildId === 'string' && /^[A-Za-z0-9-]{1,100}$/.test(expectedAppleBuildId)), 'Expected Apple build ID');
  const plan = { ascAppId: appId, appIds: { ios: bundleId }, version: candidateVersion };
  const config = { apiKeyPathEnv };
  const report = { schemaVersion: 1, kind: 'app-store-preflight-v1',
    destination: 'app-store', appId: plan.ascAppId, bundleId: plan.appIds.ios,
    candidateVersion: plan.version, observedAt: new Date().toISOString(),
    readOnly: true, publicReleaseReady: false, checks: [], errors: [], versions: [] };
  const check = (code, status, message, scope) => report.checks.push({ code, status, message, ...(scope ? { scope } : {}) });
  const field = (code, value, message, scope) => check(code, present(value) ? 'present' : 'missing', message, scope);
  const finish = () => {
    report.completedAt = new Date().toISOString();
    report.observationComplete = report.errors.length === 0;
    report.counts = Object.fromEntries(['present', 'missing', 'unknown', 'attention'].map(status => [status, report.checks.filter(c => c.status === status).length]));
    return report;
  };
  async function attempt(code, fn) {
    signal?.throwIfAborted();
    try { const value = await fn(); signal?.throwIfAborted(); return { ok: true, value }; }
    catch (error) {
      signal?.throwIfAborted();
      report.errors.push({ code, ...(Number.isInteger(error.status) ? { httpStatus: error.status } : {}) });
      check(code, 'unknown', 'Provider read unavailable; do not infer that the field or resource is absent.');
      return { ok: false };
    }
  }
  const opened = await attempt('authentication', () => session({ platform: 'ios', plan, env: environment, signal,
    config: { stores: { ios: { bundleId: plan.appIds.ios, appId: plan.ascAppId, apiKeyPathEnv: config.apiKeyPathEnv } } },
    fetch: readOnlyTransport() }));
  if (!opened.ok) return finish();
  const api = opened.value;
  const attributes = (item, required) => item.attributes && typeof item.attributes === 'object' &&
    !Array.isArray(item.attributes) && required.every(key => Object.hasOwn(item.attributes, key));
  const read = (code, path, requiredAttributes) => attempt(code, async () => {
    const response = await api.read(path);
    need(response && Object.hasOwn(response, 'data') && (response.data === null ||
      (typeof response.data === 'object' && !Array.isArray(response.data) && present(response.data.id) &&
        (!requiredAttributes || attributes(response.data, requiredAttributes)))), 'Malformed ASC resource');
    return response.data;
  });
  const list = (code, path, requiredAttributes = [], validIdentity = () => true) => attempt(code, async () => {
    const items = await api.list(path);
    need(Array.isArray(items) && items.every(x => x && present(x.id) && attributes(x, requiredAttributes) && validIdentity(x.attributes)), 'Malformed ASC inventory');
    return items;
  });
  const app = await read('app-identity', `/v1/apps/${segment(plan.ascAppId)}`, ['bundleId']);
  if (!app.ok) return finish();
  need(app.value?.id === plan.ascAppId && app.value?.type === 'apps' && app.value?.attributes?.bundleId === plan.appIds.ios, 'Remote ASC app mismatch');
  const primaryLocale = app.value.attributes.primaryLocale;
  field('content-rights-declaration', app.value.attributes.contentRightsDeclaration, 'Content-rights declaration must be recorded and verified.');
  const versions = await list('version-inventory', `/v1/apps/${segment(plan.ascAppId)}/appStoreVersions?filter[platform]=IOS&limit=200`, ['platform', 'versionString'], a => a.platform === 'IOS' && present(a.versionString));
  let selected;
  if (versions.ok) {
    const ios = versions.value.filter(v => v.attributes.platform === 'IOS');
    report.versions = ios.map(v => ({ id: v.id, version: v.attributes.versionString, state: v.attributes.appVersionState ?? v.attributes.appStoreState }));
    const matches = candidateVersion === undefined ? [] : ios.filter(v => v.attributes.versionString === candidateVersion);
    if (candidateVersion !== undefined) check('candidate-version', matches.length === 1 ? 'present' : matches.length === 0 ? 'missing' : 'unknown', 'Resolve one exact candidate version; do not create or select a draft automatically.');
    // Inspect a lone mismatched draft for remediation, never as candidate evidence.
    selected = matches.length === 1 ? matches[0] : ios.length === 1 ? ios[0] : undefined;
    if (candidateVersion !== undefined) report.selectedVersionMatchesCandidate = matches.length === 1;
  }
  if (selected) {
    const v = selected.attributes, scope = selected.id;
    report.inspectedVersionId = scope;
    report.releaseType = v.releaseType ?? 'UNKNOWN';
    check('release-policy', v.releaseType === 'MANUAL' ? 'present' : ['AFTER_APPROVAL', 'SCHEDULED'].includes(v.releaseType) ? 'attention' : 'unknown',
      'Automatic/scheduled publication requires authorization covering launch; store settings alone do not establish publisher behavior.', scope);
    field('copyright', v.copyright, 'Provide the approved copyright attribution.', scope);
    const build = await read('selected-build', `/v1/appStoreVersions/${segment(scope)}/build`);
    if (build.ok) {
      report.selectedBuildId = build.value?.id ?? null;
      check('selected-build', build.value ? 'present' : 'missing', 'A build must be selected; presence is not source or runtime acceptance.', scope);
      if (build.value) check('selected-build-identity', expectedAppleBuildId ? (build.value.id === expectedAppleBuildId ? 'present' : 'missing') : 'unknown', 'Compare the selected Apple build with this journal’s observed build identity.', scope);
    }
    const review = await read('review-contact', `/v1/appStoreVersions/${segment(scope)}/appStoreReviewDetail`, ['contactFirstName', 'contactLastName', 'contactPhone', 'contactEmail']);
    if (review.ok) check('review-contact', ['contactFirstName', 'contactLastName', 'contactPhone', 'contactEmail'].every(k => present(review.value?.attributes?.[k])) ? 'present' : 'missing', 'Complete review contact fields; private values are not retained.', scope);
    const locales = await list('version-localizations', `/v1/appStoreVersions/${segment(scope)}/appStoreVersionLocalizations?limit=200`, ['locale', 'description', 'keywords', 'supportUrl'], a => present(a.locale));
    if (locales.ok) {
      check('primary-locale', present(primaryLocale) ? (locales.value.some(l => l.attributes.locale === primaryLocale) ? 'present' : 'missing') : 'unknown', 'The app’s primary locale must have version metadata.', scope);
      if (!locales.value.length) check('version-localizations', 'missing', 'No version localization is configured.', scope);
      for (const l of locales.value) {
        const label = l.attributes.locale ?? l.id;
        field('description', l.attributes.description, 'Provide the reviewed description.', label);
        field('keywords', l.attributes.keywords, 'Provide reviewed keywords.', label);
        check('support-url', webUrl(l.attributes.supportUrl) ? 'present' : 'missing', 'Provide a public support URL; reachability/content is not checked here.', label);
        const sets = await list(`screenshot-sets:${label}`, `/v1/appStoreVersionLocalizations/${segment(l.id)}/appScreenshotSets?limit=200`);
        if (sets.ok) {
          let complete = 0, allRead = true;
          for (const set of sets.value) {
            const images = await list(`screenshots:${set.id}`, `/v1/appScreenshotSets/${segment(set.id)}/appScreenshots?limit=200`, ['assetDeliveryState']);
            if (!images.ok) allRead = false;
            else complete += images.value.filter(image => image.attributes.assetDeliveryState?.state === 'COMPLETE').length;
          }
          check('screenshots', complete > 0 ? 'present' : allRead ? 'missing' : 'unknown', 'At least one processed screenshot is required; device/locale coverage remains separately unverified.', label);
        }
      }
    }
  } else check('version-details', 'unknown', 'No unambiguous version selected for listing inspection.');
  const infos = await list('app-info-inventory', `/v1/apps/${segment(plan.ascAppId)}/appInfos?limit=200`);
  if (infos.ok) {
    const drafts = infos.value.filter(i => (i.attributes.state ?? i.attributes.appStoreState) === 'PREPARE_FOR_SUBMISSION');
    const info = drafts.length === 1 ? drafts[0] : infos.value.length === 1 ? infos.value[0] : undefined;
    if (!info) check('app-info-selection', 'unknown', 'Resolve the applicable app-info record before claiming category/privacy readiness.');
    else {
      report.inspectedAppInfoId = info.id;
      const category = await read('primary-category', `/v1/appInfos/${segment(info.id)}/primaryCategory`);
      if (category.ok) check('primary-category', category.value ? 'present' : 'missing', 'A primary category must be configured.', info.id);
      const locales = await list('privacy-localizations', `/v1/appInfos/${segment(info.id)}/appInfoLocalizations?limit=200`, ['locale', 'privacyPolicyUrl'], a => present(a.locale));
      if (locales.ok) {
        if (!locales.value.length) check('privacy-url', 'missing', 'No app-info localization is configured.', info.id);
        check('privacy-primary-locale', present(primaryLocale) ? (locales.value.some(l => l.attributes.locale === primaryLocale) ? 'present' : 'missing') : 'unknown', 'Verify privacy information for the app’s primary locale.', info.id);
        for (const l of locales.value) check('privacy-url', webUrl(l.attributes.privacyPolicyUrl) ? 'present' : 'missing', 'Provide the approved public App policy URL; a preview URL is not policy approval.', l.attributes.locale ?? l.id);
      }
    }
  }
  return finish();
}
