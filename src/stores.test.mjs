import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, access, rm, symlink, chmod } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { doctorStore, publishStore, statusStore } from './stores.mjs';

const appleKey = generateKeyPairSync('ec', {
  namedCurve: 'prime256v1',
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
}).privateKey;
const googleKey = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
}).privateKey;
const ok = (data) => ({ ok: true, status: 200, json: async () => data });
const notFound = () => ({ ok: false, status: 404 });
const build = {
  id: 'build-42',
  type: 'builds',
  attributes: { version: '42', processingState: 'VALID' },
  relationships: { preReleaseVersion: { data: { id: 'pre-2' } } },
};
const preVersion = {
  id: 'pre-2',
  type: 'preReleaseVersions',
  attributes: { version: '2.0.0', platform: 'IOS' },
};
const appVersion = (state) => ({
  id: 'version-2',
  type: 'appStoreVersions',
  attributes: { versionString: '2.0.0', appStoreState: state },
  relationships: { build: { data: { id: 'build-42' } } },
});

async function fixture(t, platform) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'store-adapter-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'metadata'));
  await mkdir(path.join(root, 'metadata', 'zh-Hans'));
  await writeFile(path.join(root, 'metadata', 'zh-Hans', 'release_notes.txt'), 'Reviewed notes');
  await writeFile(
    path.join(root, 'submission.json'),
    '{"export_compliance_uses_encryption":false}',
  );
  await writeFile(
    path.join(root, 'key.json'),
    JSON.stringify(
      platform === 'ios'
        ? { key_id: 'test', issuer_id: 'issuer', key: appleKey }
        : { client_email: 'test@example.invalid', private_key: googleKey },
    ),
  );
  const content = 'inspected binary fixture';
  const artifact = {
    path: path.join(root, platform === 'ios' ? 'app.ipa' : 'app.aab'),
    sha256: createHash('sha256').update(content).digest('hex'),
    platform,
    appId: 'com.example.app',
    version: '2.0.0',
    buildNumber: '42',
  };
  await writeFile(artifact.path, content);
  const calls = [],
    commands = [],
    journal = [];
  const ctx = {
    root,
    releaseDir: root,
    platform,
    plan: { version: '2.0.0', appIds: { ios: 'com.example.app', android: 'com.example.app' } },
    config: {
      stores: {
        ios: {
          appId: '123',
          bundleId: 'com.example.app',
          apiKeyPathEnv: 'STORE_KEY',
          metadataPath: 'metadata',
          submissionInformationPath: 'submission.json',
        },
        android: {
          packageName: 'com.example.app',
          serviceAccountPathEnv: 'STORE_KEY',
          managedPublishingDisabled: true,
        },
      },
    },
    env: { STORE_KEY: path.join(root, 'key.json') },
    artifact,
    previous: {},
    checkpoint: async (name, data) => {
      journal.push({ name, data });
      ctx.previous[name] = data;
    },
    command: async (bin, args, opts) => {
      commands.push({ bin, args, opts });
      return { code: 0 };
    },
  };
  ctx.fetch = async (url, opts) => {
    calls.push({ url, opts });
    if (url === 'https://oauth2.googleapis.com/token') return ok({ access_token: 'fake-token' });
    throw new Error(`Unexpected fake provider call: ${opts.method ?? 'GET'} ${url}`);
  };
  function checkpoint(name, value = {}) {
    ctx.previous[name] = {
      identity: {
        appId: artifact.appId,
        version: artifact.version,
        buildNumber: artifact.buildNumber,
        sha256: artifact.sha256,
      },
      ...value,
    };
  }
  return { ctx, calls, commands, journal, checkpoint };
}

function appleProvider(
  f,
  {
    hasBuild = true,
    versions = [],
    afterUpload,
    remoteBuild = build,
    includedBuilds = [remoteBuild],
  } = {},
) {
  f.ctx.fetch = async (url, opts) => {
    f.calls.push({ url, opts });
    const audit = appleAuditResponse(url);
    if (audit) return audit;
    if (url.endsWith('/v1/apps/123'))
      return ok({ data: { attributes: { bundleId: 'com.example.app' } } });
    if (url.includes('/appStoreVersions?')) return ok({ data: versions, included: includedBuilds });
    if (url.includes('/v1/builds?'))
      return ok({ data: hasBuild || afterUpload?.() ? [remoteBuild] : [], included: [preVersion] });
    if (url.includes('/buildUploads?')) return ok({ data: [] });
    throw new Error('Unexpected Apple fake request');
  };
}

function appleAuditResponse(url) {
  if (url.includes('/appStoreVersions?') && !url.includes('include=build'))
    return ok({ data: [appVersion('PREPARE_FOR_SUBMISSION')] });
  if (url.includes('/appStoreVersionLocalizations?'))
    return ok({
      data: [
        {
          id: 'zh',
          attributes: {
            locale: 'zh-Hans',
            description: 'Saved copy',
            keywords: 'app',
            supportUrl: 'https://example.invalid',
          },
        },
      ],
    });
  if (url.includes('/appScreenshotSets?'))
    return ok({ data: [{ id: 'set', attributes: { screenshotDisplayType: 'APP_IPHONE_67' } }] });
  if (url.includes('/appScreenshots?'))
    return ok({
      data: [{ id: 'image', attributes: { assetDeliveryState: { state: 'COMPLETE' } } }],
    });
  if (url.endsWith('/appStoreReviewDetail'))
    return ok({
      data: {
        attributes: {
          contactFirstName: 'PRIVATE',
          contactLastName: 'PRIVATE',
          contactPhone: 'PRIVATE',
          contactEmail: 'PRIVATE',
          demoAccountRequired: false,
        },
      },
    });
}

function playProvider(f, handler) {
  f.ctx.fetch = async (url, opts) => {
    f.calls.push({ url, opts });
    if (url === 'https://oauth2.googleapis.com/token') return ok({ access_token: 'fake-token' });
    return handler(url, opts);
  };
}

const reviewConflict = () => ({
  ok: false,
  status: 400,
  json: async () => ({
    error: {
      code: 400,
      status: 'FAILED_PRECONDITION',
      message: 'private provider message must not be journaled',
      details: [
        {
          '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
          domain: 'googleapis.com',
          reason: 'CHANGES_ALREADY_IN_REVIEW',
          metadata: { privateAccount: 'private provider metadata must not be journaled' },
        },
      ],
    },
  }),
});

function uploadedPlayProvider(f, commitResponse, overrides = {}) {
  playProvider(f, (url, opts) => {
    if (url.endsWith('/tracks/production/releases'))
      return ok({ releases: overrides.releases ?? [] });
    if (url.endsWith('/edits/edit-1')) return overrides.edit ?? ok({ id: 'edit-1' });
    if (url.endsWith('/bundles'))
      return ok({
        bundles: Object.hasOwn(overrides, 'bundles')
          ? overrides.bundles
          : [{ versionCode: 42, sha256: overrides.sha256 ?? f.ctx.artifact.sha256 }],
      });
    if (url.endsWith('/tracks/production') && !opts.method)
      return ok(
        overrides.track ?? {
          track: 'production',
          releases: [{ status: 'completed', versionCodes: ['42'] }],
        },
      );
    if (url.includes(':commit?')) return commitResponse(url, opts);
    assert.fail(`Unexpected mutation while reconciling uploaded bundle: ${opts.method}: ${url}`);
  });
}

const release = (state) => ({
  track: 'production',
  activeArtifacts: [{ versionCode: 42 }],
  releaseLifecycleState: `RELEASE_LIFECYCLE_STATE_${state}`,
});

test('publication doctor audits iOS read-only while Play doctor retains local-only checks', async (t) => {
  for (const platform of ['ios', 'android']) {
    const f = await fixture(t, platform);
    if (platform === 'ios') appleProvider(f);
    const out = await doctorStore(f.ctx);
    assert.ok(out.checks.every((c) => c.ok));
    if (platform === 'android') assert.equal(f.calls.length, 0);
    else {
      assert.ok(f.calls.length > 0);
      assert.ok(f.calls.every((c) => !c.opts.method));
      assert.deepEqual(out.checks.at(-1).listing.locales, [
        { locale: 'zh-Hans', completeIphoneScreenshots: 1 },
      ]);
      assert.ok(f.commands.every((c) => c.args.join(' ') === 'deliver --help'));
      assert.equal(f.journal.length, 0);
    }
  }
});

test('Play doctor reports publishing policy and credential failures independently', async (t) => {
  for (const policyConfirmed of [false, true]) {
    for (const credentialPresent of [false, true]) {
      const f = await fixture(t, 'android');
      f.ctx.config.stores.android.managedPublishingDisabled = policyConfirmed;
      if (!credentialPresent) delete f.ctx.env.STORE_KEY;
      const out = await doctorStore(f.ctx);
      assert.deepEqual(
        out.checks.map(({ name, ok }) => ({ name, ok })),
        [
          { name: 'android managed publishing', ok: policyConfirmed },
          { name: 'android store credentials', ok: credentialPresent },
        ],
      );
      assert.match(
        out.checks[0].message,
        policyConfirmed
          ? /Play Console setting has not been verified/
          : /Confirm managed publishing/,
      );
      assert.match(
        out.checks[1].message,
        credentialPresent
          ? /contents and remote permissions have not been tested/
          : /absolute file path/,
      );
      assert.equal(f.calls.length, 0);
      assert.equal(f.commands.length, 0);
      assert.equal(f.journal.length, 0);
    }
  }
});

test('Play doctor rejects missing files, relative paths and directories without exposing the path', async (t) => {
  for (const value of ['missing-file', 'relative-path', 'directory']) {
    const f = await fixture(t, 'android');
    f.ctx.env.STORE_KEY =
      value === 'relative-path' ? 'PRIVATE-key.json' : path.join(f.ctx.root, `PRIVATE-${value}`);
    if (value === 'directory') await mkdir(f.ctx.env.STORE_KEY);
    const out = await doctorStore(f.ctx);
    assert.equal(out.checks[0].ok, true, value);
    assert.equal(out.checks[1].name, 'android store credentials', value);
    assert.equal(out.checks[1].ok, false, value);
    assert.equal(JSON.stringify(out).includes('PRIVATE'), false, value);
    assert.equal(f.calls.length, 0, value);
    assert.equal(f.commands.length, 0, value);
    assert.equal(f.journal.length, 0, value);
  }
});

test('Play doctor rejects an unreadable credential file', async (t) => {
  if (process.getuid?.() === 0 || process.platform === 'win32') {
    t.skip('File mode bits do not restrict reads for root or on Windows.');
    return;
  }
  const f = await fixture(t, 'android');
  await chmod(f.ctx.env.STORE_KEY, 0o000);
  try {
    const out = await doctorStore(f.ctx);
    assert.equal(out.checks[0].ok, true);
    assert.equal(out.checks[1].ok, false);
    assert.match(out.checks[1].message, /unavailable or unreadable/);
    assert.equal(f.calls.length, 0);
    assert.equal(f.commands.length, 0);
    assert.equal(f.journal.length, 0);
  } finally {
    await chmod(f.ctx.env.STORE_KEY, 0o600);
  }
});

test('Play doctor refuses mismatched app identity before reporting dependent checks', async (t) => {
  const f = await fixture(t, 'android');
  f.ctx.config.stores.android.packageName = 'com.example.other';
  f.ctx.config.stores.android.managedPublishingDisabled = false;
  delete f.ctx.env.STORE_KEY;
  const out = await doctorStore(f.ctx);
  assert.deepEqual(out.checks, [
    {
      name: 'android store preflight',
      ok: false,
      message: 'Store app identity does not match the release plan.',
    },
  ]);
  assert.equal(f.calls.length, 0);
  assert.equal(f.commands.length, 0);
  assert.equal(f.journal.length, 0);
});

test('Play publish and status remain blocked until managed publishing is explicitly confirmed disabled', async (t) => {
  for (const policy of [false, undefined, 'true']) {
    const f = await fixture(t, 'android');
    f.ctx.config.stores.android.managedPublishingDisabled = policy;
    await assert.rejects(publishStore(f.ctx), /Confirm managed publishing is disabled/);
    const observed = await statusStore(f.ctx);
    assert.equal(observed.state, 'unavailable');
    assert.equal(observed.availabilityVerified, false);
    assert.match(observed.message, /Confirm managed publishing is disabled/);
    assert.equal(f.calls.length, 0);
    assert.equal(f.commands.length, 0);
    assert.equal(f.journal.length, 0);
  }
});

test('wrong app, marketing version and modified artifact fail before any provider request', async (t) => {
  for (const changed of [{ appId: 'other' }, { version: '9.0' }, { platform: 'ios' }]) {
    const f = await fixture(t, 'android');
    Object.assign(f.ctx.artifact, changed);
    await assert.rejects(publishStore(f.ctx), /identity/);
    assert.equal(f.calls.length, 0);
  }
  const f = await fixture(t, 'ios');
  await writeFile(f.ctx.artifact.path, 'replacement');
  await assert.rejects(publishStore(f.ctx), /changed after inspection/);
  assert.equal(f.calls.length, 0);
});

test('iOS upload and review are independently journaled and use exact artifact/build', async (t) => {
  const f = await fixture(t, 'ios');
  appleProvider(f, { hasBuild: false, afterUpload: () => f.commands.length > 0 });
  const out = await publishStore(f.ctx);
  assert.equal(out.state, 'submitted');
  assert.equal(f.commands.length, 2);
  assert.ok(f.commands[0].args.includes(f.ctx.artifact.path));
  assert.equal(f.commands[1].args[f.commands[1].args.indexOf('--build_number') + 1], '42');
  assert.equal(f.commands[1].args[f.commands[1].args.indexOf('--app_version') + 1], '2.0.0');
  assert.equal(f.commands[1].args[f.commands[1].args.indexOf('--automatic_release') + 1], 'true');
  assert.ok(f.commands.every((c) => c.opts.sensitive));
  assert.deepEqual(
    f.journal.map((j) => [j.name, j.data.state]),
    [
      ['ios-upload', 'intent'],
      ['ios-upload', 'uploaded'],
      ['ios-upload', 'uploaded'],
      ['ios-review', 'intent'],
      ['ios-review', 'submitted'],
    ],
  );
  assert.equal(JSON.stringify(f.journal).includes(appleKey), false);
});

test('iOS unknown upload with no remote build never sends a second upload', async (t) => {
  const f = await fixture(t, 'ios');
  appleProvider(f, { hasBuild: false });
  f.ctx.command = async () => {
    throw new Error('timeout with secret response');
  };
  assert.equal((await publishStore(f.ctx)).state, 'unknown');
  f.ctx.command = async () => assert.fail('must not retry upload');
  assert.equal((await publishStore(f.ctx)).state, 'unknown');
  assert.equal(f.journal.length, 2);
});

test('iOS reconciles upload timeout into the exact remote build then submits review once', async (t) => {
  const f = await fixture(t, 'ios');
  f.checkpoint('ios-upload', { state: 'unknown' });
  appleProvider(f);
  assert.equal((await publishStore(f.ctx)).state, 'submitted');
  assert.equal(f.commands.length, 1);
  assert.equal(f.commands[0].args[0], 'deliver');
  const out = await publishStore(f.ctx);
  assert.equal(out.state, 'unknown');
  assert.equal(f.commands.length, 1);
});

test('iOS missing journal, newer remote version, wrong bundle and wrong build cannot overwrite store', async (t) => {
  const unowned = await fixture(t, 'ios');
  appleProvider(unowned);
  await assert.rejects(publishStore(unowned.ctx), /without a matching upload journal/);
  const newer = await fixture(t, 'ios');
  appleProvider(newer, { versions: [{ attributes: { versionString: '2.1' } }] });
  await assert.rejects(publishStore(newer.ctx), /newer App Store version/);
  const wrong = await fixture(t, 'ios');
  wrong.ctx.fetch = async () => ok({ data: { attributes: { bundleId: 'different' } } });
  await assert.rejects(publishStore(wrong.ctx), /different bundle/);
  const selected = await fixture(t, 'ios');
  const version = appVersion('IN_REVIEW');
  version.relationships.build.data.id = 'other';
  appleProvider(selected, { versions: [version] });
  await assert.rejects(publishStore(selected.ctx), /could not be inspected/);
  assert.equal(
    unowned.commands.length +
      newer.commands.length +
      wrong.commands.length +
      selected.commands.length,
    0,
  );
});

test('iOS rejected review is observed without resubmission; released does not claim territory availability', async (t) => {
  const f = await fixture(t, 'ios');
  f.checkpoint('ios-upload', { state: 'uploaded' });
  appleProvider(f, { versions: [appVersion('REJECTED')] });
  assert.equal((await publishStore(f.ctx)).state, 'rejected');
  appleProvider(f, { versions: [appVersion('READY_FOR_SALE')] });
  const status = await statusStore(f.ctx);
  assert.equal(status.state, 'released');
  assert.equal(status.availabilityVerified, false);
  assert.equal(f.commands.length, 0);
  assert.ok(f.calls.every((c) => !c.opts.method || c.opts.method === 'GET'));
});

test('Play full path checks returned SHA, explicitly selects production completed and commits without cancelling existing review', async (t) => {
  const f = await fixture(t, 'android');
  playProvider(f, async (url, opts) => {
    if (url.endsWith('/tracks/production/releases')) return ok({ releases: [] });
    if (url.endsWith('/edits')) return ok({ id: 'edit-1' });
    if (url.endsWith('/edits/edit-1')) return ok({ id: 'edit-1' });
    if (url.endsWith('/bundles')) return ok({ bundles: [] });
    if (url.includes('uploadType=media')) {
      for await (const _ of opts.body) {
        /* consume fake upload */
      }
      return ok({ versionCode: 42, sha256: f.ctx.artifact.sha256 });
    }
    if (url.endsWith('/tracks/production'))
      return ok(
        opts.method === 'PUT' ? JSON.parse(opts.body) : { track: 'production', releases: [] },
      );
    if (url.includes(':commit?')) return ok({ id: 'edit-1' });
    assert.fail(url);
  });
  assert.equal((await publishStore(f.ctx)).state, 'submitted');
  const put = f.calls.find((c) => c.opts.method === 'PUT');
  assert.deepEqual(JSON.parse(put.opts.body), {
    track: 'production',
    releases: [{ name: '2.0.0', versionCodes: ['42'], status: 'completed' }],
  });
  assert.match(
    f.calls.find((c) => c.url.includes(':commit?')).url,
    /changesInReviewBehavior=ERROR_IF_IN_REVIEW/,
  );
  assert.deepEqual(
    f.journal.map((j) => [j.name, j.data.state]),
    [
      ['android-edit', 'intent'],
      ['android-edit', 'created'],
      ['android-upload', 'intent'],
      ['android-upload', 'uploaded'],
      ['android-track', 'intent'],
      ['android-track', 'selected'],
      ['android-commit', 'intent'],
      ['android-commit', 'submitted'],
    ],
  );
});

test('Play read-only status can distinguish review, rejection, held publication and production availability', async (t) => {
  const f = await fixture(t, 'android');
  f.checkpoint('android-upload', { state: 'uploaded' });
  for (const [provider, expected] of [
    ['IN_REVIEW', 'in-review'],
    ['NOT_APPROVED', 'rejected'],
    ['APPROVED_NOT_PUBLISHED', 'pending-release'],
    ['PUBLISHED', 'available'],
  ]) {
    playProvider(f, () => ok({ releases: [release(provider)] }));
    assert.equal((await statusStore(f.ctx)).state, expected);
  }
  assert.ok(f.calls.every((c) => c.url.endsWith('/token') || c.opts.method === undefined));
  assert.equal(f.journal.length, 0);
});

test('Play refuses to adopt a foreign same-version release without artifact ownership', async (t) => {
  const f = await fixture(t, 'android');
  playProvider(f, () => ok({ releases: [release('PUBLISHED')] }));
  await assert.rejects(publishStore(f.ctx), /ownership/);
  assert.equal((await statusStore(f.ctx)).state, 'unavailable');
  assert.equal(f.journal.length, 0);
});

test('iOS availability requires exact released build and observed available territory', async (t) => {
  const f = await fixture(t, 'ios');
  f.checkpoint('ios-upload', { state: 'uploaded' });
  appleProvider(f, { versions: [appVersion('READY_FOR_SALE')] });
  const base = f.ctx.fetch;
  f.ctx.fetch = async (url, opts) => {
    if (url.endsWith('/appAvailabilityV2')) return ok({ data: { id: 'availability' } });
    if (url.includes('/territoryAvailabilities?'))
      return ok({
        data: [
          {
            attributes: { available: true, contentStatuses: ['AVAILABLE'] },
            relationships: { territory: { data: { id: 'GIN' } } },
          },
          {
            attributes: { available: true, contentStatuses: ['PROCESSING_TO_AVAILABLE'] },
            relationships: { territory: { data: { id: 'CHN' } } },
          },
        ],
      });
    return base(url, opts);
  };
  const out = await statusStore(f.ctx);
  assert.equal(out.state, 'available');
  assert.deepEqual(out.availableTerritories, ['GIN']);
  assert.equal(out.availabilityVerified, true);
  assert.equal(f.journal.length, 0);
});

test('iOS unrecognized version state does not attempt review', async (t) => {
  const f = await fixture(t, 'ios');
  f.checkpoint('ios-upload', { state: 'uploaded' });
  appleProvider(f, { versions: [appVersion('FUTURE_UNKNOWN_STATE')] });
  assert.equal((await publishStore(f.ctx)).state, 'unknown');
  assert.equal(f.commands.length, 0);
});

test('iOS current appVersionState processing takes precedence over the legacy released field', async (t) => {
  const f = await fixture(t, 'ios');
  f.checkpoint('ios-upload', { state: 'uploaded' });
  const version = appVersion('READY_FOR_SALE');
  version.attributes.appVersionState = 'PROCESSING_FOR_DISTRIBUTION';
  appleProvider(f, { versions: [version] });
  for (const observe of [statusStore, publishStore]) {
    const output = await observe(f.ctx);
    assert.equal(output.state, 'processing');
    assert.equal(output.providerState, 'PROCESSING_FOR_DISTRIBUTION');
    assert.notEqual(output.availabilityVerified, true);
  }
  assert.equal(f.commands.length, 0);
  assert.equal(f.journal.length, 0);
  assert.ok(f.calls.every(({ opts }) => !opts.method || opts.method === 'GET'));
});

test('Play API unavailable never falls back to mutating edits in status', async (t) => {
  const f = await fixture(t, 'android');
  playProvider(f, () => notFound());
  assert.equal((await statusStore(f.ctx)).state, 'unavailable');
  assert.equal(f.calls.filter((c) => c.url.includes('/edits')).length, 0);
});

test('Play newer production version stops stale resume before creating any edit', async (t) => {
  const f = await fixture(t, 'android');
  const newer = release('IN_REVIEW');
  newer.activeArtifacts[0].versionCode = 43;
  playProvider(f, () => ok({ releases: [newer] }));
  await assert.rejects(publishStore(f.ctx), /supersedes/);
  assert.equal(f.journal.length, 0);
});

test('Play unknown commit reconciles when visible and never commits a second time', async (t) => {
  const f = await fixture(t, 'android');
  f.checkpoint('android-commit', { state: 'intent', editId: 'old-edit' });
  playProvider(f, () => ok({ releases: [] }));
  assert.equal((await publishStore(f.ctx)).state, 'unknown');
  playProvider(f, () => ok({ releases: [release('IN_REVIEW')] }));
  assert.equal((await publishStore(f.ctx)).state, 'in-review');
  assert.ok(f.calls.every((c) => c.url.endsWith('/token') || !c.opts.method));
  assert.equal(f.journal.length, 0);
});

test('Play upload reconciliation rejects different bytes and does not duplicate absent unknown upload', async (t) => {
  for (const wrongBytes of [true, false]) {
    const f = await fixture(t, 'android');
    f.checkpoint('android-edit', { id: 'edit-1' });
    f.checkpoint('android-upload', { state: 'intent', editId: 'edit-1' });
    playProvider(f, (url) => {
      if (url.endsWith('/tracks/production/releases')) return ok({ releases: [] });
      if (url.endsWith('/edits/edit-1')) return ok({ id: 'edit-1' });
      if (url.endsWith('/bundles'))
        return ok({ bundles: wrongBytes ? [{ versionCode: 42, sha256: 'f'.repeat(64) }] : [] });
      assert.fail('must not make a write call');
    });
    if (wrongBytes) await assert.rejects(publishStore(f.ctx), /different artifact bytes/);
    else assert.equal((await publishStore(f.ctx)).state, 'unknown');
    assert.equal(f.journal.length, 0);
  }
});

test('Play expired edit remains unresolved without creating replacement or uploading', async (t) => {
  const f = await fixture(t, 'android');
  f.checkpoint('android-edit', { id: 'expired' });
  playProvider(f, (url) =>
    url.endsWith('/tracks/production/releases') ? ok({ releases: [] }) : notFound(),
  );
  assert.equal((await publishStore(f.ctx)).state, 'unknown');
  assert.equal(f.journal.length, 0);
});

test('durable intent failure prevents the corresponding upload', async (t) => {
  const f = await fixture(t, 'ios');
  appleProvider(f, { hasBuild: false });
  f.ctx.checkpoint = async () => {
    throw new Error('disk full');
  };
  await assert.rejects(publishStore(f.ctx), /disk full/);
  assert.equal(f.commands.length, 0);
});

test('Play resumes a confirmed unknown track update without repeating upload or track write', async (t) => {
  const f = await fixture(t, 'android');
  f.checkpoint('android-edit', { id: 'edit-1' });
  f.checkpoint('android-upload', { state: 'uploaded', editId: 'edit-1' });
  f.checkpoint('android-track', { state: 'intent', editId: 'edit-1' });
  playProvider(f, (url, opts) => {
    if (url.endsWith('/tracks/production/releases')) return ok({ releases: [] });
    if (url.endsWith('/edits/edit-1')) return ok({ id: 'edit-1' });
    if (url.endsWith('/bundles'))
      return ok({ bundles: [{ versionCode: 42, sha256: f.ctx.artifact.sha256 }] });
    if (url.endsWith('/tracks/production') && !opts.method)
      return ok({ track: 'production', releases: [{ status: 'completed', versionCodes: ['42'] }] });
    if (url.includes(':commit?')) return ok({ id: 'edit-1' });
    assert.fail('must not upload or update the track twice');
  });
  assert.equal((await publishStore(f.ctx)).state, 'submitted');
  assert.deepEqual(
    f.journal.map((j) => j.name),
    ['android-commit', 'android-commit'],
  );
});

test('Play commit timeout persists intent and next invocation never repeats the commit', async (t) => {
  const f = await fixture(t, 'android');
  f.checkpoint('android-edit', { id: 'edit-1' });
  f.checkpoint('android-upload', { state: 'uploaded', editId: 'edit-1' });
  let commits = 0;
  playProvider(f, (url) => {
    if (url.endsWith('/tracks/production/releases')) return ok({ releases: [] });
    if (url.endsWith('/edits/edit-1')) return ok({ id: 'edit-1' });
    if (url.endsWith('/bundles'))
      return ok({ bundles: [{ versionCode: 42, sha256: f.ctx.artifact.sha256 }] });
    if (url.endsWith('/tracks/production'))
      return ok({ track: 'production', releases: [{ status: 'completed', versionCodes: ['42'] }] });
    if (url.includes(':commit?')) {
      commits++;
      throw new Error('connection dropped after commit');
    }
    assert.fail(url);
  });
  assert.equal((await publishStore(f.ctx)).state, 'unknown');
  assert.equal((await publishStore(f.ctx)).state, 'unknown');
  assert.equal(commits, 1);
  assert.equal(f.ctx.previous['android-commit'].state, 'intent');
});

test('Play confirmed review conflict resumes the same edit after rechecking its artifact and track', async (t) => {
  const f = await fixture(t, 'android');
  f.checkpoint('android-edit', { id: 'edit-1' });
  f.checkpoint('android-upload', { state: 'uploaded', editId: 'edit-1' });
  let commits = 0;
  let sourceChecks = 0;
  f.ctx.assertPublicationSource = async () => sourceChecks++;
  uploadedPlayProvider(f, () => (++commits < 3 ? reviewConflict() : ok({ id: 'edit-1' })));
  for (let attempt = 0; attempt < 2; attempt++) {
    const output = await publishStore(f.ctx);
    assert.equal(output.state, 'blocked');
    assert.equal(output.retryable, true);
    assert.equal(output.editId, 'edit-1');
    assert.equal(commits, attempt + 1, 'one commit request per explicit resume, no retry loop');
    assert.equal(f.ctx.previous['android-commit'].state, 'not-committed');
    assert.deepEqual(output.providerError, {
      httpStatus: 400,
      code: 400,
      status: 'FAILED_PRECONDITION',
      reason: 'CHANGES_ALREADY_IN_REVIEW',
    });
  }
  const journalLength = f.journal.length;
  const observed = await statusStore(f.ctx);
  assert.equal(observed.state, 'blocked');
  assert.equal(observed.retryable, true);
  assert.equal(f.journal.length, journalLength, 'status stays read-only');
  assert.equal(commits, 2);

  const output = await publishStore(f.ctx);
  assert.equal(output.state, 'submitted');
  assert.equal(f.ctx.previous['android-commit'].state, 'submitted');
  assert.equal(sourceChecks, 3, 'every fresh commit intent revalidates production source');
  assert.equal(f.calls.filter(({ url }) => url.endsWith('/edits/edit-1')).length, 3);
  assert.equal(f.calls.filter(({ url }) => url.endsWith('/bundles')).length, 3);
  assert.equal(f.calls.filter(({ url }) => url.endsWith('/tracks/production')).length, 3);
  const mutations = f.calls.filter(({ url, opts }) => opts.method && !url.endsWith('/token'));
  assert.equal(mutations.length, 3);
  assert.ok(mutations.every(({ url }) => url.includes('/edits/edit-1:commit?')));
  assert.equal(JSON.stringify([f.journal, observed]).includes('private provider'), false);
});

test('Play retryable commit is blocked by changed source before recording another intent', async (t) => {
  const f = await fixture(t, 'android');
  f.checkpoint('android-edit', { id: 'edit-1' });
  f.checkpoint('android-upload', { state: 'uploaded', editId: 'edit-1' });
  let commits = 0;
  uploadedPlayProvider(f, () => {
    commits++;
    return reviewConflict();
  });
  await publishStore(f.ctx);
  f.ctx.assertPublicationSource = async () => {
    throw new Error('remote default branch advanced');
  };
  await assert.rejects(publishStore(f.ctx), /default branch advanced/);
  assert.equal(commits, 1);
  assert.equal(f.ctx.previous['android-commit'].state, 'not-committed');
  assert.equal(f.journal.length, 2);
});

test('Play review-conflict retry refuses expired edits, changed bytes and superseding releases', async (t) => {
  for (const variant of ['expired', 'invalidated', 'wrong-edit', 'wrong-bytes', 'newer-release']) {
    const f = await fixture(t, 'android');
    f.checkpoint('android-edit', { id: 'edit-1' });
    f.checkpoint('android-upload', { state: 'uploaded', editId: 'edit-1' });
    uploadedPlayProvider(f, reviewConflict);
    await publishStore(f.ctx);
    const newer = release('IN_REVIEW');
    newer.activeArtifacts[0].versionCode = 43;
    const overrides = {
      expired: { edit: notFound() },
      invalidated: { edit: { ok: false, status: 410 } },
      'wrong-edit': { edit: ok({ id: 'foreign-edit' }) },
      'wrong-bytes': { sha256: 'f'.repeat(64) },
      'newer-release': { releases: [newer] },
    };
    const start = f.calls.length;
    uploadedPlayProvider(f, () => assert.fail('must not retry commit'), overrides[variant]);
    if (['expired', 'invalidated'].includes(variant)) {
      for (let attempt = 0; attempt < 2; attempt++) {
        const outcome = await publishStore(f.ctx);
        assert.equal(outcome.state, 'blocked');
        assert.equal(outcome.retryable, false);
        assert.match(outcome.message, /expired or was invalidated/);
      }
      assert.equal(f.ctx.previous['android-commit'].state, 'failed');
      assert.equal((await statusStore(f.ctx)).retryable, false);
    } else {
      await assert.rejects(
        publishStore(f.ctx),
        /different edit|different artifact bytes|supersedes/,
      );
    }
    assert.ok(
      f.calls.slice(start).every(({ url, opts }) => url.endsWith('/token') || !opts.method),
      variant,
    );
  }
});

test('Play review-conflict retry refuses a different, newer or changed production selection', async (t) => {
  const cases = [
    { track: 'internal', status: 'completed', versionCode: '42', error: /wrong destination track/ },
    { track: 'production', status: 'completed', versionCode: '43', error: /supersedes/ },
    { track: 'production', status: 'draft', versionCode: '42' },
    { track: 'production', status: 'completed', versionCode: '41' },
  ];
  for (const scenario of cases.flatMap((value) =>
    [true, false].map((hasTrackCheckpoint) => ({ ...value, hasTrackCheckpoint })),
  )) {
    const f = await fixture(t, 'android');
    f.checkpoint('android-edit', { id: 'edit-1' });
    f.checkpoint('android-upload', { state: 'uploaded', editId: 'edit-1' });
    if (scenario.hasTrackCheckpoint)
      f.checkpoint('android-track', { state: 'selected', editId: 'edit-1' });
    let commits = 0;
    uploadedPlayProvider(f, () => {
      commits++;
      return reviewConflict();
    });
    assert.equal((await publishStore(f.ctx)).retryable, true);
    const journalLength = f.journal.length;
    const start = f.calls.length;
    uploadedPlayProvider(f, () => assert.fail('must not commit the changed track'), {
      track: {
        track: scenario.track,
        releases: [{ status: scenario.status, versionCodes: [scenario.versionCode] }],
      },
    });
    if (scenario.error) await assert.rejects(publishStore(f.ctx), scenario.error);
    else {
      const output = await publishStore(f.ctx);
      assert.equal(output.state, 'unknown');
      assert.match(output.message, /track update could not be reconciled/);
    }
    assert.equal(commits, 1);
    assert.equal(f.journal.length, journalLength, 'no new operation intent was persisted');
    assert.equal(f.ctx.previous['android-commit'].state, 'not-committed');
    const retryCalls = f.calls.slice(start);
    assert.ok(retryCalls.some(({ url }) => url.endsWith('/tracks/production')));
    assert.ok(
      retryCalls.every(({ url, opts }) => url.endsWith('/token') || !opts.method),
      'retry must not PUT, upload, create a new edit or commit',
    );
  }
});

test('Play generic, malformed and server errors never authorize another commit', async (t) => {
  for (const variant of [
    'server',
    'other-reason',
    'missing-body',
    'invalid-json',
    'wrong-domain',
  ]) {
    const f = await fixture(t, 'android');
    f.checkpoint('android-edit', { id: 'edit-1' });
    f.checkpoint('android-upload', { state: 'uploaded', editId: 'edit-1' });
    let commits = 0;
    uploadedPlayProvider(f, async () => {
      commits++;
      const response = reviewConflict();
      if (variant === 'missing-body') return { ok: false, status: 400 };
      if (variant === 'invalid-json')
        return {
          ...response,
          json: async () => {
            throw new Error('bad body');
          },
        };
      const body = await response.json();
      if (variant === 'server') response.status = 500;
      if (variant === 'other-reason') body.error.details[0].reason = 'OTHER_PRECONDITION';
      if (variant === 'wrong-domain') body.error.details[0].domain = 'unrecognized.invalid';
      return { ...response, json: async () => body };
    });
    assert.equal((await publishStore(f.ctx)).state, 'unknown', variant);
    assert.equal((await publishStore(f.ctx)).state, 'unknown', variant);
    assert.equal(commits, 1, variant);
    assert.equal(f.ctx.previous['android-commit'].state, 'intent', variant);
    assert.equal(JSON.stringify(f.journal).includes('private provider'), false);
  }
});

test('Play interrupted persistence of a known failure retains ambiguous intent and forbids retry', async (t) => {
  const f = await fixture(t, 'android');
  f.checkpoint('android-edit', { id: 'edit-1' });
  f.checkpoint('android-upload', { state: 'uploaded', editId: 'edit-1' });
  const checkpoint = f.ctx.checkpoint;
  f.ctx.checkpoint = async (name, data) => {
    if (data.state === 'not-committed') throw new Error('disk unavailable');
    await checkpoint(name, data);
  };
  let commits = 0;
  uploadedPlayProvider(f, () => {
    commits++;
    return reviewConflict();
  });
  await assert.rejects(publishStore(f.ctx), /disk unavailable/);
  assert.equal((await publishStore(f.ctx)).state, 'unknown');
  assert.equal(commits, 1);
  assert.equal(f.ctx.previous['android-commit'].state, 'intent');
});

test('journal reuse with another artifact hash is rejected before another mutation', async (t) => {
  const f = await fixture(t, 'ios');
  f.checkpoint('ios-upload', { state: 'unknown' });
  f.ctx.previous['ios-upload'].identity.sha256 = 'f'.repeat(64);
  appleProvider(f);
  await assert.rejects(publishStore(f.ctx), /different artifact/);
  assert.equal(f.commands.length, 0);
});

test('metadata and submission links are rejected before credentials or store requests', async (t) => {
  for (const variant of [
    'metadata-root',
    'metadata-component',
    'metadata-file',
    'metadata-directory',
    'submission',
  ]) {
    const f = await fixture(t, 'ios');
    const outside = await mkdtemp(path.join(os.tmpdir(), 'untracked-store-metadata-'));
    t.after(() => rm(outside, { recursive: true, force: true }));
    await writeFile(path.join(outside, 'secret.txt'), 'not tracked source');
    if (variant === 'metadata-root') {
      await rm(path.join(f.ctx.root, 'metadata'), { recursive: true });
      await symlink(outside, path.join(f.ctx.root, 'metadata'));
    } else if (variant === 'metadata-component') {
      await mkdir(path.join(outside, 'locale'));
      await symlink(outside, path.join(f.ctx.root, 'linked-parent'));
      f.ctx.config.stores.ios.metadataPath = 'linked-parent/locale';
    } else if (variant === 'submission') {
      await rm(path.join(f.ctx.root, 'submission.json'));
      await symlink(path.join(outside, 'secret.txt'), path.join(f.ctx.root, 'submission.json'));
    } else {
      await mkdir(path.join(f.ctx.root, 'metadata', 'en-US'));
      await symlink(
        variant === 'metadata-directory' ? outside : path.join(outside, 'secret.txt'),
        path.join(f.ctx.root, 'metadata', 'en-US', 'linked'),
      );
    }
    const report = await doctorStore(f.ctx);
    assert.ok(
      report.checks.some((check) => !check.ok && /symbolic links/.test(check.message)),
      variant,
    );
    await assert.rejects(publishStore(f.ctx), /symbolic links/, variant);
    assert.equal(f.calls.length, 0, variant);
    assert.equal(f.commands.length, 0, variant);
    assert.equal(f.journal.length, 0, variant);
  }
});

test('a metadata symlink introduced during upload cannot reach review submission', async (t) => {
  const f = await fixture(t, 'ios');
  appleProvider(f, { hasBuild: false, afterUpload: () => f.commands.length > 0 });
  const command = f.ctx.command;
  f.ctx.command = async (...args) => {
    const response = await command(...args);
    await symlink(f.ctx.env.STORE_KEY, path.join(f.ctx.root, 'metadata', 'key.txt'));
    return response;
  };
  await assert.rejects(publishStore(f.ctx), /symbolic links/);
  assert.equal(f.commands.length, 1);
  assert.equal(f.commands[0].args[0], 'pilot');
  assert.equal(f.ctx.previous['ios-review'], undefined);
});

test('App Store JWT is refreshed after a long upload before subsequent read-only requests', async (t) => {
  const f = await fixture(t, 'ios');
  let clock = 1800000000000;
  f.ctx.now = () => clock;
  appleProvider(f, { hasBuild: false, afterUpload: () => f.commands.length > 0 });
  const command = f.ctx.command;
  f.ctx.command = async (...args) => {
    const response = await command(...args);
    clock += 11 * 60 * 1000;
    return response;
  };
  const provider = f.ctx.fetch;
  f.ctx.fetch = async (url, opts) => {
    const jwt = opts.headers.Authorization.split(' ')[1];
    const claims = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());
    assert.ok(claims.exp * 1000 > clock, 'expired JWT reached provider');
    return provider(url, opts);
  };
  assert.equal((await publishStore(f.ctx)).state, 'submitted');
  const tokens = f.calls.map((call) => call.opts.headers.Authorization);
  assert.equal(new Set(tokens).size, 2);
  assert.equal(f.commands.length, 2);
  assert.equal(f.commands.filter((call) => call.args[0] === 'pilot').length, 1);
});

test('a released Apple version without exact build relationship cannot attest availability', async (t) => {
  const f = await fixture(t, 'ios');
  f.checkpoint('ios-upload', { state: 'uploaded' });
  const version = appVersion('READY_FOR_SALE');
  delete version.relationships.build;
  appleProvider(f, { hasBuild: false, versions: [version] });
  await assert.rejects(publishStore(f.ctx), /different build/);
  assert.equal((await statusStore(f.ctx)).state, 'unavailable');
  assert.equal(f.commands.length, 0);
});

test('matching pre-existing Play bundle receives durable hash-bound ownership before commit', async (t) => {
  const f = await fixture(t, 'android');
  f.checkpoint('android-edit', { id: 'edit-1' });
  playProvider(f, (url, opts) => {
    if (url.endsWith('/tracks/production/releases')) return ok({ releases: [] });
    if (url.endsWith('/edits/edit-1')) return ok({ id: 'edit-1' });
    if (url.endsWith('/bundles'))
      return ok({ bundles: [{ versionCode: 42, sha256: f.ctx.artifact.sha256 }] });
    if (url.endsWith('/tracks/production'))
      return ok({ track: 'production', releases: [{ status: 'completed', versionCodes: ['42'] }] });
    if (url.includes(':commit?')) {
      assert.equal(f.ctx.previous['android-upload'].identity.sha256, f.ctx.artifact.sha256);
      return ok({ id: 'edit-1' });
    }
    assert.fail(`${opts.method}: ${url}`);
  });
  assert.equal((await publishStore(f.ctx)).state, 'submitted');
  assert.equal(f.ctx.previous['android-upload'].reconciled, true);
  assert.equal(f.calls.filter((call) => call.url.includes('uploadType=media')).length, 0);
});

test('Play cancellation during upload stops subsequent track/commit even if transport returns late success', async (t) => {
  for (const lateSuccess of [false, true]) {
    const f = await fixture(t, 'android');
    const abort = new AbortController();
    f.ctx.signal = abort.signal;
    let uploadSignal;
    playProvider(f, async (url, opts) => {
      if (url.endsWith('/tracks/production/releases')) return ok({ releases: [] });
      if (url.endsWith('/edits')) return ok({ id: 'edit-1' });
      if (url.endsWith('/edits/edit-1')) return ok({ id: 'edit-1' });
      if (url.endsWith('/bundles')) return ok({ bundles: [] });
      if (url.includes('uploadType=media')) {
        uploadSignal = opts.signal;
        // Consume the body so this regression focuses on cancellation semantics,
        // without leaving synthetic transport-owned file handles behind.
        for await (const _ of opts.body) {
          /* consume fake upload */
        }
        abort.abort(new Error('operator stopped release'));
        if (lateSuccess) return ok({ versionCode: 42, sha256: f.ctx.artifact.sha256 });
        opts.signal.throwIfAborted();
      }
      assert.fail('cancellation must prevent every subsequent provider request');
    });
    const out = await publishStore(f.ctx);
    assert.equal(out.state, 'unknown');
    assert.equal(uploadSignal.aborted, true);
    assert.equal(f.ctx.previous['android-upload'].state, 'intent');
    assert.equal(f.ctx.previous['android-edit'].state, 'created');
    assert.equal(f.ctx.previous['android-track'], undefined);
    assert.equal(f.ctx.previous['android-commit'], undefined);
    assert.equal(
      f.calls.some((call) => call.opts.method === 'PUT' || call.url.includes(':commit')),
      false,
    );
    const requests = f.calls.length;
    await assert.rejects(publishStore(f.ctx), /operator stopped release/);
    assert.equal(f.calls.length, requests);
  }
});

test('cancellation after confirmed upload checkpoint preserves receipt and stops next HTTP operation', async (t) => {
  const f = await fixture(t, 'android');
  const abort = new AbortController();
  f.ctx.signal = abort.signal;
  const checkpoint = f.ctx.checkpoint;
  f.ctx.checkpoint = async (name, data) => {
    await checkpoint(name, data);
    if (name === 'android-upload' && data.state === 'uploaded')
      abort.abort(new Error('operator stopped release'));
  };
  playProvider(f, async (url, opts) => {
    if (url.endsWith('/tracks/production/releases')) return ok({ releases: [] });
    if (url.endsWith('/edits')) return ok({ id: 'edit-1' });
    if (url.endsWith('/edits/edit-1')) return ok({ id: 'edit-1' });
    if (url.endsWith('/bundles')) return ok({ bundles: [] });
    if (url.includes('uploadType=media')) {
      for await (const _ of opts.body) {
        /* consume fake upload */
      }
      return ok({ versionCode: 42, sha256: f.ctx.artifact.sha256 });
    }
    assert.fail('no request may start after confirmed upload cancellation');
  });
  await assert.rejects(publishStore(f.ctx), /operator stopped release/);
  assert.equal(f.ctx.previous['android-upload'].state, 'uploaded');
  assert.equal(f.ctx.previous['android-track'], undefined);
  assert.equal(f.ctx.previous['android-commit'], undefined);
});

function rejectedPredecessorProvider(
  f,
  state,
  { hasNewBuild = false, olderBuildNumber = '41', transitionAfterUpload } = {},
) {
  f.ctx.fetch = async (url, opts) => {
    f.calls.push({ url, opts });
    const audit = appleAuditResponse(url);
    if (audit) return audit;
    if (url.endsWith('/v1/apps/123'))
      return ok({ data: { attributes: { bundleId: 'com.example.app' } } });
    if (url.includes('/appStoreVersions?')) {
      const version = appVersion(
        f.commands.length && transitionAfterUpload ? transitionAfterUpload : state,
      );
      version.relationships.build.data.id = 'prior-build';
      return ok({
        data: [version],
        included: [
          {
            ...build,
            id: 'prior-build',
            attributes: { ...build.attributes, version: olderBuildNumber },
          },
        ],
      });
    }
    if (url.includes('/v1/builds?'))
      return ok({ data: hasNewBuild || f.commands.length ? [build] : [], included: [preVersion] });
    if (url.includes('/buildUploads?')) return ok({ data: [] });
    assert.fail(`Unexpected request ${url}`);
  };
}

test('corrected iOS build can replace only an older editable rejected build at the same marketing version', async (t) => {
  for (const state of ['REJECTED', 'METADATA_REJECTED', 'INVALID_BINARY', 'DEVELOPER_REJECTED']) {
    const f = await fixture(t, 'ios');
    rejectedPredecessorProvider(f, state);
    assert.equal((await publishStore(f.ctx)).state, 'submitted', state);
    assert.equal(f.commands.length, 2, state);
    assert.equal(f.commands[0].args[0], 'pilot');
    assert.equal(f.commands[1].args[0], 'deliver');
    const args = f.commands[1].args;
    assert.equal(args[args.indexOf('--build_number') + 1], '42');
    assert.equal(args[args.indexOf('--app_version') + 1], '2.0.0');
    assert.equal(f.ctx.previous['ios-review'].replacesRejectedBuildId, 'prior-build');
    // Until ASC actually selects the new build, the old rejection does not
    // become a rejection result for the newly uploaded artifact.
    assert.equal((await statusStore(f.ctx)).state, 'unavailable', state);
    assert.equal(f.commands.length, 2);
    assert.equal((await publishStore(f.ctx)).state, 'unknown', state);
    assert.equal(f.commands.length, 2, 'unconfirmed replacement review must not be repeated');
  }
});

test('read-only iOS status never attributes predecessor rejection to the intended successor', async (t) => {
  const f = await fixture(t, 'ios');
  f.checkpoint('ios-upload', { state: 'uploaded', buildId: build.id });
  rejectedPredecessorProvider(f, 'REJECTED', { hasNewBuild: true });
  const observation = await statusStore(f.ctx);
  assert.equal(observation.state, 'unavailable');
  assert.match(observation.message, /different build/);
  assert.equal(f.commands.length, 0);
  assert.equal(f.journal.length, 0);
});

test('rejected-build replacement does not override newer, in-review, live or unknown selections', async (t) => {
  for (const state of [
    'IN_REVIEW',
    'WAITING_FOR_REVIEW',
    'READY_FOR_SALE',
    'PENDING_DEVELOPER_RELEASE',
    'FUTURE_UNKNOWN_STATE',
    'REJECTED',
  ]) {
    const f = await fixture(t, 'ios');
    rejectedPredecessorProvider(f, state, { olderBuildNumber: state === 'REJECTED' ? '43' : '41' });
    if (state === 'FUTURE_UNKNOWN_STATE')
      assert.equal((await publishStore(f.ctx)).state, 'unknown');
    else await assert.rejects(publishStore(f.ctx), /different build|newer App Store build/, state);
    assert.equal(f.commands.length, 0, state);
    assert.equal(f.journal.length, 0, state);
  }
});

test('a rejected predecessor becoming in-review during upload stops the corrected review submission', async (t) => {
  const f = await fixture(t, 'ios');
  rejectedPredecessorProvider(f, 'REJECTED', { transitionAfterUpload: 'IN_REVIEW' });
  await assert.rejects(publishStore(f.ctx), /different build/);
  assert.equal(f.commands.length, 1);
  assert.equal(f.commands[0].args[0], 'pilot');
  assert.equal(f.ctx.previous['ios-review'], undefined);
});

test('read-only iOS status preserves processing rejection before a store version selects the build', async (t) => {
  for (const processingState of ['FAILED', 'INVALID']) {
    const f = await fixture(t, 'ios');
    f.checkpoint('ios-upload', { state: 'uploaded' });
    appleProvider(f);
    const provider = f.ctx.fetch;
    f.ctx.fetch = async (url, options) => {
      if (url.includes('/v1/builds?')) {
        f.calls.push({ url, opts: options });
        return ok({
          data: [{ ...build, attributes: { ...build.attributes, processingState } }],
          included: [preVersion],
        });
      }
      return provider(url, options);
    };
    const observed = await statusStore(f.ctx);
    assert.equal(observed.state, 'rejected');
    assert.equal(observed.providerState, processingState);
    assert.equal(f.commands.length, 0);
    assert.ok(f.calls.every(({ opts }) => !opts.method || opts.method === 'GET'));
    assert.equal(f.journal.length, 0);
  }
});

test('read-only iOS status attests only confirmed exact uploads that have not entered review', async (t) => {
  for (const processingState of ['VALID', 'PROCESSING']) {
    for (const selection of ['no-version', 'no-build', 'this-build']) {
      for (const recordedBuildId of [undefined, build.id]) {
        const f = await fixture(t, 'ios');
        f.ctx.plan.source = 'a'.repeat(40);
        f.checkpoint('ios-upload', { state: 'uploaded', buildId: recordedBuildId });
        const version = appVersion('PREPARE_FOR_SUBMISSION');
        version.attributes.appVersionState = 'PREPARE_FOR_SUBMISSION';
        if (selection === 'no-build') version.relationships.build.data = null;
        appleProvider(f, {
          versions: selection === 'no-version' ? [] : [version],
          remoteBuild: { ...build, attributes: { ...build.attributes, processingState } },
        });
        const original = structuredClone(f.ctx.previous);
        const observed = await statusStore(f.ctx);
        assert.equal(observed.state, processingState === 'VALID' ? 'uploaded' : 'processing');
        assert.deepEqual(observed.unsubmittedUpload, {
          source: f.ctx.plan.source,
          artifactSha256: f.ctx.artifact.sha256,
          buildId: build.id,
          buildNumber: '42',
          version: '2.0.0',
          versionId: selection === 'no-version' ? null : version.id,
          versionState: selection === 'no-version' ? null : 'PREPARE_FOR_SUBMISSION',
          selectedBuildId: selection === 'this-build' ? build.id : null,
          buildProcessingState: processingState,
        });
        assert.ok(Number.isFinite(Date.parse(observed.observedAt)));
        assert.deepEqual(f.ctx.previous, original);
        assert.equal(f.journal.length, 0);
        assert.equal(f.commands.length, 0);
        assert.ok(f.calls.every(({ opts }) => !opts.method || opts.method === 'GET'));
      }
    }
  }
});

test('iOS handoff proof excludes ambiguous ownership, build processing, selection and review states', async (t) => {
  const variants = [
    'no-upload',
    'upload-intent',
    'upload-unknown',
    'wrong-upload-id',
    'wrong-upload-sha',
    'review-intent',
    'review-unknown',
    'review-submitted',
    'missing-source',
    'missing-build',
    'failed-build',
    'invalid-build',
    'unknown-build',
    'wrong-prerelease',
    'missing-relationship',
    'foreign-selection',
    'duplicate-version',
    'newer-version',
    'missing-version-state',
    'IN_REVIEW',
    'WAITING_FOR_REVIEW',
    'READY_FOR_SALE',
    'READY_FOR_DISTRIBUTION',
    'PROCESSING_FOR_DISTRIBUTION',
    'PENDING_DEVELOPER_RELEASE',
    'REJECTED',
    'FUTURE_UNKNOWN_STATE',
  ];
  for (const variant of variants) {
    const f = await fixture(t, 'ios');
    f.ctx.plan.source = 'a'.repeat(40);
    f.checkpoint('ios-upload', { state: 'uploaded', buildId: build.id });
    const version = appVersion('PREPARE_FOR_SUBMISSION');
    const remoteBuild = structuredClone(build);
    const options = { versions: [version], remoteBuild };
    if (variant === 'no-upload') delete f.ctx.previous['ios-upload'];
    if (variant.startsWith('upload-')) f.ctx.previous['ios-upload'].state = variant.slice(7);
    if (variant === 'wrong-upload-id') f.ctx.previous['ios-upload'].buildId = 'other-id';
    if (variant === 'wrong-upload-sha')
      f.ctx.previous['ios-upload'].identity.sha256 = 'b'.repeat(64);
    if (variant.startsWith('review-')) f.checkpoint('ios-review', { state: variant.slice(7) });
    if (variant === 'missing-source') delete f.ctx.plan.source;
    if (variant === 'missing-build') options.hasBuild = false;
    if (variant === 'failed-build') remoteBuild.attributes.processingState = 'FAILED';
    if (variant === 'invalid-build') remoteBuild.attributes.processingState = 'INVALID';
    if (variant === 'unknown-build')
      remoteBuild.attributes.processingState = 'FUTURE_UNKNOWN_STATE';
    if (variant === 'wrong-prerelease')
      remoteBuild.relationships.preReleaseVersion.data.id = 'wrong';
    if (variant === 'missing-relationship') delete version.relationships.build;
    if (variant === 'foreign-selection') {
      version.relationships.build.data.id = 'prior-build';
      options.includedBuilds = [
        { ...build, id: 'prior-build', attributes: { ...build.attributes, version: '41' } },
      ];
    }
    if (variant === 'duplicate-version') options.versions.push({ ...version, id: 'duplicate' });
    if (variant === 'newer-version') version.attributes.versionString = '3.0.0';
    if (variant === 'missing-version-state') delete version.attributes.appStoreState;
    if (/^[A-Z_]+$/.test(variant)) version.attributes.appVersionState = variant;
    appleProvider(f, options);
    const observed = await statusStore(f.ctx);
    assert.equal(observed.unsubmittedUpload, undefined, variant);
    assert.equal(f.journal.length, 0, variant);
    assert.equal(f.commands.length, 0, variant);
    assert.ok(
      f.calls.every(({ opts }) => !opts.method || opts.method === 'GET'),
      variant,
    );
  }
});

test('Play read-only handoff proof binds a confirmed upload to a live uncommitted edit', async (t) => {
  for (const { commitState, hasTrackCheckpoint } of ['absent', 'not-committed'].flatMap(
    (commitState) =>
      [true, false].map((hasTrackCheckpoint) => ({ commitState, hasTrackCheckpoint })),
  )) {
    const f = await fixture(t, 'android');
    f.ctx.plan.source = 'a'.repeat(40);
    f.checkpoint('android-edit', { state: 'created', id: 'edit-1' });
    f.checkpoint('android-upload', { state: 'uploaded', editId: 'edit-1' });
    if (hasTrackCheckpoint) f.checkpoint('android-track', { state: 'selected', editId: 'edit-1' });
    uploadedPlayProvider(f, reviewConflict);
    if (commitState === 'not-committed') await publishStore(f.ctx);
    const journalLength = f.journal.length;
    const start = f.calls.length;
    const original = structuredClone(f.ctx.previous);
    const observed = await statusStore(f.ctx);
    assert.equal(observed.state, commitState === 'absent' ? 'uploaded' : 'blocked');
    assert.deepEqual(observed.uncommittedEdit, {
      source: f.ctx.plan.source,
      artifactSha256: f.ctx.artifact.sha256,
      editId: 'edit-1',
      versionCode: '42',
      version: '2.0.0',
      commitState,
      track: 'production',
    });
    assert.ok(Number.isFinite(Date.parse(observed.observedAt)));
    assert.equal(f.journal.length, journalLength);
    assert.deepEqual(f.ctx.previous, original);
    assert.ok(
      f.calls.slice(start).every(({ url, opts }) => url.endsWith('/token') || !opts.method),
    );
  }
});

test('Play handoff proof excludes uncertain operations and mismatched or submitted provider state', async (t) => {
  for (const variant of [
    'edit-intent',
    'upload-intent',
    'upload-unknown',
    'wrong-upload-edit',
    'missing-source',
    'track-intent',
    'track-unknown',
    'wrong-track-edit',
    'null-track',
    'undefined-track',
    'null-commit',
    'undefined-commit',
    'commit-intent',
    'commit-unknown',
    'commit-submitted',
    'expired-edit',
    'wrong-edit',
    'wrong-sha',
    'newer-bundle',
    'duplicate-bundle',
    'wrong-track',
    'newer-track',
    'unknown-track',
    'in-review',
    'available',
    'newer-release',
    'unknown-release',
  ]) {
    const f = await fixture(t, 'android');
    f.ctx.plan.source = 'a'.repeat(40);
    f.checkpoint('android-edit', { state: 'created', id: 'edit-1' });
    f.checkpoint('android-upload', { state: 'uploaded', editId: 'edit-1' });
    f.checkpoint('android-track', { state: 'selected', editId: 'edit-1' });
    if (variant === 'edit-intent') f.ctx.previous['android-edit'].state = 'intent';
    if (variant.startsWith('upload-')) f.ctx.previous['android-upload'].state = variant.slice(7);
    if (variant === 'wrong-upload-edit') f.ctx.previous['android-upload'].editId = 'other';
    if (variant === 'missing-source') delete f.ctx.plan.source;
    if (variant.startsWith('track-')) f.ctx.previous['android-track'].state = variant.slice(6);
    if (variant === 'wrong-track-edit') f.ctx.previous['android-track'].editId = 'other';
    if (variant === 'null-track') f.ctx.previous['android-track'] = null;
    if (variant === 'undefined-track') f.ctx.previous['android-track'] = undefined;
    if (variant === 'null-commit') f.ctx.previous['android-commit'] = null;
    if (variant === 'undefined-commit') f.ctx.previous['android-commit'] = undefined;
    if (variant.startsWith('commit-'))
      f.checkpoint('android-commit', { state: variant.slice(7), editId: 'edit-1' });
    const overrides = {};
    if (variant === 'expired-edit') overrides.edit = notFound();
    if (variant === 'wrong-edit') overrides.edit = ok({ id: 'other' });
    if (variant === 'wrong-sha') overrides.sha256 = 'f'.repeat(64);
    if (variant === 'newer-bundle')
      overrides.bundles = [{ versionCode: 43, sha256: f.ctx.artifact.sha256 }];
    if (variant === 'duplicate-bundle')
      overrides.bundles = Array(2).fill({ versionCode: 42, sha256: f.ctx.artifact.sha256 });
    if (variant === 'wrong-track') overrides.track = { track: 'internal', releases: [] };
    if (variant === 'newer-track')
      overrides.track = {
        track: 'production',
        releases: [{ status: 'completed', versionCodes: ['43'] }],
      };
    if (variant === 'unknown-track')
      overrides.track = {
        track: 'production',
        releases: [{ status: 'future', versionCodes: ['42'] }],
      };
    if (variant === 'in-review') overrides.releases = [release('IN_REVIEW')];
    if (variant === 'available') overrides.releases = [release('PUBLISHED')];
    if (variant === 'newer-release') {
      overrides.releases = [release('IN_REVIEW')];
      overrides.releases[0].activeArtifacts[0].versionCode = 43;
    }
    if (variant === 'unknown-release') overrides.releases = [release('FUTURE_UNKNOWN_STATE')];
    uploadedPlayProvider(f, () => assert.fail('status cannot commit'), overrides);
    const observed = await statusStore(f.ctx);
    assert.equal(observed.uncommittedEdit, undefined, variant);
    assert.equal(f.journal.length, 0, variant);
    assert.ok(
      f.calls.every(({ url, opts }) => url.endsWith('/token') || !opts.method),
      variant,
    );
  }
});

test('Play read-only handoff can prove a confirmed edit has not started the planned upload', async (t) => {
  for (const hasOlderVersion of [false, true]) {
    const f = await fixture(t, 'android');
    f.ctx.plan.source = 'a'.repeat(40);
    f.checkpoint('android-edit', { state: 'created', id: 'edit-1' });
    const older = release('PUBLISHED');
    older.activeArtifacts[0].versionCode = 41;
    uploadedPlayProvider(f, () => assert.fail('status cannot commit'), {
      releases: hasOlderVersion ? [older] : [],
      bundles: hasOlderVersion ? [{ versionCode: 41, sha256: 'b'.repeat(64) }] : [],
      track: {
        track: 'production',
        releases: hasOlderVersion ? [{ status: 'completed', versionCodes: ['41'] }] : [],
      },
    });
    const original = structuredClone(f.ctx.previous);
    const observed = await statusStore(f.ctx);
    assert.equal(observed.state, 'prepared');
    assert.equal(observed.uncommittedEdit, undefined);
    assert.deepEqual(observed.unuploadedEdit, {
      source: f.ctx.plan.source,
      artifactSha256: f.ctx.artifact.sha256,
      editId: 'edit-1',
      versionCode: '42',
      version: '2.0.0',
      track: 'production',
      uploadState: 'absent',
    });
    assert.ok(Number.isFinite(Date.parse(observed.observedAt)));
    assert.deepEqual(f.ctx.previous, original);
    assert.equal(f.journal.length, 0);
    assert.equal(f.commands.length, 0);
    assert.ok(f.calls.every(({ url, opts }) => url.endsWith('/token') || !opts.method));
    for (const suffix of [
      '/tracks/production/releases',
      '/edits/edit-1',
      '/bundles',
      '/tracks/production',
    ])
      assert.ok(
        f.calls.some(({ url }) => url.endsWith(suffix)),
        suffix,
      );
  }
});

test('Play unuploaded-edit handoff refuses uncertain journals and absent or conflicting remote evidence', async (t) => {
  const cases = [
    'edit-intent',
    'edit-unknown',
    'missing-edit-id',
    'wrong-edit-identity',
    'missing-source',
    'upload-intent',
    'upload-unknown',
    'upload-confirmed',
    'track-intent',
    'track-confirmed',
    'commit-intent',
    'commit-unknown',
    'commit-submitted',
    'null-upload',
    'null-track',
    'null-commit',
    'undefined-upload',
    'expired-edit',
    'wrong-edit',
    'planned-bundle',
    'newer-bundle',
    'malformed-bundles',
    'malformed-bundle-code',
    'wrong-track',
    'planned-track',
    'newer-track',
    'malformed-track',
    'malformed-track-code',
    'unknown-track',
    'planned-release',
    'newer-release',
  ];
  for (const variant of cases) {
    const f = await fixture(t, 'android');
    f.ctx.plan.source = 'a'.repeat(40);
    f.checkpoint('android-edit', { state: 'created', id: 'edit-1' });
    if (variant === 'edit-intent') f.ctx.previous['android-edit'].state = 'intent';
    if (variant === 'edit-unknown') f.ctx.previous['android-edit'].state = 'unknown';
    if (variant === 'missing-edit-id') delete f.ctx.previous['android-edit'].id;
    if (variant === 'wrong-edit-identity')
      f.ctx.previous['android-edit'].identity.sha256 = 'f'.repeat(64);
    if (variant === 'missing-source') delete f.ctx.plan.source;
    for (const name of ['upload', 'track', 'commit']) {
      if (variant.startsWith(`${name}-`))
        f.checkpoint(`android-${name}`, {
          state: variant.endsWith('-confirmed')
            ? name === 'upload'
              ? 'uploaded'
              : 'selected'
            : variant.slice(name.length + 1),
          editId: 'edit-1',
        });
      if (variant === `null-${name}`) f.ctx.previous[`android-${name}`] = null;
    }
    if (variant === 'undefined-upload') f.ctx.previous['android-upload'] = undefined;
    const overrides = { bundles: [], track: { track: 'production', releases: [] } };
    if (variant === 'expired-edit') overrides.edit = notFound();
    if (variant === 'wrong-edit') overrides.edit = ok({ id: 'other' });
    if (variant === 'planned-bundle')
      overrides.bundles = [{ versionCode: 42, sha256: f.ctx.artifact.sha256 }];
    if (variant === 'newer-bundle')
      overrides.bundles = [{ versionCode: 43, sha256: 'b'.repeat(64) }];
    if (variant === 'malformed-bundles') overrides.bundles = null;
    if (variant === 'malformed-bundle-code') overrides.bundles = [{ versionCode: 'not-a-code' }];
    if (variant === 'wrong-track') overrides.track.track = 'internal';
    if (variant === 'planned-track')
      overrides.track.releases = [{ status: 'completed', versionCodes: ['42'] }];
    if (variant === 'newer-track')
      overrides.track.releases = [{ status: 'completed', versionCodes: ['43'] }];
    if (variant === 'malformed-track') overrides.track.releases = null;
    if (variant === 'malformed-track-code')
      overrides.track.releases = [{ status: 'completed', versionCodes: ['not-a-code'] }];
    if (variant === 'unknown-track')
      overrides.track.releases = [{ status: 'unknown', versionCodes: ['41'] }];
    if (variant === 'planned-release') overrides.releases = [release('IN_REVIEW')];
    if (variant === 'newer-release') {
      overrides.releases = [release('IN_REVIEW')];
      overrides.releases[0].activeArtifacts[0].versionCode = 43;
    }
    uploadedPlayProvider(f, () => assert.fail('status cannot commit'), overrides);
    const original = structuredClone(f.ctx.previous);
    const observed = await statusStore(f.ctx);
    assert.equal(observed.unuploadedEdit, undefined, variant);
    assert.equal(observed.uncommittedEdit, undefined, variant);
    assert.deepEqual(f.ctx.previous, original, variant);
    assert.equal(f.journal.length, 0, variant);
    assert.equal(f.commands.length, 0, variant);
    assert.ok(
      f.calls.every(({ url, opts }) => url.endsWith('/token') || !opts.method),
      variant,
    );
  }
});

test('iOS listing failures stop doctor and new upload before any publication intent', async (t) => {
  for (const variant of [
    'draft',
    'locale',
    'copy',
    'screenshots',
    'processing',
    'contact',
    'account',
    'permission',
  ]) {
    const f = await fixture(t, 'ios');
    appleProvider(f, { hasBuild: false });
    const provider = f.ctx.fetch;
    f.ctx.fetch = async (url, opts) => {
      if (
        variant === 'draft' &&
        url.includes('/appStoreVersions?') &&
        !url.includes('include=build')
      )
        return ok({ data: [] });
      if (variant === 'locale' && url.includes('/appStoreVersionLocalizations?'))
        return ok({ data: [] });
      if (variant === 'copy' && url.includes('/appStoreVersionLocalizations?'))
        return ok({ data: [{ id: 'zh', attributes: { locale: 'zh-Hans' } }] });
      if (variant === 'screenshots' && url.includes('/appScreenshotSets?')) return ok({ data: [] });
      if (variant === 'processing' && url.includes('/appScreenshots?'))
        return ok({ data: [{ attributes: { assetDeliveryState: { state: 'UPLOAD_COMPLETE' } } }] });
      if (url.endsWith('/appStoreReviewDetail')) {
        if (variant === 'contact')
          return ok({ data: { attributes: { demoAccountRequired: false } } });
        if (variant === 'account')
          return ok({
            data: {
              attributes: {
                contactFirstName: 'PRIVATE',
                contactLastName: 'PRIVATE',
                contactEmail: 'PRIVATE',
                contactPhone: 'PRIVATE',
                demoAccountRequired: true,
                demoAccountName: 'PRIVATE',
              },
            },
          });
      }
      if (variant === 'permission' && url.includes('/appStoreVersionLocalizations?'))
        return { ok: false, status: 403, json: async () => ({ secret: 'PRIVATE' }) };
      return provider(url, opts);
    };
    const doctor = await doctorStore(f.ctx);
    assert.ok(
      doctor.checks.some((check) => !check.ok),
      variant,
    );
    f.commands.length = 0;
    await assert.rejects(publishStore(f.ctx), undefined, variant);
    assert.equal(f.commands.length, 0, variant);
    assert.equal(f.journal.length, 0, variant);
    assert.equal(JSON.stringify(doctor).includes('PRIVATE'), false, variant);
  }
});

test('iOS tracked new copy can fill saved fields without requiring old provider copy to match', async (t) => {
  const f = await fixture(t, 'ios');
  appleProvider(f);
  for (const [name, text] of Object.entries({
    description: 'New description',
    keywords: 'new',
    support_url: 'https://example.invalid/new',
  }))
    await writeFile(path.join(f.ctx.root, 'metadata', 'zh-Hans', `${name}.txt`), text);
  const provider = f.ctx.fetch;
  f.ctx.fetch = (url, opts) =>
    url.includes('/appStoreVersionLocalizations?')
      ? ok({ data: [{ id: 'zh', attributes: { locale: 'zh-Hans' } }] })
      : provider(url, opts);
  const report = await doctorStore(f.ctx);
  assert.ok(report.checks.every((check) => check.ok));
  assert.equal(JSON.stringify(report).includes('New description'), false);
});

test('iOS readiness considers older versions on subsequent provider pages', async (t) => {
  const f = await fixture(t, 'ios');
  appleProvider(f, { hasBuild: false });
  await rm(path.join(f.ctx.root, 'metadata', 'zh-Hans', 'release_notes.txt'));
  const provider = f.ctx.fetch;
  let historyPages = 0;
  f.ctx.fetch = (url, opts) => {
    if (url.includes('/appStoreVersions?') && !url.includes('include=build')) {
      historyPages++;
      if (url.includes('cursor=older'))
        return ok({
          data: [
            {
              id: 'older',
              type: 'appStoreVersions',
              attributes: { versionString: '1.0.0', appStoreState: 'READY_FOR_DISTRIBUTION' },
            },
          ],
        });
      return ok({
        data: [appVersion('PREPARE_FOR_SUBMISSION')],
        links: {
          next: 'https://api.appstoreconnect.apple.com/v1/apps/123/appStoreVersions?cursor=older',
        },
      });
    }
    return provider(url, opts);
  };
  const report = await doctorStore(f.ctx);
  assert.equal(historyPages, 2);
  assert.ok(report.checks.some((c) => !c.ok && /release_notes/.test(c.message)));
  f.commands.length = 0;
  await assert.rejects(publishStore(f.ctx), /release_notes/);
  assert.equal(f.commands.length, 0);
  assert.equal(f.journal.length, 0);
});

test('iOS rechecks screenshots after upload before starting review intent', async (t) => {
  const f = await fixture(t, 'ios');
  appleProvider(f, { hasBuild: false, afterUpload: () => f.commands.length > 0 });
  const provider = f.ctx.fetch;
  f.ctx.fetch = (url, opts) =>
    f.commands.length && url.includes('/appScreenshots?')
      ? ok({ data: [{ attributes: { assetDeliveryState: { state: 'FAILED' } } }] })
      : provider(url, opts);
  await assert.rejects(publishStore(f.ctx), /screenshots/);
  assert.equal(f.commands.length, 1);
  assert.equal(f.ctx.previous['ios-upload'].state, 'uploaded');
  assert.equal(f.ctx.previous['ios-review'], undefined);
});

test('Fastlane uses a private option-free bootstrap before durable intent and removes it afterwards', async (t) => {
  const f = await fixture(t, 'ios');
  appleProvider(f, { hasBuild: false, afterUpload: () => f.commands.length > 0 });
  await writeFile(
    path.join(f.ctx.releaseDir, 'Deliverfile'),
    'raise "operator configuration must not load"',
  );
  const command = f.ctx.command;
  const directories = [];
  f.ctx.command = async (bin, args, opts) => {
    assert.notEqual(opts.cwd, f.ctx.releaseDir);
    const bootstrap = await readFile(path.join(opts.cwd, 'Deliverfile'), 'utf8');
    assert.match(bootstrap, /^# [^\n]+\n$/);
    directories.push(opts.cwd);
    const phase = args[0] === 'pilot' ? 'ios-upload' : 'ios-review';
    assert.equal(f.ctx.previous[phase].state, 'intent');
    assert.equal(opts.env.CI, 'true');
    if (phase === 'ios-review') {
      assert.equal(args.includes('--ipa'), false);
      assert.equal(args[args.indexOf('--metadata_path') + 1], path.join(f.ctx.root, 'metadata'));
      assert.equal(args[args.indexOf('--skip_binary_upload') + 1], 'true');
    }
    return command(bin, args, opts);
  };
  assert.equal((await publishStore(f.ctx)).state, 'submitted');
  for (const directory of directories) await assert.rejects(access(directory));
  assert.equal(
    await readFile(path.join(f.ctx.releaseDir, 'Deliverfile'), 'utf8'),
    'raise "operator configuration must not load"',
  );
});

function processingUpload(state = 'PROCESSING') {
  return {
    type: 'buildUploads',
    id: 'upload-42',
    attributes: {
      platform: 'IOS',
      cfBundleShortVersionString: '2.0.0',
      cfBundleVersion: '42',
      state: {
        state,
        errors: state === 'FAILED' ? [{ message: 'PRIVATE error' }] : [],
        warnings: [{ message: 'PRIVATE warning' }],
      },
    },
  };
}

test('Apple upload processing and failure are observed without duplicate upload or review', async (t) => {
  for (const state of ['PROCESSING', 'COMPLETE', 'FAILED', 'AWAITING_UPLOAD', 'FUTURE']) {
    const f = await fixture(t, 'ios');
    f.checkpoint('ios-upload', { state: 'unknown' });
    appleProvider(f, { hasBuild: false });
    const provider = f.ctx.fetch;
    f.ctx.fetch = (url, opts) =>
      url.includes('/buildUploads?')
        ? ok({ data: [processingUpload(state)] })
        : provider(url, opts);
    const expected =
      state === 'FAILED'
        ? 'rejected'
        : ['PROCESSING', 'COMPLETE'].includes(state)
          ? 'processing'
          : 'unknown';
    for (const observe of [statusStore, publishStore]) {
      const out = await observe(f.ctx);
      assert.equal(out.state, expected, state);
      assert.equal(out.providerState, state);
      assert.equal(out.buildUpload.id, 'upload-42');
      assert.equal(out.buildUpload.warningCount, 1);
      assert.equal(out.availabilityVerified, false);
      assert.equal(out.unsubmittedUpload, undefined);
      assert.equal(JSON.stringify(out).includes('PRIVATE'), false);
    }
    assert.equal(f.commands.length, 0);
    assert.equal(f.journal.length, 0);
    assert.equal(f.ctx.previous['ios-upload'].state, 'unknown');
  }
});

test('ambiguous, foreign, inaccessible and unowned Apple uploads never authorize mutation', async (t) => {
  for (const variant of ['duplicate', 'version', 'platform', 'permission', 'unowned']) {
    const f = await fixture(t, 'ios');
    if (variant !== 'unowned') f.checkpoint('ios-upload', { state: 'uploaded' });
    appleProvider(f, { hasBuild: false });
    const provider = f.ctx.fetch;
    const upload = processingUpload();
    if (variant === 'version') upload.attributes.cfBundleVersion = '43';
    if (variant === 'platform') upload.attributes.platform = 'MAC_OS';
    f.ctx.fetch = (url, opts) =>
      url.includes('/buildUploads?')
        ? variant === 'permission'
          ? { ok: false, status: 403 }
          : ok({ data: variant === 'duplicate' ? [upload, upload] : [upload] })
        : provider(url, opts);
    await assert.rejects(publishStore(f.ctx), undefined, variant);
    assert.equal((await statusStore(f.ctx)).state, 'unavailable', variant);
    assert.equal(f.commands.length, 0, variant);
    assert.equal(f.journal.length, 0, variant);
  }
});

test('existing unknown iOS review can reconcile even when new-operation listing audit would fail', async (t) => {
  const f = await fixture(t, 'ios');
  f.checkpoint('ios-upload', { state: 'uploaded' });
  f.checkpoint('ios-review', { state: 'unknown' });
  appleProvider(f, { versions: [appVersion('WAITING_FOR_REVIEW')] });
  const provider = f.ctx.fetch;
  f.ctx.fetch = (url, opts) => {
    assert.equal(url.includes('/appStoreVersionLocalizations?'), false);
    return provider(url, opts);
  };
  f.ctx.command = () => assert.fail('reconciliation must not need Fastlane');
  assert.ok((await doctorStore(f.ctx)).checks.every((check) => check.ok));
  assert.equal((await publishStore(f.ctx)).state, 'in-review');
  assert.equal(f.ctx.previous['ios-review'].state, 'unknown');
  assert.equal(f.journal.length, 0);
});

test('new remote upload appearing during listing audit stops first upload', async (t) => {
  const f = await fixture(t, 'ios');
  appleProvider(f, { hasBuild: false });
  const provider = f.ctx.fetch;
  let audited = false;
  f.ctx.fetch = (url, opts) => {
    if (url.endsWith('/appStoreReviewDetail')) audited = true;
    if (audited && url.includes('/buildUploads?')) return ok({ data: [processingUpload()] });
    return provider(url, opts);
  };
  await assert.rejects(publishStore(f.ctx), /without an upload journal/);
  assert.equal(f.commands.length, 0);
  assert.equal(f.journal.length, 0);
});

test('iOS publication doctor treats command failure as a failed preflight and cleans bootstrap', async (t) => {
  const f = await fixture(t, 'ios');
  let directory;
  f.ctx.command = async (_bin, _args, opts) => {
    directory = opts.cwd;
    await access(path.join(directory, 'Deliverfile'));
    return { code: 1 };
  };
  const out = await doctorStore(f.ctx);
  assert.ok(out.checks.some((check) => !check.ok));
  assert.equal(f.calls.length, 0);
  assert.equal(f.journal.length, 0);
  await assert.rejects(access(directory));
});

test('Play publication adopts the exact prepared edit and rechecks listing before commit', async (t) => {
  const { loadStoreContent } = await import('./store-content.mjs');
  const f = await fixture(t, 'android');
  const manifest = {
    schemaVersion: 1,
    platform: 'android',
    version: '2.0.0',
    locales: [
      {
        locale: 'en-US',
        fields: { title: 'Title', shortDescription: 'Short', fullDescription: 'Full' },
      },
    ],
  };
  const bytes = Buffer.from(JSON.stringify(manifest));
  await writeFile(path.join(f.ctx.root, 'content.json'), bytes);
  f.ctx.config.stores.android.contentPath = 'content.json';
  f.ctx.plan.source = 'a'.repeat(40);
  const blob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  f.ctx.command = async () => ({ stdout: blob });
  const input = await loadStoreContent(f.ctx);
  const edit = {
    id: 'prepared-edit',
    expiryTimeSeconds: String(Math.floor(Date.now() / 1000) + 3600),
  };
  f.ctx.preparation = {
    status: 'prepared',
    inputDigest: input.inputDigest,
    edit,
    approval: 'b'.repeat(64),
  };
  let listingReads = 0,
    changeBeforeCommit = false;
  playProvider(f, async (url, opts) => {
    if (url.endsWith('/tracks/production/releases')) return ok({ releases: [] });
    if (url.endsWith('/edits/prepared-edit')) return ok(edit);
    if (url.endsWith('/listings')) {
      listingReads++;
      return ok({
        listings: [
          {
            language: 'en-US',
            ...manifest.locales[0].fields,
            ...(changeBeforeCommit && listingReads > 1 ? { title: 'External title' } : {}),
          },
        ],
      });
    }
    if (url.endsWith('/phoneScreenshots')) return ok({ images: [] });
    if (url.endsWith('/bundles'))
      return ok({ bundles: [{ versionCode: 42, sha256: f.ctx.artifact.sha256 }] });
    if (url.endsWith('/tracks/production'))
      return ok({ track: 'production', releases: [{ status: 'completed', versionCodes: ['42'] }] });
    if (url.includes(':commit?')) return ok(edit);
    assert.fail(`Unexpected operation ${opts.method}: ${url}`);
  });
  changeBeforeCommit = true;
  await assert.rejects(publishStore(f.ctx), /changed before publication/);
  assert.equal(f.calls.filter((call) => call.url.includes(':commit?')).length, 0);
  assert.equal(f.ctx.previous['android-edit'].id, edit.id);
  changeBeforeCommit = false;
  assert.equal((await publishStore(f.ctx)).state, 'submitted');
  assert.ok(listingReads >= 4);
  assert.equal(
    f.calls.filter((call) => call.url.endsWith('/edits') && call.opts.method === 'POST').length,
    0,
  );
  assert.equal(f.calls.filter((call) => call.url.includes(':commit?')).length, 1);
});

test('prepared iOS publication explicitly restores automatic/full release while Fastlane skips reviewed metadata', async (t) => {
  const { loadStoreContent } = await import('./store-content.mjs');
  const f = await fixture(t, 'ios');
  const bytes = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      platform: 'ios',
      version: '2.0.0',
      locales: [{ locale: 'en-US', fields: { description: 'Reviewed' } }],
    }),
  );
  await writeFile(path.join(f.ctx.root, 'content.json'), bytes);
  f.ctx.config.stores.ios.contentPath = 'content.json';
  f.ctx.plan.source = 'a'.repeat(40);
  const command = f.ctx.command;
  f.ctx.command = async (bin, args, opts) =>
    bin === 'git'
      ? { stdout: createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') }
      : command(bin, args, opts);
  f.ctx.preparation = {
    status: 'prepared',
    inputDigest: (await loadStoreContent(f.ctx)).inputDigest,
  };
  f.ctx.session = async () => ({
    cfg: { appId: '123', bundleId: 'com.example.app' },
    read: async () => ({ data: { attributes: { bundleId: 'com.example.app' } } }),
    list: async (url) =>
      url.includes('/appStoreVersions?')
        ? [appVersion('PREPARE_FOR_SUBMISSION')]
        : url.includes('/appStoreVersionLocalizations?')
          ? [{ id: 'locale', attributes: { locale: 'en-US', description: 'Reviewed' } }]
          : [],
  });
  f.checkpoint('ios-upload', { state: 'uploaded', buildId: 'build-42' });
  appleProvider(f, { versions: [appVersion('PREPARE_FOR_SUBMISSION')] });
  const provider = f.ctx.fetch;
  let releaseType = 'MANUAL',
    phased = { type: 'appStoreVersionPhasedReleases', id: 'phase' };
  let losePolicyResponse = true;
  f.ctx.fetch = async (url, opts) => {
    if (url.endsWith('/appStoreVersions/version-2')) {
      f.calls.push({ url, opts });
      if (opts.method === 'PATCH') {
        assert.equal(f.ctx.previous['ios-release-policy'].state, 'intent');
        releaseType = JSON.parse(opts.body).data.attributes.releaseType;
        if (losePolicyResponse) throw new Error('lost policy response');
      }
      return ok({ data: { id: 'version-2', attributes: { releaseType } } });
    }
    if (url.endsWith('/appStoreVersionPhasedRelease')) return ok({ data: phased });
    if (url.endsWith('/appStoreVersionPhasedReleases/phase')) {
      f.calls.push({ url, opts });
      assert.equal(opts.method, 'DELETE');
      assert.equal(f.ctx.previous['ios-phased-release'].state, 'intent');
      phased = null;
      return { ok: true, status: 204 };
    }
    return provider(url, opts);
  };
  await assert.rejects(publishStore(f.ctx));
  assert.equal(f.commands.length, 0);
  assert.equal(f.ctx.previous['ios-review'], undefined);
  losePolicyResponse = false;
  assert.equal((await publishStore(f.ctx)).state, 'submitted');
  assert.equal(releaseType, 'AFTER_APPROVAL');
  assert.equal(phased, null);
  assert.equal(f.calls.filter((call) => call.opts.method === 'PATCH').length, 1);
  const deliver = f.commands.find((call) => call.args[0] === 'deliver');
  assert.equal(deliver.args[deliver.args.indexOf('--skip_metadata') + 1], 'true');
  assert.equal(
    f.calls.filter((call) => /appStoreVersionLocalizations/.test(call.url) && call.opts.method)
      .length,
    0,
  );
});
