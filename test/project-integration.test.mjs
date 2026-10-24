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
import { digest, loadState, releasePath, saveState } from "../src/state.mjs";
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
    sourceValidationPolicy: `${name}/checks/v1`,
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
  assert.equal(stored.stages["ui-eval"].status, "invalidated");
  const recovered = await f.runner().validate(f.plan, { ui: true });
  assert.equal(recovered.uiValidation.state, "passed");
  assert.equal(recovered.uiValidation.evidenceReused, false);
  assert.equal(f.calls.filter((x) => x === "evaluate").length, 2);
  assert.deepEqual(await readdir(join(f.store, "locks")), []);
});

test("missing UI receipts and changed verifier requirements regenerate without resetting delivery history", async (t) => {
  for (const variant of ["missing", "verifier-change"]) {
    const f = await fixture(t, variant);
    const first = await f.runner().validate(f.plan, { ui: true });
    const preserved = await seedDeliveryHistory(f);
    if (variant === "missing") {
      await rm(first.uiValidation.evidence.path);
    } else {
      const evaluate = f.project.evaluateUI;
      f.project.evaluateUI = async ctx => ({ ...await evaluate(ctx), verifier: "v2" });
      const revalidate = f.project.revalidateUI;
      f.project.revalidateUI = async ctx => {
        if (ctx.evidence.verifier !== "v2") throw new Error("Verifier v2 evidence required");
        await revalidate(ctx);
      };
    }
    await assert.rejects(f.runner().validate(f.plan, { ui: true }));
    const invalidated = await preserved();
    assert.equal(invalidated.schemaVersion, 1);
    assert.equal(invalidated.stages["ui-eval"].status, "invalidated");
    assert.deepEqual(invalidated.stages["ui-eval"].output, first.uiValidation.evidence);
    const recovered = await f.runner().validate(f.plan, { ui: true });
    assert.equal(recovered.uiValidation.state, "passed");
    assert.equal(recovered.uiValidation.evidenceReused, false);
    assert.equal(recovered.stages["ui-eval"].attempt, 2);
    await preserved();
    const reused = await f.runner().validate(f.plan, { ui: true });
    assert.equal(reused.uiValidation.evidenceReused, true);
    assert.equal(f.calls.filter(x => x === "evaluate").length, 2);
  }
});

test("failed replacement UI evaluation cannot restore a historical pass", async t => {
  const f = await fixture(t, "ui-replacement");
  const initial = await f.runner().validate(f.plan, { ui: true });
  await rm(initial.uiValidation.evidence.path);
  await assert.rejects(f.runner().validate(f.plan, { ui: true }));
  f.project.evaluateUI = async () => { throw new Error("Replacement UI failed"); };
  await assert.rejects(f.runner().validate(f.plan, { ui: true }), /Replacement UI failed/);
  const state = await loadState(releasePath(f.store, f.plan.id));
  assert.equal(state.uiValidation.state, "failed");
  assert.equal(state.stages["ui-eval"].status, "failed");
  assert.equal(state.stages["ui-eval"].output, undefined);
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
  assert.match(output.at(-1).sourceValidation.policy, /^[a-f0-9]{64}$/);
  assert.equal(output.at(-1).summaryOnly, true);
});

async function seedDeliveryHistory(f) {
  const directory = releasePath(f.store, f.plan.id);
  const state = await loadState(directory);
  Object.assign(state, {
    publicationRequested: true,
    artifacts: {
      ios: { path: "/synthetic/retained.ipa", sha256: "b".repeat(64) },
    },
    outcomes: { ios: { state: "processing", providerId: "retained-build" } },
    acceptance: { ios: { provenance: "retained-acceptance" } },
    checkpoints: { ios: { submitted: { id: "retained-submission" } } },
    buildAttempts: { ios: 2 },
  });
  await saveState(directory, state);
  const keys = [
    "plan",
    "publicationRequested",
    "artifacts",
    "outcomes",
    "acceptance",
    "checkpoints",
    "buildAttempts",
  ];
  const delivery = Object.fromEntries(
    keys.map((key) => [key, structuredClone(state[key])]),
  );
  const events = new Map(
    await Promise.all(
      (await readdir(join(directory, "events"))).map(async (name) => [
        name,
        await readFile(join(directory, "events", name)),
      ]),
    ),
  );
  return async () => {
    const updated = await loadState(directory);
    for (const [key, value] of Object.entries(delivery))
      assert.deepEqual(updated[key], value, key);
    for (const [name, bytes] of events)
      assert.deepEqual(await readFile(join(directory, "events", name)), bytes);
    assert.deepEqual(await readdir(join(f.store, "locks")), []);
    return updated;
  };
}

test("changed source policy runs its new gate and cannot relabel an old pass", async (t) => {
  const f = await fixture(t, "policy-change");
  const first = await f.runner().validate(f.plan);
  const preserved = await seedDeliveryHistory(f);
  f.project.sourceValidationPolicy = "policy-change/checks/v2";
  f.project.checksDescription = "new strict policy";
  let newCalls = 0;
  f.project.checkSource = async () => {
    newCalls++;
    throw new Error("New gate rejected");
  };
  await assert.rejects(f.runner().validate(f.plan), /New gate rejected/);
  const failed = await preserved();
  assert.equal(newCalls, 1);
  assert.equal(failed.sourceValidation.state, "failed");
  assert.notEqual(
    failed.sourceValidation.policy,
    first.sourceValidation.policy,
  );
  assert.equal(failed.stages.checks.status, "failed");
  assert.equal(f.calls.filter((call) => call === "install").length, 2);
  f.project.checkSource = async () => {
    newCalls++;
  };
  const repaired = await f.runner().validate(f.plan);
  assert.equal(repaired.sourceValidation.checksReused, false);
  assert.equal(repaired.sourceValidation.state, "passed");
  await f.runner().validate(f.plan);
  assert.equal(newCalls, 2);
  await preserved();
});

test("unchanged source policy reuses evidence across unrelated adapter changes", async (t) => {
  const f = await fixture(t, "stable-policy");
  const first = await f.runner().validate(f.plan);
  const other = createRunner({
    ...f,
    project: {
      ...f.project,
      uiScope: "unrelated-verifier-scope",
      evaluateUI: async () =>
        assert.fail("source-only validation cannot run UI"),
    },
  });
  const next = await other.validate(f.plan);
  assert.equal(next.sourceValidation.checksReused, true);
  assert.deepEqual(next.stages.checks, first.stages.checks);
  assert.deepEqual(f.calls, ["install", "check"]);
});

test("legacy successful stages are upgraded by revalidation without rewriting history", async (t) => {
  const f = await fixture(t, "legacy-policy");
  await f.runner().validate(f.plan);
  const directory = releasePath(f.store, f.plan.id);
  const legacy = await loadState(directory);
  delete legacy.sourceValidation.policy;
  legacy.stages["install-validation"].output = null;
  delete legacy.stages.checks.output.policy;
  await saveState(directory, legacy);
  const preserved = await seedDeliveryHistory(f);
  const updated = await f.runner().validate(f.plan);
  assert.equal(updated.sourceValidation.checksReused, false);
  assert.match(updated.sourceValidation.policy, /^[a-f0-9]{64}$/);
  const again = await f.runner().validate(f.plan);
  assert.equal(again.sourceValidation.checksReused, true);
  assert.deepEqual(f.calls, ["install", "check", "install", "check"]);
  await preserved();
});

test("legacy adapters without a declared policy remain usable but never cache a pass", async (t) => {
  const f = await fixture(t, "unversioned");
  await f.runner().validate(f.plan);
  delete f.project.sourceValidationPolicy;
  for (let index = 0; index < 2; index++) {
    const state = await f.runner().validate(f.plan);
    assert.equal(state.sourceValidation.state, "passed");
    assert.equal(state.sourceValidation.policy, null);
    assert.equal(state.sourceValidation.checksReused, false);
  }
  assert.deepEqual(f.calls, [
    "install",
    "check",
    "install",
    "check",
    "install",
    "check",
  ]);
});

test("pre-cleanup core fingerprints revalidate once while preserving schema v1 delivery history", async t => {
  const f = await fixture(t, "core-migration");
  await f.runner().validate(f.plan);
  const directory = releasePath(f.store, f.plan.id);
  const state = await loadState(directory);
  const oldPolicy = digest({
    contract: 'release-kit/source-validation/v1',
    project: f.project.sourceValidationPolicy,
    node: process.version,
  });
  state.sourceValidation.policy = oldPolicy;
  for (const key of ['install-validation', 'checks']) state.stages[key].output.policy = oldPolicy;
  await saveState(directory, state);
  const preserved = await seedDeliveryHistory(f);
  const upgraded = await f.runner().validate(f.plan);
  assert.equal(upgraded.schemaVersion, 1);
  assert.notEqual(upgraded.sourceValidation.policy, oldPolicy);
  assert.equal(upgraded.sourceValidation.checksReused, false);
  assert.equal((await f.runner().validate(f.plan)).sourceValidation.checksReused, true);
  assert.deepEqual(f.calls, ['install', 'check', 'install', 'check']);
  await preserved();
});

test("replacement install failure revokes old checks before work and rollback must revalidate", async (t) => {
  const f = await fixture(t, "install-failure");
  await f.runner().validate(f.plan);
  const preserved = await seedDeliveryHistory(f);
  const original = { ...f.project };
  f.project.sourceValidationPolicy = "install-failure/checks/v2";
  f.project.installValidation = async () => {
    const during = await loadState(releasePath(f.store, f.plan.id));
    assert.equal(during.stages.checks.status, "invalidated");
    assert.equal(during.sourceValidation.state, "running");
    throw new Error("Replacement install failed");
  };
  await assert.rejects(
    f.runner().validate(f.plan),
    /Replacement install failed/,
  );
  const failed = await preserved();
  assert.equal(failed.stages.checks.status, "invalidated");
  assert.equal(failed.sourceValidation.state, "failed");
  Object.assign(f.project, original);
  const rollback = await f.runner().validate(f.plan);
  assert.equal(rollback.sourceValidation.checksReused, false);
  assert.deepEqual(f.calls, ["install", "check", "install", "check"]);
  await preserved();
});

test("cancellation during replacement installation cannot restore a cached pass", async (t) => {
  const f = await fixture(t, "cancel-policy");
  await f.runner().validate(f.plan);
  const original = { ...f.project };
  const abort = new AbortController();
  f.project.sourceValidationPolicy = "cancel-policy/checks/v2";
  f.project.installValidation = async () => {
    abort.abort();
  };
  await assert.rejects(
    createRunner({ ...f, signal: abort.signal }).validate(f.plan),
    /interrupted/,
  );
  const state = await loadState(releasePath(f.store, f.plan.id));
  assert.equal(state.sourceValidation.state, "failed");
  assert.equal(state.stages.checks.status, "invalidated");
  f.project.installValidation = original.installValidation;
  const resumed = await f.runner().validate(f.plan);
  assert.equal(resumed.sourceValidation.checksReused, false);
  assert.equal(resumed.sourceValidation.state, "passed");
});

test("malformed declared policy identities are rejected instead of enabling reuse", async (t) => {
  const f = await fixture(t, "invalid-policy");
  for (const policy of ["", " ", null, {}, "x".repeat(201), "line\nbreak"]) {
    f.project.sourceValidationPolicy = policy;
    await assert.rejects(
      f.runner().validate(f.plan),
      /trusted version-1 project adapter/,
    );
  }
  assert.deepEqual(f.calls, []);
});
