# Registered task resources

This capability manages explicitly registered preparation caches and task-owned
sessions. It is disabled for existing installations. Source delivery is not an
installed-control upgrade, policy activation or permission to remove legacy files.
The [OpenSpec change](../openspec/changes/add-task-resource-lifecycle/proposal.md)
tracks implementation and remaining consumer/installed acceptance gates.

## Commands and activation

`storage-inspect` and `storage-plan` keep their read-only contract. The separate
`storage-reclaim` command requires an explicit private lifecycle policy and trusted
project adapter; it accepts neither arbitrary targets nor saved plans.

```sh
release-kit storage-reclaim --config <private-lifecycle-policy.json> --dry-run
release-kit storage-reclaim --config <private-lifecycle-policy.json>
```

Exit codes: 0 for a complete assessment satisfying capacity, 3 for protected overage
or insufficient capacity, 4 for incomplete assessment/removal, 130 for cancellation.
Invalid configuration fails with exit 2 at the executable boundary. Dry-run does not
write state/ownership or stop sessions. A managed wrapper can separately hold its
normal read activity; mutation requires maintenance. Logical bytes removed and
observed volume free bytes are distinct; no report promises physical space recovery.

The private operational policy has `schemaVersion: 1`, canonical `stateDirectory`
and `coordinationAnchor`, positive `cacheBudgetBytes` and `minimumFreeBytes`, and
positive `phaseBytes` for `validate`, `execute` and `content`. Adapters may require
additional project inputs. No universal GB defaults are supplied; measure cold/warm
workloads before choosing installed values. Keep this policy separate from release
configuration so existing plan IDs and configuration digests remain unchanged.

Direct heavy CLI execution may supply `--lifecycle-config <private-policy.json>`.
Managed entries bind the policy in their installation manifest. Neither candidate
source nor journals select an adapter. Ordinary execution never activates a root.
API `activate({lease})` requires current in-process maintenance ownership and settled
dispatch/cleanup evidence. Unknown metadata or partial activation requires explicit
reconciliation, not directory replacement.

A managed iOS build attachment borrows an existing activity lease. The
activated policy and settled resource journal must match the installed state
root. The admission is scoped to the saved release, attachment command, and
one continuous activity lease. The runner rechecks ownership and the active
policy before recording attachment checkpoints. It preserves the lease and resource journal
without opening a heavy lifecycle task. See [bounded attachment](ios-upload.md#attach-the-confirmed-build-to-a-manual-draft).

## Trusted adapter and resource boundaries

The project's `resourceAdapter` factory receives explicit policy, supervised command
runner, selected execution environment and repository context. Its version-1 result supplies:

- SHA-256 `policy` identity covering semantic inputs;
- `caches`: distinct, nonoverlapping relative preparation leaves and affected `stages`, drawn from
  `install-validation`, `checks`, `ui-eval`;
- `toolchain`: verified SHA-256 identity before cache use;
- `references`: verified required absolute paths from retained reports;
- `reconstructable`: matching source/toolchain, `sourceClean`, `inputsAvailable`
  and `recoveryIndependent` proofs;
- optional `sessions`, `validateSession`, `releaseSession` for owned native sessions.
  Release must honor its separate bounded cleanup signal.

Registration precedes allocation; observed identity is bound before use. Existing
undeclared directories are rejected. Only preparation leaves in validation
workspaces under the configured state root are supported initially; content/build
workspaces remain protected. Opaque symlinks, mounts,
hard-linked files and unknown classes stay protected. This is not automatic
enrollment of dependency installations or entire workspaces. Final packages,
signing inputs, source identities, journals and required reports remain durable.

## Two triggers and dispatch

Core runners and workers refuse an activated root without a live root/plan-bound
admission. `createResourceLifecycle` can use a managed lease for atomic transitions.
Admission acquires exclusive maintenance before task locks, reconciles pending
work, measures references/caches, reclaims oldest eligible leaves, checks the budget
and free-space floor plus phase estimate, records a reservation, then atomically
enters activity. Heavy phases recheck actual space before allocating. Initially one
heavy task is admitted per coordination domain; no machine scheduler is introduced.

Settlement attempts owned-session finalization with an independent bounded signal
even if execution, evidence or ledger writes fail. Preserve the original error and
uncertain ownership fences. Record pending cache disposition before activity release.
Then use the same maintenance collector, or defer if another activity prevents
exclusive ownership. Task outcome and maintenance outcome are reported separately.

Enabled remote dispatch returns its still-pending request once dispatch evidence
is durable, letting the dispatcher release activity before worker maintenance.
Workers may wait up to 30 seconds for voluntary settlement, never steal ownership.
Unknown dispatch is not native completion. Explicit dispatch-resume may claim an
unstarted request under admission; claimed requests never replay. Disabled
consumers retain their existing polling/fallback behavior.

## Durable state and recovery

`resources/feature.json` binds contract, root, anchor and policy. Ordered hash-linked
deltas in `resources/events/` record task, cache-generation and session changes.
The current index is derived in memory; unrelated identities are not recopied into
each event. Release/request histories are not rewritten or replaced.

Caches progress through creating, retained/pending, reclaiming and reclaimed.
Reclaim intent revokes cache reuse before removal. Historical evidence and once-only
build/provider checkpoints remain intact; required preparation reruns after cache
loss. Complete fresh ownership, retained-reference, dispatch-input, target-owner,
reconstruction and filesystem checks precede deletion. Legacy references are not
weakened. Deletion verifies identities without following links; completion requires
verified absence. Interrupted removal is reassessed. Replacement or uncertain
completion retains ownership for explicit recovery.

After fatal termination, reconcile process groups/sessions before recovering leases;
PID absence and age are insufficient. `reconcileTask` accepts an operator attestation
bound to task, policy and current history digest, confirming children, sessions and
evidence settlement. This records operator provenance, not independent proof, and
never resets native/provider intent. Existing partially created paths stay protected.

There is no daemon: next admission compensates for missed finalization; explicit
reclaim works during idle maintenance. History/reference/traversal limits fail closed.
Status and already-uncertain provider reconciliation do not require native allocation.

Prerequisite-only `doctor` diagnostics live in `diagnostics/<release-id>/logs`,
outside the journaled `releases/` namespace. A doctor call creates no release
history and cannot leave a journal-less release blocking later admission.
Existing logs-only legacy directories remain protected: this layout change neither
moves their files nor invents missing release events.

Schema-v1 engine error/message fields are diagnostic text, not file dependencies,
even when an error begins with an absolute compiler path. Their bytes remain in
history. All other literals and typed path fields retain conservative reference
assessment; custom fields named `error` or `message` gain no exemption. Reports
normalize adapter error codes rather than exposing arbitrary diagnostic values.
The planner's `plan.metadata.metadataPath` and `submissionInformationPath` values
are Git object identities despite their legacy names. Only valid 40-hex identities
at those exact schema locations are classified as identities; malformed/custom
values still block assessment. The standalone legacy inventory keeps its existing
conservative preview rules.

## Rollout and rollback

Adopt the reviewed core pin, adapter and lifecycle-aware stable bootstrap before
activation. The bootstrap must reject older controls before deletion. All cooperative
writers must use that entry; arbitrary obsolete binaries run directly with the same
user privileges are outside this guarantee. Stop or migrate unsupported launch
routes first. This is not a filesystem sandbox against unrelated writers.

Disabling collection does not restore caches or make old runtimes safe. Retain the
compatibility fence until reconstruction and rollback execution are verified under
maintenance. Legacy folders, SDK/runtime images, shared containers and swap remain
outside automatic mutation. Consumer source adoption, installed activation and real
native acceptance require their own evidence.

There is no `--disable` flag that allows heavy work to bypass an activated root.
To stop collection, quiesce heavy writers and leave the feature/installation fences
in place; status and independent observation remain available. A source rollback
must restore a reviewed compatible control, adapter and policy together under
maintenance. Changing the budget or removing the feature marker is not a rollback.
An incompatible policy fails before allocation; compatible restart retains the
same feature bytes and reconstructs reclaimed preparation normally. Rehearse the
installed snapshot/restore procedure before rollout; source tests do not prove it.

## Source acceptance and remaining operational limits

The process-boundary suite kills real child processes after reservation, registration,
directory creation, confirmed use, pending disposition, reclaim intent, partial
removal, verified absence and completion. It also interrupts both ownership handoffs.
Stale fences block another process; controlled operator recovery preserves source
history and does not adopt an unconfirmed directory. Filesystem-call ENOSPC injection
covers session/task settlement and post-removal completion, while the independent
finalizer deadline is exercised with a controlled clock. These are process/fault
tests, not hardware power-cut or physically full-volume acceptance.

Two synthetic project adapters exercise their own source checks, repeated cache
generations and protected overage. Additional tests cover hard links, historical
cross-release/relative references, corrupt/truncated/missing events, typed diagnostic
and Git-identity classification, bounded reports and compatibility refusal.
A private scratch-image rehearsal also replaced a registered empty leaf with an
actual mounted filesystem. The changed device identity made the complete collection
incomplete: an earlier eligible cache and the foreign mounted sentinel both survived.
The newly created image was then detached and removed. This establishes mount
substitution refusal, not permission to manipulate existing volumes.

A copied private installation exercised actual compatible and legacy consumer
controls. Ordinary status did not activate; explicit activation was required. The
old bootstrap refused the new manifest, the new bootstrap refused the old control,
and a manifest downgrade could not bypass an active feature. Restoring the compatible
tuple preserved history and feature bytes. Unavailable capacity refused a task before
its callback, CLI dry-run preserved state, and policy drift retained maintenance.
These scratch rehearsals do not upgrade an existing installation or demonstrate
rebuilding a reclaimed native product. Measured cold/warm workloads, live cutover,
post-reclamation native reconstruction and authorized legacy reconciliation remain
separate OpenSpec gates.
