# Task resource lifecycle management

## Why
Isolated source validation and native acceptance create independent installations,
compiler intermediates and running tool sessions. Isolation protects source and
evidence identity, but indefinite retention makes storage grow with execution
history. Process cleanup alone does not reclaim those files, and a finalizer cannot
run after a crash or machine shutdown. A free-space check only refuses the next
build; it does not close this lifecycle.

## What Changes
- Add an explicitly enabled, project-scoped lifecycle for registered rebuildable
  resources, separate from release outcomes and permanent evidence.
- Check pending reclamation at managed task admission and record/reconcile it after
  task settlement. Persist interrupted work so the next admission can recover it.
- Reclaim only under exclusive maintenance, with fresh identity, ownership,
  reference and reconstruction checks; preserve existing release/provider gates.
- Bound retained caches by a required byte budget and deterministic recent-use
  ordering. Refuse new allocation when safe reclamation cannot satisfy admission.
- Track task-owned running resources and release them only after their users and
  subprocesses settle. Existing shared services remain outside automatic teardown.
- Add private, bounded lifecycle reports and a separate mutating reclaim entry;
  retain the existing standalone inventory/preview commands as read-only.
- Define compatibility fencing, synthetic acceptance and downstream managed-control
  adoption before any automatic reclamation can be enabled.

## Capabilities
### New Capabilities
- `task-resource-lifecycle`: resource registration, two admission/settlement hooks,
  maintenance reclamation, crash recovery, cache reuse and owned-session release.

### Modified Capabilities
None. `release-storage` observation and preview remain unchanged; this proposal
adds a distinct execution contract rather than making saved previews executable.

## Impact
Release Kit owns the reusable ledger, reclaim engine and runner admission contract.
Trusted consumer adapters own exact cache classes, reconstruction semantics,
evidence references and native resource controls. Managed consumer bootstraps must
adopt the contract before activation; repository merge alone enables nothing.

## Non-goals
No implementation or deletion in this proposal. No automatic enrollment of legacy
directories, broad home-directory cleanup, OS swap manipulation, runtime-image
uninstallation, service shutdown, scheduled daemon, shared writable DerivedData,
cross-release evidence shortcut, remote artifact service or provider replay.
No filesystem-space savings or build-speed claim follows from directory size.

## Delivery boundary
This is a proposed contract, not implemented behavior. Implementation, synthetic
acceptance, consumer integration and authorized installed rollout are separate
tasks. Publication authorization and review/release gates remain unchanged.
