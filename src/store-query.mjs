import { withAppleRead, segment, need, present } from './apple-store-read.mjs';
import { describeAppleVersionState } from './apple-version-state.mjs';

export async function queryAppleVersions(reader) {
  if (!reader.app) return { ok: false };
  const ids = new Set();
  return reader.list('version-inventory', `/v1/apps/${segment(reader.target.appId)}/appStoreVersions?filter[platform]=IOS&limit=200`,
    ['platform', 'versionString'], item => {
      if (ids.has(item.id)) return false;
      ids.add(item.id);
      return item.type === 'appStoreVersions' && item.attributes.platform === 'IOS' &&
        present(item.attributes.versionString) && /^\d+(?:\.\d+){0,2}$/.test(item.attributes.versionString) && item.attributes.versionString.length <= 64;
    });
}
export function versionFacts(resource) {
  const attributes = resource.attributes;
  return { id: resource.id, version: attributes.versionString,
    ...describeAppleVersionState(attributes.appVersionState ?? attributes.appStoreState),
    releaseType: typeof attributes.releaseType === 'string' && /^[A-Z][A-Z0-9_]{0,99}$/.test(attributes.releaseType) ? attributes.releaseType : 'UNKNOWN' };
}
export async function queryAppleVersion(reader, options) {
  const inventory = await queryAppleVersions(reader);
  if (!inventory.ok) return { resolution: 'unavailable', versions: [] };
  // A repeated remote resource across pages is ambiguous, not a second proof.
  const matches = inventory.value.filter(item => item.attributes.versionString === options.candidateVersion);
  const versions = inventory.value.map(versionFacts);
  if (matches.length !== 1) return { resolution: matches.length ? 'ambiguous' : 'not-found', versions };
  const resource = matches[0], version = versionFacts(resource);
  if (version.rawState === null) reader.errors.push({ code: 'version-state', reason: 'missing-state' });
  const build = await reader.read('selected-build', `/v1/appStoreVersions/${segment(resource.id)}/build`);
  version.build = { observed: build.ok };
  if (build.ok) {
    if (build.value !== null && build.value.type !== 'builds') {
      reader.errors.push({ code: 'selected-build', reason: 'invalid-resource-type' });
      version.build.observed = false;
    } else {
      version.build.id = build.value?.id ?? null;
      if (options.expectedAppleBuildId !== undefined) version.build.matchesExpected = version.build.id === options.expectedAppleBuildId;
    }
  }
  return { resolution: 'found', versions, version, resource };
}
export async function listStoreVersions(options) {
  return withAppleRead(options, async reader => {
    const inventory = await queryAppleVersions(reader);
    const versions = inventory.ok ? inventory.value.map(versionFacts) : [];
    if (versions.some(version => version.rawState === null)) reader.errors.push({ code: 'version-state', reason: 'missing-state' });
    return { operation: 'store-versions', coverage: inventory.ok ? 'complete-ios-version-inventory' : 'incomplete', versions };
  });
}
export async function getStoreVersion(options) {
  need(typeof options.candidateVersion === 'string', 'store-status requires an exact candidate version');
  return withAppleRead(options, async reader => {
    const { resource, ...query } = await queryAppleVersion(reader, options);
    return { operation: 'store-status', candidateVersion: options.candidateVersion,
      interpretationScope: 'Version lifecycle only; build matching is separate from source, review-attempt and installation acceptance.', ...query };
  });
}
