# Design

## Reader and scope
`inspectStorage` accepts an existing absolute state directory, entry budget,
overall timeout and cancellation. It validates existing ancestors, streams directory
entries, uses lstat and does not follow nested symlinks. Files outside state are
never read. Measurements count regular-file apparent bytes per nonoverlapping
release/top-level group; global observed allocations count each inode once.
Hard links outside the scan, compression and snapshots make actual reclaimable
space unknowable here, so reclaimable bytes remain null.

Only release event JSON is read, bounded by per-record, total-metadata and object
complexity budgets. Event numbering and the shared journal-integrity rule validate
all retained snapshots. Raw metadata values never enter the report. Literal absolute
paths are matched to candidate ancestors/descendants; possible relative paths and
unresolved external paths conservatively block preview candidates. Metadata is
checked again after reading; no lock or state directory is created.

## Preview and failure
Known validation/build/store-content source directories are inventoried as workspaces.
Unrecognized directories remain unclassified. All historical snapshot references
protect their targets, including references owned by another release. Current
running/unknown/failed stages, build/submission intents, publication checkpoints,
nonterminal outcomes and recorded ownership protect workspaces. Unknown formats,
read failures, changed history and exhausted budgets disable all review candidates.
Symlinks within a workspace protect it because their targets are outside this scan.

`planStorageCleanup` is pure and only accepts the current inventory schema. Its
review candidates still require exclusive maintenance, fresh identity/reference
checks, clean source verification and explicit cache-stage invalidation. No build,
publication or journal history is invalidated by this feature. Clearing an install
stage must not permit a duplicate build or submission. Neither a saved inventory
nor replay authenticates evidence or authorizes deletion.

## CLI and packaging
Both commands require `--state-dir`; neither accepts project/config/publish/apply
options or a release ID. Default timeout is 120 seconds (CLI maximum 300), entry
budget 100000 (maximum 1000000), record limit 8 MiB, total journal bytes 64 MiB.
Exit 0 means observation complete, even with protected workspaces. Partial reads
return 2; invalid input and cancellation fail. No automatic retry or report writes.
The public package includes only synthetic fixtures and documentation. Real paths,
credentials and operational observations stay private.

## Adoption
Source/package acceptance and private read acceptance are separate. First test two
synthetic consumer layouts, reference/corruption/concurrency and no-write boundaries.
Inspect available private roots only after source checks; an imported metadata-only
root does not establish the old machine's actual workspace size or rollout. Keep
this change active until its required delivery/acceptance tasks are complete.
