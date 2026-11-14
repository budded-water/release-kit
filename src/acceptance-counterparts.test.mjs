import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readAcceptance } from './plan.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'acceptance-counterparts-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = 'a'.repeat(40),
    main = 'b'.repeat(64),
    counterpart = 'c'.repeat(64);
  const plan = { source };
  const artifact = {
    platform: 'harmony',
    sha256: main,
    acceptanceCounterparts: [{ source, sha256: counterpart }],
  };
  const receipt = {
    schemaVersion: 1,
    kind: 'native-acceptance',
    source,
    platform: 'harmony',
    artifactSha256: main,
    checkedAt: new Date().toISOString(),
    passed: true,
    provenance: 'operator',
    checks: [{ name: 'synthetic', passed: true }],
    testedBuild: {
      kind: 'counterpart',
      source,
      sha256: counterpart,
      configurationRelationship: 'Same payload',
      limitations: 'Synthetic observation',
    },
  };
  return {
    plan,
    artifact,
    receipt,
    read: async (r = receipt, a = artifact) => {
      const path = join(directory, 'receipt.json');
      await writeFile(path, JSON.stringify(r));
      return readAcceptance(path, plan, a);
    },
  };
}

test('declared counterparts require exact source and signed hash; main artifacts remain eligible', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.read()).testedBuild.sha256, f.artifact.acceptanceCounterparts[0].sha256);
  await assert.rejects(
    f.read({ ...f.receipt, testedBuild: { ...f.receipt.testedBuild, sha256: 'd'.repeat(64) } }),
    /verified counterpart/,
  );
  await assert.rejects(
    f.read({ ...f.receipt, testedBuild: { ...f.receipt.testedBuild, source: 'f'.repeat(40) } }),
    /tested build/,
  );
  assert.equal(
    (
      await f.read({
        ...f.receipt,
        testedBuild: { kind: 'artifact', source: f.plan.source, sha256: f.artifact.sha256 },
      })
    ).testedBuild.kind,
    'artifact',
  );
});

test('absent declarations retain legacy operator counterparts; malformed and empty policies fail closed', async (t) => {
  const f = await fixture(t);
  const legacy = { ...f.artifact };
  delete legacy.acceptanceCounterparts;
  const other = { ...f.receipt, testedBuild: { ...f.receipt.testedBuild, sha256: 'd'.repeat(64) } };
  assert.equal((await f.read(other, legacy)).testedBuild.sha256, 'd'.repeat(64));
  for (const policy of [
    null,
    {},
    [{ source: 'wrong', sha256: 'c'.repeat(64) }],
    [{ source: f.plan.source, sha256: 'bad' }],
  ])
    await assert.rejects(
      f.read(f.receipt, { ...f.artifact, acceptanceCounterparts: policy }),
      /Invalid verified/,
    );
  await assert.rejects(
    f.read(f.receipt, { ...f.artifact, acceptanceCounterparts: [] }),
    /verified counterpart/,
  );
});
