import { lstat, readFile } from 'node:fs/promises';
import { constants, createPrivateKey, sign } from 'node:crypto';

const BASE = 'https://connect-api.cloud.huawei.com';
const AUDIENCE = 'https://oauth-login.cloud.huawei.com/oauth2/v3/token';
class AgcError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
const id = (value) => typeof value === 'string' && /^\d{1,32}$/.test(value);
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);

function settings(ctx) {
  const cfg = ctx.config.stores?.harmony;
  if (
    !object(cfg) ||
    Object.keys(cfg).some(
      (key) =>
        !['appId', 'bundleId', 'serviceAccountPathEnv', 'versionId', 'language'].includes(key),
    ) ||
    !id(cfg.appId) ||
    typeof cfg.bundleId !== 'string' ||
    !/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/.test(cfg.bundleId) ||
    typeof cfg.serviceAccountPathEnv !== 'string' ||
    !/^[A-Z_][A-Z0-9_]*$/.test(cfg.serviceAccountPathEnv) ||
    (cfg.versionId !== undefined && !id(cfg.versionId)) ||
    (cfg.language !== undefined && !/^[A-Za-z0-9_-]{2,16}$/.test(cfg.language))
  )
    throw new AgcError(
      'AGC_CONFIG',
      'Configure the exact Harmony app ID, bundle ID and Service Account environment reference.',
    );
  if (ctx.plan.appIds.harmony !== cfg.bundleId)
    throw new AgcError(
      'AGC_IDENTITY',
      'Configured Harmony bundle identity differs from the inspection target.',
    );
  return cfg;
}

async function token(ctx, cfg) {
  try {
    const path = ctx.env[cfg.serviceAccountPathEnv];
    if (typeof path !== 'string' || !path.startsWith('/')) throw new Error();
    const stat = await lstat(path);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size > 65536 ||
      stat.mode & 0o077 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw new Error();
    const key = JSON.parse(await readFile(path, 'utf8'));
    for (const field of ['key_id', 'sub_account'])
      if (typeof key[field] !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(key[field]))
        throw new Error();
    const privateKey = createPrivateKey(key.private_key);
    if (!['rsa', 'rsa-pss'].includes(privateKey.asymmetricKeyType)) throw new Error();
    const iat = Math.floor(Date.now() / 1000);
    const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const data = `${encode({ kid: key.key_id, typ: 'JWT', alg: 'PS256' })}.${encode({
      aud: AUDIENCE,
      iss: key.sub_account,
      iat,
      exp: iat + 3600,
    })}`;
    const signature = sign('sha256', Buffer.from(data), {
      key: privateKey,
      padding: constants.RSA_PKCS1_PSS_PADDING,
      saltLength: 32,
    });
    return `${data}.${signature.toString('base64url')}`;
  } catch {
    throw new AgcError(
      'AGC_CREDENTIAL',
      'Service Account must reference an owned private regular JSON file with a valid RSA signing key.',
    );
  }
}

async function get(ctx, route, query, jwt) {
  ctx.signal?.throwIfAborted();
  const url = new URL(route, BASE);
  url.search = new URLSearchParams(query).toString();
  let response;
  try {
    const timeout = AbortSignal.timeout(60000);
    response = await (ctx.fetch ?? fetch)(url.href, {
      method: 'GET',
      redirect: 'error',
      signal: ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout,
      headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
    });
  } catch {
    ctx.signal?.throwIfAborted();
    throw new AgcError('AGC_TRANSPORT', 'AGC provider read could not be completed.');
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new AgcError(`AGC_HTTP_${response.status}`, 'AGC provider rejected the read request.');
  }
  let data;
  try {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > 4 * 1024 * 1024) throw new Error();
      chunks.push(chunk);
    }
    data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    // The published API schemas include both object and JSON-string ret values.
    const ret = typeof data.ret === 'string' ? JSON.parse(data.ret) : data.ret;
    if (!object(ret) || !Number.isInteger(ret.code)) throw new Error();
    if (ret.code !== 0)
      throw new AgcError(
        `AGC_CODE_${ret.code}`,
        'AGC provider reported an unsuccessful operation.',
      );
  } catch (error) {
    ctx.signal?.throwIfAborted();
    if (error instanceof AgcError) throw error;
    throw new AgcError(
      'AGC_RESPONSE',
      'AGC response is incomplete or does not match its documented schema.',
    );
  }
  ctx.signal?.throwIfAborted();
  return data;
}

// Read-only visibility. Raw app-info contains review passwords and government IDs;
// only the explicitly selected public operational fields may leave this module.
export async function inspectAgc(ctx) {
  const report = {
    supported: true,
    provider: 'appgallery-connect',
    ok: false,
    publicationReadiness: 'not-evaluated',
    identitySource: 'explicit-config-and-package-lookup',
    checks: [],
  };
  try {
    ctx.signal?.throwIfAborted();
    const cfg = settings(ctx);
    const jwt = await token(ctx, cfg);
    ctx.signal?.throwIfAborted();
    const lookup = await get(
      ctx,
      '/api/publish/v2/appid-list',
      { packageName: cfg.bundleId, packageTypes: '7' },
      jwt,
    );
    if (!Array.isArray(lookup.appids) || !lookup.appids.some((pair) => pair.value === cfg.appId))
      throw new AgcError(
        'AGC_IDENTITY',
        'Provider package lookup does not contain the configured Harmony app ID.',
      );
    const data = await get(
      ctx,
      '/api/publish/v3/app-info',
      {
        appId: cfg.appId,
        releaseType: '1',
        ...(cfg.versionId ? { versionId: cfg.versionId } : {}),
        ...(cfg.language ? { lang: cfg.language } : {}),
      },
      jwt,
    );
    if (!object(data.appInfo)) throw new AgcError('AGC_RESPONSE', 'AGC app-info is missing.');
    const info = data.appInfo;
    if (cfg.versionId && info.versionId !== cfg.versionId)
      throw new AgcError(
        'AGC_IDENTITY',
        'Provider version differs from the configured formal-release target.',
      );
    report.app = { appId: cfg.appId, bundleId: cfg.bundleId, releaseType: 1 };
    for (const key of ['releaseState', 'reviewState', 'versionCode', 'onShelfVersionCode'])
      if (Number.isSafeInteger(info[key])) report.app[key] = info[key];
    for (const key of [
      'versionNumber',
      'versionId',
      'onShelfVersionNumber',
      'onShelfVersionId',
      'privacyAgreementId',
      'updateTime',
      'releaseTime',
    ])
      if (
        typeof info[key] === 'string' &&
        info[key].length <= 128 &&
        !/[\x00-\x1f]/.test(info[key])
      )
        report.app[key] = info[key];
    report.app.auditOpinionPresent =
      typeof data.auditInfo?.auditOpinion === 'string' && !!data.auditInfo.auditOpinion.trim();
    report.checks.push({
      name: 'harmony provider visibility',
      ok: true,
      message: 'Harmony app identity and selected formal-release metadata are visible.',
    });
    report.ok = true;
  } catch (error) {
    ctx.signal?.throwIfAborted();
    report.checks.push({
      name: 'harmony provider inspection',
      ok: false,
      code: error instanceof AgcError ? error.code : 'AGC_INSPECTION',
      message: error instanceof AgcError ? error.message : 'AGC inspection could not be completed.',
    });
  }
  return report;
}
