# Release storage inventory and cleanup preview

These standalone commands inspect an existing **state root**, not a whole home,
installation, runner or toolchain directory. They require no project module,
release configuration, credentials, native tools or provider access.

```sh
release-kit storage-inspect --state-dir /absolute/private/project-state
release-kit storage-plan --state-dir /absolute/private/project-state
```

Both print one JSON report and write nothing. Save reports privately outside the
inspected root. Exit 0 means the declared observation completed, even if every
workspace is protected; incomplete observation returns 2. Invalid inputs and caller
cancellation fail. Neither command accepts a release ID, `--config`, publication
options or `--apply`. No deletion command or executable cleanup plan exists.

## API and boundaries

```js
import { inspectStorage, planStorageCleanup } from '@budded-water/release-kit/storage';

const inventory = await inspectStorage({
  stateDirectory: '/absolute/private/project-state',
  maxEntries: 100000, timeoutMs: 120000, signal
});
const preview = planStorageCleanup(inventory);
```

The Node API requires an existing absolute directory. CLI budgets are
`--max-entries` (1–10000000, default 100000) and `--timeout-seconds` (1–300,
default 120). API timeout uses milliseconds with the same maximum. Directory depth
is bounded; journal reads additionally cap each record at 8 MiB, total event bytes
at 64 MiB and parsed-reference complexity. The reader uses the same event-integrity
rule as normal journal replay and checks event numbering. Schema-v1 journal bytes,
IDs, stages, operation checkpoints and publication gates are unchanged.

The observer first discovers release journals, workspace roots and immediate
ownership markers, then verifies the discovered journals before measuring deep
workspace contents. Thus a large workspace does not consume the entry budget
before other releases' journals can be read. Metadata discovery/verification still
shares the overall limits and may itself be partial. A later measurement failure
retains completed journal checks but disables every review candidate. Unverified
or missing journals never report a resolved reference scope. Literal deep paths
are resolved against the subsequent traversal, not the shallow discovery pass.
Deferred directories are checked again before traversal, and history/directory
change checks still run after an entry-budget failure while time remains.

For a large root, callers can explicitly raise `--max-entries` above one million;
the default and five-minute timeout maximum remain unchanged. Exhausted limits
still produce partial results, never a complete size or cleanup clearance.

Directory entries are streamed and observed with lstat. Symlinks are counted but
never intentionally traversed, and their target bytes are excluded. This is a
cooperative local observation, not a filesystem sandbox or an atomic snapshot.
Metadata identity/directory changes and read failures produce partial reports;
callers must quiesce writers and reverify under maintenance before any future write.
The observer does not acquire/create a lock and never uses project/provider code.

## Measurements

`groups` partition observed regular-file apparent bytes by release and top-level
state area. `workspaces` additionally measure known `validation`, `build-ios`,
`build-android`, `build-harmony`, numbered build-attempt and `store-content-source`
directories. Workspace sizes are subsets of groups; do not sum both.
Unknown directories are measured but never suggested as cleanup targets.

Global `observedUniqueAllocatedBytes` counts available regular-file block allocation
once per observed device/inode. Directory allocation is excluded; hard links can
exist outside the scan, and filesystem compression/snapshots affect actual freeing.
Neither this value nor apparent bytes estimate reclaimable space. `reclaimableBytes`
always remains null. Symlink and hard-linked-path counts are reported separately.

## References and protection

All valid retained event snapshots participate, including old evidence and
cross-release references. Literal absolute paths inside the explicit root protect
matching workspace ancestors/descendants. Only the already-validated declared-root
OS alias is normalized. External, missing or possible relative path references
conservatively block workspace candidates. Referenced outside files are not read;
no credential values, contact data or other raw journal contents enter the report.

Common stage, TestFlight operation, outcome and checkpoint fields are checked for
unsettled or unrecognized execution. Any state lock/cleanup marker protects all
workspaces. A symlink or invalid file at a reserved locks/dispatch/targets root
makes observation incomplete without reading the target. Dispatch history and target
ownership are deliberately not declared
settled by this first reader: their presence requires reconciliation and protects
all workspaces, even if a separate trusted operator can prove them settled.
Opaque workspace symlinks also protect their containing workspace. Unknown/corrupt
journal schemas, missing events, errors, changed history and exhausted budgets
produce incomplete observation and disable all review candidates.

Protection is conservative and scoped. The reader does not inspect external
receipts, arbitrary relative-path conventions, clean Git state, platform-specific
signature input dependencies or the wider machine's references. Project review
must cover those before a later cleanup implementation.

## Meaning of a candidate

`planStorageCleanup` is pure. `review-candidate` means that no protection was
observed within this limited inventory, not that a directory is safe to delete.
Every entry still requires exclusive maintenance and a fresh scan, clean source/
project-policy verification, retained external evidence and signing inputs, and
explicit invalidation of reconstructable installation/check stages. Removing
workspaces without invalidating their successful stages can break reuse; the
current feature neither removes them nor changes those stages. Build/publication
intents must not be invalidated into a duplicate side effect.

Saved/replayed JSON is not authenticated evidence. `applySupported` and
`deletionAuthorized` are false. There is no retention timer, cache deletion,
artifact deduplication, journal compaction or installed-controller upgrade.
[The active OpenSpec change](../openspec/changes/add-read-only-storage-inventory/)
owns first-slice acceptance. Synthetic consumers establish behavior and packaging,
not acceptance of an old machine's real state or its reported disk footprint.
