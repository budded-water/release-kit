import { contentSession } from './stores.mjs';

export const present = value => typeof value === 'string' && value.trim().length > 0;
export const segment = value => encodeURIComponent(value);
export const need = (condition, message) => { if (!condition) throw new Error(message); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
export const validId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value);

export function readOnlyTransport(transport = fetch, limit = 200) {
  let requests = 0;
  return (url, options = {}) => {
    need((options.method ?? 'GET') === 'GET' && new URL(url).origin === 'https://api.appstoreconnect.apple.com', 'Only ASC GET is allowed');
    if (++requests > limit) throw Object.assign(new Error('App Store read request budget exceeded'), { code: 'request-budget' });
    return transport(url, { ...options, redirect: 'error' });
  };
}

// One operation owns its identity, authentication, deadline and request budget.
// The internal reader is never shared across accounts or separate operations.
export async function withAppleRead(options, operation) {
  const { appId, bundleId, apiKeyPathEnv, environment = process.env,
    session = contentSession, timeoutMs = 120_000, signal: parentSignal,
    candidateVersion, expectedAppleBuildId } = options;
  need(options.provider === undefined || options.provider === 'app-store-connect', 'Unsupported query provider');
  need(typeof appId === 'string' && /^\d{1,30}$/.test(appId), 'Expected numeric ASC app ID');
  need(typeof bundleId === 'string' && bundleId.length <= 255 && /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(bundleId), 'Expected bundle ID');
  need(typeof apiKeyPathEnv === 'string' && /^[A-Z][A-Z0-9_]+$/.test(apiKeyPathEnv), 'Expected credential environment reference');
  need(candidateVersion === undefined || (typeof candidateVersion === 'string' && /^\d+(?:\.\d+){0,2}$/.test(candidateVersion) && candidateVersion.length <= 64), 'Expected candidate version');
  need(expectedAppleBuildId === undefined || validId(expectedAppleBuildId), 'Expected Apple build ID');
  need(Number.isInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 3_600_000, 'Read timeout must be 1–3600000 milliseconds');
  parentSignal?.throwIfAborted();
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new DOMException('Store read timed out', 'TimeoutError')), timeoutMs);
  const signal = parentSignal ? AbortSignal.any([parentSignal, deadline.signal]) : deadline.signal;
  const errors = [], startedAt = new Date().toISOString();
  let api;
  async function attempt(code, fn) {
    signal.throwIfAborted();
    try { const value = await fn(); signal.throwIfAborted(); return { ok: true, value }; }
    catch (error) {
      signal.throwIfAborted();
      const status = Number.isInteger(error?.status) ? error.status : undefined;
      errors.push({ code, reason: status === 401 ? 'authentication' : status === 403 ? 'forbidden'
        : error?.code === 'request-budget' ? 'request-budget' : 'read-unavailable',
        ...(status === undefined ? {} : { httpStatus: status }) });
      return { ok: false };
    }
  }
  const attributes = (value, required) => object(value.attributes) && required.every(key => Object.hasOwn(value.attributes, key));
  const reader = {
    errors, signal, attempt,
    target: { provider: 'app-store-connect', appId, bundleId, platform: 'IOS', destination: 'app-store' },
    read: (code, path, required = []) => attempt(code, async () => {
      const response = await api.read(path);
      need(object(response) && Object.hasOwn(response, 'data') && (response.data === null ||
        (object(response.data) && validId(response.data.id) && (!required.length || attributes(response.data, required)))), 'Malformed ASC resource');
      return response.data;
    }),
    list: (code, path, required = [], valid = () => true) => attempt(code, async () => {
      const items = await api.list(path);
      need(Array.isArray(items) && items.every(item => object(item) && validId(item.id) && attributes(item, required) && valid(item)), 'Malformed ASC inventory');
      return items;
    }),
  };
  try {
    const opened = await attempt('authentication', () => session({ platform: 'ios',
      plan: { appIds: { ios: bundleId } },
      config: { stores: { ios: { appId, bundleId, apiKeyPathEnv } } },
      env: environment, signal, fetch: readOnlyTransport() }));
    let app;
    if (opened.ok) {
      api = opened.value;
      const result = await reader.read('app-identity', `/v1/apps/${segment(appId)}`, ['bundleId']);
      if (result.ok) {
        need(result.value?.id === appId && result.value?.type === 'apps' && result.value?.attributes?.bundleId === bundleId, 'Remote ASC app mismatch');
        app = result.value;
      }
    }
    reader.app = app;
    const result = await operation(reader);
    signal.throwIfAborted();
    return { schemaVersion: 1, ...result, target: reader.target, startedAt,
      observedAt: startedAt, completedAt: new Date().toISOString(),
      source: 'official-api', readOnly: true, errors,
      observationComplete: errors.length === 0 };
  } finally { clearTimeout(timer); }
}
