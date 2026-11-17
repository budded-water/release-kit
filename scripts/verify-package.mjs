import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";

const root = process.cwd();
const installer = process.argv[2] ?? "pnpm";
assert(["pnpm", "npm"].includes(installer), "Unsupported consumer package manager");
const consumer = await mkdtemp(join(tmpdir(), "release-kit-package-"));
const env = { ...process.env, npm_config_cache: join(consumer, "cache") };
const run = (bin, args, cwd = consumer) =>
  execFileSync(bin, args, {
    cwd,
    env,
    encoding: "utf8",
    timeout: 120000,
    stdio: ["ignore", "pipe", "pipe"],
  });
try {
  const pack = JSON.parse(
    run("pnpm", ["pack", "--json", "--pack-destination", consumer], root),
  );
  assert(
    pack.files.every(
      ({ path }) =>
        !path.endsWith(".test.mjs") && !path.includes("node_modules"),
    ),
  );
  await writeFile(
    join(consumer, "package.json"),
    '{"private":true,"type":"module"}\n',
  );
  // npm is a compatibility consumer, not this repository's package manager.
  run(installer, installer === "pnpm" ? [
    "add",
    "--ignore-scripts",
    resolve(consumer, pack.filename),
  ] : [
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    resolve(consumer, pack.filename),
  ]);
  await writeFile(
    join(consumer, "verify.mjs"),
    `
    import assert from 'node:assert/strict';
    import { fileURLToPath } from 'node:url';
    import { main } from '@budded-water/release-kit/cli';
    import { uploadStore } from '@budded-water/release-kit/stores';
    assert.equal(typeof uploadStore, 'function');
    let uploadHelp;
    assert.equal(await main({args:['upload','--help'],output:s=>uploadHelp=s}),0);
    assert.match(uploadHelp,/upload <release-id>/);
    import { inspectAppStore, assessStorePreflight } from '@budded-water/release-kit/store-preflight';
    import { listStoreVersions, getStoreVersion } from '@budded-water/release-kit/store-query';
    assert.equal(typeof listStoreVersions, 'function');
    assert.equal(typeof getStoreVersion, 'function');
    assert.equal(typeof assessStorePreflight, 'function');
    const query = await getStoreVersion({appId:'123',bundleId:'test.example',apiKeyPathEnv:'EXAMPLE_KEY',candidateVersion:'1.0.0',
      session:async()=>({read:async path=>path.startsWith('/v1/apps/')?{data:{id:'123',type:'apps',attributes:{bundleId:'test.example'}}}:{data:null},
      list:async()=>[{id:'v1',type:'appStoreVersions',attributes:{platform:'IOS',versionString:'1.0.0',appVersionState:'IN_REVIEW'}}]})});
    assert.equal(query.resolution,'found'); assert.equal(query.version.reviewState,'in-review');
    assert.equal(query.observationComplete,true);
    assert.equal(typeof inspectAppStore, 'function');
    let preflightHelp;
    assert.equal(await main({args:['store-preflight','--help'],output:s=>preflightHelp=s}),0);
    assert.match(preflightHelp,/GET-only iOS/);
    import { saveState, releasePath } from '@budded-water/release-kit/state';
    import { inspectStorage, planStorageCleanup } from '@budded-water/release-kit/storage';
    assert.equal(typeof inspectStorage, 'function'); assert.equal(typeof planStorageCleanup, 'function');
    import { createRunner } from '@budded-water/release-kit/engine';
    import { storeHandoff, inspectPrivacyAssociation } from '@budded-water/release-kit/operator-store';
    import { workerMain } from '@budded-water/release-kit/worker';
    import { assertWechatVersionObservation } from '@budded-water/release-kit/wechat';
    assert.doesNotThrow(() => assertWechatVersionObservation({appId:'wx1111111111111111',version:'1.0.0',source:'owner',observedAt:new Date().toISOString()},'wx1111111111111111','1.0.1'));
    const id = 'release-' + 'a'.repeat(24);
    const store = fileURLToPath(new URL('./state', import.meta.url));
    await saveState(releasePath(store, id), { schemaVersion: 1, plan: { id, source: 'a'.repeat(40), platforms: ['ios'] }, stages: {}, outcomes: {} });
    let result;
    assert.equal(await main({ args: ['status', id, '--state-dir', store, '--summary'], output: s => result = JSON.parse(s) }), 0);
    assert.equal(result.releaseId, id); assert.equal(result.summaryOnly, true);
    const storage = await inspectStorage({stateDirectory:store});
    assert.equal(storage.observationComplete,true); assert.equal(storage.releases[0].verifiedEvents,1);
    assert.equal(planStorageCleanup(storage).deletionAuthorized,false);
    assert.equal(await main({args:['storage-plan','--state-dir',store],output:s=>result=JSON.parse(s)}),0);
    assert.equal(result.applySupported,false);
    assert.deepEqual((await storeHandoff({ store, id })).observations, []);
    assert.equal(inspectPrivacyAssociation({ listingAppName: 'Example', policyAppName: 'Example', policyId: 'p1', linkedPolicyId: 'p1', reviewState: 'approved' }).state, 'matched');
    assert.equal(typeof createRunner, 'function'); assert.equal(typeof workerMain, 'function');
    console.log('Installed tarball imports and CLI history read passed.');
  `,
  );
  process.stdout.write(run(process.execPath, ["verify.mjs"]));
  const projectPath = join(consumer, "trusted project.mjs");
  await writeFile(
    projectPath,
    `export default { repo: ${JSON.stringify(consumer)} };\n`,
  );
  const result = JSON.parse(
    run(join(consumer, "node_modules", ".bin", "release-kit"), [
      "--project",
      projectPath,
      "status",
      "release-" + "a".repeat(24),
      "--state-dir",
      join(consumer, "state"),
      "--summary",
    ]),
  );
  assert.equal(result.releaseId, "release-" + "a".repeat(24));
  assert.equal(result.summaryOnly, true);
  console.log(
    "Installed executable and explicit project-module loading passed.",
  );
  console.log(
    `Packed ${pack.files.length} files; ${installer} consumer passed; no test or dependency tree bundled.`,
  );
} finally {
  await rm(consumer, { recursive: true, force: true });
}
