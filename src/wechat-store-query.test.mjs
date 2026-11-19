import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from './cli.mjs';
import { getWechatAudit, listWechatVersions } from './wechat-store-query.mjs';

const appId = 'wx1111111111111111';
const token = 'test-authorizer~token+/=';
const tokenName = 'EXAMPLE_WECHAT_TOKEN';
const identityPath = '/cgi-bin/account/getaccountbasicinfo';
const versionsPath = '/wxa/getversioninfo';
const latestPath = '/wxa/get_latest_auditstatus';
const exactPath = '/wxa/get_auditstatus';
const timestamp = 1640762988;
const store = { appId, authorizerAccessTokenEnv: tokenName };

function fixture() {
  const calls = [];
  const responses = {
    [identityPath]: { errcode: 0, appid: appId, account_type: 3, principal_name: 'private identity' },
    [versionsPath]: { errcode: 0,
      exp_info: { exp_version: 'V1.5-体验', exp_time: timestamp, exp_desc: 'Reviewed build' },
      release_info: { release_version: '1.4', release_time: timestamp - 60, release_desc: 'Current' } },
    [latestPath]: { errcode: 0, auditid: 123, status: 1, user_version: 'V1.5-体验', submit_audit_time: timestamp,
      reason: '请补充类目说明', screenshot: 'private-media-id' },
    [exactPath]: { errcode: 0, status: 0 },
  };
  const fetch = async (url, init) => {
    const target = new URL(url);
    assert.equal(target.origin, 'https://api.weixin.qq.com');
    assert.deepEqual([...target.searchParams], [['access_token', token]]);
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal instanceof AbortSignal);
    const { pathname } = target;
    assert.ok(Object.hasOwn(responses, pathname));
    calls.push({ path: pathname, method: init.method, body: init.body && JSON.parse(init.body) });
    const data = responses[pathname];
    return typeof data === 'function' ? data(init, target) : Response.json(data);
  };
  return { options: { store, environment: { [tokenName]: token }, fetch }, calls, responses };
}

test('WeChat inventory reads only bound current channels using exact read-only POST bodies', async () => {
  const f = fixture();
  const result = await listWechatVersions(f.options);
  assert.equal(result.observationComplete, true);
  assert.equal(result.source, 'official-api');
  assert.equal(result.readOnly, true);
  assert.deepEqual(result.target, { provider: 'wechat-mini-program', platform: 'WECHAT_MINI_PROGRAM', appId });
  assert.equal(result.coverage, 'current-experience-production');
  assert.deepEqual(result.versions, [
    { channel: 'experience', version: 'V1.5-体验', changedAtEpochSeconds: timestamp,
      description: 'Reviewed build', publicationState: 'testing', reviewState: 'unknown' },
    { channel: 'production', version: '1.4', changedAtEpochSeconds: timestamp - 60,
      description: 'Current', publicationState: 'published', reviewState: 'unknown' },
  ]);
  assert.deepEqual(f.calls, [identityPath, versionsPath].map(path => ({ path, method: 'POST', body: {} })));
  assert.doesNotMatch(JSON.stringify(result), /private identity/);
});

test('WeChat audit lookups bind latest or exact IDs and keep review separate from publication', async () => {
  const f = fixture();
  const latest = await getWechatAudit({ ...f.options, latest: true });
  assert.equal(latest.observationComplete, true);
  assert.equal(latest.resolution, 'found');
  assert.equal(latest.coverage, 'latest-audit');
  assert.deepEqual(latest.audit, { auditId: '123', version: 'V1.5-体验', rawState: 1,
    reviewState: 'rejected', publicationState: 'unknown', reason: '请补充类目说明', submittedAtEpochSeconds: timestamp });
  assert.equal(JSON.stringify(latest).includes('private-media-id'), false);
  const exact = await getWechatAudit({ ...f.options, auditId: '42' });
  assert.equal(exact.observationComplete, true);
  assert.equal(exact.target.auditId, '42');
  assert.deepEqual(exact.audit, { auditId: '42', rawState: 0,
    reviewState: 'approved', publicationState: 'unknown', reason: null });
  assert.deepEqual(f.calls, [
    { path: identityPath, method: 'POST', body: {} }, { path: latestPath, method: 'GET', body: undefined },
    { path: identityPath, method: 'POST', body: {} }, { path: exactPath, method: 'POST', body: { auditid: 42 } },
  ]);
  for (const [status, reviewState] of [[2, 'in-review'], [3, 'withdrawn'], [4, 'deferred'], [99, 'unknown']]) {
    f.responses[exactPath] = { errcode: 0, status, reason: '等待补充' };
    const report = await getWechatAudit({ ...f.options, auditId: '42' });
    assert.deepEqual([report.audit.rawState, report.audit.reviewState, report.audit.publicationState], [status, reviewState, 'unknown']);
    assert.equal(report.audit.reason, status === 4 ? '等待补充' : null);
  }
});

test('WeChat credentials must be live and bound to the exact mini program before release reads', async () => {
  const f = fixture();
  assert.deepEqual((await listWechatVersions({ ...f.options, environment: {} })).errors,
    [{ code: 'authentication', reason: 'missing-or-invalid-token' }]);
  assert.deepEqual(f.calls, []);
  for (const data of [
    { errcode: 0, appid: 'wx2222222222222222', account_type: 3 },
    { errcode: 0, appid: appId, account_type: 2 },
  ]) {
    f.responses[identityPath] = data;
    const report = await getWechatAudit({ ...f.options, latest: true });
    assert.equal(report.observationComplete, false);
    assert.equal(report.resolution, 'unavailable');
    assert.deepEqual(report.errors, [{ code: 'app-identity', reason: 'app-identity-mismatch' }]);
  }
  f.responses[identityPath] = { errcode: 48001, errmsg: `provider echoed ${token}` };
  const report = await listWechatVersions(f.options);
  assert.deepEqual(report.errors, [{ code: 'app-identity', reason: 'forbidden', providerCode: 48001 }]);
  assert.equal(JSON.stringify(report).includes(token), false);
  assert.deepEqual(f.calls.map(call => call.path), [identityPath, identityPath, identityPath]);
});

test('WeChat slots can be partial and malformed or unsuccessful audits never become absence or approval', async () => {
  const f = fixture();
  delete f.responses[versionsPath].release_info;
  const partial = await listWechatVersions(f.options);
  assert.equal(partial.observationComplete, false);
  assert.deepEqual(partial.versions.map(version => version.channel), ['experience']);
  assert.deepEqual(partial.errors, [{ code: 'production-version', reason: 'missing-version' }]);
  for (const [response, reason] of [
    [{ errcode: 0, auditid: 7, status: 0 }, 'malformed-response'],
    [{ errcode: 0 }, 'malformed-response'],
    [{ errcode: 85012, errmsg: 'invalid id' }, 'invalid-audit-id'],
    [{ errcode: 40014 }, 'authentication'],
    [() => new Response('{}', { status: 403 }), 'forbidden'],
    [() => new Response('malformed JSON'), 'malformed-response'],
    [() => new Response('{"errcode":0,"auditid":41,"\\u0061uditid":42,"status":0}'), 'malformed-response'],
    [() => new Response('{"errcode":0,"status":1,"status":0}'), 'malformed-response'],
    [() => new Response('{"errcode":0,"status":1e-324}'), 'malformed-response'],
    [() => new Response('{"errcode":0,"auditid":42.000000000000001,"status":0}'), 'malformed-response'],
    [() => new Response('x'.repeat(256 * 1024 + 1)), 'response-too-large'],
  ]) {
    f.responses[exactPath] = response;
    const report = await getWechatAudit({ ...f.options, auditId: '42' });
    assert.equal(report.observationComplete, false);
    assert.equal(report.resolution, 'unavailable');
    assert.equal(report.audit, undefined);
    assert.equal(report.errors[0].reason, reason);
  }
});

test('WeChat inventory retains a verified sibling when raw evidence is ambiguous within one slot', async () => {
  const f = fixture();
  const production = JSON.stringify(f.responses[versionsPath].release_info);
  for (const experience of [
    '{"exp_version":"V1.5","exp_time":1640762988.00000001}',
    '{"exp_version":"V1.5","exp_time":0,"\\u0065xp_time":1640762988}',
    '{"exp_version":"V1.5","exp_time":1640762988,"extra":[{"key":1,"key":2}]}',
  ]) {
    f.responses[versionsPath] = () => new Response(`{"errcode":0,"exp_info":${experience},"release_info":${production}}`);
    const result = await listWechatVersions(f.options);
    assert.equal(result.observationComplete, false);
    assert.deepEqual(result.versions.map(version => version.channel), ['production']);
    assert.deepEqual(result.errors, [{ code: 'experience-version', reason: 'malformed-response' }]);
  }
  f.responses[versionsPath] = () => new Response(`{"errcode":0,"release_info":${production},"release_info":${production}}`);
  const ambiguous = await listWechatVersions(f.options);
  assert.deepEqual(ambiguous.versions, []);
  assert.deepEqual(ambiguous.errors, [{ code: 'versions', reason: 'malformed-response' }]);
});

test('WeChat only emits bounded, sanitized free text and never copies transport errors', async () => {
  const f = fixture();
  const latest = f.responses[latestPath];
  f.responses[latestPath] = (_, url) => Response.json({ ...latest,
    reason: `before\u0000${token}\n${encodeURIComponent(token)} ${url.search.split('=')[1]} ${'中'.repeat(1100)}` });
  const report = await getWechatAudit({ ...f.options, latest: true });
  assert.equal(report.audit.reason.length, 1024);
  assert.match(report.audit.reason, /^before \[redacted\] \[redacted\] \[redacted\]/);
  f.responses[latestPath] = () => { throw new Error(`private request failure ${token}`); };
  const failure = await getWechatAudit({ ...f.options, latest: true });
  assert.deepEqual(failure.errors, [{ code: 'audit-status', reason: 'read-unavailable' }]);
});

test('WeChat omits provider text that exposes the token as sent in the query string', async () => {
  const f = fixture();
  const versions = f.responses[versionsPath];
  f.responses[versionsPath] = (_, url) => {
    const encoded = url.search.split('=')[1];
    assert.match(encoded, /%7E/);
    return Response.json({ ...versions,
      exp_info: { ...versions.exp_info, exp_version: encoded },
      release_info: { ...versions.release_info, release_desc: encoded },
    });
  };
  const report = await listWechatVersions(f.options);
  assert.equal(report.observationComplete, false);
  assert.equal(report.versions.length, 1);
  assert.equal(report.versions[0].description, '[redacted]');
  assert.doesNotMatch(JSON.stringify(report), /test-authorizer/);
});

test('WeChat cancellable queries cannot report a late response as evidence', async () => {
  const f = fixture();
  const controller = new AbortController();
  f.responses[versionsPath] = () => {
    controller.abort();
    return Response.json({ errcode: 0 });
  };
  await assert.rejects(listWechatVersions({ ...f.options, signal: controller.signal }), { name: 'AbortError' });
  f.responses[identityPath] = async ({ signal }) => {
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    return Response.json({ errcode: 0, appid: appId, account_type: 3 });
  };
  await assert.rejects(getWechatAudit({ ...f.options, latest: true, timeoutMs: 10 }), { name: 'TimeoutError' });
  assert.deepEqual(f.calls.map(call => call.path), [identityPath, versionsPath, identityPath]);
});

test('WeChat deadlines stop stalled headers, stalled bodies and over-budget approvals', { timeout: 3000 }, async () => {
  const f = fixture();
  let releaseHeaders;
  const headers = new Promise(resolve => { releaseHeaders = resolve; });
  const cancelledLate = Promise.withResolvers();
  f.responses[exactPath] = () => headers;
  await assert.rejects(getWechatAudit({ ...f.options, auditId: '42', timeoutMs: 100 }), { name: 'TimeoutError' });
  assert.equal(f.calls.at(-1).path, exactPath);
  releaseHeaders(new Response(new ReadableStream({ cancel() { cancelledLate.resolve(); } })));
  await cancelledLate.promise;

  let cancelledBody = false;
  const stalled = new Response(new ReadableStream({
    start(stream) { stream.enqueue(Buffer.from('{"errcode":0,"status":0}')); },
    cancel() { cancelledBody = true; return new Promise(() => {}); },
  }));
  f.responses[exactPath] = () => stalled;
  await assert.rejects(getWechatAudit({ ...f.options, auditId: '42', timeoutMs: 100 }), { name: 'TimeoutError' });
  assert.equal(cancelledBody, true);
  assert.equal(stalled.body.locked, false);

  f.responses[exactPath] = () => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 160);
    return Response.json({ errcode: 0, status: 0 });
  };
  await assert.rejects(getWechatAudit({ ...f.options, auditId: '42', timeoutMs: 100 }), { name: 'TimeoutError' });
});

test('WeChat selector and platform validation happens before config, authentication or provider access', async () => {
  const f = fixture();
  for (const selection of [{}, { latest: true, auditId: '4' }, { auditId: '0' }, { auditId: '9007199254740992' },
    { auditId: '1e2' }, { auditId: '041' }, { auditId: 42 }])
    await assert.rejects(getWechatAudit({ ...f.options, ...selection }), /audit ID/);
  assert.deepEqual(f.calls, []);
  const wx = ['--provider', 'wechat-mini-program', '--config', '/absent/config.json'];
  for (const [args, reason] of [
    [['store-status', ...wx], /--latest or --audit-id/],
    [['store-status', ...wx, '--latest', '--audit-id', '42'], /--latest or --audit-id/],
    [['store-status', ...wx, '--audit-id', '41', '--audit-id=42'], /--latest or --audit-id/],
    [['store-status', ...wx, '--latest', '--latest'], /--latest or --audit-id/],
    [['store-status', ...wx, '--latest', '--config', '/absent/other.json'], /require one provider/],
    [['store-status', ...wx, '--latest', '--version', '1.2.3'], /Incompatible WeChat/],
    [['store-versions', ...wx, '--latest'], /no audit selector/],
    [['store-preflight', ...wx, '--latest'], /supports store-versions and store-status/],
    [['store-status', '--config', '/absent/config.json', '--version', '1.0', '--audit-id', '42'], /WeChat selectors/],
  ]) await assert.rejects(main({ args }), reason);
});

test('WeChat executable refuses an explicit project without executing its module', async t => {
  const root = await mkdtemp(join(tmpdir(), 'wechat-standalone-executable-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project.mjs');
  const executed = join(root, 'executed');
  await writeFile(project, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(executed)}, 'executed'); export default { repo: '.' };`);
  const bin = fileURLToPath(new URL('../bin/release-kit.mjs', import.meta.url));
  for (const provider of [['--provider', 'wechat-mini-program'], ['--provider=wechat-mini-program']]) {
    const result = spawnSync(process.execPath, [bin, '--project', project, 'store-status',
      ...provider, '--config', '/absent/config.json', '--audit-id', '0'], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /standalone CLI without --project/);
    assert.deepEqual(await readdir(root), ['project.mjs']);
  }
});

test('standalone WeChat CLI reads from a private config without build or journal setup', async t => {
  const f = fixture();
  const root = await mkdtemp(join(tmpdir(), 'wechat-standalone-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = join(root, 'query.json');
  await writeFile(config, JSON.stringify({ schemaVersion: 1, stores: { wechat: store } }), { mode: 0o600 });
  t.mock.method(globalThis, 'fetch', f.options.fetch);
  const print = [];
  const run = (operation, ...extra) => main({ args: [operation, '--provider', 'wechat-mini-program', '--config', config, ...extra],
    repo: join(root, 'no-checkout'), environment: f.options.environment, output: value => print.push(JSON.parse(value)) });
  assert.equal(await run('store-versions'), 0);
  assert.equal(await run('store-status', '--latest'), 0);
  assert.equal(await run('store-status', '--audit-id', '42'), 0);
  f.responses[exactPath] = { errcode: 85012 };
  assert.equal(await run('store-status', '--audit-id', '42'), 2);
  assert.deepEqual(print.map(report => [report.operation, report.observationComplete]),
    [['store-versions', true], ['store-status', true], ['store-status', true], ['store-status', false]]);
  assert.deepEqual(await readdir(root), ['query.json']);
});
