import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { inspectAppStore, readOnlyTransport } from './store-preflight.mjs';
const inspectStore = ({ plan, config, ...options }) => inspectAppStore({ ...options, appId: plan.ascAppId, bundleId: plan.appIds.ios, candidateVersion: plan.version, apiKeyPathEnv: config.apiKeyPathEnv });

const plan = { id: `release-${'a'.repeat(24)}`, source: 'a'.repeat(40), buildProfile: 'production',
  environment: 'production', ascAppId: '123', appIds: { ios: 'test.example' }, version: '1.0.0' };
const config = { apiKeyPathEnv: 'EXAMPLE_ASC_API_KEY_PATH' };
const resource = (id, attributes = {}, type = 'test') => ({ id, type, attributes });
const data = value => ({ data: value });
function fixture() {
  const rows = {
    '/v1/apps/123': data(resource('123', { bundleId: 'test.example', primaryLocale: 'en-US', contentRightsDeclaration: 'DOES_NOT_USE_THIRD_PARTY_CONTENT' }, 'apps')),
    '/v1/apps/123/appStoreVersions': [resource('version', { platform: 'IOS', versionString: '1.0.0', appStoreState: 'PREPARE_FOR_SUBMISSION', releaseType: 'MANUAL', copyright: 'Example Team' })],
    '/v1/appStoreVersions/version/build': data(resource('build')),
    '/v1/appStoreVersions/version/appStoreReviewDetail': data(resource('review', { contactFirstName: 'PRIVATE_NAME', contactLastName: 'PRIVATE_LAST', contactPhone: 'PRIVATE_PHONE', contactEmail: 'PRIVATE_EMAIL', demoAccountPassword: 'PRIVATE_PASSWORD' })),
    '/v1/appStoreVersions/version/appStoreVersionLocalizations': [resource('locale', { locale: 'en-US', description: 'PRIVATE_DESCRIPTION', keywords: 'test', supportUrl: 'https://example.com/support?PRIVATE_QUERY' })],
    '/v1/appStoreVersionLocalizations/locale/appScreenshotSets': [resource('set', { screenshotDisplayType: 'APP_IPHONE_67' })],
    '/v1/appScreenshotSets/set/appScreenshots': [resource('image', { assetDeliveryState: { state: 'COMPLETE' }, imageAsset: { templateUrl: 'PRIVATE_IMAGE' } })],
    '/v1/apps/123/appInfos': [resource('info', { appStoreState: 'PREPARE_FOR_SUBMISSION' })],
    '/v1/appInfos/info/primaryCategory': data(resource('HEALTH_AND_FITNESS')),
    '/v1/appInfos/info/appInfoLocalizations': [resource('info-locale', { locale: 'en-US', privacyPolicyUrl: 'https://example.com/privacy' })],
  };
  const calls = [];
  const lookup = async path => {
    calls.push(path);
    const key = new URL(path, 'https://api.appstoreconnect.apple.com').pathname;
    assert.ok(Object.hasOwn(rows, key), `Unexpected endpoint ${key}`);
    const value = rows[key];
    if (value instanceof Error) throw value;
    return value;
  };
  return { rows, calls, options: { plan, config, environment: {}, session: async () => ({ read: lookup, list: lookup }) } };
}
const find = (r, code) => r.checks.find(c => c.code === code);
test('filled fields are observed, never public readiness or privacy/device acceptance; private data is omitted', async () => {
  const f = fixture(), r = await inspectStore({ ...f.options, expectedAppleBuildId: 'build' });
  assert.equal(r.observationComplete, true);
  assert.equal(r.publicReleaseReady, false);
  assert.equal(r.counts.missing, 0);
  assert.equal(find(r, 'selected-build-identity').status, 'present');
  assert.ok(!JSON.stringify(r).includes('PRIVATE_'));
  assert.equal(r.kind, 'app-store-preflight-v1');
  assert.equal(r.releaseId, undefined);
});
test('a lone mismatched draft is inspected for remediation and is never candidate evidence', async () => {
  const f = fixture(); f.rows['/v1/apps/123/appStoreVersions'][0].attributes.versionString = '1.0';
  const r = await inspectStore({ ...f.options, plan: { ...plan, buildProfile: 'testflight-pilot', environment: 'development' } });
  assert.equal(r.selectedVersionMatchesCandidate, false);
  assert.equal(find(r, 'candidate-version').status, 'missing');
  assert.equal(r.inspectedVersionId, 'version');
});
test('ambiguous/missing versions never select another version by list order', async () => {
  for (const entries of [[], [resource('a', { platform: 'IOS', versionString: '1.0.0' }), resource('b', { platform: 'IOS', versionString: '1.0.0' })], [resource('a', { platform: 'IOS', versionString: '2.0' }), resource('b', { platform: 'IOS', versionString: '3.0' })]]) {
    const f = fixture(); f.rows['/v1/apps/123/appStoreVersions'] = entries;
    const r = await inspectStore(f.options);
    assert.equal(r.inspectedVersionId, undefined);
    assert.equal(find(r, 'version-details').status, 'unknown');
    assert.ok(!f.calls.some(path => path.startsWith('/v1/appStoreVersions/')));
  }
});
test('API errors are unknown, sanitized and independent fields still get inspected', async () => {
  const f = fixture(); f.rows['/v1/appStoreVersions/version/appStoreReviewDetail'] = Object.assign(new Error('PRIVATE_KEY'), { status: 403 });
  const r = await inspectStore(f.options);
  assert.equal(r.observationComplete, false);
  assert.equal(find(r, 'review-contact').status, 'unknown');
  assert.deepEqual(r.errors, [{ code: 'review-contact', httpStatus: 403 }]);
  assert.equal(find(r, 'primary-category').status, 'present');
  assert.ok(!JSON.stringify(r).includes('PRIVATE_KEY'));
});
test('successful null resources are missing; malformed responses are unknown', async () => {
  for (const response of [data(null), {}, data([])]) {
    const f = fixture(); f.rows['/v1/appStoreVersions/version/build'] = response;
    const r = await inspectStore(f.options);
    assert.equal(find(r, 'selected-build').status, response.data === null ? 'missing' : 'unknown');
  }
  const f = fixture(); f.rows['/v1/apps/123/appStoreVersions'] = { data: [] };
  assert.equal(find(await inspectStore(f.options), 'version-inventory').status, 'unknown');
});
test('missing response identity/attribute structure never becomes confirmed absent metadata', async () => {
  for (const [path, response, code] of [
    ['/v1/apps/123/appStoreVersions', [resource('version', { versionString: '1.0.0' })], 'version-inventory'],
    ['/v1/appStoreVersions/version/appStoreReviewDetail', data({ id: 'review' }), 'review-contact'],
    ['/v1/appStoreVersions/version/appStoreReviewDetail', data(resource('review', {})), 'review-contact'],
    ['/v1/appStoreVersions/version/appStoreVersionLocalizations', [resource('locale', { description: null })], 'version-localizations'],
  ]) {
    const f = fixture(); f.rows[path] = response;
    const r = await inspectStore(f.options);
    assert.equal(find(r, code).status, 'unknown');
    assert.equal(r.observationComplete, false);
    assert.ok(!r.checks.some(c => c.code === 'candidate-version' && c.status === 'missing') || code !== 'version-inventory');
  }
});
test('null, empty and invalid identity values are unknown while legitimate null metadata remains missing', async () => {
  for (const values of [{ platform: null }, { platform: 'MAC_OS' }, { versionString: null }, { versionString: '' }, { versionString: 1 }]) {
    const f = fixture(); Object.assign(f.rows['/v1/apps/123/appStoreVersions'][0].attributes, values);
    const r = await inspectStore(f.options);
    assert.equal(find(r, 'version-inventory').status, 'unknown');
    assert.equal(find(r, 'candidate-version'), undefined);
    assert.equal(r.observationComplete, false);
  }
  const f = fixture(), l = f.rows['/v1/appStoreVersions/version/appStoreVersionLocalizations'][0];
  l.attributes.locale = null;
  assert.equal(find(await inspectStore(f.options), 'version-localizations').status, 'unknown');
  l.attributes.locale = 'en-US'; l.attributes.description = null;
  const r = await inspectStore(f.options);
  assert.equal(find(r, 'description').status, 'missing');
  assert.equal(r.observationComplete, true);
});
test('app identity mismatch aborts before inspecting other resources', async () => {
  for (const field of ['id', 'type', 'bundleId']) {
    const f = fixture(), a = f.rows['/v1/apps/123'].data;
    if (field === 'bundleId') a.attributes.bundleId = 'other.app'; else a[field] = 'other';
    await assert.rejects(inspectStore(f.options), /mismatch/);
    assert.equal(f.calls.length, 1);
  }
});
test('automatic and scheduled release remain visible attention items', async () => {
  for (const policy of ['AFTER_APPROVAL', 'SCHEDULED', 'FUTURE_UNKNOWN']) {
    const f = fixture(); f.rows['/v1/apps/123/appStoreVersions'][0].attributes.releaseType = policy;
    const r = await inspectStore(f.options);
    assert.equal(r.releaseType, policy);
    assert.equal(find(r, 'release-policy').status, policy === 'FUTURE_UNKNOWN' ? 'unknown' : 'attention');
  }
});
test('empty screenshot sets and incomplete assets cannot pass screenshot presence', async () => {
  for (const images of [[], [resource('x', { assetDeliveryState: { state: 'FAILED' } })]]) {
    const f = fixture(); f.rows['/v1/appScreenshotSets/set/appScreenshots'] = images;
    assert.equal(find(await inspectStore(f.options), 'screenshots').status, 'missing');
  }
  const f = fixture(); f.rows['/v1/appScreenshotSets/set/appScreenshots'] = new Error('unavailable');
  assert.equal(find(await inspectStore(f.options), 'screenshots').status, 'unknown');
  f.rows['/v1/appScreenshotSets/set/appScreenshots'] = [resource('x', {})];
  assert.equal(find(await inspectStore(f.options), 'screenshots').status, 'unknown');
});
test('missing primary locale and invalid URLs remain visible even if another locale is populated', async () => {
  const f = fixture(); f.rows['/v1/apps/123'].data.attributes.primaryLocale = 'fr-FR';
  f.rows['/v1/appStoreVersions/version/appStoreVersionLocalizations'][0].attributes.supportUrl = 'file:///private';
  f.rows['/v1/appInfos/info/appInfoLocalizations'][0].attributes.privacyPolicyUrl = '';
  const r = await inspectStore(f.options);
  for (const code of ['primary-locale', 'privacy-primary-locale', 'support-url', 'privacy-url']) assert.equal(find(r, code).status, 'missing');
});
test('ambiguous app-info records are not combined into a false category/privacy pass', async () => {
  const f = fixture(); f.rows['/v1/apps/123/appInfos'].push(resource('other', { appStoreState: 'PREPARE_FOR_SUBMISSION' }));
  const r = await inspectStore(f.options);
  assert.equal(find(r, 'app-info-selection').status, 'unknown');
  assert.ok(!f.calls.some(path => path.startsWith('/v1/appInfos/')));
});
test('credentials unavailable produce a useful incomplete report without leaking exceptions', async () => {
  const f = fixture(); const r = await inspectStore({ ...f.options, session: async () => { throw new Error('PRIVATE_SECRET'); } });
  assert.equal(r.observationComplete, false);
  assert.equal(find(r, 'authentication').status, 'unknown');
  assert.equal(f.calls.length, 0);
  assert.ok(!JSON.stringify(r).includes('PRIVATE_SECRET'));
});
test('cancellation propagates instead of being downgraded to a missing field', async () => {
  const f = fixture(), abort = new AbortController(); abort.abort();
  await assert.rejects(inspectStore({ ...f.options, signal: abort.signal }), { name: 'AbortError' });
  assert.equal(f.calls.length, 0);
});
test('transport refuses writes, other origins and request overflow before dispatch; redirects are disabled', async () => {
  const calls = [], transport = readOnlyTransport(async (...args) => { calls.push(args); return 'ok'; }, 1);
  assert.throws(() => transport('https://api.appstoreconnect.apple.com/v1/apps', { method: 'POST' }), /GET/);
  assert.throws(() => transport('https://example.com/v1/apps'), /GET/);
  assert.equal(await transport('https://api.appstoreconnect.apple.com/v1/apps', { redirect: 'follow' }), 'ok');
  assert.equal(calls[0][1].redirect, 'error');
  assert.throws(() => transport('https://api.appstoreconnect.apple.com/v1/apps'), /budget/);
  assert.equal(calls.length, 1);
});
test('real Release Kit authentication and pagination use only GET and reject off-origin next links', async t => {
  const f = fixture(), root = await mkdtemp(join(tmpdir(), 'preflight-auth-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const file = join(root, 'key.json');
  await writeFile(file, JSON.stringify({ key_id: 'test', issuer_id: 'test', key: privateKey.export({ type: 'pkcs8', format: 'pem' }) }), { mode: 0o600 });
  let nextOrigin = 'https://api.appstoreconnect.apple.com', paginated = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const u = new URL(url);
    assert.equal(u.origin, 'https://api.appstoreconnect.apple.com');
    assert.equal(options.method ?? 'GET', 'GET'); assert.equal(options.redirect, 'error');
    assert.match(options.headers.Authorization, /^Bearer /);
    const value = f.rows[u.pathname]; assert.ok(value);
    if (u.pathname.endsWith('/appStoreVersions') && !u.searchParams.has('page')) {
      paginated++;
      return Response.json({ data: [], links: { next: `${nextOrigin}${u.pathname}?page=2` } });
    }
    return Response.json(Array.isArray(value) ? data(value) : value);
  });
  const options = { plan, config, environment: { EXAMPLE_ASC_API_KEY_PATH: file } };
  assert.equal((await inspectStore(options)).observationComplete, true);
  assert.equal(paginated, 1);
  nextOrigin = 'https://example.com';
  const r = await inspectStore(options);
  assert.equal(r.observationComplete, false);
  assert.equal(find(r, 'version-inventory').status, 'unknown');
});
test('standalone inventory needs no candidate or journal and never picks among multiple versions', async () => {
  const f = fixture();
  const options = { ...f.options, plan: { ...plan, version: undefined } };
  let r = await inspectStore(options);
  assert.equal(r.inspectedVersionId, 'version');
  assert.equal(find(r, 'candidate-version'), undefined);
  assert.equal(r.selectedVersionMatchesCandidate, undefined);
  f.rows['/v1/apps/123/appStoreVersions'].push(resource('other', { platform: 'IOS', versionString: '2.0' }));
  r = await inspectStore(options);
  assert.equal(r.versions.length, 2);
  assert.equal(r.inspectedVersionId, undefined);
  assert.equal(find(r, 'version-details').status, 'unknown');
});
test('invalid standalone identity and expectations fail before authentication', async () => {
  const f = fixture();
  const valid = { appId: '123', bundleId: 'test.example', apiKeyPathEnv: 'EXAMPLE_KEY' };
  for (const invalid of [{ appId: '../x' }, { appId: 123 }, { bundleId: 'invalid' },
    { apiKeyPathEnv: 'bad name' }, { candidateVersion: '' }, { expectedAppleBuildId: '../x' }]) {
    await assert.rejects(inspectAppStore({ ...valid, ...invalid, session: async () => assert.fail('authentication must not run') }));
  }
  assert.equal(f.calls.length, 0);
});
