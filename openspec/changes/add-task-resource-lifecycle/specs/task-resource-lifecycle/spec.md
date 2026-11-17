# task-resource-lifecycle Specification Delta

## ADDED Requirements

### Requirement: Explicit activation and trusted resource registration
The system SHALL enable lifecycle mutation only through a reviewed trusted policy,
compatible installed control and explicit resource registration within one state root.

#### Scenario: Existing consumer without policy
- **WHEN** a consumer has not activated lifecycle management
- **THEN** its commands retain existing execution semantics and no automatic cache deletion occurs

#### Scenario: Registered rebuildable leaf
- **WHEN** an enabled task needs a new cache
- **THEN** its registration intent is durable before allocation and its observed identity is bound before use
- **AND** the trusted adapter declares reconstruction inputs and required evidence separately

#### Scenario: Legacy or redirected resource
- **WHEN** a directory is undeclared, outside the root, redirected or governed by an unsupported policy
- **THEN** the system protects it and does not infer deletion authority from size or age

### Requirement: Mandatory resource admission
The system SHALL check resource recovery and capacity before new workspace, installation
or native-phase allocation on every enabled local, worker and direct execution route.

#### Scenario: Enabled runner bypass
- **WHEN** an enabled runner is invoked without a valid installation-bound admission capability
- **THEN** it fails before allocating or executing the heavy phase

#### Scenario: Pending reclamation at entry
- **WHEN** a new task enters after interrupted collection
- **THEN** it obtains exclusive maintenance before task activity and reconciles ownership and resource state
- **AND** stale ownership is not removed solely because a parent PID is gone or time elapsed

#### Scenario: Insufficient safe capacity
- **WHEN** protected resources or incomplete assessment prevent satisfying the configured cache budget and free-space floor plus phase estimate
- **THEN** new heavy work is refused with a machine-readable reason and no protected resource is deleted

#### Scenario: Concurrent admission
- **WHEN** two enabled tasks seek capacity at the same time
- **THEN** maintenance-to-activity transfer is atomic and reservations are accounted without duplicate allocation
- **AND** native execution preserves the existing exclusive device/build constraints

#### Scenario: Read-only status during pressure
- **WHEN** an operator reads state or reconciles a previously uncertain external operation
- **THEN** storage pressure does not require native allocation or authorize a new provider side effect

### Requirement: Durable settlement and compensating entry
The system SHALL persist task resource dispositions, settle owned subprocesses and
attempt eligible reclamation after execution, with next-entry recovery for missed finalization.

#### Scenario: Normal task settlement
- **WHEN** execution settles and durable materials verify
- **THEN** pending cache dispositions are recorded before activity release
- **AND** collection runs only after task locks are released and exclusive maintenance is acquired

#### Scenario: Other activity prevents collection
- **WHEN** another admitted task prevents exclusive maintenance at settlement
- **THEN** pending work remains durable for the next admission without deadlocking on the finishing task's own activity
- **AND** the successful task outcome is reported separately from deferred reclamation

#### Scenario: Fatal termination before finalizer
- **WHEN** the process or machine stops before the settlement hook
- **THEN** the next enabled entry discovers the admitted resource generation and requires ownership reconciliation before mutation
- **AND** no immediate idle-machine or powered-off reclamation guarantee is claimed

#### Scenario: Child cleanup remains uncertain
- **WHEN** owned child processes cannot be confirmed settled
- **THEN** existing ownership fences remain and destructive collection does not proceed

#### Scenario: Evidence or settlement recording fails
- **WHEN** task-result recording, evidence verification or pending-disposition persistence fails before session release
- **THEN** bounded ownership-verified child/session teardown is still attempted while ownership is held
- **AND** the original error is retained, disk resources remain protected and no successful settlement is reported
- **AND** ownership fences remain where child/session settlement is uncertain, while a proven-safe owned lease can be released without clearing evidence or ledger protection

### Requirement: Reference-safe bounded reclamation
The system SHALL delete only registered rebuildable resources cleared by fresh complete
ownership, source, reconstruction, historical-reference and filesystem-identity checks under maintenance.

#### Scenario: Receipt or historical reference
- **WHEN** any retained or cross-release evidence requires a target, descendant or enclosing path
- **THEN** that resource is protected and old reference semantics are not weakened to enable deletion

#### Scenario: Unresolved operation dependency
- **WHEN** a pending build or provider operation may depend on a resource and its dependency closure is unknown
- **THEN** the enclosing workspace remains protected without retrying that operation

#### Scenario: Incomplete live assessment
- **WHEN** a required scan times out, changes, encounters an unreadable dependency or cannot establish writers
- **THEN** no deletion is authorized by that assessment and the report distinguishes incomplete observation from successful collection

#### Scenario: Replaced path or unexpected mount
- **WHEN** target or ancestor identity changes, traversal encounters a symlink or device boundary, or link ownership is ambiguous
- **THEN** mutation stops without following the redirected target and reconciliation remains required

#### Scenario: Budget-based candidate selection
- **WHEN** several resources pass all eligibility checks
- **THEN** oldest last-use sequence followed by stable resource identity orders reclamation until the configured targets are met
- **AND** age never overrides protection and observed free-space changes are distinct from bytes traversed

### Requirement: Crash-consistent resource state and safe cache reuse
The system SHALL persist reclaim intent and revoke affected reuse before deletion,
verify completion afterward and preserve release identities, historical evidence and side-effect fences.

#### Scenario: Interrupted partial deletion
- **WHEN** collection stops after intent or during removal
- **THEN** the resource remains pending or reclaiming and is rechecked under maintenance before continuation
- **AND** no completed result is inferred without verifying that generation's absence

#### Scenario: Deletion completed before completion record
- **WHEN** a matching durable intent exists and the original generation is absent
- **THEN** reconciliation may record completion after fresh ownership and identity checks
- **AND** a replacement generation is never deleted as if it were the old target

#### Scenario: Cache lost without reclaim intent
- **WHEN** a historical successful cache stage references unexpectedly missing output
- **THEN** reuse is refused and the loss is diagnosed before any new evidence claim

#### Scenario: Resume after cache reclamation
- **WHEN** a task resumes with an affected resource marked reclaimed
- **THEN** reconstructable preparation executes again and any required evidence is freshly validated
- **AND** prior build, upload, submission and publication checkpoints retain their once-only recovery semantics
- **AND** old acceptance remains a historical fact rather than a current available-cache assertion

#### Scenario: Resource ledger persistence fails
- **WHEN** intent or reuse revocation cannot be durably written
- **THEN** deletion does not start
- **AND** failure to persist completion after removal remains an incomplete operation for reconciliation

### Requirement: Task-owned running resource release
The system SHALL release only verified task-owned sessions after all users and subprocesses settle.

#### Scenario: Last simulator session user
- **WHEN** the final registered user exits and live ownership verifies
- **THEN** the trusted adapter may stop the owned session without erasing device data or uninstalling a runtime

#### Scenario: Unknown session user or reused PID
- **WHEN** another user's ownership is unknown or the process identity differs
- **THEN** the session is protected and no name-based or PID-only termination occurs

#### Scenario: Shared service and operating system memory
- **WHEN** lifecycle collection runs
- **THEN** it does not stop shared database containers, change Docker settings or manipulate swap files
- **AND** stopping a session does not imply a guaranteed swap decrease

### Requirement: Read-only compatibility and bounded reporting
The system SHALL preserve existing read-only storage commands and separate task,
maintenance and capacity outcomes in bounded private reports.

#### Scenario: Existing preview is replayed
- **WHEN** stored `storage-plan` output is supplied or re-read
- **THEN** it remains non-executable and does not authorize deletion

#### Scenario: Explicit reclaim dry-run
- **WHEN** the operator invokes the proposed reclaim entry with dry-run
- **THEN** no ledger, ownership file, target or running session is changed
- **AND** later mutation must freshly acquire maintenance and revalidate the live state

#### Scenario: Reclamation report
- **WHEN** a collection attempt ends
- **THEN** its report records trigger, coverage, resource generations, protection/errors, before/after free space and maintenance outcome separately from task outcome
- **AND** sizes are not presented as guaranteed freed space and secrets are omitted

### Requirement: Fenced rollout and backward execution protection
The system SHALL require compatible bootstrap and runner adoption before mutation,
without rewriting historical release journals or silently activating old installations.

#### Scenario: Old control after lifecycle activation
- **WHEN** a control lacking lifecycle-aware reuse attempts execution against an activated root
- **THEN** the stable compatibility fence refuses execution before cache or publication reuse

#### Scenario: Disable or rollback
- **WHEN** an operator disables collection or rolls back code
- **THEN** the compatibility fence and history remain until safe reconstruction and execution compatibility are proven under maintenance
- **AND** disabling collection alone does not restore deleted caches or remove admission safety

#### Scenario: Package merge without consumer rollout
- **WHEN** the reusable capability is merged but the consumer has not adopted its pin, adapter, bootstrap and policy
- **THEN** the installation remains unchanged and no source merge constitutes live reclamation acceptance
