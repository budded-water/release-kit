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
pnpm add --save-dev 'git+https://github.com/budded-water/release-kit.git#<reviewed-commit>'
pnpm exec release-kit --project ./release.project.mjs validate --ref <source-commit> \
  --platforms ios,android --config /absolute/private/release.json --state-dir /absolute/private/project-state
pnpm exec release-kit status <release-id> --state-dir /absolute/private/project-state --summary
```

`--project` must be the first argument. It explicitly imports a **trusted executable local module** exporting `{ repo, project, platformAdapters }`. It has the caller's privileges; it is not a sandbox. Never point it at unreviewed pull-request source. The tool does not discover project modules from candidate checkouts or journals. [The source-only example](examples/release.project.mjs) deliberately refuses UI and build operations until real adapters are supplied.

Embedding consumers can import `@budded-water/release-kit/cli`, `/engine`, `/plan`, `/state`, `/command`, `/executor`, `/worker`, `/stores` and other named modules. A thin wrapper can supply defaults and retain an existing command line. `RELEASE_KIT_EXECUTOR_CONFIG` selects the private executor policy; consumers may map a legacy environment name in their wrapper.

This repository uses the pnpm version pinned in `package.json`. Consumers may keep their own package manager; the source-validation example uses npm for a hypothetical npm consumer. Adapt its commands to the consumer's lockfile and bump `sourceValidationPolicy` whenever installation/check semantics change. Repository tooling changes do not upgrade installed controls or consumer dependency pins.

Direct `createRunner` consumers may omit `command` to use the bounded default
command runner, or inject their own implementation for the trusted adapter.

## Project contract, version 1

`project` supplies `schemaVersion: 1`, `checksDescription`, `uiScope`, an optional
`sourceValidationPolicy` identity and these asynchronous functions:

| Hook                                 | Contract                                                                                             |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `installValidation(ctx)`             | Install the dependencies needed by the complete source gate                                          |
| `checkSource(ctx)`                   | Execute the project's required checks; reject on failure                                             |
| `evaluateUI(ctx)`                    | Produce and validate evidence; return `{ path, sha256, source, scope, ... }`                         |
| `revalidateUI({ ...ctx, evidence })` | Recheck exact source, scope, verifier/runtime, suite coverage and referenced evidence on every reuse |
| `installBuild({ ...ctx, platform })` | Install the selected host's build dependencies                                                       |

`ctx` includes `root` (isolated source), `source`, `config`, `command`, `env`, `environment` and `signal`. Hooks use the supplied bounded command runner and cancellation signal, await cleanup, and never mutate publication journals. UI receipts must be bounded, unredirected files owned by the selected source checkout. The core hashes the stored receipt and invokes project revalidation before any build; the adapter is responsible for interpreting and checking the receipt and all linked reports. A forged or weak trusted adapter can defeat its own gate—do not treat arbitrary callbacks as validated evidence.

### Source validation reuse

Declare `sourceValidationPolicy` as a bounded nonempty identifier (up to 200
ASCII letters, digits, `.`, `_`, `:`, `/`, `-`; first character alphanumeric).
It identifies the trusted **installation and source-check policy**, including
transitive helper/configuration inputs outside the candidate source. Change it
whenever those semantics change. A consumer can derive it from hashes of the
reviewed policy files; a manually versioned ID requires an explicit bump. Function
text alone cannot identify closed-over or imported policy. The core combines this
identity with its validation contract version and the actual Node version.

Successful installation/check stages are reusable only when both carry the current
fingerprint and the isolated source still matches the plan. A policy change or
legacy stage without the fingerprint invalidates old source passes before any
replacement installation, then reruns installation and checks. Install failures,
check failures and cancellation cannot restore those passes. Unchanged policy
retains reuse; unrelated control/package edits do not invalidate it. Core changes
to these validation semantics must advance the validation contract version.

Adapters without the optional identity still execute, but reinstall/recheck on
every invocation. This is the safe compatibility default, not a permanent cache
key. Status exposes the effective `sourceValidation.policy` fingerprint (or `null`
when reuse is disabled). UI evidence still receives its independent per-use
revalidation; this identity does not certify a different UI suite or runtime.

The journal remains schema v1 with additive policy metadata and an `invalidated`
status for reconstructable source stages. Old events, release identity, build
attempts, acceptance, publication checkpoints and outcomes are preserved. Old
runtime versions do not enforce this policy boundary: do not resume updated
journals under an older core to bypass revalidation. Roll back to a reviewed
policy-aware runtime/adapter while retaining the same journal.

Source-only `validate` never calls platform build/publication adapters. `validate --ui` also runs the declared UI gate. `run`/`resume` retain artifact and acceptance gates. Unknown external operations require reconciliation rather than blind replay. `status --summary` is a progress projection, never approval or retry authority; omit the flag for full history. Passive `observe` differs from `status --remote`, which reconciles observations into the saved journal.

### Evidence recovery and execution outcomes

If a saved UI receipt is missing, changed or rejected by the current verifier,
the invocation fails and appends an `invalidated` UI stage retaining the old
output. The next `validate --ui`, `run` or `resume` evaluates UI again and must
pass current revalidation. Failed regeneration cannot restore the old pass.
This extends schema v1's reconstructable-stage invalidation to `ui-eval` without
changing release/request IDs, rewriting events, or resetting build attempts,
acceptance or publication checkpoints. Historical schema v1 passes are still
revalidated before reuse. Do not downgrade to a runtime that lacks these gates.
The source-validation contract fingerprint also advances for cleanup-aware
execution: passes from the previous core are reinstalled and rechecked once,
even when the adapter's policy identity is unchanged.

`run`/`resume` return zero only when every selected platform has a recognized
successful or progressing outcome: `submitted`, `in-review`, `processing`,
`released`, or `available` with `availabilityVerified: true`. An `accepted`
artifact also qualifies when publication has not been requested. Zero indicates
execution progress, not store availability. `pending-review`, `pending-release`,
`prepared`, `uploaded`, absent results, and unknown adapter states return nonzero.
Adapters must use these explicit outcomes. Polling uses the same classification
but succeeds only when all selected platforms have verified availability.

## Execution and storage

Local operation is the default. Optional GitHub scheduling supports one designated self-hosted Mac and its existing shared filesystem, using a pinned workflow and permanent request claims. It does not select paid hosted runners or perform cross-machine failover. Consumer repositories for this executor must remain private; this public tool repository does not run release jobs. The [workflow example](examples/.github/workflows/release-local.yml) is inert until explicitly installed and configured in a consumer.

Each project needs its own private configuration, credential references and state directory. Retain the existing directory when adopting this package: journal/request formats and identities are unchanged by this extraction. Do not create a second publication ledger or reset history. This first version does not provide multi-project concurrent resource scheduling; serialize projects sharing devices, native tooling or store targets through the designated machine's existing coordination procedure.

An installed control, its trusted project adapter and this exact dependency pin form one reviewed execution unit. Changing that unit while requests are unresolved is forbidden. Existing independent bootstrap copies must be upgraded through their own maintenance procedure; copying an npm re-export into a standalone bootstrap directory will not work. The standalone `src/coordination.mjs` has no package dependencies and may be installed as a checked byte-identical companion to a trusted bootstrap.

### Unconfirmed subprocess cleanup

An error with `cleanupIncomplete: true` means a subprocess group could not be
proven stopped. Execution stops before the next platform, retains currently held
release/resource/target locks, and creates an exclusive private
`locks/cleanup-incomplete.lock` fence in the same state directory. The fence is
the admission authority; stage error metadata is diagnostic history. Even if an
adapter catches the command failure, it cannot report successful completion or
launch another command through the supplied runner. New runners refuse execution
in that store. A cleanup failure during claimed execution leaves its dispatch
unknown; a failure before claiming leaves the request pending. Maintenance
inventory reports a blocker. Local `status` remains readable. Partial or malformed fences
also block admission; neither elapsed time nor PID disappearance clears one.

Recovery is an operator procedure: stop admission through all entry points,
inspect the fence and retained ownership records, establish that the owning
process and all children stopped, and reconcile any provider effects. Only then
remove the verified stale locks and the fence, retaining journals and dispatch
records, and restart with a new runner. There is no automatic unlock or provider
replay. The fence is additive installation state with schema version 1; legacy
stores without a fence need no migration. Older runtimes do not enforce it, so
keep the installed execution unit pinned until recovery is complete.

## Verification and limits

```sh
pnpm install --frozen-lockfile
pnpm run check
pnpm run verify:package
```

The package check uses `pnpm pack` and installs the resulting tarball into separate synthetic pnpm and npm consumers, verifying imports and the executable in each. `pnpm-lock.yaml` is the only repository dependency lockfile. pnpm uses a shared content-addressable store to reuse dependency files across projects; this package currently has no dependencies to deduplicate.

Tests cover bounded subprocess cleanup, private state, provider failures, store-content planning, request ownership, retirement, polling, summaries, complete synthetic run/resume flows, cleanup admission fences, UI evidence regeneration and two synthetic project adapters. Synthetic adapters demonstrate isolation and recovery; they are not a second real consumer, native UI acceptance or store readiness. Real consumer regression and packaging acceptance must be recorded against exact commits separately. A GitHub response of unknown remains unverified even when local recovery succeeds.
