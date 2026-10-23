import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  loadStoreContent,
  prepareStoreContent,
  uploadAppleParts,
  verifyPreparedPlayContent,
} from './store-content.mjs';
import { digest } from './state.mjs';
import { main } from './cli.mjs';

const clone = (x) => structuredClone(x);
async function fixture(t, platform = 'ios', { screenshots = true, existing = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'store-content-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const png = Buffer.alloc(40);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(png);
  png.write('IHDR', 12);
  png.writeUInt32BE(1290, 16);
  png.writeUInt32BE(2796, 20);
  const manifest = {
    schemaVersion: 1,
    platform,
    version: '1.2.0',
    locales: [
      {
        locale: 'en-US',
        fields:
          platform === 'ios'
            ? { description: 'Reviewed description', name: 'Reviewed name' }
            : { title: 'Reviewed title', shortDescription: 'Short', fullDescription: 'Long' },
        screenshots: screenshots
          ? [
              {
                path: 'screen.png',
                displayType: platform === 'ios' ? 'APP_IPHONE_67' : 'phoneScreenshots',
              },
            ]
          : [],
      },
    ],
  };
  const blobs = new Map();
  async function input(name, bytes) {
    bytes = Buffer.from(bytes);
    await writeFile(join(root, name), bytes);
    blobs.set(
      name,
      createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'),
    );
  }
  await input('screen.png', png);
  await input('content.json', JSON.stringify(manifest));
  const writes = [],
    uploads = [],
    saved = [];
  const remote = {
    versions: existing
      ? [
          {
            id: 'version',
            attributes: { versionString: '1.2.0', appStoreState: 'PREPARE_FOR_SUBMISSION' },
          },
        ]
      : [],
    locales: existing
      ? [
          {
            id: 'locale',
            attributes: { locale: 'en-US', description: 'Old description', whatsNew: 'Untouched' },
          },
        ]
      : [],
    infoLocales: [
      {
        id: 'info-locale',
        attributes: { locale: 'en-US', name: 'Old name', subtitle: 'Keep subtitle' },
      },
    ],
    sets: [],
    images: [],
    listings: [],
    playImages: [],
    edit: null,
  };
  let sequence = 0,
    failBefore,
    failAfter,
    failUpload = false,
    verify = 0;
  const api = {
    cfg: { appId: '123', bundleId: 'example.app', packageName: 'example.app' },
    async read(path) {
      if (path === '/v1/apps/123') return { data: { attributes: { bundleId: 'example.app' } } };
      if (/^edits\/edit$/.test(path)) return clone(remote.edit);
      if (path.endsWith('/phoneScreenshots')) return { images: clone(remote.playImages) };
      if (path.endsWith('/listings')) return { listings: clone(remote.listings) };
      throw new Error(`Unexpected read ${path}`);
    },
    async list(path) {
      if (path.includes('/appStoreVersions?')) return clone(remote.versions);
      if (path.includes('/appStoreVersionLocalizations?')) return clone(remote.locales);
      if (path.includes('/appInfos?'))
        return [{ id: 'info', attributes: { appStoreState: 'PREPARE_FOR_SUBMISSION' } }];
      if (path.includes('/appInfoLocalizations?')) return clone(remote.infoLocales);
      if (path.includes('/appScreenshotSets?')) return clone(remote.sets);
      if (path.includes('/appScreenshots?')) return clone(remote.images);
      throw new Error(`Unexpected list ${path}`);
    },
    async write(method, path, payload) {
      writes.push({ method, path, payload: clone(payload) });
      assert.ok(
        saved.at(-1) && Object.values(saved.at(-1).steps).some((step) => step.state === 'intent'),
        'intent persisted before any mutation',
      );
      if (failBefore?.(path)) throw new Error('private provider error');
      let result = null;
      if (path === '/v1/appStoreVersions') {
        remote.versions = [
          {
            id: 'version',
            attributes: {
              versionString: payload.data.attributes.versionString,
              appStoreState: 'PREPARE_FOR_SUBMISSION',
            },
          },
        ];
        result = { data: remote.versions[0] };
      } else if (path === '/v1/appStoreVersionLocalizations') {
        const item = { id: `locale-${++sequence}`, attributes: payload.data.attributes };
        remote.locales.push(item);
        result = { data: item };
      } else if (path.startsWith('/v1/appStoreVersionLocalizations/'))
        Object.assign(
          remote.locales.find((item) => item.id === payload.data.id).attributes,
          payload.data.attributes,
        );
      else if (path.startsWith('/v1/appInfoLocalizations/'))
        Object.assign(remote.infoLocales[0].attributes, payload.data.attributes);
      else if (path === '/v1/appScreenshotSets') {
        const item = { id: 'set', attributes: payload.data.attributes };
        remote.sets.push(item);
        result = { data: item };
      } else if (path === '/v1/appScreenshots') {
        const item = {
          id: 'image',
          attributes: {
            ...payload.data.attributes,
            assetDeliveryState: { state: 'AWAITING_UPLOAD' },
            uploadOperations: [
              {
                method: 'PUT',
                url: 'https://store-001.blobstore.apple.com/private-signed-url',
                offset: 0,
                length: png.length,
                requestHeaders: [{ name: 'Content-Type', value: 'image/png' }],
              },
            ],
          },
        };
        remote.images.push(item);
        result = { data: clone(item) };
      } else if (path === '/v1/appScreenshots/image')
        Object.assign(remote.images[0].attributes, payload.data.attributes, {
          assetDeliveryState: { state: 'COMPLETE' },
        });
      else if (path === 'edits') {
        remote.edit = {
          id: 'edit',
          expiryTimeSeconds: String(Math.floor(Date.now() / 1000) + 3600),
        };
        result = clone(remote.edit);
      } else if (path.endsWith('/listings/en-US')) remote.listings = [clone(payload)];
      else if (path.includes('uploadType=media')) {
        remote.playImages.push({ id: 'play-image', sha256: digest(png) });
        result = { image: remote.playImages[0] };
      } else throw new Error(`Unexpected write ${path}`);
      if (failAfter?.(path)) throw new Error('private lost response');
      return clone(result);
    },
  };
  const ctx = {
    root,
    platform,
    plan: {
      id: 'release-' + 'a'.repeat(24),
      source: 'b'.repeat(40),
      version: '1.2.0',
      configDigest: 'c'.repeat(64),
      appIds: { ios: 'example.app', android: 'example.app' },
    },
    config: { stores: { [platform]: { contentPath: 'content.json' } } },
    env: {},
    command: async (binary, args) => ({
      stdout: blobs.get(args.at(-1).split(':').slice(1).join(':')) ?? 'untracked',
    }),
    session: async () => api,
    async savePreparation(record) {
      ctx.preparation = clone(record);
      saved.push(clone(record));
    },
    async assertPublicationSource() {
      verify++;
    },
    async fetch(url, options) {
      uploads.push({ url, options });
      if (failUpload) throw new Error('private upload URL');
      return new Response(null, { status: 200 });
    },
  };
  const plan = () => prepareStoreContent(ctx);
  const apply = () =>
    prepareStoreContent(ctx, { mode: 'apply', approval: ctx.preparation.approval });
  return {
    ctx,
    manifest,
    input,
    png,
    api,
    remote,
    writes,
    uploads,
    saved,
    plan,
    apply,
    setFailure: (before, after, upload = false) => {
      failBefore = before;
      failAfter = after;
      failUpload = upload;
    },
    verificationCount: () => verify,
  };
}

test('iOS plan reads only; approved apply preserves unspecified text/assets and never selects or submits a build', async (t) => {
  const f = await fixture(t);
  f.remote.sets = [{ id: 'set', attributes: { screenshotDisplayType: 'APP_IPHONE_67' } }];
  f.remote.images.push({
    id: 'existing',
    attributes: {
      fileName: 'old.png',
      sourceFileChecksum: '0'.repeat(32),
      assetDeliveryState: { state: 'COMPLETE' },
    },
  });
  const proposal = await f.plan();
  assert.equal(f.writes.length, 0);
  assert.equal(f.verificationCount(), 0);
  assert.equal(proposal.proposal.content.locales[0].fields.name, 'Reviewed name');
  // The fake patches the last reserved image when an existing asset is present.
  const write = f.api.write;
  f.api.write = async (method, path, payload) => {
    if (path === '/v1/appScreenshots/image') {
      const old = f.remote.images.shift();
      const result = await write(method, path, payload);
      f.remote.images.unshift(old);
      return result;
    }
    return write(method, path, payload);
  };
  const result = await f.apply();
  assert.equal(result.status, 'prepared');
  assert.equal(f.remote.locales[0].attributes.whatsNew, 'Untouched');
  assert.equal(f.remote.infoLocales[0].attributes.subtitle, 'Keep subtitle');
  assert.equal(f.remote.images[0].id, 'existing');
  assert.equal(f.uploads.length, 1);
  assert.equal(f.uploads[0].options.headers.Authorization, undefined);
  assert.equal(f.uploads[0].options.redirect, 'error');
  assert.ok(
    f.writes.every(({ method, path }) => method !== 'DELETE' && !/review|build|commit/.test(path)),
  );
  const count = f.writes.length;
  await f.apply();
  assert.equal(f.writes.length, count);
  assert.ok(!JSON.stringify(f.saved).includes('private-signed-url'));
});

test('iOS creates exact manual-release draft and locale without uploading a binary', async (t) => {
  const f = await fixture(t, 'ios', { existing: false, screenshots: false });
  await f.plan();
  const result = await f.apply();
  assert.equal(result.status, 'prepared');
  assert.deepEqual(f.writes[0].payload.data.attributes, {
    platform: 'IOS',
    versionString: '1.2.0',
    releaseType: 'MANUAL',
  });
  assert.equal(f.remote.locales[0].attributes.description, 'Reviewed description');
});

test('plan rejects published/newer/other active iOS versions before any writes', async (t) => {
  for (const version of [
    { versionString: '1.2.0', appStoreState: 'READY_FOR_DISTRIBUTION' },
    { versionString: '1.3.0', appStoreState: 'PREPARE_FOR_SUBMISSION' },
    { versionString: '1.1.0', appStoreState: 'WAITING_FOR_REVIEW' },
  ]) {
    const f = await fixture(t);
    f.remote.versions[0].attributes = version;
    await assert.rejects(f.plan());
    assert.equal(f.writes.length, 0);
  }
});

test('wrong approval, remote drift and source rejection cannot mutate stores', async (t) => {
  const f = await fixture(t);
  await f.plan();
  await assert.rejects(
    prepareStoreContent(f.ctx, { mode: 'apply', approval: 'd'.repeat(64) }),
    /exact reviewed/,
  );
  f.remote.locales[0].attributes.description = 'External change';
  await assert.rejects(f.apply(), /changed after planning/);
  assert.equal(f.writes.length, 0);
  f.remote.locales[0].attributes.description = 'Old description';
  f.ctx.assertPublicationSource = async () => {
    throw new Error('unmerged source');
  };
  await assert.rejects(f.apply(), /unmerged/);
  assert.equal(f.writes.length, 0);
});

test('unknown text result is reconciled from desired remote bytes, never blindly replayed', async (t) => {
  const f = await fixture(t, 'ios', { screenshots: false });
  await f.plan();
  f.setFailure(null, (path) => path.startsWith('/v1/appStoreVersionLocalizations/'));
  await assert.rejects(f.apply(), /incomplete/);
  assert.equal(f.ctx.preparation.status, 'unknown');
  f.setFailure();
  await f.apply();
  assert.equal(
    f.writes.filter((op) => op.path.startsWith('/v1/appStoreVersionLocalizations/')).length,
    1,
  );
  assert.equal(f.ctx.preparation.status, 'prepared');
});

test('unknown absent writes remain blocked; observe is read-only and keeps error details private', async (t) => {
  const f = await fixture(t, 'ios', { screenshots: false });
  await f.plan();
  f.setFailure(() => true);
  await assert.rejects(f.apply(), /incomplete/);
  const count = f.writes.length;
  f.setFailure();
  await assert.rejects(f.apply(), /incomplete/);
  assert.equal(f.writes.length, count);
  await prepareStoreContent(f.ctx, { mode: 'observe' });
  assert.equal(f.writes.length, count);
  assert.ok(!JSON.stringify(f.saved).includes('private provider'));
});

test('unknown screenshot upload preserves reservation ID and never uploads twice', async (t) => {
  const f = await fixture(t);
  await f.plan();
  f.setFailure(null, null, true);
  await assert.rejects(f.apply(), /incomplete/);
  assert.ok(Object.values(f.ctx.preparation.steps).some((step) => step.providerId === 'image'));
  f.setFailure();
  await assert.rejects(f.apply(), /incomplete/);
  assert.equal(f.uploads.length, 1);
  assert.equal(f.writes.filter((op) => op.path === '/v1/appScreenshots').length, 1);
});

test('Google preparation creates one uncommitted edit and publication verifies the same edit/content', async (t) => {
  const f = await fixture(t, 'android');
  await f.plan();
  assert.equal(f.writes.length, 0);
  await f.apply();
  assert.equal(f.ctx.preparation.status, 'prepared');
  assert.ok(f.writes.every(({ path }) => !/commit|bundles|tracks/.test(path)));
  const count = f.writes.length;
  await f.apply();
  assert.equal(f.writes.length, count);
  await verifyPreparedPlayContent(f.ctx, f.ctx.preparation.edit);
  await assert.rejects(verifyPreparedPlayContent(f.ctx, { id: 'foreign' }));
  f.remote.listings[0].title = 'Foreign change';
  await assert.rejects(verifyPreparedPlayContent(f.ctx, f.ctx.preparation.edit), /changed/);
});

test('Google lost edit creation response cannot create a replacement edit', async (t) => {
  const f = await fixture(t, 'android');
  await f.plan();
  f.setFailure(null, (path) => path === 'edits');
  await assert.rejects(f.apply(), /incomplete/);
  f.setFailure();
  await assert.rejects(f.apply(), /incomplete/);
  assert.equal(f.writes.length, 1);
});

test('expired Play edit blocks preparation and publication without replacement', async (t) => {
  const f = await fixture(t, 'android');
  await f.plan();
  await f.apply();
  f.remote.edit.expiryTimeSeconds = '1';
  const count = f.writes.length;
  await assert.rejects(f.apply(), /expired/);
  await assert.rejects(verifyPreparedPlayContent(f.ctx, f.ctx.preparation.edit), /expired/);
  assert.equal(f.writes.length, count);
});

test('content rejects changed/untracked bytes, symlinks, traversal, mismatched version and unsupported fields', async (t) => {
  const f = await fixture(t);
  await f.plan();
  await writeFile(join(f.ctx.root, 'screen.png'), Buffer.concat([f.png, Buffer.from('changed')]));
  await assert.rejects(loadStoreContent(f.ctx), /tracked/);
  await rm(join(f.ctx.root, 'screen.png'));
  await symlink('/etc/hosts', join(f.ctx.root, 'screen.png'));
  await assert.rejects(loadStoreContent(f.ctx), /regular/);
  for (const update of [
    (m) => {
      m.version = '2.0.0';
    },
    (m) => {
      m.locales[0].fields.reviewPassword = 'secret';
    },
    (m) => {
      m.locales[0].screenshots[0].path = '../escape.png';
    },
    (m) => {
      m.locales[0].fields.supportUrl = 'https://user:pass@example.com';
    },
  ]) {
    const m = clone(f.manifest);
    update(m);
    await f.input('content.json', JSON.stringify(m));
    await assert.rejects(loadStoreContent(f.ctx));
  }
});

test('Apple upload rejects foreign hosts, credentials, overlapping/incomplete parts before any network call', async () => {
  let requests = 0;
  const ctx = {
    fetch: async () => {
      requests++;
      return new Response();
    },
  };
  const valid = {
    url: 'https://store-001.blobstore.apple.com/path',
    method: 'PUT',
    offset: 0,
    length: 4,
    requestHeaders: [],
  };
  for (const operations of [
    [{ ...valid, url: 'https://evil.example/path' }],
    [{ ...valid, url: 'http://store-001.blobstore.apple.com/path' }],
    [{ ...valid, requestHeaders: [{ name: 'Authorization', value: 'secret' }] }],
    [{ ...valid, length: 2 }],
    [valid, { ...valid, offset: 1 }],
    [{ ...valid, offset: -1 }],
  ])
    await assert.rejects(uploadAppleParts(ctx, operations, Buffer.alloc(4)));
  assert.equal(requests, 0);
});

test('content CLI rejects publication/executor switches and missing platform before execution', async () => {
  for (const args of [
    ['store-plan', '--ref', 'HEAD'],
    ['store-plan', '--ref', 'HEAD', '--platforms', 'ios,android'],
    ['store-plan', '--ref', 'HEAD', '--platforms', 'ios', '--publish'],
    ['store-plan', '--ref', 'HEAD', '--platforms', 'ios', '--executor', 'github'],
    ['store-observe', 'release-' + 'a'.repeat(24), '--approve', 'b'.repeat(64)],
  ])
    await assert.rejects(main({ args, output() {}, environment: {} }));
});

test('observe settles completed unknown writes without requiring a current source or sending new mutations', async (t) => {
  const f = await fixture(t, 'ios', { screenshots: false });
  await f.plan();
  f.setFailure(null, (path) => path.startsWith('/v1/appInfoLocalizations/'));
  await assert.rejects(f.apply());
  assert.equal(f.ctx.preparation.status, 'unknown');
  f.ctx.assertPublicationSource = async () => {
    throw new Error('old source');
  };
  const count = f.writes.length;
  const result = await prepareStoreContent(f.ctx, { mode: 'observe' });
  assert.equal(result.status, 'prepared');
  assert.equal(f.writes.length, count);
});

test('only a known unavailable unuploaded Play edit can be retired by observation', async (t) => {
  const f = await fixture(t, 'android');
  await f.plan();
  await f.apply();
  f.api.read = async () => {
    throw Object.assign(new Error('gone'), { status: 404 });
  };
  const result = await prepareStoreContent(f.ctx, { mode: 'observe' });
  assert.equal(result.status, 'edit-unavailable');
  f.ctx.artifact = { sha256: 'a'.repeat(64) };
  await assert.rejects(prepareStoreContent(f.ctx, { mode: 'observe' }));
});

test('aborted image transfer never commits its reservation or sends further writes', async (t) => {
  const f = await fixture(t);
  const abort = new AbortController();
  f.ctx.signal = abort.signal;
  await f.plan();
  f.ctx.fetch = async () => {
    abort.abort();
    return new Response();
  };
  await assert.rejects(f.apply());
  assert.equal(
    f.writes.filter(
      ({ method, path }) => method === 'PATCH' && path.startsWith('/v1/appScreenshots/'),
    ).length,
    0,
  );
});

test('a downstream Play listing 404 never retires a live owned edit', async (t) => {
  const f = await fixture(t, 'android');
  await f.plan();
  await f.apply();
  const read = f.api.read;
  f.api.read = async (path) => {
    if (path.endsWith('/listings')) throw Object.assign(new Error('listing race'), { status: 404 });
    return read(path);
  };
  await assert.rejects(prepareStoreContent(f.ctx, { mode: 'observe' }));
  assert.equal(f.ctx.preparation.status, 'prepared');
  assert.notEqual(f.ctx.preparation.status, 'edit-unavailable');
});

test('malformed Play expiry cannot establish a prepared edit', async (t) => {
  const f = await fixture(t, 'android');
  await f.plan();
  await f.apply();
  delete f.remote.edit.expiryTimeSeconds;
  await assert.rejects(
    verifyPreparedPlayContent(f.ctx, f.ctx.preparation.edit),
    /expired or changed/,
  );
});
