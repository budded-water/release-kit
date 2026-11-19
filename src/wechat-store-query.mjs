import { observeStoreRead } from './store-read-observation.mjs';

const origin = 'https://api.weixin.qq.com';
const methods = Object.freeze({
  '/cgi-bin/account/getaccountbasicinfo': 'POST',
  '/wxa/getversioninfo': 'POST',
  '/wxa/get_latest_auditstatus': 'GET',
  '/wxa/get_auditstatus': 'POST',
});
const maxResponseBytes = 256 * 1024;
const reviewStates = ['approved', 'rejected', 'in-review', 'withdrawn', 'deferred'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const positiveInt = value => Number.isSafeInteger(value) && value > 0;
export const validWechatAuditId = value => typeof value === 'string' && /^[1-9]\d{0,15}$/.test(value) &&
  positiveInt(Number(value));

class WechatReadError extends Error {
  constructor(reason, details = {}) {
    super(reason);
    this.diagnostic = { reason, ...details };
  }
}

function wechatTarget(options) {
  const { appId, authorizerAccessTokenEnv } = options.store ?? {};
  if (typeof appId !== 'string' || !/^wx[0-9a-f]{16}$/.test(appId))
    throw new Error('Expected a WeChat Mini Program AppID');
  if (typeof authorizerAccessTokenEnv !== 'string' || !/^[A-Z][A-Z0-9_]{1,127}$/.test(authorizerAccessTokenEnv))
    throw new Error('Expected a WeChat authorizer token environment reference');
  return { provider: 'wechat-mini-program', platform: 'WECHAT_MINI_PROGRAM', appId };
}

function providerReason(code) {
  if ([40001, 40014, 42001].includes(code)) return 'authentication';
  if ([48001, 86000].includes(code)) return 'forbidden';
  if (code === 85012) return 'invalid-audit-id';
  return 'provider-error';
}

function readTransport(fetch, token, signal) {
  return async (path, payload = {}) => {
    const method = methods[path];
    if (!Object.hasOwn(methods, path)) throw new Error('Unexpected WeChat read endpoint');
    signal.throwIfAborted();
    const url = new URL(path, origin);
    url.searchParams.set('access_token', token);
    const response = await fetch(url.href, { method, signal, redirect: 'error',
      ...(method === 'POST' ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) } : {}) });
    signal.throwIfAborted();
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      const httpStatus = response.status;
      throw new WechatReadError(httpStatus === 401 ? 'authentication' : httpStatus === 403 ? 'forbidden' : 'read-unavailable',
        Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599 ? { httpStatus } : {});
    }
    const chunks = [];
    let bytes = 0;
    if (response.body) for await (const chunk of response.body) {
      signal.throwIfAborted();
      bytes += chunk.length;
      if (bytes > maxResponseBytes) throw new WechatReadError('response-too-large');
      chunks.push(chunk);
    }
    signal.throwIfAborted();
    let data;
    try { data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes))); }
    catch { throw new WechatReadError('malformed-response'); }
    if (!object(data) || !Number.isInteger(data.errcode) || Math.abs(data.errcode) > 2147483647)
      throw new WechatReadError('malformed-response');
    if (data.errcode !== 0)
      throw new WechatReadError(providerReason(data.errcode), { providerCode: data.errcode });
    return data;
  };
}

function withWechatRead(options, target, fallback, code, operation) {
  return observeStoreRead(options, target, async signal => {
    let stage = 'authentication';
    try {
      const environment = options.environment ?? process.env;
      const token = environment[options.store.authorizerAccessTokenEnv];
      if (typeof token !== 'string' || !/^[A-Za-z0-9._~+/=-]{1,2048}$/.test(token))
        throw new WechatReadError('missing-or-invalid-token');
      const read = readTransport(options.fetch ?? globalThis.fetch, token, signal);
      stage = 'app-identity';
      const account = await read('/cgi-bin/account/getaccountbasicinfo');
      if (account.appid !== target.appId || account.account_type !== 3)
        throw new WechatReadError('app-identity-mismatch');
      stage = code;
      return { ...fallback, ...await operation(read, token) };
    } catch (error) {
      signal.throwIfAborted();
      const diagnostic = error instanceof WechatReadError ? error.diagnostic : { reason: 'read-unavailable' };
      return { ...fallback, errors: [{ code: stage, ...diagnostic }] };
    }
  });
}

function versionLabel(value, token) {
  return typeof value === 'string' && value.length <= 128 && value.trim() === value && value.length > 0 &&
    !/[\p{Cc}\p{Cf}]/u.test(value) && !value.includes(token) && !value.includes(encodeURIComponent(token));
}

function safeText(value, token) {
  if (typeof value !== 'string' || !value.trim()) return null;
  return value.replaceAll(token, '[redacted]').replaceAll(encodeURIComponent(token), '[redacted]')
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ').slice(0, 1024);
}

export async function listWechatVersions(options) {
  const target = wechatTarget(options);
  return withWechatRead(options, target, { operation: 'store-versions', coverage: 'current-experience-production',
    versions: [] }, 'versions', async (read, token) => {
    const data = await read('/wxa/getversioninfo');
    const versions = [], errors = [];
    for (const [channel, prefix, publicationState] of [
      ['experience', 'exp', 'testing'], ['production', 'release', 'published'],
    ]) {
      const slot = data[`${prefix}_info`];
      const version = slot?.[`${prefix}_version`], changedAtEpochSeconds = slot?.[`${prefix}_time`];
      if (!object(slot) || !versionLabel(version, token) || !positiveInt(changedAtEpochSeconds)) {
        errors.push({ code: `${channel}-version`, reason: slot == null ? 'missing-version' : 'malformed-response' });
        continue;
      }
      versions.push({ channel, version, changedAtEpochSeconds, description: safeText(slot[`${prefix}_desc`], token),
        reviewState: 'unknown', publicationState });
    }
    return { versions, errors };
  });
}

export async function getWechatAudit(options) {
  const { latest, auditId } = options;
  if (!((latest === true && auditId === undefined) ||
      ((latest === undefined || latest === false) && validWechatAuditId(auditId))))
    throw new Error('WeChat status requires either latest or a positive safe decimal audit ID');
  const target = { ...wechatTarget(options), ...(latest ? { selector: 'latest-audit' } : { selector: 'audit-id', auditId }) };
  return withWechatRead(options, target, { operation: 'store-status', coverage: target.selector, resolution: 'unavailable' },
    'audit-status', async (read, token) => {
      const data = await (latest ? read('/wxa/get_latest_auditstatus') : read('/wxa/get_auditstatus', { auditid: Number(auditId) }));
      const observedId = latest ? data.auditid : Number(auditId);
      if (!positiveInt(observedId) || (!latest && data.auditid !== undefined && data.auditid !== observedId) ||
          !Number.isInteger(data.status) || data.status < 0 || data.status > 2147483647 ||
          (latest && data.user_version !== undefined && !versionLabel(data.user_version, token)) ||
          (latest && data.submit_audit_time !== undefined && !positiveInt(data.submit_audit_time)))
        throw new WechatReadError('malformed-response');
      return { resolution: 'found', errors: [], audit: { auditId: String(observedId), rawState: data.status,
        reviewState: reviewStates[data.status] ?? 'unknown', publicationState: 'unknown',
        ...(latest ? { version: data.user_version ?? null, submittedAtEpochSeconds: data.submit_audit_time ?? null } : {}),
        reason: [1, 4].includes(data.status) ? safeText(data.reason, token) : null } };
    });
}
