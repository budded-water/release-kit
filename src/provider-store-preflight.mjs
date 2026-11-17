import { getPlayRelease, getHarmonyRelease } from './provider-store-query.mjs';

const need = (condition, message) => { if (!condition) throw new Error(message); };

// Presence checks do not establish reviewer login, policy truth, build provenance
// or provider admission. Saved facts are inputs, never authenticated evidence.
export function assessProviderPreflight(facts) {
  need(facts && ['google-play', 'appgallery-connect'].includes(facts.provider) &&
    ['found', 'ambiguous', 'not-observed', 'unavailable'].includes(facts.resolution) && Array.isArray(facts.errors),
    'Expected sanitized provider facts with read diagnostics');
  const checks = [];
  const check = (code, status, message) => checks.push({ code, status, message });
  const presence = (code, value, message) => check(code, typeof value !== 'boolean' ? 'unknown' : value ? 'present' : 'missing', message);
  check('candidate-release', facts.resolution === 'found' ? 'present' : 'unknown',
    'Resolve one exact release within the declared provider coverage; no other version is selected.');
  const interpreted = ['not-submitted', 'waiting', 'in-review', 'approved', 'rejected', 'withdrawn'].includes(facts.release?.reviewState) ||
    ['published', 'pending-release', 'testing', 'pending-test', 'removed', 'expired'].includes(facts.release?.publicationState);
  check('release-lifecycle', interpreted ? 'present' : 'unknown',
    'Lifecycle observation is separate from artifact ownership, review admission and installation.');
  if (facts.provider === 'google-play') {
    for (const code of ['listing-metadata', 'review-access', 'policy-declarations', 'managed-publishing'])
      check(code, 'unsupported', 'Not inspected by the read-only release-summary endpoint; no edit is created.');
  } else {
    const metadata = facts.metadata;
    presence('privacy-url', metadata?.privacyWebUrl, 'Public policy URL syntax is not reachability, policy approval or linked-policy acceptance.');
    check('review-access-presence', metadata?.reviewAccessPresent === true ? 'present' : 'unknown',
      'Reviewer credential presence is not successful authentication; absent optional credentials need project-specific access requirements.');
    const locales = metadata?.localizations;
    presence('listing-localizations', Array.isArray(locales) ? locales.length > 0 : undefined, 'Presence does not certify locale/device coverage.');
    if (Array.isArray(locales)) for (const locale of locales) {
      presence('listing-name', locale?.namePresent, 'Localized app name presence only.');
      presence('listing-description', locale?.descriptionPresent, 'Localized description presence only.');
      check('listing-locale', typeof locale?.locale === 'string' && /^[A-Za-z0-9_-]{2,35}$/.test(locale.locale) ? 'present' : 'unknown', 'Locale identity must be observed.');
    }
    for (const code of ['screenshot-coverage', 'privacy-declarations', 'reviewer-login'])
      check(code, 'unsupported', 'Requires separate product/provider evidence; no approval is inferred.');
  }
  check('artifact-and-runtime', 'unsupported', 'Source, signature and installed behavior require separate exact-artifact acceptance.');
  for (const error of facts.errors) check('provider-read', 'unknown', 'A required provider observation is unavailable; absence must not be inferred.');
  const counts = Object.fromEntries(['present', 'missing', 'unknown', 'unsupported'].map(status => [status, checks.filter(entry => entry.status === status).length]));
  return { rulesVersion: 1, checks, counts,
    conclusion: counts.missing ? 'blocked' : counts.unknown || counts.unsupported ? 'incomplete' : 'clear-within-scope',
    publicReleaseReady: false };
}

export async function inspectProviderStore(options) {
  need(['google-play', 'appgallery-connect'].includes(options.provider), 'Unsupported preflight provider');
  const report = options.provider === 'google-play' ? await getPlayRelease(options)
    : await getHarmonyRelease({ ...options, preflight: true });
  const facts = { provider: options.provider, resolution: report.resolution,
    ...(report.release ? { release: report.release } : {}),
    ...(report.metadata ? { metadata: report.metadata } : {}), errors: report.errors };
  return { ...report, operation: 'store-preflight', kind: 'provider-store-preflight-v1',
    assessmentScope: 'Scoped release observation and supported metadata presence only; not complete submission or publication readiness.',
    facts, ...assessProviderPreflight(facts) };
}
