import { lstat, readFile } from 'node:fs/promises';
import { resolve, relative, sep, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { digest } from './state.mjs';
import { contentSession } from './stores.mjs';

const fields = {
  ios: ['description', 'keywords', 'whatsNew', 'supportUrl', 'marketingUrl', 'promotionalText'],
  android: ['title', 'shortDescription', 'fullDescription', 'video'],
};
const infoFields = ['name', 'subtitle', 'privacyPolicyUrl'];
const editable = new Set([
  'PREPARE_FOR_SUBMISSION',
  'REJECTED',
  'METADATA_REJECTED',
  'DEVELOPER_REJECTED',
  'INVALID_BINARY',
]);
const segment = encodeURIComponent;
const hash = (bytes, algorithm) => createHash(algorithm).update(bytes).digest('hex');
const stateOf = (version) => version.attributes.appVersionState ?? version.attributes.appStoreState;
const relation = (type, id) => ({ data: { type, id } });
const body = (type, attributes, relationships, id) => ({
  data: { type, ...(id ? { id } : {}), attributes, ...(relationships ? { relationships } : {}) },
});
const fail = (message) => {
  throw new Error(message);
};
function keys(value, allowed) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !allowed.includes(key))
  )
    fail('Store content contains unsupported fields.');
}
async function localFile(root, name, limit) {
  if (typeof name !== 'string' || !name || isAbsolute(name) || name.split(/[\\/]/).includes('..'))
    fail('Content inputs must be checkout-relative files.');
  const file = resolve(root, name);
  if (!file.startsWith(resolve(root) + sep)) fail('Content input escapes its checkout.');
  let current = resolve(root);
  for (const part of ['', ...relative(current, file).split(sep)]) {
    current = resolve(current, part);
    const info = await lstat(current);
    if (
      info.isSymbolicLink() ||
      (current === file ? !info.isFile() || info.size > limit : !info.isDirectory())
    )
      fail('Content input must be a bounded regular file without symlinks.');
  }
  const bytes = await readFile(file);
  if (bytes.length > limit) fail('Content input exceeds its size limit.');
  return bytes;
}
export async function loadStoreContent(ctx) {
  const load = async (name, limit) => {
    const bytes = await localFile(ctx.root, name, limit);
    const tracked = (
      await ctx.command('git', ['rev-parse', '--verify', `${ctx.plan.source}:${name}`], {
        cwd: ctx.root,
        sensitive: true,
        diagnostics: false,
      })
    ).stdout.trim();
    const blob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    if (tracked !== blob)
      fail('Content inputs must exactly match files tracked in the planned source.');
    return bytes;
  };
  const input = JSON.parse(await load(ctx.config.stores?.[ctx.platform]?.contentPath, 1024 * 1024));
  keys(input, ['schemaVersion', 'platform', 'version', 'locales']);
  if (
    input.schemaVersion !== 1 ||
    input.platform !== ctx.platform ||
    input.version !== ctx.plan.version ||
    !/^\d+(?:\.\d+){0,2}$/.test(input.version ?? '') ||
    !fields[ctx.platform]
  )
    fail('Content identity must match the planned platform and version.');
  if (!Array.isArray(input.locales) || !input.locales.length || input.locales.length > 40)
    fail('Content requires 1–40 explicit locales.');
  const locales = [],
    images = new Map(),
    names = new Set();
  let totalBytes = 0;
  for (const entry of input.locales) {
    keys(entry, ['locale', 'fields', 'screenshots']);
    if (!/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(entry.locale ?? '') || names.has(entry.locale))
      fail('Content locales must be unique language tags.');
    names.add(entry.locale);
    keys(entry.fields, [...fields[ctx.platform], ...(ctx.platform === 'ios' ? infoFields : [])]);
    for (const [key, value] of Object.entries(entry.fields)) {
      if (typeof value !== 'string' || value.length > 5000 || !value.trim())
        fail('Content fields require nonempty bounded strings.');
      if (['supportUrl', 'marketingUrl', 'privacyPolicyUrl', 'video'].includes(key)) {
        const url = new URL(value);
        if (url.protocol !== 'https:' || url.username || url.password)
          fail('Content URLs must be public HTTPS URLs.');
      }
    }
    if (!Array.isArray(entry.screenshots ?? []) || (entry.screenshots?.length ?? 0) > 10)
      fail('A locale can request at most ten screenshots.');
    const screenshots = [];
    for (const screenshot of entry.screenshots ?? []) {
      keys(screenshot, ['path', 'displayType']);
      const allowed =
        ctx.platform === 'ios'
          ? ['APP_IPHONE_65', 'APP_IPHONE_67', 'APP_IPHONE_69']
          : ['phoneScreenshots'];
      if (!allowed.includes(screenshot.displayType)) fail('Unsupported screenshot display type.');
      const bytes = await load(screenshot.path, 10 * 1024 * 1024);
      totalBytes += bytes.length;
      if (totalBytes > 100 * 1024 * 1024) fail('Content screenshots exceed 100 MiB.');
      if (
        bytes.length < 33 ||
        bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' ||
        bytes.subarray(12, 16).toString() !== 'IHDR'
      )
        fail('Screenshots must be PNG files.');
      const width = bytes.readUInt32BE(16),
        height = bytes.readUInt32BE(20);
      const sizes = {
        APP_IPHONE_65: [
          [1242, 2688],
          [1284, 2778],
        ],
        APP_IPHONE_67: [[1290, 2796]],
        APP_IPHONE_69: [
          [1320, 2868],
          [1260, 2736],
        ],
      };
      if (
        ctx.platform === 'ios' &&
        !sizes[screenshot.displayType].some(
          ([w, h]) => (w === width && h === height) || (h === width && w === height),
        )
      )
        fail('Screenshot dimensions do not match the declared iPhone display.');
      if (width < 320 || height < 320 || width > 10000 || height > 10000)
        fail('Screenshot dimensions are outside supported bounds.');
      const sha256 = digest(bytes),
        md5 = hash(bytes, 'md5');
      if (
        screenshots.some(
          (item) => item.sha256 === sha256 && item.displayType === screenshot.displayType,
        )
      )
        fail('Duplicate screenshot bytes in one display set.');
      images.set(sha256, bytes);
      screenshots.push({ ...screenshot, sha256, md5, size: bytes.length, width, height });
    }
    if (!Object.keys(entry.fields).length && !screenshots.length)
      fail('Each locale must request text or screenshots.');
    locales.push({ locale: entry.locale, fields: entry.fields, screenshots });
  }
  const manifest = { schemaVersion: 1, platform: ctx.platform, version: input.version, locales };
  return { manifest, inputDigest: digest(manifest), images };
}

async function appleSnapshot(api, version, requireEditable = true) {
  const app = (await api.read(`/v1/apps/${segment(api.cfg.appId)}`)).data;
  if (app?.attributes?.bundleId !== api.cfg.bundleId)
    fail('Remote App Store identity does not match configuration.');
  const versions = await api.list(
    `/v1/apps/${segment(api.cfg.appId)}/appStoreVersions?filter[platform]=IOS&limit=200`,
  );
  const history = versions.map((item) => ({
    id: item.id,
    version: item.attributes?.versionString,
    state: stateOf(item),
  }));
  if (history.some((item) => !item.id || !/^\d+(?:\.\d+){0,2}$/.test(item.version ?? '')))
    fail('Invalid App Store version history.');
  const compare = (left, right) => {
    const a = left.split('.').map(BigInt),
      b = right.split('.').map(BigInt);
    for (let i = 0; i < 3; i++)
      if ((a[i] ?? 0n) !== (b[i] ?? 0n)) return (a[i] ?? 0n) > (b[i] ?? 0n) ? 1 : -1;
    return 0;
  };
  if (requireEditable && history.some((item) => compare(item.version, version) > 0))
    fail('A newer App Store version supersedes the content plan.');
  const targets = history.filter((item) => item.version === version);
  if (targets.length > 1) fail('Ambiguous App Store version.');
  const target = targets[0] ?? null;
  if (requireEditable && target && !editable.has(target.state))
    fail('The exact App Store version is not editable.');
  if (
    requireEditable &&
    !target &&
    history.some(
      (item) =>
        ![
          'READY_FOR_DISTRIBUTION',
          'READY_FOR_SALE',
          'REMOVED_FROM_SALE',
          'DEVELOPER_REMOVED_FROM_SALE',
          'REPLACED_WITH_NEW_VERSION',
        ].includes(item.state),
    )
  )
    fail('Another App Store version is active; reconcile it before creating a draft.');
  const locales = target
    ? await api.list(
        `/v1/appStoreVersions/${segment(target.id)}/appStoreVersionLocalizations?limit=200`,
      )
    : [];
  const infos = await api.list(`/v1/apps/${segment(api.cfg.appId)}/appInfos?limit=200`);
  const editableInfos = infos.filter((item) => editable.has(stateOf(item)));
  if (editableInfos.length > 1) fail('Ambiguous editable App Store app information.');
  const info = editableInfos[0] ?? null;
  const infoLocales = info
    ? await api.list(`/v1/appInfos/${segment(info.id)}/appInfoLocalizations?limit=200`)
    : [];
  const normalized = [];
  for (const item of locales) {
    if (
      !item.id ||
      !item.attributes?.locale ||
      normalized.some((loc) => loc.locale === item.attributes.locale)
    )
      fail('Invalid App Store localizations.');
    const sets = await api.list(
      `/v1/appStoreVersionLocalizations/${segment(item.id)}/appScreenshotSets?limit=200`,
    );
    const screenshots = [];
    for (const set of sets) {
      const assets = await api.list(
        `/v1/appScreenshotSets/${segment(set.id)}/appScreenshots?limit=200`,
      );
      screenshots.push({
        id: set.id,
        displayType: set.attributes.screenshotDisplayType,
        assets: assets.map((asset) => ({
          id: asset.id,
          fileName: asset.attributes.fileName,
          checksum: asset.attributes.sourceFileChecksum,
          state: asset.attributes.assetDeliveryState?.state,
        })),
      });
    }
    normalized.push({
      id: item.id,
      locale: item.attributes.locale,
      fields: Object.fromEntries(fields.ios.map((key) => [key, item.attributes[key] ?? null])),
      screenshots,
    });
  }
  return {
    target,
    locales: normalized,
    info: info
      ? {
          id: info.id,
          locales: infoLocales.map((item) => ({
            id: item.id,
            locale: item.attributes.locale,
            fields: Object.fromEntries(
              infoFields.map((key) => [key, item.attributes[key] ?? null]),
            ),
          })),
        }
      : null,
  };
}
async function playSnapshot(api, edit) {
  if (!edit) return { edit: null, locales: [] };
  let current;
  try {
    current = await api.read(`edits/${segment(edit.id)}`);
  } catch (error) {
    if ([404, 410].includes(error.status)) error.preparedEditUnavailable = true;
    throw error;
  }
  if (
    current.id !== edit.id ||
    !/^\d+$/.test(String(current.expiryTimeSeconds)) ||
    Number(current.expiryTimeSeconds) * 1000 <= Date.now()
  )
    fail('The prepared Play edit expired or changed; no replacement is created automatically.');
  const response = await api.read(`edits/${segment(edit.id)}/listings`);
  const locales = [];
  for (const item of response.listings ?? []) {
    if (!item.language || locales.some((loc) => loc.locale === item.language))
      fail('Invalid Play localizations.');
    const assets = await api.read(
      `edits/${segment(edit.id)}/listings/${segment(item.language)}/phoneScreenshots`,
    );
    locales.push({
      locale: item.language,
      fields: Object.fromEntries(fields.android.map((key) => [key, item[key] ?? null])),
      screenshots: [
        {
          displayType: 'phoneScreenshots',
          assets: (assets.images ?? []).map((image) => ({
            id: image.id,
            checksum: image.sha256?.toLowerCase(),
            state: 'COMPLETE',
          })),
        },
      ],
    });
  }
  return { edit: { id: current.id, expiryTimeSeconds: current.expiryTimeSeconds }, locales };
}
const snapshot = (ctx, api, record, requireEditable = true) =>
  ctx.platform === 'ios'
    ? appleSnapshot(api, ctx.plan.version, requireEditable)
    : playSnapshot(api, record.edit);
function matches(manifest, remote) {
  if (!(remote.target || remote.edit)) return false;
  return manifest.locales.every((desired) => {
    const actual = remote.locales.find((item) => item.locale === desired.locale);
    return (
      actual &&
      Object.entries(desired.fields).every(
        ([key, value]) =>
          (infoFields.includes(key)
            ? remote.info?.locales.find((item) => item.locale === desired.locale)?.fields[key]
            : actual.fields[key]) === value,
      ) &&
      desired.screenshots.every((image) =>
        actual.screenshots.some(
          (set) =>
            set.displayType === image.displayType &&
            set.assets.some(
              (asset) =>
                asset.state === 'COMPLETE' &&
                asset.checksum?.toLowerCase() ===
                  (manifest.platform === 'ios' ? image.md5 : image.sha256),
            ),
        ),
      )
    );
  });
}

// Every request with external effects has an intent before the request. A lost
// response is reconciled by reads; absence never authorizes automatic replay.
export async function prepareStoreContent(ctx, { mode = 'plan', approval } = {}) {
  const input = await loadStoreContent(ctx);
  const api = await (ctx.session ?? contentSession)(ctx);
  let record = ctx.preparation;
  const persist = async () => {
    await ctx.savePreparation(record);
  };
  if (record && record.inputDigest !== input.inputDigest)
    fail('Content bytes changed after planning.');
  let remote;
  try {
    remote = await snapshot(ctx, api, record ?? {}, mode !== 'observe');
  } catch (error) {
    if (
      mode === 'observe' &&
      ctx.platform === 'android' &&
      record?.edit?.id &&
      !ctx.artifact &&
      !Object.keys(ctx.previous ?? {}).length &&
      error.preparedEditUnavailable === true
    ) {
      record.status = 'edit-unavailable';
      record.observation = {
        observedAt: new Date().toISOString(),
        matches: false,
        editId: record.edit.id,
        httpStatus: error.status,
      };
      await persist();
      return record;
    }
    throw error;
  }
  if (!record) {
    if (mode !== 'plan') fail('Plan store content before applying or observing it.');
    const proposal = {
      schemaVersion: 1,
      releaseId: ctx.plan.id,
      source: ctx.plan.source,
      configDigest: ctx.plan.configDigest,
      inputDigest: input.inputDigest,
      content: input.manifest,
      before: remote,
      screenshotPolicy: 'append-missing-preserve-existing',
      submitsForReview: false,
      selectsBuild: false,
    };
    record = {
      inputDigest: input.inputDigest,
      proposal,
      approval: digest(proposal),
      status: 'planned',
      steps: {},
    };
    await persist();
  }
  if (mode === 'plan') return record;
  if (mode === 'observe') {
    record.observation = {
      observedAt: new Date().toISOString(),
      matches: matches(input.manifest, remote),
      remote,
    };
    // Exact desired content can settle a lost response without replaying writes.
    if (record.status !== 'planned' && record.observation.matches) record.status = 'prepared';
    await persist();
    return record;
  }
  if (mode !== 'apply' || approval !== record.approval)
    fail('Apply requires the exact reviewed content approval digest.');
  if (record.status === 'planned' && digest(remote) !== digest(record.proposal.before))
    fail('Remote content changed after planning; review a new source plan.');
  await ctx.assertPublicationSource();
  await ctx.acquirePreparationTarget?.();
  if (
    record.status === 'planned' &&
    digest(await snapshot(ctx, api, record)) !== digest(record.proposal.before)
  )
    fail('Remote content changed after planning; review a new source plan.');
  record.status = 'applying';
  await persist();
  const effect = async (key, task) => {
    ctx.signal?.throwIfAborted();
    if (record.steps[key])
      fail(
        'An earlier content operation is unresolved; observe and reconcile without replaying it.',
      );
    await ctx.assertPublicationSource();
    record.steps[key] = { state: 'intent', at: new Date().toISOString() };
    await persist();
    const result = await task();
    ctx.signal?.throwIfAborted();
    record.steps[key] = { ...record.steps[key], state: 'confirmed', at: new Date().toISOString() };
    return result;
  };
  try {
    if (ctx.platform === 'ios' && !remote.target) {
      await effect('draft', () =>
        api.write(
          'POST',
          '/v1/appStoreVersions',
          body(
            'appStoreVersions',
            { platform: 'IOS', versionString: ctx.plan.version, releaseType: 'MANUAL' },
            { app: relation('apps', api.cfg.appId) },
          ),
        ),
      );
      await persist();
    }
    if (ctx.platform === 'android' && !record.edit) {
      const created = await effect('edit', () => api.write('POST', 'edits', {}));
      if (!created?.id || !/^\d+$/.test(String(created.expiryTimeSeconds)))
        fail('Play edit creation was not confirmed.');
      record.edit = { id: created.id, expiryTimeSeconds: created.expiryTimeSeconds };
      await persist();
    }
    remote = await snapshot(ctx, api, record);
    if (
      ctx.platform === 'ios' &&
      (!remote.target ||
        (input.manifest.locales.some((locale) =>
          Object.keys(locale.fields).some((key) => infoFields.includes(key)),
        ) &&
          !remote.info))
    )
      fail('Created draft/app information is not yet visible; observe before continuing.');
    record.baseline ??=
      record.proposal.before.target || record.proposal.before.edit
        ? record.proposal.before
        : remote;
    await persist();
    for (const desired of input.manifest.locales) {
      remote = await snapshot(ctx, api, record);
      const versionFields = Object.fromEntries(
        Object.entries(desired.fields).filter(([key]) => !infoFields.includes(key)),
      );
      const desiredInfo = Object.fromEntries(
        Object.entries(desired.fields).filter(([key]) => infoFields.includes(key)),
      );
      let actual = remote.locales.find((item) => item.locale === desired.locale);
      if (ctx.platform === 'ios' && !actual) {
        await effect(`locale:${desired.locale}`, () =>
          api.write(
            'POST',
            '/v1/appStoreVersionLocalizations',
            body(
              'appStoreVersionLocalizations',
              { locale: desired.locale, ...versionFields },
              { appStoreVersion: relation('appStoreVersions', remote.target.id) },
            ),
          ),
        );
        await persist();
        remote = await snapshot(ctx, api, record);
        actual = remote.locales.find((item) => item.locale === desired.locale);
        if (!actual) fail('Created App Store localization is not visible.');
      }
      const changed = Object.entries(versionFields).filter(
        ([key, value]) => actual?.fields[key] !== value,
      );
      if (changed.length) {
        const baseline = record.baseline.locales.find((item) => item.locale === desired.locale);
        if (
          changed.some(([key]) => (actual?.fields[key] ?? null) !== (baseline?.fields[key] ?? null))
        )
          fail('Remote text changed during content preparation.');
        if (ctx.platform === 'ios') {
          await effect(`text:${desired.locale}`, () =>
            api.write(
              'PATCH',
              `/v1/appStoreVersionLocalizations/${segment(actual.id)}`,
              body('appStoreVersionLocalizations', Object.fromEntries(changed), null, actual.id),
            ),
          );
        } else {
          const merged = { ...(actual?.fields ?? {}), ...desired.fields, language: desired.locale };
          for (const key of Object.keys(merged)) if (merged[key] === null) delete merged[key];
          if (!merged.title || !merged.shortDescription || !merged.fullDescription)
            fail('New Play listings require title, shortDescription and fullDescription.');
          await effect(`text:${desired.locale}`, () =>
            api.write(
              'PUT',
              `edits/${segment(record.edit.id)}/listings/${segment(desired.locale)}`,
              merged,
            ),
          );
        }
        await persist();
      }
      if (ctx.platform === 'ios' && Object.keys(desiredInfo).length) {
        remote = await snapshot(ctx, api, record);
        if (!remote.info) fail('Editable App Store app information is unavailable.');
        const infoLocale = remote.info.locales.find((item) => item.locale === desired.locale);
        const beforeInfo = record.baseline.info?.locales.find(
          (item) => item.locale === desired.locale,
        );
        const changedInfo = Object.entries(desiredInfo).filter(
          ([key, value]) => infoLocale?.fields[key] !== value,
        );
        if (changedInfo.length) {
          if (
            changedInfo.some(
              ([key]) => (infoLocale?.fields[key] ?? null) !== (beforeInfo?.fields[key] ?? null),
            )
          )
            fail('Remote app information changed during content preparation.');
          await effect(`info:${desired.locale}`, () =>
            infoLocale
              ? api.write(
                  'PATCH',
                  `/v1/appInfoLocalizations/${segment(infoLocale.id)}`,
                  body(
                    'appInfoLocalizations',
                    Object.fromEntries(changedInfo),
                    null,
                    infoLocale.id,
                  ),
                )
              : api.write(
                  'POST',
                  '/v1/appInfoLocalizations',
                  body(
                    'appInfoLocalizations',
                    { locale: desired.locale, ...desiredInfo },
                    { appInfo: relation('appInfos', remote.info.id) },
                  ),
                ),
          );
          await persist();
        }
      }
      for (const image of desired.screenshots) {
        remote = await snapshot(ctx, api, record);
        actual = remote.locales.find((item) => item.locale === desired.locale);
        let set = actual?.screenshots.find((item) => item.displayType === image.displayType);
        const checksum = ctx.platform === 'ios' ? image.md5 : image.sha256;
        if (
          set?.assets.some(
            (asset) => asset.checksum?.toLowerCase() === checksum && asset.state === 'COMPLETE',
          )
        )
          continue;
        if ((set?.assets.length ?? 0) >= (ctx.platform === 'ios' ? 10 : 8))
          fail('Screenshot set is full; existing assets are never deleted automatically.');
        const key = `image:${desired.locale}:${image.displayType}:${image.sha256}`;
        if (ctx.platform === 'android') {
          await effect(key, () =>
            api.write(
              'POST',
              `https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications/${segment(api.cfg.packageName)}/edits/${segment(record.edit.id)}/listings/${segment(desired.locale)}/phoneScreenshots?uploadType=media`,
              input.images.get(image.sha256),
              { 'Content-Type': 'image/png' },
            ),
          );
          await persist();
          continue;
        }
        if (!set) {
          await effect(`set:${desired.locale}:${image.displayType}`, () =>
            api.write(
              'POST',
              '/v1/appScreenshotSets',
              body(
                'appScreenshotSets',
                { screenshotDisplayType: image.displayType },
                {
                  appStoreVersionLocalization: relation('appStoreVersionLocalizations', actual.id),
                },
              ),
            ),
          );
          await persist();
          remote = await snapshot(ctx, api, record);
          set = remote.locales
            .find((item) => item.locale === desired.locale)
            ?.screenshots.find((item) => item.displayType === image.displayType);
          if (!set?.id) fail('Created screenshot set is not visible.');
        }
        // Compatibility with the existing ASC listing audit and Fastlane adapter.
        // No global asset-library migration or replacement/deletion is implied.
        await effect(key, async () => {
          const reserved = (
            await api.write(
              'POST',
              '/v1/appScreenshots',
              body(
                'appScreenshots',
                { fileName: `${image.sha256}.png`, fileSize: image.size },
                { appScreenshotSet: relation('appScreenshotSets', set.id) },
              ),
            )
          ).data;
          if (!reserved?.id) fail('Screenshot reservation was not confirmed.');
          record.steps[key].providerId = reserved.id;
          await persist();
          await uploadAppleParts(
            ctx,
            reserved.attributes?.uploadOperations,
            input.images.get(image.sha256),
          );
          await api.write(
            'PATCH',
            `/v1/appScreenshots/${segment(reserved.id)}`,
            body(
              'appScreenshots',
              { uploaded: true, sourceFileChecksum: image.md5 },
              null,
              reserved.id,
            ),
          );
        });
        await persist();
      }
    }
    remote = await snapshot(ctx, api, record);
    record.observation = {
      observedAt: new Date().toISOString(),
      matches: matches(input.manifest, remote),
      remote,
    };
    record.status = record.observation.matches ? 'prepared' : 'processing';
    await persist();
    return record;
  } catch {
    record.status = 'unknown';
    await persist();
    fail(
      'Store content preparation is incomplete. Use store-observe; no upload or submission will be retried automatically.',
    );
  }
}

export async function uploadAppleParts(ctx, operations, bytes) {
  if (!Array.isArray(operations) || !operations.length || operations.length > 100)
    fail('Invalid screenshot upload operations.');
  let end = 0;
  const prepared = operations
    .toSorted((a, b) => a.offset - b.offset)
    .map((op) => {
      const url = new URL(op.url);
      if (
        url.protocol !== 'https:' ||
        !url.hostname.endsWith('.blobstore.apple.com') ||
        url.port ||
        url.username ||
        url.password ||
        op.method !== 'PUT' ||
        !Number.isSafeInteger(op.offset) ||
        !Number.isSafeInteger(op.length) ||
        op.offset !== end ||
        op.length < 1 ||
        op.offset + op.length > bytes.length
      )
        fail('Invalid screenshot upload destination or byte range.');
      end += op.length;
      const headers = {};
      if (!Array.isArray(op.requestHeaders)) fail('Invalid screenshot upload headers.');
      for (const header of op.requestHeaders) {
        if (
          typeof header.name !== 'string' ||
          typeof header.value !== 'string' ||
          /^(authorization|cookie|host|proxy-authorization)$/i.test(header.name) ||
          /[\r\n]/.test(header.name + header.value)
        )
          fail('Unsafe screenshot upload headers.');
        headers[header.name] = header.value;
      }
      return { ...op, headers };
    });
  if (end !== bytes.length) fail('Screenshot upload ranges do not cover the file.');
  for (const op of prepared) {
    const timeout = AbortSignal.timeout(60000);
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout;
    signal.throwIfAborted();
    try {
      const response = await (ctx.fetch ?? fetch)(op.url, {
        method: 'PUT',
        headers: op.headers,
        body: bytes.subarray(op.offset, op.offset + op.length),
        redirect: 'error',
        signal,
      });
      signal.throwIfAborted();
      if (!response.ok) fail('Upload rejected.');
      await response.body?.cancel();
    } catch {
      fail('Screenshot byte upload result is unconfirmed.');
    }
  }
}

// Called by publication before adopting/committing the prepared Play edit.
export async function verifyPreparedPlayContent(ctx, edit) {
  const input = await loadStoreContent(ctx);
  const record = ctx.preparation;
  if (
    record?.status !== 'prepared' ||
    record.inputDigest !== input.inputDigest ||
    record.edit?.id !== edit.id
  )
    fail('Play content preparation is missing or differs from the publication edit.');
  const api = await (ctx.session ?? contentSession)(ctx);
  if (!matches(input.manifest, await playSnapshot(api, edit)))
    fail('Prepared Play listing or screenshots changed before publication.');
}

export async function verifyPreparedAppleContent(ctx) {
  const input = await loadStoreContent(ctx);
  if (ctx.preparation?.status !== 'prepared' || ctx.preparation.inputDigest !== input.inputDigest)
    fail('iOS content preparation is missing or differs from the publication inputs.');
  const api = await (ctx.session ?? contentSession)(ctx);
  if (!matches(input.manifest, await appleSnapshot(api, ctx.plan.version)))
    fail('Prepared iOS listing or screenshots changed before publication.');
}
