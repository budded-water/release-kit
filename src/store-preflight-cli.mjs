import { parseArgs } from 'node:util';
import { loadConfig } from './plan.mjs';
import { inspectAppStore } from './store-preflight.mjs';

export async function storePreflightMain({ args, environment = process.env, signal,
  output = console.log, inspector = inspectAppStore }) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true,
    options: { config: { type: 'string' }, version: { type: 'string' },
      'build-id': { type: 'string' }, 'timeout-seconds': { type: 'string', default: '120' },
      help: { type: 'boolean' } } });
  if (values.help) {
    output('store-preflight --config <private.json> [--version <candidate>] [--build-id <expected-apple-build>] [--timeout-seconds <1–300>]\nGET-only iOS App Store inspection; no project, journal or publication approval.');
    return 0;
  }
  if (positionals.length !== 1 || positionals[0] !== 'store-preflight' || !values.config)
    throw new Error('store-preflight requires --config and accepts no release ID');
  if (!/^[1-9]\d*$/.test(values['timeout-seconds']) || Number(values['timeout-seconds']) > 300)
    throw new Error('Observation timeout must be an integer from 1 to 300 seconds');
  signal?.throwIfAborted();
  const { config } = await loadConfig(values.config);
  const ios = config.stores?.ios;
  const boundedSignal = AbortSignal.timeout(Number(values['timeout-seconds']) * 1000);
  const inspectionSignal = signal ? AbortSignal.any([signal, boundedSignal]) : boundedSignal;
  const report = await inspector({ appId: ios?.appId, bundleId: ios?.bundleId,
    apiKeyPathEnv: ios?.apiKeyPathEnv, candidateVersion: values.version,
    expectedAppleBuildId: values['build-id'], environment,
    signal: inspectionSignal });
  inspectionSignal.throwIfAborted();
  output(JSON.stringify(report, null, 2));
  return report.observationComplete ? 0 : 2;
}
