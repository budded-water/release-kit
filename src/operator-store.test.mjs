import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLock, digest, loadState, releasePath, saveState } from './state.mjs';
import {
  recordStoreObservation,
  storeHandoff,
  inspectPrivacyAssociation,
} from './operator-store.mjs';
import { main } from './cli.mjs';

async function fixture(t) {
  const store = await mkdtemp(join(tmpdir(), 'operator-store-'));
  t.after(() => rm(store, { recursive: true, force: true }));
  const id = `release-${'a'.repeat(24)}`;
  const directory = releasePath(store, id);
  const state = {
    schemaVersion: 1,
    plan: { id, source: 'b'.repeat(40), platforms: ['harmony'] },
    artifacts: { harmony: { appId: 'example.app', sha256: 'c'.repeat(64) } },
    stages: { publish: { status: 'pending_operator' } },
    outcomes: {},
    publicationRequested: false,
  };
  await saveState(directory, state);
  await writeFile(join(store, 'proof.txt'), 'Provider UI observation');
  const receiptPath = join(store, 'receipt.json');
  const receipt = {
    schemaVersion: 1,
    releaseId: id,
    source: state.plan.source,
    platform: 'harmony',
    store: 'example-store',
    appId: 'example.app',
    draftId: 'draft-1',
    artifactSha256: state.artifacts.harmony.sha256,
    observedAt: '2026-01-01T00:00:00Z',
    facts: {
      package: 'uploaded',
      draft: 'saved',
      submission: 'blocked',
      review: 'unknown',
      publication: 'unknown',
    },
    privacy: {
      listingAppName: 'Example',
      policyAppName: 'Old Example',
      policyId: 'policy-2',
      linkedPolicyId: 'policy-1',
      reviewState: 'approved',
    },
    evidence: [{ path: 'proof.txt', kind: 'document' }],
    nextAction: 'Reconcile policy name and association',
  };
  const record = async (value = receipt) => {
    await writeFile(receiptPath, JSON.stringify(value));
    return recordStoreObservation({ store, id, receiptPath });
  };
  return { store, id, directory, state, receiptPath, receipt, record };
}

test('append-only manual records preserve engine gates and deduplicate exact retries', async (t) => {
  const f = await fixture(t);
  const result = await f.record();
  assert.equal(result.recorded, true);
  assert.equal(result.publicationAuthority, false);
  assert.deepEqual(result.privacyCheck.blockers, [
    'privacy_app_name_mismatch',
    'privacy_policy_not_linked',
  ]);
  assert.equal((await f.record()).recorded, false);
  const state = await loadState(f.directory);
  assert.equal(state.operatorStoreRecords.length, 1);
  assert.deepEqual(state.stages, f.state.stages);
  assert.deepEqual(state.outcomes, {});
  assert.equal(state.publicationRequested, false);
  assert.equal((await readdir(join(f.directory, 'events'))).length, 2);
});

test('handoff selects observed time per draft and exposes changed/missing proof', async (t) => {
  const f = await fixture(t);
  await f.record();
  await f.record({
    ...f.receipt,
    observedAt: '2025-12-31T00:00:00Z',
    nextAction: 'Older observation',
  });
  await f.record({ ...f.receipt, draftId: 'draft-2' });
  let handoff = await storeHandoff(f);
  assert.equal(handoff.observations.length, 2);
  assert.equal(handoff.observations[0].nextAction, f.receipt.nextAction);
  assert.equal(handoff.observations[0].evidence[0].integrity, 'matched');
  await writeFile(join(f.store, 'proof.txt'), 'changed');
  handoff = await storeHandoff(f);
  assert.equal(handoff.observations[0].evidence[0].integrity, 'changed');
  const changedState = await loadState(f.directory);
  changedState.artifacts.harmony.sha256 = 'd'.repeat(64);
  await saveState(f.directory, changedState);
  assert.equal((await storeHandoff(f)).observations[0].artifactMatchesCurrent, false);
  await rm(join(f.store, 'proof.txt'));
  assert.equal((await storeHandoff(f)).observations[0].evidence[0].integrity, 'unavailable');
});

test('identity, invalid schemas and missing evidence fail before journal append', async (t) => {
  const f = await fixture(t);
  for (const change of [
    { source: 'x' },
    { appId: 'other.app' },
    { artifactSha256: 'd'.repeat(64) },
    { platform: 'android' },
    { evidence: [] },
    { password: 'must-not-be-recorded' },
    { observedAt: '2999-01-01T00:00:00Z' },
    { facts: { ...f.receipt.facts, publication: 'done' } },
  ]) {
    await assert.rejects(f.record({ ...f.receipt, ...change }));
  }
  assert.equal((await readdir(join(f.directory, 'events'))).length, 1);
});

test('manual writer uses engine release lock and never overwrites concurrent work', async (t) => {
  const f = await fixture(t);
  const unlock = await acquireLock(join(f.store, 'locks', `${f.id}.lock`));
  await assert.rejects(f.record(), /Execution lock exists/);
  await unlock();
  await f.record();
  assert.equal((await loadState(f.directory)).operatorStoreRecords.length, 1);
});

test('policy approval alone does not satisfy name/association checks', () => {
  const policy = {
    listingAppName: 'Example',
    policyAppName: 'Example',
    policyId: 'p2',
    linkedPolicyId: 'p2',
    reviewState: 'approved',
  };
  assert.equal(inspectPrivacyAssociation(policy).state, 'matched');
  assert.deepEqual(inspectPrivacyAssociation({ ...policy, reviewState: 'in_review' }).blockers, [
    'privacy_review_not_approved',
  ]);
  assert.throws(() => inspectPrivacyAssociation({ ...policy, policyAppName: undefined }));
});

test('CLI records and hands off without config, provider or execution calls', async (t) => {
  const f = await fixture(t);
  await writeFile(f.receiptPath, JSON.stringify(f.receipt));
  const output = [];
  const command = async () => {
    throw new Error('Unexpected execution');
  };
  const args = ['store-record', f.id, '--receipt', f.receiptPath, '--state-dir', f.store];
  assert.equal(await main({ args, command, output: (s) => output.push(JSON.parse(s)) }), 0);
  assert.equal(output[0].recorded, true);
  assert.equal(
    await main({
      args: ['store-handoff', f.id, '--state-dir', f.store],
      command,
      output: (s) => output.push(JSON.parse(s)),
    }),
    0,
  );
  assert.equal(output[1].observations.length, 1);
  for (const option of ['--publish', '--remote', '--ui'])
    await assert.rejects(main({ args: [...args, option] }));
});

test('old journals produce an empty handoff and redirected evidence is refused', async (t) => {
  const f = await fixture(t);
  assert.deepEqual((await storeHandoff(f)).observations, []);
  await symlink(join(f.store, 'proof.txt'), join(f.store, 'alias.txt'));
  await assert.rejects(
    f.record({ ...f.receipt, evidence: [{ path: 'alias.txt', kind: 'document' }] }),
    /regular file/,
  );
  assert.equal((await readdir(join(f.directory, 'events'))).length, 1);
});

test('handoff combines large artifacts, exact counterparts, acceptance and per-draft screenshot order', async (t) => {
  const f = await fixture(t);
  const mainPath = join(f.store, 'main.app'),
    debugPath = join(f.store, 'debug.hap');
  const mainBytes = Buffer.alloc(21 * 1024 * 1024, 1);
  await writeFile(mainPath, mainBytes);
  await writeFile(debugPath, 'debug package');
  const source = f.state.plan.source;
  f.state.artifacts.harmony = {
    appId: 'example.app',
    path: mainPath,
    sha256: digest(mainBytes),
    version: '1.2.3',
    buildNumber: '42',
    source,
    packageFormat: 'app',
    profileType: 'release',
    acceptanceCounterparts: [
      { path: debugPath, source, sha256: digest('debug package'), profileType: 'debug' },
    ],
  };
  const artifact = f.state.artifacts.harmony;
  f.state.acceptance = {
    harmony: {
      source,
      platform: 'harmony',
      artifactSha256: artifact.sha256,
      testedBuild: {
        kind: 'counterpart',
        source,
        sha256: digest('debug package'),
        configurationRelationship: 'Same payload',
        limitations: 'Synthetic test',
      },
      passed: true,
    },
  };
  f.state.acceptanceStatus = { harmony: { state: 'passed' } };
  await saveState(f.directory, f.state);
  await writeFile(join(f.store, 'second.txt'), 'Another synthetic screenshot');
  await f.record({
    ...f.receipt,
    artifactSha256: artifact.sha256,
    evidence: [
      { path: 'second.txt', kind: 'screenshot' },
      { path: 'receipt.json', kind: 'document' },
      { path: 'proof.txt', kind: 'screenshot' },
    ],
  });
  const before = await readdir(join(f.directory, 'events'));
  let report = await storeHandoff(f);
  assert.equal(report.platforms.harmony.artifact.integrity, 'matched');
  assert.equal(report.platforms.harmony.artifact.version, '1.2.3');
  assert.equal(report.platforms.harmony.counterparts[0].profileType, 'debug');
  assert.equal(report.platforms.harmony.acceptance.binding, 'matched');
  assert.deepEqual(
    report.observations[0].screenshots.map((x) => x.path),
    [join(f.store, 'second.txt'), join(f.store, 'proof.txt')],
  );
  assert.deepEqual(await readdir(join(f.directory, 'events')), before);
  await writeFile(debugPath, 'replaced');
  report = await storeHandoff(f);
  assert.equal(report.platforms.harmony.counterparts[0].integrity, 'changed');
  assert.equal(report.platforms.harmony.acceptance.status, 'passed');
  assert.equal(report.platforms.harmony.acceptance.binding, 'mismatched');
  await rm(debugPath);
  assert.equal((await storeHandoff(f)).platforms.harmony.acceptance.binding, 'unverified');
});

test('malformed counterpart policies stay visible in handoff without approving cached receipts', async (t) => {
  const f = await fixture(t);
  f.state.artifacts.harmony.acceptanceCounterparts = {};
  await saveState(f.directory, f.state);
  const report = await storeHandoff(f);
  assert.equal(report.platforms.harmony.counterpartPolicy, 'invalid');
  assert.equal(report.platforms.harmony.acceptance.binding, 'not-recorded');
});
