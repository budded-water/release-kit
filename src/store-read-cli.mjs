import { parseArgs } from 'node:util';
import { loadConfig } from './plan.mjs';
import { inspectAppStore } from './store-preflight.mjs';
import { listStoreVersions, getStoreVersion } from './store-query.mjs';
import { listPlayReleases, getPlayRelease, listHarmonyReleases, getHarmonyRelease } from './provider-store-query.mjs';
import { inspectProviderStore } from './provider-store-preflight.mjs';

export async function storeReadMain({ args, environment = process.env, signal,
  output = console.log, inspector, command }) {
  signal?.throwIfAborted();
  const operation = args[0];
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true,
    options: { config: { type: 'string' }, version: { type: 'string' },
      'build-id': { type: 'string' }, 'timeout-seconds': { type: 'string', default: '120' },
      provider: { type: 'string', default: 'app-store-connect' },
      track: { type: 'string' }, 'version-code': { type: 'string' },
      'release-type': { type: 'string' }, 'version-id': { type: 'string' },
      help: { type: 'boolean' } } });
  const provider = values.provider;
  if (!['app-store-connect', 'google-play', 'appgallery-connect'].includes(provider))
    throw new Error('Unsupported query provider');
  if (values.help) {
    output(`${operation} --config <private.json> [--provider app-store-connect|google-play|appgallery-connect] [--timeout-seconds <1–300>]\nGET-only iOS App Store reads by default: --version <candidate> [--build-id <expected-apple-build>] (neither for store-versions).\nPlay: --track <track> and --version-code <code> for status/preflight.\nHarmony: store-versions lists formal/test versions; use --release-type 1|6 and --version-id <id> for status/preflight.\nNo project, journal, edit creation or publication approval; Google authentication and the Harmony list endpoint use bounded POSTs.`);
    return 0;
  }
  if (positionals.length !== 1 || !['store-versions', 'store-status', 'store-preflight'].includes(operation) || !values.config)
    throw new Error('Store reads require --config and accept no release ID');
  const inventory = operation === 'store-versions';
  const has = keys => keys.some(key => values[key] !== undefined);
  if (provider === 'app-store-connect') {
    if (has(['track', 'version-code', 'release-type', 'version-id'])) throw new Error('Incompatible Apple query selectors');
    if (inventory ? has(['version', 'build-id']) : !values.version)
      throw new Error('store-status/preflight require --version; store-versions accepts neither version nor build ID');
  } else if (provider === 'google-play') {
    if (has(['version', 'build-id', 'release-type', 'version-id']) || !values.track ||
        (inventory ? values['version-code'] !== undefined : !values['version-code']))
      throw new Error('Play requires an explicit track and status/preflight version-code, without other provider selectors');
  } else {
    if (has(['version', 'build-id', 'track', 'version-code'])) throw new Error('Incompatible Harmony query selectors');
    if (inventory ? has(['release-type', 'version-id'])
      : !['1', '6'].includes(values['release-type']) || !values['version-id'])
      throw new Error('Harmony status/preflight require release-type 1/6 and version-id; inventory accepts neither');
  }
  if (!/^[1-9]\d*$/.test(values['timeout-seconds']) || Number(values['timeout-seconds']) > 300)
    throw new Error('Observation timeout must be an integer from 1 to 300 seconds');
  signal?.throwIfAborted();
  const { config } = await loadConfig(values.config);
  if (provider !== 'app-store-connect') {
    const inspect = inspector ?? (operation === 'store-preflight' ? inspectProviderStore
      : provider === 'google-play' ? (inventory ? listPlayReleases : getPlayRelease)
        : (inventory ? listHarmonyReleases : getHarmonyRelease));
    const report = await inspect({ provider, store: config.stores?.[provider === 'google-play' ? 'android' : 'harmony'],
      track: values.track, versionCode: values['version-code'], releaseType: values['release-type'] === undefined ? undefined : Number(values['release-type']),
      versionId: values['version-id'], environment, command, signal, timeoutMs: Number(values['timeout-seconds']) * 1000 });
    signal?.throwIfAborted();
    output(JSON.stringify(report, null, 2));
    return report.observationComplete ? 0 : 2;
  }
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
