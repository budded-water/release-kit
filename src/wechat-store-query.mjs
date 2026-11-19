import { observeStoreRead } from './store-read-observation.mjs';

const origin = 'https://api.weixin.qq.com';
const methods = Object.freeze({
  '/cgi-bin/account/getaccountbasicinfo': 'POST',
  '/wxa/getversioninfo': 'POST',
  '/wxa/get_latest_auditstatus': 'GET',
  '/wxa/get_auditstatus': 'POST',
});
const maxResponseBytes = 256 * 1024;
const integerFields = new Set(['errcode', 'account_type', 'exp_time', 'release_time', 'auditid', 'status', 'submit_audit_time']);
const versionSlots = [
  { key: 'exp_info', prefix: 'exp', channel: 'experience', publicationState: 'testing' },
  { key: 'release_info', prefix: 'release', channel: 'production', publicationState: 'published' },
];
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

function createReadGate(signal, check) {
  async function run(operation) {
    check();
    let onAbort;
    const cancelled = new Promise((_, reject) => { onAbort = () => reject(signal.reason); });
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      return await Promise.race([cancelled, Promise.resolve().then(() => { check(); return operation(); })]);
    } finally { signal.removeEventListener('abort', onAbort); }
  }
  return { check, run };
}

function parseFacts(bytes, inventory) {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const data = JSON.parse(text);
    const invalidSlots = new Set();
    function invalidate(scope) {
      if (scope === undefined) throw new Error('Ambiguous response facts');
      invalidSlots.add(scope);
    }
    // The native parser owns JSON syntax. Inspect original member names and
    // numbers before trusting the values it coalesces or rounds.
    const containers = [];
    for (const [token, colon, number] of text.matchAll(/"(?:[^"\\]|\\[\s\S])*"(\s*:)?|[{}\[\],]|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g)) {
      const current = containers.at(-1);
      if (token === '{' || token === '[') {
        const slot = inventory && containers.length === 1 && versionSlots.some(({ key }) => key === current.key)
          ? current.key : current?.slot;
        containers.push({ slot, names: token === '{' ? new Set() : undefined });
      } else if (token === '}' || token === ']') containers.pop();
      else if (token === ',') current.key = undefined;
      else if (colon) {
        const name = JSON.parse(token.slice(0, -colon.length));
        if (current.names.has(name)) invalidate(current.slot);
        current.names.add(name);
        current.key = name;
      } else if (number !== undefined && integerFields.has(current?.key)) {
        const value = Number(number);
        if (!Number.isSafeInteger(value) || String(value) !== number) invalidate(current.slot);
      }
    }
    return { data, invalidSlots };
  } catch { throw new WechatReadError('malformed-response'); }
}

async function readBody(response, gate) {
  const chunks = [];
  let bytes = 0;
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  try {
    while (true) {
      const { done, value } = await gate.run(() => reader.read());
      gate.check();
      if (done) return Buffer.concat(chunks, bytes);
      bytes += value.length;
      if (bytes > maxResponseBytes) throw new WechatReadError('response-too-large');
      chunks.push(value);
    }
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
}

function readTransport(fetch, token, signal, gate) {
  return async (path, payload = {}) => {
    const method = methods[path];
    if (!Object.hasOwn(methods, path)) throw new Error('Unexpected WeChat read endpoint');
    const url = new URL(path, origin);
    url.searchParams.set('access_token', token);
    const response = await gate.run(async () => {
      const result = await fetch(url.href, { method, signal, redirect: 'error',
        ...(method === 'POST' ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) } : {}) });
      try { gate.check(); } catch (error) { void result.body?.cancel().catch(() => {}); throw error; }
      return result;
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      const httpStatus = response.status;
      throw new WechatReadError(httpStatus === 401 ? 'authentication' : httpStatus === 403 ? 'forbidden' : 'read-unavailable',
        Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599 ? { httpStatus } : {});
    }
    const facts = parseFacts(await readBody(response, gate), path === '/wxa/getversioninfo');
    const { data } = facts;
    gate.check();
    if (!object(data) || !Number.isInteger(data.errcode) || Math.abs(data.errcode) > 2147483647)
      throw new WechatReadError('malformed-response');
    if (data.errcode !== 0)
      throw new WechatReadError(providerReason(data.errcode), { providerCode: data.errcode });
    return facts;
  };
}

function withWechatRead(options, target, fallback, code, operation) {
  return observeStoreRead(options, target, async (signal, checkDeadline) => {
    const gate = createReadGate(signal, checkDeadline);
    let stage = 'authentication';
    try {
      const environment = options.environment ?? process.env;
      const token = environment[options.store.authorizerAccessTokenEnv];
      if (typeof token !== 'string' || !/^[A-Za-z0-9._~+/=-]{1,2048}$/.test(token))
        throw new WechatReadError('missing-or-invalid-token');
      const read = readTransport(options.fetch ?? globalThis.fetch, token, signal, gate);
      stage = 'app-identity';
      const { data: account } = await read('/cgi-bin/account/getaccountbasicinfo');
      if (account.appid !== target.appId || account.account_type !== 3)
        throw new WechatReadError('app-identity-mismatch');
      stage = code;
      const formEncodedToken = new URLSearchParams({ access_token: token }).toString().slice('access_token='.length);
      const tokenForms = [...new Set([token, encodeURIComponent(token), formEncodedToken])];
      const facts = await operation(read, tokenForms);
      gate.check();
      return { ...fallback, ...facts };
    } catch (error) {
      gate.check();
      const diagnostic = error instanceof WechatReadError ? error.diagnostic : { reason: 'read-unavailable' };
      return { ...fallback, errors: [{ code: stage, ...diagnostic }] };
    }
  });
}

function versionLabel(value, tokenForms) {
  return typeof value === 'string' && value.length <= 128 && value.trim() === value && value.length > 0 &&
    !/[\p{Cc}\p{Cf}]/u.test(value) && !tokenForms.some(token => value.includes(token));
}

function safeText(value, tokenForms) {
  if (typeof value !== 'string' || !value.trim()) return null;
  for (const token of tokenForms) value = value.replaceAll(token, '[redacted]');
  return value.replace(/[\p{Cc}\p{Cf}]/gu, ' ').slice(0, 1024);
}

export async function listWechatVersions(options) {
  const target = wechatTarget(options);
  return withWechatRead(options, target, { operation: 'store-versions', coverage: 'current-experience-production',
    versions: [] }, 'versions', async (read, tokenForms) => {
    const { data, invalidSlots } = await read('/wxa/getversioninfo');
    const versions = [], errors = [];
    for (const { key, channel, prefix, publicationState } of versionSlots) {
      const slot = data[key];
      const version = slot?.[`${prefix}_version`], changedAtEpochSeconds = slot?.[`${prefix}_time`];
      if (invalidSlots.has(key) || !object(slot) || !versionLabel(version, tokenForms) || !positiveInt(changedAtEpochSeconds)) {
        errors.push({ code: `${channel}-version`, reason: slot == null ? 'missing-version' : 'malformed-response' });
        continue;
      }
      versions.push({ channel, version, changedAtEpochSeconds, description: safeText(slot[`${prefix}_desc`], tokenForms),
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
    'audit-status', async (read, tokenForms) => {
      const { data } = await (latest ? read('/wxa/get_latest_auditstatus') : read('/wxa/get_auditstatus', { auditid: Number(auditId) }));
      const observedId = latest ? data.auditid : Number(auditId);
      if (!positiveInt(observedId) || (!latest && data.auditid !== undefined && data.auditid !== observedId) ||
          !Number.isInteger(data.status) || data.status < 0 || data.status > 2147483647 ||
          (latest && data.user_version !== undefined && !versionLabel(data.user_version, tokenForms)) ||
          (latest && data.submit_audit_time !== undefined && !positiveInt(data.submit_audit_time)))
        throw new WechatReadError('malformed-response');
      return { resolution: 'found', errors: [], audit: { auditId: String(observedId), rawState: data.status,
        reviewState: reviewStates[data.status] ?? 'unknown', publicationState: 'unknown',
        ...(latest ? { version: data.user_version ?? null, submittedAtEpochSeconds: data.submit_audit_time ?? null } : {}),
        reason: [1, 4].includes(data.status) ? safeText(data.reason, tokenForms) : null } };
    });
}
