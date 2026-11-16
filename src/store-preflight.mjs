import { withAppleRead, present, segment, need } from './apple-store-read.mjs';
import { queryAppleVersion } from './store-query.mjs';
export { readOnlyTransport } from './apple-store-read.mjs';

const localeName = value => typeof value === 'string' && value.length <= 35 && /^[a-z]{2,3}(?:-[A-Za-z0-9]+)*$/.test(value);
const webUrl = value => {
  try { return ['https:', 'http:'].includes(new URL(value).protocol); } catch { return false; }
};

// Sanitized facts only; no contact values, passwords, listing text or URLs leave
// the reader. Presence and URL syntax cannot certify product correctness.
async function collectListingFacts(reader, query) {
  const facts = { resolution: query.resolution, versions: query.versions,
    ...(query.version ? { version: query.version } : {}), app: null };
  if (!reader.app) return facts;
  const app = reader.app.attributes;
  facts.app = { primaryLocale: localeName(app.primaryLocale) ? app.primaryLocale : null,
    rightsPresent: present(app.contentRightsDeclaration) };
  const { read, list } = reader;
  if (query.resource) {
    const id = query.resource.id;
    facts.copyrightPresent = present(query.resource.attributes.copyright);
    const review = await read('review-contact', `/v1/appStoreVersions/${segment(id)}/appStoreReviewDetail`, ['contactFirstName', 'contactLastName', 'contactPhone', 'contactEmail']);
    facts.reviewContactComplete = review.ok ? ['contactFirstName', 'contactLastName', 'contactPhone', 'contactEmail'].every(key => present(review.value?.attributes?.[key])) : null;
    const locales = await list('version-localizations', `/v1/appStoreVersions/${segment(id)}/appStoreVersionLocalizations?limit=200`,
      ['locale', 'description', 'keywords', 'supportUrl'], item => localeName(item.attributes.locale));
    facts.locales = locales.ok ? [] : null;
    if (locales.ok) for (const locale of locales.value) {
      const entry = { locale: locale.attributes.locale, descriptionPresent: present(locale.attributes.description),
        keywordsPresent: present(locale.attributes.keywords), supportWebUrl: webUrl(locale.attributes.supportUrl),
        screenshots: { observed: false, completeCount: 0 } };
      const sets = await list(`screenshot-sets:${entry.locale}`, `/v1/appStoreVersionLocalizations/${segment(locale.id)}/appScreenshotSets?limit=200`);
      if (sets.ok) {
        entry.screenshots.observed = true;
        for (const set of sets.value) {
          const images = await list(`screenshots:${set.id}`, `/v1/appScreenshotSets/${segment(set.id)}/appScreenshots?limit=200`, ['assetDeliveryState']);
          if (!images.ok) entry.screenshots.observed = false;
          else entry.screenshots.completeCount += images.value.filter(image => image.attributes.assetDeliveryState?.state === 'COMPLETE').length;
        }
      }
      facts.locales.push(entry);
    }
  }
  const infos = await list('app-info-inventory', `/v1/apps/${segment(reader.target.appId)}/appInfos?limit=200`);
  facts.appInfo = { resolution: 'unavailable' };
  if (infos.ok) {
    const drafts = infos.value.filter(info => (info.attributes.state ?? info.attributes.appStoreState) === 'PREPARE_FOR_SUBMISSION');
    const info = drafts.length === 1 ? drafts[0] : infos.value.length === 1 ? infos.value[0] : undefined;
    facts.appInfo = { resolution: info ? 'found' : infos.value.length ? 'ambiguous' : 'not-found' };
    if (info) {
      facts.appInfo.id = info.id;
      const category = await read('primary-category', `/v1/appInfos/${segment(info.id)}/primaryCategory`);
      facts.appInfo.categoryPresent = category.ok ? category.value !== null : null;
      const locales = await list('privacy-localizations', `/v1/appInfos/${segment(info.id)}/appInfoLocalizations?limit=200`,
        ['locale', 'privacyPolicyUrl'], item => localeName(item.attributes.locale));
      facts.appInfo.locales = locales.ok ? locales.value.map(locale => ({ locale: locale.attributes.locale,
        privacyWebUrl: webUrl(locale.attributes.privacyPolicyUrl) })) : null;
    }
  }
  return facts;
}

// Pure evaluation: callers may re-evaluate facts, but this function never
// authenticates saved evidence or grants permission to publish.
export function assessStorePreflight(facts, { expectedAppleBuildId } = {}) {
  need(facts && typeof facts === 'object' && Array.isArray(facts.versions), 'Expected sanitized preflight facts');
  const checks = [];
  const check = (code, status, message, scope) => checks.push({ code, status, message, ...(scope ? { scope } : {}) });
  const presence = (code, value, message, scope) => check(code, value === null || value === undefined ? 'unknown' : value ? 'present' : 'missing', message, scope);
  if (facts.resolution !== 'unavailable') presence('candidate-version', facts.resolution === 'ambiguous' ? null : facts.resolution === 'found', 'Resolve one exact candidate version; no fallback or store selection is performed.');
  if (facts.app) presence('content-rights-declaration', facts.app.rightsPresent, 'Content-rights declaration must be recorded and verified.');
  const version = facts.version;
  if (version) {
    const scope = version.id;
    check('version-state', version.reviewState === 'unknown' ? 'unknown' : 'present', 'Version lifecycle is not candidate build or installation acceptance.', scope);
    check('release-policy', version.releaseType === 'MANUAL' ? 'present' : ['AFTER_APPROVAL', 'SCHEDULED'].includes(version.releaseType) ? 'attention' : 'unknown', 'Automatic/scheduled publication needs launch authorization; no publication is performed.', scope);
    presence('copyright', facts.copyrightPresent, 'Provide the approved copyright attribution.', scope);
    presence('selected-build', version.build.observed ? version.build.id !== null : null, 'A build must be selected; presence is not source/runtime acceptance.', scope);
    if (version.build.observed && version.build.id !== null) presence('selected-build-identity', expectedAppleBuildId === undefined ? null : version.build.id === expectedAppleBuildId, 'Compare with the explicitly expected Apple build.', scope);
    if (facts.reviewContactComplete !== null) presence('review-contact', facts.reviewContactComplete, 'Complete review contact fields; private values are omitted.', scope);
    if (Array.isArray(facts.locales)) {
      presence('primary-locale', facts.app.primaryLocale ? facts.locales.some(locale => locale.locale === facts.app.primaryLocale) : null, 'The primary locale needs version metadata.', scope);
      if (!facts.locales.length) presence('version-localizations', false, 'No version localization is configured.', scope);
      for (const locale of facts.locales) {
        presence('description', locale.descriptionPresent, 'Provide the reviewed description.', locale.locale);
        presence('keywords', locale.keywordsPresent, 'Provide reviewed keywords.', locale.locale);
        presence('support-url', locale.supportWebUrl, 'Provide a public support URL; reachability/content is unverified.', locale.locale);
        presence('screenshots', locale.screenshots.completeCount > 0 ? true : locale.screenshots.observed ? false : null,
          'Processed screenshot presence does not attest device or locale coverage.', locale.locale);
      }
    }
  } else check('version-details', 'unknown', 'No exact candidate version available for inspection.');
  const info = facts.appInfo;
  if (info?.resolution !== 'unavailable' && info?.resolution !== undefined) {
    if (info.resolution !== 'found') check('app-info-selection', 'unknown', 'Resolve the applicable app-info record before claiming category/privacy readiness.');
    else {
      if (info.categoryPresent !== null) presence('primary-category', info.categoryPresent, 'Configure a primary category.', info.id);
      if (Array.isArray(info.locales)) {
        if (!info.locales.length) presence('privacy-url', false, 'No app-info localization configured.', info.id);
        presence('privacy-primary-locale', facts.app.primaryLocale ? info.locales.some(locale => locale.locale === facts.app.primaryLocale) : null, 'Verify privacy information for the primary locale.', info.id);
        for (const locale of info.locales) presence('privacy-url', locale.privacyWebUrl, 'Public policy URL syntax is not policy approval.', locale.locale);
      }
    }
  }
  return checks;
}

export async function inspectAppStore(options) {
  need(typeof options.candidateVersion === 'string', 'store-preflight requires an exact candidate version');
  return withAppleRead(options, async reader => {
    const query = await queryAppleVersion(reader, options);
    const facts = await collectListingFacts(reader, query);
    const checks = assessStorePreflight(facts, options);
    for (const error of reader.errors) checks.push({ code: error.code, status: 'unknown', message: 'Provider read unavailable; absence must not be inferred.' });
    const counts = Object.fromEntries(['present', 'missing', 'unknown', 'attention'].map(status => [status, checks.filter(check => check.status === status).length]));
    return { kind: 'app-store-preflight-v1', operation: 'store-preflight', rulesVersion: 1,
      assessmentScope: 'iOS store submission metadata and explicit candidate/build matching; not full submission or public readiness.',
      conclusion: counts.missing ? 'blocked' : counts.unknown || reader.errors.length || counts.attention ? 'incomplete' : 'clear-within-scope',
      publicReleaseReady: false, destination: 'app-store', appId: reader.target.appId, bundleId: reader.target.bundleId,
      candidateVersion: options.candidateVersion, selectedVersionMatchesCandidate: query.resolution === 'found',
      ...(query.version ? { inspectedVersionId: query.version.id, releaseType: query.version.releaseType,
        ...(query.version.build.observed ? { selectedBuildId: query.version.build.id } : {}) } : {}),
      ...(facts.appInfo?.id ? { inspectedAppInfoId: facts.appInfo.id } : {}),
      versions: query.versions.map(version => ({ id: version.id, version: version.version, state: version.rawState ?? 'UNKNOWN' })),
      facts, checks, counts };
  });
}
