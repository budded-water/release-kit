import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { listStoreVersions, getStoreVersion } from './store-query.mjs';
import { inspectAppStore, assessStorePreflight } from './store-preflight.mjs';
import { main } from './cli.mjs';

const version = (id = 'v1', value = '1.2.0', state = 'PENDING_DEVELOPER_RELEASE') => ({
  id, type: 'appStoreVersions', attributes: { platform: 'IOS', versionString: value,
    appVersionState: state, releaseType: 'MANUAL' } });
function fixture() {
  const calls = [], rows = {
    '/v1/apps/123': { data: { id: '123', type: 'apps', attributes: { bundleId: 'test.example' } } },
    '/v1/apps/123/appStoreVersions': [version()],
    '/v1/appStoreVersions/v1/build': { data: { id: 'b1', type: 'builds' } },
  };
  const lookup = async path => {
    calls.push(new URL(path, 'https://api.appstoreconnect.apple.com').pathname);
    const key = calls.at(-1);
    assert.ok(Object.hasOwn(rows, key), `Unexpected broad read: ${key}`);
    if (rows[key] instanceof Error) throw rows[key];
    return rows[key];
  };
  return { rows, calls, options: { appId: '123', bundleId: 'test.example',
    apiKeyPathEnv: 'EXAMPLE_KEY', candidateVersion: '1.2.0', environment: {},
    session: async () => ({ read: lookup, list: lookup }) } };
}
test('review query is lightweight and distinguishes approval, publication and wrong expected build', async () => {
  const f = fixture();
  const r = await getStoreVersion({ ...f.options, expectedAppleBuildId: 'other' });
  assert.equal(r.observationComplete, true); assert.equal(r.resolution, 'found');
  assert.equal(r.version.reviewState, 'approved'); assert.equal(r.version.publicationState, 'pending-release');
  assert.equal(r.version.build.matchesExpected, false); assert.equal(r.version.build.id, 'b1');
  assert.equal(r.target.destination, 'app-store'); assert.equal(r.source, 'official-api');
  assert.equal(f.calls.length, 3);
});
test('inventory and exact missing/ambiguous versions never inspect other build or listing resources', async () => {
  const f = fixture();
  let r = await listStoreVersions(f.options);
  assert.equal(r.coverage, 'complete-ios-version-inventory'); assert.equal(f.calls.length, 2);
  f.calls.length = 0;
  r = await getStoreVersion({ ...f.options, candidateVersion: '9.9.9' });
  assert.equal(r.resolution, 'not-found'); assert.equal(f.calls.length, 2);
  f.rows['/v1/apps/123/appStoreVersions'].push(version('v2'));
  r = await getStoreVersion(f.options);
  assert.equal(r.resolution, 'ambiguous'); assert.equal(r.version, undefined);
});
test('failed inventory is unavailable, never not-found; errors do not expose private diagnostics', async () => {
  const f = fixture();
  f.rows['/v1/apps/123/appStoreVersions'] = Object.assign(new Error('PRIVATE_VALUE'), { status: 403 });
  const r = await getStoreVersion(f.options);
  assert.equal(r.resolution, 'unavailable'); assert.equal(r.observationComplete, false);
  assert.equal(r.errors[0].reason, 'forbidden'); assert.ok(!JSON.stringify(r).includes('PRIVATE_VALUE'));
});
test('unknown raw lifecycle remains visible; absent lifecycle is explicit incomplete evidence', async () => {
  const f = fixture();
  f.rows['/v1/apps/123/appStoreVersions'][0].attributes.appVersionState = 'FUTURE_STATE';
  let r = await getStoreVersion(f.options);
  assert.equal(r.version.rawState, 'FUTURE_STATE'); assert.equal(r.version.reviewState, 'unknown');
  assert.equal(r.observationComplete, true);
  delete f.rows['/v1/apps/123/appStoreVersions'][0].attributes.appVersionState;
  r = await getStoreVersion(f.options);
  assert.equal(r.version.rawState, null); assert.equal(r.observationComplete, false);
  assert.equal(r.errors[0].reason, 'missing-state');
});
test('absent versus unreadable build is preserved and does not erase observed version state', async () => {
  const f = fixture();
  f.rows['/v1/appStoreVersions/v1/build'] = { data: null };
  let r = await getStoreVersion(f.options);
  assert.equal(r.version.build.id, null); assert.equal(r.observationComplete, true);
  f.rows['/v1/appStoreVersions/v1/build'] = new Error('private');
  r = await getStoreVersion(f.options);
  assert.equal(r.resolution, 'found'); assert.equal(r.version.reviewState, 'approved');
  assert.deepEqual(r.version.build, { observed: false }); assert.equal(r.observationComplete, false);
});
test('shared operation deadline/cancellation prevents late successful reports', async () => {
  const f = fixture(); let received;
  const slowSession = async ({ signal }) => {
    received = signal;
    await new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  };
  await assert.rejects(getStoreVersion({ ...f.options, timeoutMs: 5, session: slowSession }), { name: 'TimeoutError' });
  assert.equal(received.aborted, true);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(listStoreVersions({ ...f.options, signal: controller.signal }), { name: 'AbortError' });
  await assert.rejects(getStoreVersion({ ...f.options, timeoutMs: 0 }));
  await assert.rejects(getStoreVersion({ ...f.options, provider: 'google-play' }), /Unsupported/);
});
test('real packed-style CLI reads isolated app identities with generated credentials, no project or journal', async t => {
  const root = await mkdtemp(join(tmpdir(), 'store-query-auth-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const key = join(root, 'key.json');
  await writeFile(key, JSON.stringify({ key_id: 'test', issuer_id: 'test',
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }) }), { mode: 0o600 });
  let nextOrigin = 'https://api.appstoreconnect.apple.com';
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const u = new URL(url); calls.push(u.pathname);
    assert.equal(u.origin, 'https://api.appstoreconnect.apple.com');
    assert.equal(options.method ?? 'GET', 'GET'); assert.equal(options.redirect, 'error');
    assert.match(options.headers.Authorization, /^Bearer /);
    const appId = u.pathname.match(/^\/v1\/apps\/(\d+)$/)?.[1];
    if (appId) return Response.json({ data: { id: appId, type: 'apps', attributes: { bundleId: `test.app${appId}` } } });
    if (u.pathname.endsWith('/appStoreVersions')) {
      if (!u.searchParams.has('page')) return Response.json({ data: [], links: { next: `${nextOrigin}${u.pathname}?page=2` } });
      return Response.json({ data: [version()] });
    }
    assert.equal(u.pathname, '/v1/appStoreVersions/v1/build');
    return Response.json({ data: { id: 'b1', type: 'builds' } });
  });
  for (const appId of ['123', '456']) {
    const config = join(root, `${appId}.json`);
    await writeFile(config, JSON.stringify({ schemaVersion: 1, stores: { ios: { appId,
      bundleId: `test.app${appId}`, apiKeyPathEnv: 'EXAMPLE_KEY' } } }));
    for (const operation of ['store-versions', 'store-status']) {
      let report;
      assert.equal(await main({ repo: '/missing-project', args: [operation, '--config', config,
        ...(operation === 'store-status' ? ['--version', '1.2.0'] : [])],
        environment: { EXAMPLE_KEY: key }, output: s => report = JSON.parse(s) }), 0);
      assert.equal(report.target.appId, appId); assert.equal(report.observationComplete, true);
    }
  }
  nextOrigin = 'https://example.com';
  const r = await getStoreVersion({ appId: '123', bundleId: 'test.app123', candidateVersion: '1.2.0', apiKeyPathEnv: 'EXAMPLE_KEY', environment: { EXAMPLE_KEY: key } });
  assert.equal(r.resolution, 'unavailable'); assert.equal(r.observationComplete, false);
  assert.deepEqual((await readdir(root)).sort(), ['123.json', '456.json', 'key.json']);
});
test('real pagination exceeding the traversal bound cannot claim a missing version', async t => {
  const root = await mkdtemp(join(tmpdir(), 'store-query-budget-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const key = join(root, 'key.json');
  await writeFile(key, JSON.stringify({ key_id: 'test', issuer_id: 'test', key: privateKey.export({ type: 'pkcs8', format: 'pem' }) }));
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls++;
    const u = new URL(url);
    if (u.pathname === '/v1/apps/123') return Response.json({ data: { id: '123', type: 'apps', attributes: { bundleId: 'test.example' } } });
    return Response.json({ data: [], links: { next: `${u.origin}${u.pathname}?page=${calls}` } });
  });
  const r = await getStoreVersion({ appId: '123', bundleId: 'test.example', candidateVersion: '1.2.0', apiKeyPathEnv: 'EXAMPLE_KEY', environment: { EXAMPLE_KEY: key } });
  assert.equal(r.resolution, 'unavailable'); assert.equal(r.observationComplete, false);
  assert.ok(calls <= 101);
});
test('malformed inventory identities and duplicate remote IDs cannot resolve a candidate', async () => {
  for (const change of [
    f => { f.rows['/v1/apps/123/appStoreVersions'][0].type = 'builds'; },
    f => { f.rows['/v1/apps/123/appStoreVersions'][0].id = '../private'; },
    f => { f.rows['/v1/apps/123/appStoreVersions'].push(version('v1', '2.0.0')); },
  ]) {
    const f = fixture(); change(f);
    const report = await getStoreVersion(f.options);
    assert.equal(report.resolution, 'unavailable'); assert.equal(report.observationComplete, false);
    assert.equal(report.version, undefined); assert.equal(f.calls.length, 2);
  }
});
test('a late uncooperative session cannot return a successful report after the deadline', async () => {
  const f = fixture();
  await assert.rejects(getStoreVersion({ ...f.options, timeoutMs: 1,
    session: async () => { await new Promise(resolve => setTimeout(resolve, 15)); return {}; } }), { name: 'TimeoutError' });
  assert.equal(f.calls.length, 0);
});
