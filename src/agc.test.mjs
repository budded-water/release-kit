import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, chmod, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, verify, constants } from 'node:crypto';
import { inspectAgc } from './agc.mjs';
import { inspectProviders } from './inspection.mjs';

const networkGuard = mock.method(globalThis, 'fetch', () => {
  throw new Error('Fixture transport required');
});
test.after(() => {
  assert.equal(networkGuard.mock.callCount(), 0);
  mock.restoreAll();
});

const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const secret = 'review-password-must-not-leave-client';
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'agc-inspect-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'service-account.json');
  await writeFile(
    path,
    JSON.stringify({
      key_id: 'synthetic-key',
      sub_account: 'synthetic-service',
      private_key: keys.privateKey.export({ format: 'pem', type: 'pkcs8' }),
    }),
    { mode: 0o600 },
  );
  const calls = [];
  const cfg = {
    appId: '123456789',
    bundleId: 'example.app',
    serviceAccountPathEnv: 'AGC_TEST_KEY',
    language: 'en-US',
  };
  const ctx = {
    config: { stores: { harmony: cfg } },
    plan: { appIds: { harmony: 'example.app' } },
    env: { AGC_TEST_KEY: path },
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (url.includes('appid-list'))
        return Response.json({ ret: { code: 0 }, appids: [{ value: cfg.appId }] });
      return Response.json({
        ret: { code: 0 },
        appInfo: {
          releaseState: 4,
          reviewState: 2,
          versionNumber: '1.0.0',
          versionCode: 12,
          versionId: '987654321',
          privacyAgreementId: '11111',
          testUserPassword: secret,
          testUserName: 'private-user',
          registeredIdNumber: 'private-id',
          certificateURLs: 'https://private.example/?token=secret',
        },
        auditInfo: { auditOpinion: secret },
      });
    },
  };
  return { directory, path, cfg, ctx, calls };
}

test('AGC uses verifiable PS256 JWT and two exact GETs, projecting no review secrets', async (t) => {
  const f = await fixture(t);
  const result = await inspectAgc(f.ctx);
  assert.equal(result.ok, true);
  assert.equal(result.app.appId, f.cfg.appId);
  assert.equal(result.app.releaseState, 4);
  assert.equal(result.app.auditOpinionPresent, true);
  assert.equal(result.publicationReadiness, 'not-evaluated');
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(JSON.stringify(result).includes('private-user'), false);
  assert.equal(JSON.stringify(result).includes('private-id'), false);
  assert.equal(JSON.stringify(result).includes('token=secret'), false);
  assert.equal(f.calls.length, 2);
  for (const call of f.calls) {
    assert.equal(new URL(call.url).origin, 'https://connect-api.cloud.huawei.com');
    assert.equal(call.options.method, 'GET');
    assert.equal(call.options.redirect, 'error');
    assert.equal(call.options.headers.client_id, undefined);
    const jwt = call.options.headers.Authorization.slice(7);
    const [h, p, s] = jwt.split('.');
    const header = JSON.parse(Buffer.from(h, 'base64url'));
    const payload = JSON.parse(Buffer.from(p, 'base64url'));
    assert.deepEqual(header, { kid: 'synthetic-key', typ: 'JWT', alg: 'PS256' });
    assert.equal(payload.iss, 'synthetic-service');
    assert.equal(payload.aud, 'https://oauth-login.cloud.huawei.com/oauth2/v3/token');
    assert.equal(payload.exp - payload.iat, 3600);
    assert.ok(
      verify(
        'sha256',
        Buffer.from(`${h}.${p}`),
        { key: keys.publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 },
        Buffer.from(s, 'base64url'),
      ),
    );
    assert.equal(JSON.stringify(result).includes(jwt), false);
  }
  assert.equal(new URL(f.calls[0].url).searchParams.get('packageTypes'), '7');
  assert.equal(new URL(f.calls[1].url).searchParams.get('releaseType'), '1');
});

test('wrong bundle/app/version and unavailable keys stop at their boundary', async (t) => {
  const f = await fixture(t);
  f.ctx.plan.appIds.harmony = 'other.app';
  assert.equal((await inspectAgc(f.ctx)).checks[0].code, 'AGC_IDENTITY');
  assert.equal(f.calls.length, 0);
  f.ctx.plan.appIds.harmony = f.cfg.bundleId;
  f.ctx.env.AGC_TEST_KEY = '/missing/key.json';
  assert.equal((await inspectAgc(f.ctx)).checks[0].code, 'AGC_CREDENTIAL');
  f.ctx.env.AGC_TEST_KEY = f.path;
  f.ctx.fetch = async (url, options) => {
    f.calls.push({ url, options });
    return Response.json({ ret: { code: 0 }, appids: [{ value: '111' }] });
  };
  assert.equal((await inspectAgc(f.ctx)).checks[0].code, 'AGC_IDENTITY');
  assert.equal(f.calls.length, 1);
});

test('AGC rejects shared and symlink credentials before any provider request', async (t) => {
  const f = await fixture(t);
  await chmod(f.path, 0o644);
  assert.equal((await inspectAgc(f.ctx)).checks[0].code, 'AGC_CREDENTIAL');
  await chmod(f.path, 0o600);
  const link = join(f.directory, 'linked.json');
  await symlink(f.path, link);
  f.ctx.env.AGC_TEST_KEY = link;
  assert.equal((await inspectAgc(f.ctx)).checks[0].code, 'AGC_CREDENTIAL');
  assert.equal(f.calls.length, 0);
});

test('AGC reports provider rejection and malformed bodies without reflecting their content', async (t) => {
  for (const mode of ['http', 'provider', 'invalid', 'oversize'])
    await t.test(mode, async (sub) => {
      const f = await fixture(sub);
      f.ctx.fetch = async () =>
        mode === 'http'
          ? new Response(secret, { status: 403 })
          : mode === 'provider'
            ? Response.json({ ret: { code: 403, msg: secret } })
            : mode === 'oversize'
              ? new Response('x'.repeat(4 * 1024 * 1024 + 1))
              : new Response(secret);
      const report = await inspectAgc(f.ctx);
      assert.equal(report.ok, false);
      assert.equal(JSON.stringify(report).includes(secret), false);
    });
});

test('malformed present metadata fails closed instead of becoming a successful empty projection', async (t) => {
  for (const info of [
    { releaseState: 'bad', versionId: 123 },
    { reviewState: null },
    { versionId: 123 },
    { versionNumber: 'x'.repeat(129) },
    { updateTime: 'bad\nvalue' },
  ]) {
    const f = await fixture(t);
    f.ctx.fetch = async (url) =>
      Response.json(
        url.includes('appid-list')
          ? { ret: { code: 0 }, appids: [{ value: f.cfg.appId }] }
          : { ret: { code: 0 }, appInfo: info },
      );
    const report = await inspectAgc(f.ctx);
    assert.equal(report.ok, false);
    assert.equal(report.checks[0].code, 'AGC_RESPONSE');
    assert.equal(report.app, undefined);
  }
});

test('cancellation prevents a subsequent query and a specified version cannot be substituted', async (t) => {
  const f = await fixture(t);
  const ac = new AbortController();
  f.ctx.signal = ac.signal;
  f.ctx.fetch = async () => {
    ac.abort();
    return Response.json({ ret: { code: 0 }, appids: [{ value: f.cfg.appId }] });
  };
  await assert.rejects(inspectAgc(f.ctx), /abort/i);
  delete f.ctx.signal;
  f.cfg.versionId = '333';
  const other = await fixture(t);
  f.ctx.fetch = other.ctx.fetch;
  assert.equal((await inspectAgc(f.ctx)).checks[0].code, 'AGC_IDENTITY');
});

test('Harmony-only provider inspection needs no Expo files, SDK, journal or command execution', async (t) => {
  const f = await fixture(t);
  const direct = await inspectProviders({
    repo: f.directory,
    config: f.ctx.config,
    platforms: ['harmony'],
    environment: f.ctx.env,
    inspector: (ctx) => inspectAgc({ ...ctx, fetch: f.ctx.fetch }),
  });
  assert.equal(direct.ok, true);
  assert.equal(direct.identitySource, 'explicit-harmony-config');
  assert.equal(direct.results.harmony.supported, true);
});

test('missing Expo identity fails only Expo hosts during mixed inspection', async (t) => {
  const f = await fixture(t);
  const report = await inspectProviders({
    repo: f.directory,
    config: f.ctx.config,
    platforms: ['android', 'harmony'],
    environment: f.ctx.env,
    inspector: (ctx) => {
      assert.equal(ctx.platform, 'harmony');
      return inspectAgc({ ...ctx, fetch: f.ctx.fetch });
    },
  });
  assert.equal(report.ok, false);
  assert.equal(report.results.android.ok, false);
  assert.equal(report.results.harmony.ok, true);
  assert.equal(f.calls.length, 2);
});
