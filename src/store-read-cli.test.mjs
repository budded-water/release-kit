import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { storeReadMain } from './store-read-cli.mjs';
import { main } from './cli.mjs';

test('standalone CLI forwards explicit identity and optional expectations, prints JSON without state writes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'preflight-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = join(root, 'private.json');
  await writeFile(config, JSON.stringify({ schemaVersion: 1, stores: { ios: {
    appId: '123', bundleId: 'test.example', apiKeyPathEnv: 'EXAMPLE_KEY' } } }));
  let captured, printed;
  const inspector = async options => { captured = options; return { observationComplete: true, publicReleaseReady: false }; };
  const args = ['store-preflight', '--config', config, '--version', '1.0', '--build-id', 'build'];
  assert.equal(await storeReadMain({ args, inspector, environment: {}, output: v => printed = JSON.parse(v) }), 0);
  assert.equal(captured.appId, '123'); assert.equal(captured.candidateVersion, '1.0');
  assert.equal(captured.expectedAppleBuildId, 'build'); assert.equal(captured.timeoutMs, 120000);
  assert.equal(printed.publicReleaseReady, false);
  assert.equal(await storeReadMain({ args: ['store-versions', ...args.slice(1, 3)], output: () => {},
    inspector: async options => { assert.equal(options.candidateVersion, undefined); return { observationComplete: false }; } }), 2);
  await assert.rejects(storeReadMain({ args: [...args, '--timeout-seconds', '0'], inspector }));
  for (const extra of [['release-123'], ['--publish'], ['--state-dir', root], ['--platforms', 'android']])
    await assert.rejects(storeReadMain({ args: [...args, ...extra], inspector }));
});
test('release-kit routes standalone help before project/config loading', async () => {
  let help;
  assert.equal(await main({ args: ['store-preflight', '--help'], repo: '/absent', output: s => help = s }), 0);
  assert.match(help, /GET-only iOS/);
});
test('standalone cancellation propagates without reporting completion', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(storeReadMain({ args: ['store-preflight', '--config', '/absent'], signal: controller.signal }), { name: 'AbortError' });
});
