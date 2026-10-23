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
