# Release Kit

A local-first mobile release CLI and runtime for pinned source validation, artifact delivery, durable recovery and bounded store observations. It has no runtime dependencies and requires Node.js 22 or newer.

This is an initial extraction, not a hosted release service. Source is public and **UNLICENSED**; no package has been published to a registry. Install a reviewed Git commit, not a moving branch. Provider credentials and operational records never belong in this repository.

## Responsibilities

| Layer                       | Owns                                                                                                                              |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Release Kit                 | Source/plan binding, journals, stage recovery, artifact checks, publication gates, polling, dispatch claims and store API helpers |
| Trusted project adapter     | Dependency installation, source checks, UI execution and evidence validation                                                      |
| Platform adapters           | Build, inspect, doctor, publish and status for the project's selected platforms                                                   |
| UI-eval or another verifier | Actual verification evidence; successful process exit alone is insufficient                                                       |

The initial planner expects an Expo `app.json`, `eas.json` and `runtimeVersion.policy = appVersion`. Supported destination names are `ios`, `android`, and `harmony`. Expo native configuration and Harmony build hosts remain consumer-owned. This does not claim arbitrary framework support or fresh store-delivery acceptance.

## Use

```sh
npm install --save-dev 'git+https://github.com/budded-water/release-kit.git#<reviewed-commit>'
npx release-kit --project ./release.project.mjs validate --ref <source-commit> \
  --platforms ios,android --config /absolute/private/release.json --state-dir /absolute/private/project-state
npx release-kit status <release-id> --state-dir /absolute/private/project-state --summary
```

`--project` must be the first argument. It explicitly imports a **trusted executable local module** exporting `{ repo, project, platformAdapters }`. It has the caller's privileges; it is not a sandbox. Never point it at unreviewed pull-request source. The tool does not discover project modules from candidate checkouts or journals. [The source-only example](examples/release.project.mjs) deliberately refuses UI and build operations until real adapters are supplied.

Embedding consumers can import `@budded-water/release-kit/cli`, `/engine`, `/plan`, `/state`, `/command`, `/executor`, `/worker`, `/stores` and other named modules. A thin wrapper can supply defaults and retain an existing command line. `RELEASE_KIT_EXECUTOR_CONFIG` selects the private executor policy; consumers may map a legacy environment name in their wrapper.

## Project contract, version 1

`project` supplies `schemaVersion: 1`, `checksDescription`, `uiScope` and these asynchronous functions:

| Hook                                 | Contract                                                                                             |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `installValidation(ctx)`             | Install the dependencies needed by the complete source gate                                          |
| `checkSource(ctx)`                   | Execute the project's required checks; reject on failure                                             |
| `evaluateUI(ctx)`                    | Produce and validate evidence; return `{ path, sha256, source, scope, ... }`                         |
| `revalidateUI({ ...ctx, evidence })` | Recheck exact source, scope, verifier/runtime, suite coverage and referenced evidence on every reuse |
| `installBuild({ ...ctx, platform })` | Install the selected host's build dependencies                                                       |

`ctx` includes `root` (isolated source), `source`, `config`, `command`, `env`, `environment` and `signal`. Hooks use the supplied bounded command runner and cancellation signal, await cleanup, and never mutate publication journals. UI receipts must be bounded, unredirected files owned by the selected source checkout. The core hashes the stored receipt and invokes project revalidation before any build; the adapter is responsible for interpreting and checking the receipt and all linked reports. A forged or weak trusted adapter can defeat its own gate—do not treat arbitrary callbacks as validated evidence.

Source-only `validate` never calls platform build/publication adapters. `validate --ui` also runs the declared UI gate. `run`/`resume` retain artifact and acceptance gates. Unknown external operations require reconciliation rather than blind replay. `status --summary` is a progress projection, never approval or retry authority; omit the flag for full history. Passive `observe` differs from `status --remote`, which reconciles observations into the saved journal.

## Execution and storage

Local operation is the default. Optional GitHub scheduling supports one designated self-hosted Mac and its existing shared filesystem, using a pinned workflow and permanent request claims. It does not select paid hosted runners or perform cross-machine failover. Consumer repositories for this executor must remain private; this public tool repository does not run release jobs. The [workflow example](examples/.github/workflows/release-local.yml) is inert until explicitly installed and configured in a consumer.

Each project needs its own private configuration, credential references and state directory. Retain the existing directory when adopting this package: journal/request formats and identities are unchanged by this extraction. Do not create a second publication ledger or reset history. This first version does not provide multi-project concurrent resource scheduling; serialize projects sharing devices, native tooling or store targets through the designated machine's existing coordination procedure.

An installed control, its trusted project adapter and this exact dependency pin form one reviewed execution unit. Changing that unit while requests are unresolved is forbidden. Existing independent bootstrap copies must be upgraded through their own maintenance procedure; copying an npm re-export into a standalone bootstrap directory will not work. The standalone `src/coordination.mjs` has no package dependencies and may be installed as a checked byte-identical companion to a trusted bootstrap.

## Verification and limits

```sh
npm run check
npm run verify:package
```

Tests cover bounded subprocess cleanup, private state, provider failures, store-content planning, request ownership, retirement, polling, summaries and two synthetic project adapters. Synthetic adapters demonstrate isolation and recovery; they are not a second real consumer, native UI acceptance or store readiness. Real consumer regression and packaging acceptance must be recorded against exact commits separately. A GitHub response of unknown remains unverified even when local recovery succeeds.
