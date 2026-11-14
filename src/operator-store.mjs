import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { assertAcceptanceTestedBuild, validateAcceptanceCounterparts } from './plan.mjs';
import { lstat, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { acquireLock, digest, loadState, releasePath, saveState } from './state.mjs';

function object(value, allowed, name) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !allowed.includes(key))
  )
    throw new Error(`Invalid ${name} fields`);
}
function text(value, name, max = 300) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f]/.test(value))
    throw new Error(`Invalid ${name}`);
  return value;
}
function choice(value, choices, name) {
  if (!choices.includes(value)) throw new Error(`Invalid ${name}`);
  return value;
}
function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value))
    throw new Error('Invalid observedAt');
  const date = new Date(value);
  if (
    !Number.isFinite(date.getTime()) ||
    date.toISOString().replace('.000Z', 'Z') !== value.replace('.000Z', 'Z') ||
    date.getTime() > Date.now()
  )
    throw new Error('Invalid or future observedAt');
  return value;
}

// This evaluates explicit observations only, never privacy behavior or legal compliance.
export function inspectPrivacyAssociation(privacy) {
  object(
    privacy,
    ['listingAppName', 'policyAppName', 'policyId', 'linkedPolicyId', 'reviewState'],
    'privacy',
  );
  text(privacy.listingAppName, 'listingAppName');
  text(privacy.policyAppName, 'policyAppName');
  text(privacy.policyId, 'policyId');
  if (privacy.linkedPolicyId !== null) text(privacy.linkedPolicyId, 'linkedPolicyId');
  choice(
    privacy.reviewState,
    ['unknown', 'draft', 'in_review', 'approved', 'rejected'],
    'privacy reviewState',
  );
  const blockers = [];
  if (privacy.listingAppName !== privacy.policyAppName) blockers.push('privacy_app_name_mismatch');
  if (privacy.reviewState !== 'approved') blockers.push('privacy_review_not_approved');
  if (privacy.linkedPolicyId !== privacy.policyId) blockers.push('privacy_policy_not_linked');
  return {
    state: blockers.length ? 'blocked' : 'matched',
    blockers,
    scope:
      'Observed name, review and association only; provider submission validation remains authoritative.',
  };
}

async function regularBytes(path) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 20 * 1024 * 1024)
    throw new Error('Evidence/input must be a regular file up to 20 MiB');
  return readFile(path);
}
async function validateReceipt(input, state, receiptPath) {
  object(
    input,
    [
      'schemaVersion',
      'releaseId',
      'source',
      'platform',
      'store',
      'appId',
      'draftId',
      'artifactSha256',
      'observedAt',
      'facts',
      'privacy',
      'evidence',
      'nextAction',
    ],
    'receipt',
  );
  if (
    input.schemaVersion !== 1 ||
    input.releaseId !== state.plan.id ||
    input.source !== state.plan.source
  )
    throw new Error('Receipt release/source mismatch');
  if (!state.plan.platforms.includes(input.platform)) throw new Error('Receipt platform mismatch');
  text(input.store, 'store', 64);
  if (!/^[a-z][a-z0-9-]*$/.test(input.store)) throw new Error('Invalid store');
  const artifact = state.artifacts?.[input.platform];
  if (
    !artifact ||
    input.appId !== artifact.appId ||
    input.artifactSha256 !== artifact.sha256 ||
    !/^[a-f0-9]{64}$/.test(input.artifactSha256)
  )
    throw new Error('Receipt artifact/app identity mismatch');
  text(input.appId, 'appId');
  text(input.draftId, 'draftId');
  timestamp(input.observedAt);
  object(input.facts, ['package', 'draft', 'submission', 'review', 'publication'], 'facts');
  const enums = {
    package: ['unknown', 'uploaded'],
    draft: ['unknown', 'saved'],
    submission: ['unknown', 'blocked', 'submitted'],
    review: ['unknown', 'in_review', 'approved', 'rejected'],
    publication: ['unknown', 'published'],
  };
  for (const [key, values] of Object.entries(enums)) choice(input.facts[key], values, key);
  text(input.nextAction, 'nextAction', 1000);
  const privacyCheck = input.privacy ? inspectPrivacyAssociation(input.privacy) : null;
  if (!Array.isArray(input.evidence) || !input.evidence.length || input.evidence.length > 10)
    throw new Error('Provide 1–10 evidence files');
  const evidence = [];
  for (const entry of input.evidence) {
    object(entry, ['path', 'kind'], 'evidence');
    choice(entry.kind, ['screenshot', 'document', 'provider-response'], 'evidence kind');
    const path = resolve(receiptPath, '..', text(entry.path, 'evidence path', 2000));
    const bytes = await regularBytes(path);
    evidence.push({ path, kind: entry.kind, sha256: digest(bytes), bytes: bytes.length });
  }
  return {
    ...input,
    evidence,
    privacyCheck,
    provenance: 'operator-supplied',
    recordedAt: new Date().toISOString(),
  };
}

export async function recordStoreObservation({ store, id, receiptPath }) {
  const directory = releasePath(store, id);
  const unlock = await acquireLock(join(store, 'locks', `${id}.lock`));
  try {
    const state = await loadState(directory);
    if (!state) throw new Error('Unknown release ID');
    const input = JSON.parse(await regularBytes(receiptPath));
    const receipt = await validateReceipt(input, state, receiptPath);
    const receiptId = digest({ ...receipt, recordedAt: undefined });
    const existing = (state.operatorStoreRecords ?? []).find((r) => r.id === receiptId);
    if (!existing) {
      state.operatorStoreRecords = [
        ...(state.operatorStoreRecords ?? []),
        { id: receiptId, ...receipt },
      ];
      await saveState(directory, state);
    }
    return {
      releaseId: id,
      receiptId,
      recorded: !existing,
      provenance: 'operator-supplied',
      privacyCheck: receipt.privacyCheck,
      publicationAuthority: false,
    };
  } finally {
    await unlock();
  }
}

const pick = (value, keys) =>
  Object.fromEntries(
    keys.filter((key) => Object.hasOwn(value ?? {}, key)).map((key) => [key, value[key]]),
  );

function acceptanceReference(receipt) {
  return receipt
    ? pick(receipt, [
        'source',
        'platform',
        'artifactSha256',
        'checkedAt',
        'passed',
        'provenance',
        'checks',
        'testedBuild',
        'evidenceSha256',
      ])
    : null;
}

async function artifactReference(artifact) {
  if (!artifact) return null;
  const result = pick(artifact, [
    'path',
    'sha256',
    'bytes',
    'appId',
    'version',
    'buildNumber',
    'source',
    'sourceEvidence',
    'packageFormat',
    'signatureVerification',
    'certificateSha256',
    'profileType',
    'signatureToolSha256',
    'payloadVerification',
    'payloadSha256',
    'inspectedAt',
    'relationship',
    'limitations',
  ]);
  result.integrity = 'unavailable';
  try {
    const stat = await lstat(artifact.path);
    if (stat.isFile() && !stat.isSymbolicLink()) {
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(artifact.path)) hash.update(chunk);
      result.integrity = hash.digest('hex') === artifact.sha256 ? 'matched' : 'changed';
    }
  } catch {
    /* The historical reference remains visible when the file is missing. */
  }
  return result;
}

async function platformHandoffs(state) {
  const results = {};
  for (const platform of state.plan.platforms ?? []) {
    const artifact = state.artifacts?.[platform];
    const receipt = state.acceptance?.[platform];
    let identityMatchesCurrent = false;
    if (receipt && artifact) {
      try {
        assertAcceptanceTestedBuild(receipt.testedBuild, state.plan, artifact);
        identityMatchesCurrent =
          receipt.source === state.plan.source &&
          receipt.platform === platform &&
          receipt.artifactSha256 === artifact.sha256;
      } catch {
        /* Preserve the failed relationship rather than a valid-looking pass. */
      }
    }
    let counterparts = [];
    let counterpartPolicy = 'absent';
    try {
      const declared = artifact
        ? validateAcceptanceCounterparts(artifact, state.plan.source)
        : null;
      if (declared) {
        counterparts = declared;
        counterpartPolicy = 'valid';
      }
    } catch {
      counterpartPolicy = 'invalid';
    }
    const mainReference = await artifactReference(artifact);
    const references = await Promise.all(counterparts.map(artifactReference));
    let binding = receipt ? 'mismatched' : 'not-recorded';
    if (identityMatchesCurrent) {
      const testedReference =
        receipt.testedBuild.kind === 'artifact'
          ? mainReference
          : references.find(
              (entry) =>
                entry?.source === receipt.testedBuild.source &&
                entry.sha256 === receipt.testedBuild.sha256,
            );
      binding =
        mainReference?.integrity === 'changed' || testedReference?.integrity === 'changed'
          ? 'mismatched'
          : mainReference?.integrity === 'matched' && testedReference?.integrity === 'matched'
            ? 'matched'
            : 'unverified';
    }
    results[platform] = {
      artifact: mainReference,
      counterparts: references,
      counterpartPolicy,
      acceptance: {
        status: state.acceptanceStatus?.[platform]?.state ?? 'unknown',
        binding,
        ...pick(state.acceptanceStatus?.[platform], [
          'startedAt',
          'finishedAt',
          'error',
          'evidenceSha256',
        ]),
        receipt: acceptanceReference(receipt),
        superseded: (state.acceptanceHistory ?? [])
          .filter((entry) => entry.platform === platform && entry.receipt)
          .slice(-1)
          .map((entry) => ({
            status: entry.state ?? 'unknown',
            supersededAt: entry.supersededAt,
            receipt: acceptanceReference(entry.receipt),
          })),
      },
      outcome: state.outcomes?.[platform]
        ? pick(state.outcomes[platform], [
            'state',
            'observedAt',
            'message',
            'version',
            'buildNumber',
            'submissionId',
            'versionId',
          ])
        : null,
    };
  }
  return results;
}

export async function storeHandoff({ store, id }) {
  const state = await loadState(releasePath(store, id));
  if (!state) throw new Error('Unknown release ID');
  const targets = new Map();
  for (const record of state.operatorStoreRecords ?? []) {
    const key = JSON.stringify([record.platform, record.store, record.appId, record.draftId]);
    const previous = targets.get(key);
    if (!previous || Date.parse(record.observedAt) >= Date.parse(previous.observedAt))
      targets.set(key, record);
  }
  const observations = [];
  for (const record of targets.values()) {
    const evidence = [];
    for (const entry of record.evidence) {
      let integrity = 'unavailable';
      try {
        integrity = digest(await regularBytes(entry.path)) === entry.sha256 ? 'matched' : 'changed';
      } catch {
        /* Preserve the observation and expose missing evidence. */
      }
      evidence.push({ ...entry, integrity });
    }
    const artifact = state.artifacts?.[record.platform];
    observations.push({
      ...record,
      evidence,
      screenshots: evidence.filter((entry) => entry.kind === 'screenshot'),
      artifactMatchesCurrent:
        artifact?.sha256 === record.artifactSha256 && artifact?.appId === record.appId,
    });
  }
  return {
    releaseId: id,
    source: state.plan.source,
    generatedAt: new Date().toISOString(),
    scope:
      'Historical operator observations; no live provider read, acceptance or retry authority.',
    observations,
    platforms: await platformHandoffs(state),
  };
}
