import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { digest } from './state.mjs';
import { inspectStore } from './stores.mjs';

// Inspection deliberately needs neither an EAS profile nor a release/artifact.
// app.json supplies declared store identities, not the effective build identity.
// Never evaluate executable Expo config just to query an explicitly configured store.
export async function inspectProviders({
  repo,
  config,
  platforms = ['ios', 'android'],
  environment = process.env,
  inspector = inspectStore,
  command,
  signal,
}) {
  const report = {
    schemaVersion: 1,
    operation: 'provider-inspect',
    observedAt: new Date().toISOString(),
    configDigest: digest(config),
    scope:
      'Provider visibility for declared store identities only; no effective build identity, publication readiness, artifact ownership or device acceptance attestation.',
    identitySource: 'static-app-json',
    results: {},
  };
  signal?.throwIfAborted();
  if (
    !platforms.length ||
    new Set(platforms).size !== platforms.length ||
    platforms.some((p) => !['ios', 'android', 'harmony'].includes(p))
  )
    throw new Error('Invalid provider inspection platforms');
  let app;
  try {
    const dynamicFiles = [];
    for (const name of [
      'app.config',
      'app.config.js',
      'app.config.ts',
      'app.config.mts',
      'app.config.cts',
      'app.config.mjs',
      'app.config.cjs',
    ]) {
      try {
        const info = await lstat(join(repo, name));
        if (!info.isFile()) throw new Error('Invalid dynamic config path');
        dynamicFiles.push(name);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    report.dynamicConfig = { files: dynamicFiles, evaluated: false };
    const file = join(repo, 'app.json');
    const info = await lstat(file);
    if (!info.isFile() || info.size > 1024 * 1024) throw new Error('Invalid static config');
    const bytes = await readFile(file);
    app = JSON.parse(bytes).expo;
    if (!app || typeof app !== 'object' || Array.isArray(app))
      throw new Error('Invalid Expo config');
    report.appConfigDigest = digest(bytes);
  } catch {
    signal?.throwIfAborted();
    for (const platform of platforms)
      report.results[platform] = {
        supported: platform !== 'harmony',
        ok: false,
        publicationReadiness: 'not-evaluated',
        checks: [
          {
            name: 'project identity',
            ok: false,
            message:
              'A readable regular static app.json is required; redirected or non-file Expo configuration paths are unsupported.',
          },
        ],
      };
    return { ...report, ok: false };
  }
  const plan = {
    version: app.version,
    appIds: { ios: app.ios?.bundleIdentifier, android: app.android?.package },
  };
  report.project = Object.fromEntries(
    platforms
      .filter(
        (platform) =>
          typeof plan.appIds[platform] === 'string' &&
          /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(plan.appIds[platform]),
      )
      .map((platform) => [platform, { appId: plan.appIds[platform] }]),
  );
  for (const platform of platforms) {
    signal?.throwIfAborted();
    if (platform === 'harmony') {
      report.results[platform] = {
        supported: false,
        ok: false,
        publicationReadiness: 'not-evaluated',
        checks: [
          {
            name: 'provider inspection',
            ok: false,
            message:
              'Harmony provider inspection is unsupported; device delivery and AGC handoff have separate checks.',
          },
        ],
      };
      continue;
    }
    try {
      report.results[platform] = await inspector({
        platform,
        config,
        plan,
        env: environment,
        signal,
        command,
      });
      signal?.throwIfAborted();
    } catch (error) {
      if (error?.cleanupIncomplete) throw error;
      signal?.throwIfAborted();
      report.results[platform] = {
        supported: true,
        ok: false,
        publicationReadiness: 'not-evaluated',
        checks: [
          {
            name: 'provider inspection',
            ok: false,
            message: 'Provider inspection could not be completed.',
          },
        ],
      };
    }
  }
  return { ...report, ok: Object.values(report.results).every((r) => r.ok === true) };
}
