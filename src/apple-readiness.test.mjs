import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditAppleListing } from './apple-readiness.mjs';

async function fixture(t) {
  const metadata = await mkdtemp(join(tmpdir(), 'apple-readiness-'));
  t.after(() => rm(metadata, { recursive: true, force: true }));
  await mkdir(join(metadata, 'en-US'));
  const version = (id, number, state = 'PREPARE_FOR_SUBMISSION') => ({
    id,
    attributes: { versionString: number, appStoreState: state },
  });
  const locale = (name) => ({
    id: name,
    attributes: {
      locale: name,
      description: 'Saved description',
      keywords: 'app',
      supportUrl: 'https://example.invalid',
      whatsNew: 'Saved notes',
    },
  });
  const versions = [version('current', '2.0.0')];
  const locales = [locale('en-US')];
  const missingScreenshots = new Set();
  const calls = [];
  const options = {
    metadata,
    appId: '123',
    version: '2.0.0',
    list: async (url) => {
      calls.push(url);
      if (url.includes('/appStoreVersions?')) return { data: versions };
      if (url.includes('/appStoreVersionLocalizations?')) return { data: locales };
      if (url.includes('/appScreenshotSets?')) {
        const id = url.split('/')[3];
        return {
          data: missingScreenshots.has(id)
            ? []
            : [{ id: 'screens', attributes: { screenshotDisplayType: 'APP_IPHONE_69' } }],
        };
      }
      if (url.includes('/appScreenshots?'))
        return {
          data: [{ attributes: { assetDeliveryState: { state: 'COMPLETE' } } }],
        };
      assert.fail('Unexpected listing read');
    },
    read: async () => ({
      data: {
        attributes: {
          contactFirstName: 'PRIVATE',
          contactLastName: 'PRIVATE',
          contactPhone: 'PRIVATE',
          contactEmail: 'PRIVATE',
          demoAccountRequired: true,
          demoAccountName: 'PRIVATE',
          demoAccountPassword: 'PRIVATE',
        },
      },
    }),
  };
  return { metadata, options, versions, locales, version, locale, missingScreenshots, calls };
}

test('listing audits remote-only locales and keeps 6.9-inch screenshot support', async (t) => {
  const f = await fixture(t);
  f.locales.push(f.locale('fr-FR'));
  const report = await auditAppleListing(f.options);
  assert.deepEqual(
    report.locales.map((l) => l.locale),
    ['en-US', 'fr-FR'],
  );
  assert.equal(JSON.stringify(report).includes('PRIVATE'), false);
  f.missingScreenshots.add('fr-FR');
  await assert.rejects(auditAppleListing(f.options), /screenshots.*fr-FR/);
  f.missingScreenshots.clear();
  f.locales[1].attributes.description = '';
  await assert.rejects(auditAppleListing(f.options), /description.*fr-FR/);
});

test('only sole-version history permits omitted release notes', async (t) => {
  const f = await fixture(t);
  f.locales[0].attributes.whatsNew = '';
  assert.equal((await auditAppleListing(f.options)).releaseNotesRequired, false);
  f.versions.push(f.version('previous', '1.0.0', 'READY_FOR_DISTRIBUTION'));
  await assert.rejects(auditAppleListing(f.options), /release_notes/);
  await writeFile(join(f.metadata, 'en-US/release_notes.txt'), 'New notes');
  assert.equal((await auditAppleListing(f.options)).releaseNotesRequired, true);
});

test('newer, ambiguous, malformed or uneditable versions fail before media reads', async (t) => {
  for (const kind of ['newer', 'duplicate', 'malformed', 'review', 'precedence']) {
    const f = await fixture(t);
    if (kind === 'newer') f.versions.push(f.version('newer', '2.0.1'));
    if (kind === 'duplicate') f.versions.push(f.version('duplicate', '2.0.0'));
    if (kind === 'malformed') f.versions.push(f.version('bad', 'invalid'));
    if (kind === 'review') f.versions[0].attributes.appStoreState = 'WAITING_FOR_REVIEW';
    if (kind === 'precedence') f.versions[0].attributes.appVersionState = 'READY_FOR_DISTRIBUTION';
    await assert.rejects(auditAppleListing(f.options));
    assert.equal(
      f.calls.some((p) => p.includes('appScreenshot')),
      false,
    );
  }
});

test('default metadata fills absent local fields, blanks preserve saved values and remote-only locales get no defaults', async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.metadata, 'default'));
  await writeFile(join(f.metadata, 'default/description.txt'), 'Default description');
  f.locales[0].attributes.description = '';
  await auditAppleListing(f.options);
  await writeFile(join(f.metadata, 'en-US/description.txt'), ' \n');
  await assert.rejects(auditAppleListing(f.options), /description/);
  f.locales[0].attributes.description = 'Saved description';
  await auditAppleListing(f.options);
  f.locales.push(f.locale('fr-FR'));
  f.locales[1].attributes.description = '';
  await assert.rejects(auditAppleListing(f.options), /description.*fr-FR/);
});

test('missing or duplicate localization identities never pass by inspecting only local folders', async (t) => {
  for (const kind of ['missing', 'duplicate', 'invalid']) {
    const f = await fixture(t);
    if (kind === 'missing') f.locales.length = 0;
    if (kind === 'duplicate') f.locales.push(f.locale('en-US'));
    if (kind === 'invalid') f.locales.push(f.locale('not/a/locale'));
    await assert.rejects(auditAppleListing(f.options), /localization/);
  }
});

test('prepared-content preflight cannot use skipped legacy metadata to hide missing remote copy', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.metadata, 'en-US', 'description.txt'), 'Legacy pending description');
  f.locales[0].attributes.description = '';
  await auditAppleListing(f.options);
  await assert.rejects(
    auditAppleListing({ ...f.options, metadataWillUpload: false }),
    /description/,
  );
});

test('remote-only prepared-content preflight rejects an empty localization inventory', async (t) => {
  const f = await fixture(t);
  f.locales.length = 0;
  await assert.rejects(auditAppleListing({ ...f.options, metadataWillUpload: false }), /No saved/);
});
