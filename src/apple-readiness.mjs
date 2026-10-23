import { readdir, readFile } from 'node:fs/promises';

export class AppleListingError extends Error {}

// Deliberately return presence/counts only. Provider review credentials and
// contact values must never enter command output or the release journal.
export async function auditAppleListing({
  metadata,
  appId,
  version,
  list,
  read,
  metadataWillUpload = true,
}) {
  const localePattern = /^[a-z]{2,3}(?:-[A-Za-z0-9]+)*$/;
  const locales = new Map();
  const defaults = {};
  for (const entry of await readdir(metadata, { withFileTypes: true })) {
    if (!entry.isDirectory() || (entry.name !== 'default' && !localePattern.test(entry.name)))
      continue;
    const fields = entry.name === 'default' ? defaults : {};
    for (const file of await readdir(`${metadata}/${entry.name}`)) {
      if (
        !/^(name|description|keywords|support_url|release_notes|promotional_text)\.txt$/.test(file)
      )
        continue;
      fields[file.slice(0, -4)] = (
        await readFile(`${metadata}/${entry.name}/${file}`, 'utf8')
      ).trim();
    }
    if (entry.name !== 'default') locales.set(entry.name, fields);
  }
  if (metadataWillUpload && !locales.size)
    throw new AppleListingError('No explicit App Store locale directories were found.');
  const versions = await list(
    `/v1/apps/${encodeURIComponent(appId)}/appStoreVersions?filter[platform]=IOS&limit=200`,
  );
  const validVersion = (value) => typeof value === 'string' && /^\d+(?:\.\d+){0,2}$/.test(value);
  if (
    !validVersion(version) ||
    versions.data.some((v) => !v.id || !validVersion(v.attributes?.versionString))
  )
    throw new AppleListingError('App Store version history could not be verified.');
  const newer = (candidate) => {
    const left = candidate.split('.').map(BigInt),
      right = version.split('.').map(BigInt);
    for (let i = 0; i < Math.max(left.length, right.length); i++) {
      if ((left[i] ?? 0n) !== (right[i] ?? 0n)) return (left[i] ?? 0n) > (right[i] ?? 0n);
    }
    return false;
  };
  if (versions.data.some((v) => newer(v.attributes.versionString)))
    throw new AppleListingError(
      'A newer App Store version supersedes this release. Replan explicitly.',
    );
  const targets = versions.data.filter((v) => v.attributes?.versionString === version);
  if (targets.length !== 1 || !targets[0].id)
    throw new AppleListingError(
      'Create the exact iOS App Store version draft before publication preflight.',
    );
  const versionState = targets[0].attributes.appVersionState ?? targets[0].attributes.appStoreState;
  if (
    ![
      'PREPARE_FOR_SUBMISSION',
      'REJECTED',
      'METADATA_REJECTED',
      'INVALID_BINARY',
      'DEVELOPER_REJECTED',
    ].includes(versionState)
  )
    throw new AppleListingError(
      'The planned App Store version is not editable; observe existing publication instead.',
    );
  const releaseNotesRequired = versions.data.some((v) => v.id !== targets[0].id);
  const id = encodeURIComponent(targets[0].id);
  const remote = await list(`/v1/appStoreVersions/${id}/appStoreVersionLocalizations?limit=200`);
  const remoteLocales = new Map();
  for (const item of remote.data) {
    const locale = item.attributes?.locale;
    if (!localePattern.test(locale ?? '') || !item.id || remoteLocales.has(locale))
      throw new AppleListingError('App Store localizations are missing or ambiguous.');
    remoteLocales.set(locale, item);
  }
  if (!remoteLocales.size)
    throw new AppleListingError('No saved App Store localizations are available.');
  for (const locale of metadataWillUpload ? locales.keys() : []) {
    if (!remoteLocales.has(locale))
      throw new AppleListingError(`App Store localization ${locale} is missing or ambiguous.`);
  }
  const report = [];
  for (const [locale, item] of remoteLocales) {
    const fields = locales.get(locale);
    const required = {
      description: 'description',
      keywords: 'keywords',
      supportUrl: 'support_url',
    };
    if (releaseNotesRequired) required.whatsNew = 'release_notes';
    for (const [key, localKey] of Object.entries(required)) {
      // Deliver applies defaults only to enabled local languages and absent fields.
      // Explicit blanks suppress defaults but are skipped during upload.
      const pending =
        metadataWillUpload && fields ? (fields[localKey] ?? defaults[localKey]) : undefined;
      const value = pending || item.attributes[key];
      if (typeof value !== 'string' || !value.trim())
        throw new AppleListingError(`Required App Store ${localKey} is missing for ${locale}.`);
    }
    const sets = await list(
      `/v1/appStoreVersionLocalizations/${encodeURIComponent(item.id)}/appScreenshotSets?limit=200`,
    );
    let complete = 0;
    for (const set of sets.data) {
      if (
        !['APP_IPHONE_69', 'APP_IPHONE_67', 'APP_IPHONE_65'].includes(
          set.attributes?.screenshotDisplayType,
        )
      )
        continue;
      const screenshots = await list(
        `/v1/appScreenshotSets/${encodeURIComponent(set.id)}/appScreenshots?limit=200`,
      );
      for (const screenshot of screenshots.data) {
        if (screenshot.attributes?.assetDeliveryState?.state !== 'COMPLETE')
          throw new AppleListingError(
            `App Store screenshots are not fully processed for ${locale}.`,
          );
        complete++;
      }
    }
    if (!complete)
      throw new AppleListingError(`App Store iPhone screenshots are missing for ${locale}.`);
    report.push({ locale, completeIphoneScreenshots: complete });
  }
  const review = await read(`/v1/appStoreVersions/${id}/appStoreReviewDetail`);
  const attributes = review.data?.attributes;
  if (
    !attributes ||
    !['contactFirstName', 'contactLastName', 'contactPhone', 'contactEmail'].every(
      (key) => typeof attributes[key] === 'string' && attributes[key].trim(),
    )
  )
    throw new AppleListingError('App Store review contact is incomplete.');
  if (typeof attributes.demoAccountRequired !== 'boolean')
    throw new AppleListingError('App Store review sign-in requirement is unconfirmed.');
  if (
    attributes.demoAccountRequired &&
    ![attributes.demoAccountName, attributes.demoAccountPassword].every(
      (v) => typeof v === 'string' && v.trim(),
    )
  )
    throw new AppleListingError('App Store requires a complete private review account.');
  return {
    versionId: targets[0].id,
    versionState,
    releaseNotesRequired,
    locales: report,
    reviewContactComplete: true,
    reviewAccountRequired: attributes.demoAccountRequired,
    observedAt: new Date().toISOString(),
  };
}
