import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const root = process.cwd();
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
  const [pack] = JSON.parse(
    run("npm", ["pack", "--json", "--pack-destination", consumer], root),
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
  run("npm", [
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    join(consumer, pack.filename),
  ]);
  await writeFile(
    join(consumer, "verify.mjs"),
    `
    import assert from 'node:assert/strict';
    import { fileURLToPath } from 'node:url';
    import { main } from '@budded-water/release-kit/cli';
    import { saveState, releasePath } from '@budded-water/release-kit/state';
    import { createRunner } from '@budded-water/release-kit/engine';
    import { workerMain } from '@budded-water/release-kit/worker';
    const id = 'release-' + 'a'.repeat(24);
    const store = fileURLToPath(new URL('./state', import.meta.url));
    await saveState(releasePath(store, id), { plan: { id, source: 'a'.repeat(40), platforms: ['ios'] }, stages: {}, outcomes: {} });
    let result;
    assert.equal(await main({ args: ['status', id, '--state-dir', store, '--summary'], output: s => result = JSON.parse(s) }), 0);
    assert.equal(result.releaseId, id); assert.equal(result.summaryOnly, true);
    assert.equal(typeof createRunner, 'function'); assert.equal(typeof workerMain, 'function');
    console.log('Installed tarball imports and CLI history read passed.');
  `,
  );
  process.stdout.write(run(process.execPath, ["verify.mjs"]));
  console.log(
    `Packed ${pack.files.length} files; no test or dependency tree bundled.`,
  );
} finally {
  await rm(consumer, { recursive: true, force: true });
}
