import { parseArgs } from 'node:util';
import { loadConfig } from './plan.mjs';
import { inspectAppStore } from './store-preflight.mjs';
import { listStoreVersions, getStoreVersion } from './store-query.mjs';

export async function storeReadMain({ args, environment = process.env, signal,
  output = console.log, inspector }) {
  signal?.throwIfAborted();
  const operation = args[0];
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true,
    options: { config: { type: 'string' }, version: { type: 'string' },
      'build-id': { type: 'string' }, 'timeout-seconds': { type: 'string', default: '120' },
      help: { type: 'boolean' } } });
  if (values.help) {
    output(`${operation} --config <private.json> ${operation === 'store-versions' ? '' : '--version <candidate> [--build-id <expected-apple-build>] '}[--timeout-seconds <1–300>]\nGET-only iOS App Store inspection; no project, journal or publication approval.`);
    return 0;
  }
  if (positionals.length !== 1 || !['store-versions', 'store-status', 'store-preflight'].includes(operation) || !values.config)
    throw new Error('Store reads require --config and accept no release ID');
  if (operation === 'store-versions' ? values.version !== undefined || values['build-id'] !== undefined : !values.version)
    throw new Error('store-status/preflight require --version; store-versions accepts neither version nor build ID');
  if (!/^[1-9]\d*$/.test(values['timeout-seconds']) || Number(values['timeout-seconds']) > 300)
    throw new Error('Observation timeout must be an integer from 1 to 300 seconds');
  signal?.throwIfAborted();
  const { config } = await loadConfig(values.config);
  const ios = config.stores?.ios;
  const inspect = inspector ?? ({ 'store-preflight': inspectAppStore, 'store-status': getStoreVersion, 'store-versions': listStoreVersions })[operation];
  const report = await inspect({ appId: ios?.appId, bundleId: ios?.bundleId,
    apiKeyPathEnv: ios?.apiKeyPathEnv, candidateVersion: values.version,
    expectedAppleBuildId: values['build-id'], environment, signal,
    timeoutMs: Number(values['timeout-seconds']) * 1000 });
  signal?.throwIfAborted();
  output(JSON.stringify(report, null, 2));
  return report.observationComplete ? 0 : 2;
}
