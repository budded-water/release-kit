import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPlan } from "../src/plan.mjs";
import { createRunner } from "../src/engine.mjs";
import { runCommand } from "../src/command.mjs";
import { digest, loadState, releasePath } from "../src/state.mjs";
import { main } from "../src/cli.mjs";

async function fixture(t, name) {
  const directory = await mkdtemp(join(tmpdir(), `release-kit-${name}-`));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repo = join(directory, "repo");
  await mkdir(repo);
  const git = (args) => runCommand("git", args, { cwd: repo });
  await git(["init", "-q"]);
  await git(["config", "user.name", "Synthetic"]);
  await git(["config", "user.email", "test@example.invalid"]);
  await git(["config", "core.hooksPath", "/dev/null"]);
  await git(["remote", "add", "origin", `https://example.invalid/${name}.git`]);
  await writeFile(join(repo, ".gitignore"), ".ui-eval/\n");
  await writeFile(
    join(repo, "app.json"),
    JSON.stringify({
      expo: {
        version: "1.0.0",
        runtimeVersion: { policy: "appVersion" },
        ios: { bundleIdentifier: `example.${name}` },
        android: { package: `example.${name}` },
      },
    }),
  );
  await writeFile(join(repo, "eas.json"), "{}");
  await git(["add", "."]);
  await git(["commit", "-qm", "synthetic project"]);
  const calls = [];
  const project = {
    schemaVersion: 1,
    checksDescription: `${name} checks`,
    uiScope: "synthetic-contract-only",
    async installValidation() {
      calls.push("install");
    },
    async checkSource() {
      calls.push("check");
    },
    async installBuild() {
      assert.fail("Validation must never install build dependencies");
    },
    async evaluateUI({ root, source }) {
      calls.push("evaluate");
      await mkdir(join(root, ".ui-eval"), { recursive: true });
      const path = join(root, ".ui-eval", "synthetic.json");
      const bytes = JSON.stringify({ source, kind: "SyntheticTestReceipt" });
      await writeFile(path, bytes);
      return {
        path,
        sha256: digest(bytes),
        source,
        scope: "synthetic-contract-only",
      };
    },
    async revalidateUI({ source, evidence }) {
      calls.push("revalidate");
      const bytes = await readFile(evidence.path);
      assert.equal(digest(bytes), evidence.sha256);
      assert.equal(JSON.parse(bytes).source, source);
    },
  };
  const config = { schemaVersion: 1, acceptance: {} };
  const store = join(directory, "state");
  const plan = await createPlan({
    repo,
    ref: "HEAD",
    platforms: ["ios"],
    config,
  });
  const options = {
    repo,
    store,
    config,
    project,
    command: runCommand,
    adapters: {},
    environment: process.env,
  };
  return { ...options, plan, calls, runner: () => createRunner(options) };
}

test("two synthetic consumers select their own checks without changing core or sharing journals", async (t) => {
  const a = await fixture(t, "alpha");
  const b = await fixture(t, "beta");
  assert.notEqual(a.plan.id, b.plan.id);
  for (const f of [a, b]) {
    const first = await f.runner().validate(f.plan);
    assert.equal(first.sourceValidation.state, "passed");
    assert.equal(
      first.stages.checks.output.command,
      f.project.checksDescription,
    );
    const second = await f.runner().validate(f.plan);
    assert.equal(second.sourceValidation.checksReused, true);
    assert.deepEqual(f.calls, ["install", "check"]);
    assert.deepEqual(second.artifacts, {});
    assert.deepEqual(second.outcomes, {});
  }
});

test("UI reuse revalidates project evidence and tampering revokes the current pass", async (t) => {
  const f = await fixture(t, "evidence");
  const first = await f.runner().validate(f.plan, { ui: true });
  assert.equal(first.uiValidation.state, "passed");
  const second = await f.runner().validate(f.plan, { ui: true });
  assert.equal(second.uiValidation.evidenceReused, true);
  assert.equal(f.calls.filter((x) => x === "evaluate").length, 1);
  await writeFile(first.stages["ui-eval"].output.path, "tampered");
  await assert.rejects(f.runner().validate(f.plan, { ui: true }), /changed/);
  const stored = await loadState(releasePath(f.store, f.plan.id));
  assert.equal(stored.uiValidation.state, "failed");
  assert.deepEqual(await readdir(join(f.store, "locks")), []);
});

test("project check failures and absent adapters cannot become release acceptance", async (t) => {
  const f = await fixture(t, "failure");
  f.project.checkSource = async () => {
    throw new Error("Synthetic check rejected");
  };
  await assert.rejects(f.runner().validate(f.plan), /Synthetic check rejected/);
  const stored = await loadState(releasePath(f.store, f.plan.id));
  assert.equal(stored.sourceValidation.state, "failed");
  assert.equal(stored.stages.checks.status, "failed");
  assert.deepEqual(stored.artifacts, {});
  await assert.rejects(
    createRunner({ ...f, project: undefined }).validate(f.plan),
    /project adapter/,
  );
});

test("CLI validation uses the supplied adapter and history remains readable without loading it", async (t) => {
  const f = await fixture(t, "cli");
  const configPath = join(f.repo, "..", "release.json");
  await writeFile(configPath, JSON.stringify(f.config));
  const output = [];
  assert.equal(
    await main({
      repo: f.repo,
      project: f.project,
      args: [
        "validate",
        "--ui",
        "--ref",
        f.plan.source,
        "--platforms",
        "ios",
        "--config",
        configPath,
        "--state-dir",
        f.store,
      ],
      output: (x) => output.push(JSON.parse(x)),
    }),
    0,
  );
  assert.deepEqual(f.calls, ["install", "check", "evaluate", "revalidate"]);
  assert.equal(output[0].scope, "source-checks-and-synthetic-contract-only");
  assert.equal(
    await main({
      args: ["status", f.plan.id, "--state-dir", f.store, "--summary"],
      output: (x) => output.push(JSON.parse(x)),
    }),
    0,
  );
  assert.equal(output.at(-1).sourceValidation.state, "passed");
  assert.equal(output.at(-1).summaryOnly, true);
});
