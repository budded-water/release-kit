import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { constants, generateKeyPairSync, verify } from 'node:crypto';
import { getPlayRelease, listPlayReleases, listHarmonyReleases, getHarmonyRelease } from './provider-store-query.mjs';
import { inspectProviderStore, assessProviderPreflight } from './provider-store-preflight.mjs';
import { main } from './cli.mjs';

const privateValue = 'PRIVATE_REVIEW_ACCOUNT_PASSWORD_OR_TOKEN';
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const prefix = 'RELEASE_LIFECYCLE_STATE_';
const row = (state = 'IN_REVIEW', codes = [42], track = 'production') => ({
  track, releaseName: privateValue, releaseLifecycleState: prefix + state,
  activeArtifacts: codes.map(versionCode => ({ versionCode })),
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'provider-read-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const google = join(root, 'google.json'), harmony = join(root, 'harmony.json');
  const pem = keys.privateKey.export({ format: 'pem', type: 'pkcs8' });
  await writeFile(google, JSON.stringify({ client_email: 'synthetic@example.iam.gserviceaccount.com', private_key: pem }), { mode: 0o600 });
  await writeFile(harmony, JSON.stringify({ key_id: 'key', sub_account: 'sub', private_key: pem }), { mode: 0o600 });
  const calls = [];
  const f = { root, calls, releases: [row()], appids: [{ value: '123' }], versionList: [], appInfo: { versionId: '99', versionNumber: '1.0', versionCode: 42, releaseState: 4,
    privacyPolicy: 'https://example.com/privacy', testUserName: privateValue, testUserPassword: privateValue,
    registeredIdNumber: privateValue, certificateURLs: privateValue }, languages: [{ lang: 'en-US', appName: privateValue, appDesc: privateValue }] };
  const fetch = async (url, init) => {
    calls.push({ url, init });
    const u = new URL(url);
    assert.equal(init.redirect, 'error');
    if (u.origin === 'https://oauth2.googleapis.com') {
      assert.equal(url, 'https://oauth2.googleapis.com/token'); assert.equal(init.method, 'POST');
      const assertion = new URLSearchParams(init.body).get('assertion');
      const [header, payload, signature] = assertion.split('.');
      assert.equal(JSON.parse(Buffer.from(header, 'base64url')).alg, 'RS256');
      assert.equal(JSON.parse(Buffer.from(payload, 'base64url')).scope, 'https://www.googleapis.com/auth/androidpublisher');
      assert.ok(verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), keys.publicKey, Buffer.from(signature, 'base64url')));
      return Response.json({ access_token: 'synthetic-token' });
    }
    if (u.href === 'https://connect-api.cloud.huawei.com/api/publish/v3/version/brief-info/list') {
      assert.equal(init.method, 'POST');
      assert.equal(init.headers.appId, '123');
      assert.deepEqual(JSON.parse(init.body), { packageName: 'example.a' });
      const [header, payload, signature] = init.headers.Authorization.slice(7).split('.');
      assert.equal(JSON.parse(Buffer.from(header, 'base64url')).alg, 'PS256');
      assert.ok(verify('sha256', Buffer.from(`${header}.${payload}`),
        { key: keys.publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }, Buffer.from(signature, 'base64url')));
      return Response.json({ ret: { code: 0, msg: privateValue }, versionList: f.versionList });
    }
    assert.equal(init.method ?? 'GET', 'GET');
    if (u.origin === 'https://androidpublisher.googleapis.com') {
      assert.match(u.pathname, /^\/androidpublisher\/v3\/applications\/example\.[ab]\/tracks\/[^/]+\/releases$/);
      assert.equal(init.headers.Authorization, 'Bearer synthetic-token');
      return Response.json({ releases: f.releases });
    }
    assert.equal(u.origin, 'https://connect-api.cloud.huawei.com');
    if (u.pathname.endsWith('/appid-list')) return Response.json({ ret: { code: 0 }, appids: f.appids });
    assert.equal(u.pathname, '/api/publish/v3/app-info');
    return Response.json({ ret: { code: 0 }, appInfo: f.appInfo, languages: f.languages, auditInfo: { auditOpinion: privateValue } });
  };
  f.play = { store: { packageName: 'example.a', serviceAccountPathEnv: 'PLAY_KEY' },
    track: 'production', versionCode: '42', environment: { PLAY_KEY: google }, fetch };
  f.harmony = { store: { appId: '123', bundleId: 'example.a', serviceAccountPathEnv: 'HARMONY_KEY' },
    releaseType: 1, versionId: '99', environment: { HARMONY_KEY: harmony }, fetch };
  return f;
}

test('Play actual credential/HTTP reads isolate two packages and tracks without a project or journal', async t => {
  const f = await fixture(t), before = await readdir(f.root);
  for (const name of ['example.a', 'example.b']) for (const track of ['production', 'internal', 'wear:beta']) {
    f.releases = [row('IN_REVIEW', [42], track)];
    const report = await getPlayRelease({ ...f.play, store: { ...f.play.store, packageName: name }, track });
    assert.equal(report.resolution, 'found'); assert.equal(report.observationComplete, true);
    assert.equal(report.release.reviewState, 'in-review'); assert.equal(report.target.packageName, name);
    assert.equal(report.target.track, track); assert.equal(report.coverage, 'selected-track-nonobsolete-max20');
    assert.equal(JSON.stringify(report).includes(privateValue), false);
  }
  assert.equal(f.calls.filter(call => call.init.method === 'POST').length, 6);
  assert.equal(f.calls.filter(call => call.init.method === 'GET').length, 6);
  assert.deepEqual(await readdir(f.root), before);
});

test('Play lifecycle distinguishes approval from publication, and retains unknown enums', async t => {
  const f = await fixture(t);
  const expectations = {
    DRAFT: ['not-submitted', 'unknown'], NOT_SENT_FOR_REVIEW: ['not-submitted', 'unknown'],
    IN_REVIEW: ['in-review', 'unknown'], APPROVED_NOT_PUBLISHED: ['approved', 'pending-release'],
    NOT_APPROVED: ['rejected', 'unknown'], PUBLISHED: ['unknown', 'published'], FUTURE: ['unknown', 'unknown'],
  };
  for (const [state, expected] of Object.entries(expectations)) {
    f.releases = [row(state)]; const report = await getPlayRelease(f.play);
    assert.deepEqual([report.release.reviewState, report.release.publicationState], expected);
    assert.equal(report.release.rawState, prefix + state); assert.equal(report.observationComplete, true);
  }
});

test('published internal tests do not fabricate review approval; numeric future enums remain raw', async t => {
  const f = await fixture(t); f.releases = [row('PUBLISHED', [42], 'internal')];
  let report = await getPlayRelease({ ...f.play, track: 'internal' });
  assert.equal(report.release.publicationState, 'published'); assert.equal(report.release.reviewState, 'unknown');
  f.releases = [{ ...row(), releaseLifecycleState: 98 }];
  report = await getPlayRelease(f.play);
  assert.equal(report.observationComplete, true); assert.equal(report.release.rawState, 98);
  assert.equal(report.release.reviewState, 'unknown'); assert.equal(report.release.publicationState, 'unknown');
});

test('bounded Play absence, multiple matching releases and default empty ProtoJSON remain distinct', async t => {
  const f = await fixture(t);
  f.releases = Array.from({ length: 20 }, (_, i) => row('PUBLISHED', [i + 1]));
  assert.equal((await getPlayRelease(f.play)).resolution, 'not-observed');
  assert.equal((await listPlayReleases(f.play)).releases.length, 20);
  f.releases = [row(), row('PUBLISHED')];
  const ambiguous = await getPlayRelease(f.play);
  assert.equal(ambiguous.resolution, 'ambiguous'); assert.equal(ambiguous.release, undefined);
  const fetch = async (url, init) => url.includes('oauth2.') ? f.play.fetch(url, init) : Response.json({});
  assert.equal((await getPlayRelease({ ...f.play, fetch })).resolution, 'not-observed');
});

test('Play malformed/wrong-track summaries never resolve a candidate or infer absence', async t => {
  for (const releases of [null, [row('IN_REVIEW', [42], 'other')], [row('IN_REVIEW', [42, 42])],
    [row('IN_REVIEW', [2100000001])], [row('IN_REVIEW', [0])], [{ ...row(), releaseLifecycleState: null }],
    Array.from({ length: 21 }, () => row())]) {
    const f = await fixture(t); f.releases = releases;
    const report = await getPlayRelease(f.play);
    assert.equal(report.resolution, 'unavailable'); assert.equal(report.observationComplete, false);
    assert.equal(report.release, undefined);
  }
});

test('Play errors and oversized bodies are bounded, redacted and never trigger another resource request', async t => {
  const f = await fixture(t);
  for (const response of [() => new Response(privateValue, { status: 403 }),
    () => new Response(privateValue, { status: 404 }), () => new Response(privateValue),
    () => new Response('x'.repeat(4 * 1024 * 1024 + 1))]) {
    let resourceReads = 0;
    const report = await getPlayRelease({ ...f.play, fetch: (url, init) => {
      if (url.includes('oauth2.')) return f.play.fetch(url, init);
      resourceReads++; return response();
    } });
    assert.equal(report.observationComplete, false); assert.equal(report.resolution, 'unavailable');
    assert.equal(resourceReads, 1); assert.equal(JSON.stringify(report).includes(privateValue), false);
  }
});

test('Play private keyless auth confines the existing command and exact IAM call; no diagnostic output', async t => {
  const f = await fixture(t); const commandCalls = [], http = [];
  const store = { packageName: 'example.a', auth: { type: 'gcloud-impersonation', account: 'owner@example.com',
    serviceAccount: 'target@example-project.iam.gserviceaccount.com', configurationDirectoryEnv: 'GOOGLE_CONFIG' } };
  const report = await getPlayRelease({ ...f.play, store, environment: { GOOGLE_CONFIG: f.root, CLOUDSDK_CORE_ACCOUNT: 'other@example.com' },
    command: async (binary, args, options) => {
      commandCalls.push({ binary, args, options });
      return { code: 0, stdout: 'source-token' };
    }, fetch: async (url, init) => {
      http.push(url);
      if (url.startsWith('https://iamcredentials.googleapis.com/')) {
        assert.equal(url, 'https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/target%40example-project.iam.gserviceaccount.com:generateAccessToken');
        assert.equal(init.method, 'POST'); assert.equal(init.headers.Authorization, 'Bearer source-token');
        assert.deepEqual(JSON.parse(init.body), { scope: ['https://www.googleapis.com/auth/androidpublisher'], lifetime: '3600s' });
        return Response.json({ accessToken: 'target-token', expireTime: new Date(Date.now() + 3500000).toISOString() });
      }
      assert.equal(init.method, 'GET'); assert.equal(init.headers.Authorization, 'Bearer target-token');
      return Response.json({ releases: [row()] });
    } });
  assert.equal(report.resolution, 'found'); assert.equal(http.length, 2); assert.equal(commandCalls.length, 1);
  const call = commandCalls[0];
  assert.equal(call.binary, 'gcloud'); assert.deepEqual(call.args, ['auth', 'print-access-token', '--account', 'owner@example.com', '--quiet']);
  assert.equal(call.options.diagnostics, false); assert.equal(call.options.sensitive, true);
  assert.equal(call.options.env.CLOUDSDK_CORE_ACCOUNT, undefined);
  assert.equal(JSON.stringify(report).includes('source-token'), false);
  assert.equal(JSON.stringify(report).includes('target-token'), false);
});

test('overall deadlines and parent cancellation reject late Play/Harmony successes', async t => {
  const f = await fixture(t), controller = new AbortController(); controller.abort();
  await assert.rejects(getPlayRelease({ ...f.play, signal: controller.signal }), { name: 'AbortError' });
  await assert.rejects(getHarmonyRelease({ ...f.harmony, signal: controller.signal }), { name: 'AbortError' });
  for (const operation of [() => getPlayRelease({ ...f.play, timeoutMs: 1, session: async () => {
    await new Promise(resolve => setTimeout(resolve, 15)); return { releases: () => ({ releases: [row()] }) };
  } }), () => getHarmonyRelease({ ...f.harmony, timeoutMs: 1, fetch: async () => {
    await new Promise(resolve => setTimeout(resolve, 15)); return Response.json({ ret: { code: 0 }, appids: [{ value: '123' }] });
  } })]) await assert.rejects(operation(), { name: 'TimeoutError' });
});

test('Harmony request-only timeout rejects late headers/body without advancing a timed-out lookup', async t => {
  const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, 'timeout', () => originalTimeout(5));
  for (const phase of ['lookup', 'app-info']) for (const late of ['headers', 'body']) {
    const f = await fixture(t), parent = new AbortController();
    const report = await getHarmonyRelease({ ...f.harmony, signal: parent.signal, timeoutMs: 1000,
      fetch: async (url, init) => {
        const response = await f.harmony.fetch(url, init);
        const targeted = phase === 'lookup' ? url.includes('appid-list') : url.includes('app-info');
        if (!targeted) return response;
        if (late === 'headers') {
          await new Promise(resolve => setTimeout(resolve, 15));
          return response;
        }
        const bytes = new TextEncoder().encode(await response.text());
        return new Response(new ReadableStream({ start(controller) {
          setTimeout(() => { controller.enqueue(bytes); controller.close(); }, 15);
        } }));
      } });
    assert.equal(report.observationComplete, false, `${phase}/${late}`);
    assert.equal(report.resolution, 'unavailable'); assert.equal(report.release, undefined);
    assert.equal(parent.signal.aborted, false);
    assert.equal(f.calls.length, phase === 'lookup' ? 1 : 2);
    assert.equal(JSON.stringify(report).includes(privateValue), false);
  }
});

test('Play route/method budget refuses a session attempting edits, external origins or repeated reads', async t => {
  const f = await fixture(t);
  for (const mode of ['edit', 'origin', 'method', 'budget']) {
    let passed = 0;
    const report = await getPlayRelease({ ...f.play, fetch: async () => { passed++; return Response.json({ releases: [row()] }); },
      session: async ctx => ({ releases: async () => {
        const exact = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications/example.a/tracks/production/releases';
        const url = mode === 'origin' ? 'https://private.example/' : mode === 'edit' ? exact.replace('/tracks/production/releases', '/edits') : exact;
        for (let i = 0; i < (mode === 'budget' ? 5 : 1); i++) await ctx.fetch(url, { method: mode === 'method' ? 'POST' : 'GET' });
        return { releases: [row()] };
      } }) });
    assert.equal(report.observationComplete, false); assert.ok(passed <= 4);
    if (mode !== 'budget') assert.equal(passed, 0);
  }
});

test('Harmony inventory sends only the bound signed reads and projects formal/test selectors in provider order', async t => {
  const f = await fixture(t);
  f.versionList = [
    { versionId: '900719925474099301', releaseType: 6, state: 0, auditInfo: privateValue,
      packageList: [{ versionCode: 42, versionName: '1.0', packageId: privateValue }] },
    { versionId: '88', releaseType: 1, state: 0 },
    { versionId: '99', releaseType: 6, state: 999, packageList: [] },
    { releaseType: 7, privateValue },
  ];
  const report = await listHarmonyReleases(f.harmony);
  assert.equal(report.observationComplete, true);
  assert.equal(report.readOnly, true);
  assert.equal(report.excludedReleaseCount, 1);
  assert.deepEqual(report.target, { provider: 'appgallery-connect', platform: 'HARMONY', appId: '123', bundleId: 'example.a', region: 'CN' });
  assert.deepEqual(report.versions.map(v => [v.versionId, v.releaseType, v.rawState, v.publicationState]),
    [['900719925474099301', 6, 0, 'testing'], ['88', 1, 0, 'published'], ['99', 6, 999, 'unknown']]);
  assert.equal(report.versions[2].reviewState, 'unknown');
  assert.deepEqual(report.versions[0].packages, [{ version: '1.0', versionCode: 42 }]);
  assert.equal(report.versions[1].packages, undefined);
  assert.deepEqual(report.versions[2].packages, []);
  assert.equal(JSON.stringify(report).includes(privateValue), false);
  assert.deepEqual(f.calls.map(c => c.init.method), ['GET', 'POST']);
  assert.equal(f.calls[0].url, 'https://connect-api.cloud.huawei.com/api/publish/v2/appid-list?packageName=example.a&packageTypes=7');
  assert.equal(f.calls[1].url, 'https://connect-api.cloud.huawei.com/api/publish/v3/version/brief-info/list');
});

test('Harmony inventory distinguishes valid empty scope from malformed or unavailable provider data', async t => {
  const f = await fixture(t);
  for (const list of [[], [{ releaseType: 7 }]]) {
    f.versionList = list;
    const result = await listHarmonyReleases(f.harmony);
    assert.equal(result.observationComplete, true);
    assert.deepEqual(result.versions, []);
    assert.equal(result.excludedReleaseCount, list.length);
  }
  const valid = { versionId: '99', releaseType: 6, state: 0 };
  for (const list of [undefined, null, {}, [null], [{ ...valid, releaseType: undefined }],
    [{ ...valid, versionId: 99 }], [{ ...valid, state: undefined }], [valid, valid],
    [valid, { ...valid, versionId: '100', packageList: [{ versionCode: privateValue }] }],
    Array.from({ length: 1001 }, (_, i) => ({ ...valid, versionId: String(i + 1) }))]) {
    f.versionList = list;
    const result = await listHarmonyReleases(f.harmony);
    assert.equal(result.observationComplete, false);
    assert.deepEqual(result.versions, []);
    assert.equal(result.excludedReleaseCount, null);
    assert.deepEqual(result.errors, [{ code: 'AGC_RESPONSE', reason: 'read-unavailable' }]);
  }
  const denied = await listHarmonyReleases({ ...f.harmony, fetch: (url, init) => init.method === 'POST'
    ? Promise.resolve(new Response(privateValue, { status: 403 })) : f.harmony.fetch(url, init) });
  assert.equal(denied.observationComplete, false);
  assert.equal(denied.errors[0].code, 'AGC_HTTP_403');
  assert.equal(JSON.stringify(denied).includes(privateValue), false);
  const oversized = await listHarmonyReleases({ ...f.harmony, fetch: (url, init) => init.method === 'POST'
    ? Promise.resolve(new Response(new Uint8Array(4 * 1024 * 1024 + 1))) : f.harmony.fetch(url, init) });
  assert.equal(oversized.observationComplete, false);
  assert.equal(oversized.errors[0].code, 'AGC_RESPONSE');
  f.calls.length = 0;
  f.appids = [{ value: '321' }];
  const mismatch = await listHarmonyReleases(f.harmony);
  assert.equal(mismatch.errors[0].code, 'AGC_IDENTITY');
  assert.equal(f.calls.length, 1);
});

test('Harmony inventory rejects a late list response and propagates caller cancellation', async t => {
  let requestDeadline;
  t.mock.method(AbortSignal, 'timeout', () => {
    requestDeadline = new AbortController();
    return requestDeadline.signal;
  });
  const f = await fixture(t);
  const late = await listHarmonyReleases({ ...f.harmony, fetch: async (url, init) => {
    const response = await f.harmony.fetch(url, init);
    if (init.method === 'POST') requestDeadline.abort();
    return response;
  } });
  assert.equal(late.observationComplete, false);
  assert.equal(late.errors[0].code, 'AGC_TRANSPORT');
  assert.equal(f.calls.length, 2);
  const controller = new AbortController();
  await assert.rejects(listHarmonyReleases({ ...f.harmony, signal: controller.signal, fetch: async (url, init) => {
    const response = await f.harmony.fetch(url, init);
    if (init.method === 'POST') controller.abort();
    return response;
  } }), { name: 'AbortError' });
  assert.equal(f.calls.length, 4);
});

test('Harmony exact formal/test HTTP reads retain type-specific semantics and redact sensitive fields', async t => {
  const f = await fixture(t), before = await readdir(f.root);
  const expected = { 1: { 0: ['approved', 'published'], 3: ['approved', 'pending-release'], 5: ['in-review', 'unknown'], 8: ['rejected', 'unknown'] },
    6: { 0: ['approved', 'testing'], 3: ['approved', 'pending-test'], 2: ['unknown', 'expired'], 7: ['not-submitted', 'unknown'] } };
  for (const type of [1, 6]) for (const [code, states] of Object.entries(expected[type])) {
    f.appInfo.releaseState = Number(code);
    const report = await getHarmonyRelease({ ...f.harmony, releaseType: type });
    assert.equal(report.observationComplete, true); assert.equal(report.resolution, 'found');
    assert.deepEqual([report.release.reviewState, report.release.publicationState], states);
    assert.equal(report.target.releaseType, type); assert.equal(report.target.versionId, '99');
    assert.equal(JSON.stringify(report).includes(privateValue), false);
    const url = new URL(f.calls.at(-1).url); assert.equal(url.searchParams.get('releaseType'), String(type));
    assert.equal(url.searchParams.get('versionId'), '99');
  }
  assert.deepEqual(await readdir(f.root), before);
});

test('Harmony wrong app/version and missing lifecycle cannot be reported complete or as another release', async t => {
  const f = await fixture(t);
  f.appInfo.versionId = '100';
  let report = await getHarmonyRelease(f.harmony);
  assert.equal(report.resolution, 'unavailable'); assert.equal(report.release, undefined);
  f.appInfo.versionId = '99'; delete f.appInfo.releaseState;
  report = await getHarmonyRelease(f.harmony);
  assert.equal(report.resolution, 'found'); assert.equal(report.release.rawState, null); assert.equal(report.observationComplete, false);
  f.appInfo.releaseState = 999;
  report = await getHarmonyRelease(f.harmony);
  assert.equal(report.observationComplete, true); assert.equal(report.release.rawState, 999); assert.equal(report.release.reviewState, 'unknown');
  report = await getHarmonyRelease({ ...f.harmony, store: { ...f.harmony.store, appId: '456' } });
  assert.equal(report.resolution, 'unavailable'); assert.equal(report.release, undefined);
});

test('Harmony review queue is separate from approval and malformed localization cannot pass preflight', async t => {
  const f = await fixture(t); f.appInfo.reviewState = 1;
  let report = await getHarmonyRelease(f.harmony);
  assert.equal(report.release.reviewState, 'waiting'); assert.equal(report.release.rawReviewState, 1);
  f.appInfo.reviewState = 2; report = await getHarmonyRelease(f.harmony);
  assert.equal(report.release.reviewState, 'in-review');
  for (const languages of [[null], Array.from({ length: 1001 }, () => ({ lang: 'en' }))]) {
    f.languages = languages; report = await inspectProviderStore({ ...f.harmony, provider: 'appgallery-connect' });
    assert.equal(report.observationComplete, false); assert.equal(report.resolution, 'unavailable');
    assert.equal(report.metadata, undefined); assert.equal(JSON.stringify(report).includes(privateValue), false);
  }
});

test('Harmony preflight rejects missing or non-array languages while an empty list is a complete missing observation', async t => {
  const f = await fixture(t), config = join(f.root, 'stores.json');
  await writeFile(config, JSON.stringify({ schemaVersion: 1, stores: { harmony: f.harmony.store } }));
  t.mock.method(globalThis, 'fetch', f.harmony.fetch);
  const cli = async releaseType => {
    let report;
    const exit = await main({ repo: '/missing-project', args: ['store-preflight', '--provider', 'appgallery-connect',
      '--config', config, '--release-type', String(releaseType), '--version-id', '99'],
      environment: f.harmony.environment, output: s => report = JSON.parse(s) });
    return { exit, report };
  };
  for (const releaseType of [1, 6]) {
    for (const languages of [undefined, null, { privateValue }]) {
      f.languages = languages;
      const query = await getHarmonyRelease({ ...f.harmony, releaseType });
      assert.equal(query.observationComplete, true);
      const api = await inspectProviderStore({ ...f.harmony, releaseType, provider: 'appgallery-connect' });
      const result = await cli(releaseType);
      assert.equal(result.exit, 2);
      for (const report of [api, result.report]) {
        assert.equal(report.observationComplete, false);
        assert.equal(report.resolution, 'unavailable');
        assert.equal(report.metadata, undefined);
        assert.ok(report.errors.some(error => error.code === 'AGC_RESPONSE'));
        assert.equal(report.publicReleaseReady, false);
        assert.equal(JSON.stringify(report).includes(privateValue), false);
      }
    }
    f.languages = [];
    const result = await cli(releaseType);
    assert.equal(result.exit, 0);
    assert.equal(result.report.observationComplete, true);
    assert.equal(result.report.resolution, 'found');
    assert.deepEqual(result.report.metadata.localizations, []);
    assert.equal(result.report.checks.find(check => check.code === 'listing-localizations').status, 'missing');
    assert.equal(result.report.conclusion, 'blocked');
    assert.equal(result.report.publicReleaseReady, false);
  }
});

test('provider preflight projects metadata only as presence and remains incomplete for unsupported guarantees', async t => {
  const f = await fixture(t);
  for (const [provider, options] of [['google-play', f.play], ['appgallery-connect', f.harmony]]) {
    const report = await inspectProviderStore({ ...options, provider });
    assert.equal(report.publicReleaseReady, false); assert.equal(report.conclusion, 'incomplete');
    assert.ok(report.counts.unsupported > 0); assert.equal(JSON.stringify(report).includes(privateValue), false);
    const calls = f.calls.length;
    assert.deepEqual(assessProviderPreflight(report.facts).checks, report.checks); assert.equal(f.calls.length, calls);
  }
  f.appInfo.privacyPolicy = 'invalid';
  const report = await inspectProviderStore({ ...f.harmony, provider: 'appgallery-connect' });
  assert.equal(report.conclusion, 'blocked'); assert.equal(report.publicReleaseReady, false);
  f.appInfo.privacyPolicy = 'https://example.com/privacy'; delete f.appInfo.testUserPassword;
  const optionalAccess = await inspectProviderStore({ ...f.harmony, provider: 'appgallery-connect' });
  assert.equal(optionalAccess.conclusion, 'incomplete');
  assert.equal(optionalAccess.checks.find(check => check.code === 'review-access-presence').status, 'unknown');
});

test('standalone multi-provider CLI uses explicit config without Expo or state and returns observation exit semantics', async t => {
  const f = await fixture(t), config = join(f.root, 'stores.json');
  await writeFile(config, JSON.stringify({ schemaVersion: 1, stores: { android: f.play.store, harmony: f.harmony.store } }));
  t.mock.method(globalThis, 'fetch', f.play.fetch);
  const maintenance = new Proxy({}, { get() { throw new Error('Store reads must not acquire or reclaim task resources'); } });
  const run = async args => {
    let report; const exit = await main({ repo: '/missing-project', args: [...args, '--config', config],
      resourceLifecycle: maintenance, resourceLease: maintenance, resourceSession: maintenance,
      environment: { ...f.play.environment, ...f.harmony.environment }, output: s => report = JSON.parse(s) });
    return { exit, report };
  };
  const inventory = await run(['store-versions', '--provider', 'google-play', '--track', 'production']);
  assert.equal(inventory.exit, 0); assert.equal(inventory.report.releases.length, 1);
  f.releases = [row('NOT_APPROVED')];
  const status = await run(['store-status', '--provider', 'google-play', '--track', 'production', '--version-code', '42']);
  assert.equal(status.exit, 0); assert.equal(status.report.release.reviewState, 'rejected');
  f.versionList = [{ versionId: '99', releaseType: 6, state: 4 }];
  const listing = await run(['store-versions', '--provider', 'appgallery-connect']);
  assert.equal(listing.exit, 0);
  const [candidate] = listing.report.versions;
  const selectors = ['--release-type', String(candidate.releaseType), '--version-id', candidate.versionId];
  const harmonyStatus = await run(['store-status', '--provider', 'appgallery-connect', ...selectors]);
  assert.equal(harmonyStatus.exit, 0);
  assert.equal(harmonyStatus.report.release.versionId, candidate.versionId);
  const preflight = await run(['store-preflight', '--provider', 'appgallery-connect', ...selectors]);
  f.versionList = undefined;
  const unavailable = await run(['store-versions', '--provider', 'appgallery-connect']);
  assert.equal(unavailable.exit, 2);
  assert.deepEqual(unavailable.report.versions, []);
  assert.equal(preflight.exit, 0); assert.equal(preflight.report.publicReleaseReady, false);
  assert.equal(preflight.report.target.releaseType, 6);
  assert.deepEqual((await readdir(f.root)).sort(), ['google.json', 'harmony.json', 'stores.json']);
});

test('incompatible CLI selectors fail before config/auth/HTTP', async () => {
  const configs = ['--config', '/absent'];
  for (const args of [
    ['store-versions', '--provider', 'appgallery-connect', '--version-id', '99'],
    ['store-versions', '--provider', 'appgallery-connect', '--release-type', '6'],
    ['store-versions', '--provider', 'appgallery-connect', '--track', 'production'],
    ['store-status', '--provider', 'google-play', '--track', 'production', '--version-code', '42', '--version', '1.0'],
    ['store-status', '--provider', 'google-play', '--version-code', '42'],
    ['store-status', '--provider', 'appgallery-connect', '--release-type', '6'],
    ['store-status', '--provider', 'appgallery-connect', '--release-type', '3', '--version-id', '99'],
    ['store-status', '--provider', 'app-store-connect', '--version', '1.0', '--track', 'production'],
  ]) await assert.rejects(main({ args: [...args, ...configs], output: () => {} }),
    error => error.code !== 'ENOENT');
});

test('invalid API identities, selectors and deadlines fail before acquiring credentials', async () => {
  for (const options of [{ store: { packageName: 'bad' }, track: 'production', versionCode: '42' },
    { store: { packageName: 'example.a' }, track: '../private', versionCode: '42' },
    { store: { packageName: 'example.a' }, track: 'production', versionCode: '0' },
    { store: { packageName: 'example.a' }, track: 'production', versionCode: '42', timeoutMs: 0 }])
    await assert.rejects(getPlayRelease(options));
  await assert.rejects(getHarmonyRelease({ store: { appId: '123', bundleId: 'example.a' }, releaseType: 6 }));
  assert.throws(() => assessProviderPreflight({ provider: 'other', resolution: 'found', errors: [] }));
});

test('authentication cancellation stops before Play resource reads and CLI emits no late JSON', async t => {
  const f = await fixture(t), ac = new AbortController();
  let requests = 0;
  await assert.rejects(getPlayRelease({ ...f.play, signal: ac.signal, fetch: async (url, init) => {
    requests++; const response = await f.play.fetch(url, init); ac.abort(); return response;
  } }), { name: 'AbortError' });
  assert.equal(requests, 1);
  const config = join(f.root, 'config.json');
  await writeFile(config, JSON.stringify({ schemaVersion: 1, stores: { android: f.play.store } }));
  const cancellation = new AbortController(); let printed = false;
  t.mock.method(globalThis, 'fetch', async () => {
    cancellation.abort(); return Response.json({ access_token: 'synthetic-token' });
  });
  await assert.rejects(main({ args: ['store-status', '--provider', 'google-play', '--config', config,
    '--track', 'production', '--version-code', '42'], environment: f.play.environment,
    signal: cancellation.signal, output: () => { printed = true; } }), { name: 'AbortError' });
  assert.equal(printed, false);
});

test('keyless cleanup uncertainty propagates instead of becoming a completed unavailable report', async t => {
  const f = await fixture(t);
  await assert.rejects(getPlayRelease({ ...f.play, store: { packageName: 'example.a', auth: {
    type: 'gcloud-impersonation', account: 'owner@example.com',
    serviceAccount: 'target@example-project.iam.gserviceaccount.com', configurationDirectoryEnv: 'GOOGLE_CONFIG' } },
    environment: { GOOGLE_CONFIG: f.root }, command: async () => {
      throw Object.assign(new Error(privateValue), { cleanupIncomplete: true });
    } }), error => error.cleanupIncomplete === true && !error.message.includes(privateValue));
});

test('pure preflight cannot treat an absent lifecycle as present or turn unsupported checks into readiness', () => {
  const report = assessProviderPreflight({ provider: 'google-play', resolution: 'found', release: {}, errors: [] });
  assert.equal(report.checks.find(check => check.code === 'release-lifecycle').status, 'unknown');
  assert.equal(report.conclusion, 'incomplete'); assert.equal(report.publicReleaseReady, false);
});
