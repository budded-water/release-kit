# Read-only release storage inventory and cleanup preview

## Why
Release state combines durable journals/evidence with reconstructable validation and
native workspaces. Whole-directory migration is expensive, while ad-hoc deletion
can break references or leave successful installation stages pointing at missing files.
Operators need bounded measurements and conservative explanations before any cleanup.

## What Changes
- Add standalone `storage-inspect` and `storage-plan` CLI/API reads of one explicit state root.
- Measure logical file bytes and unique observed allocations without following symlinks.
- Validate retained journal chains and find literal path references across their snapshots.
- Explain protected workspaces and review candidates with mandatory future checks and stage invalidation requirements.
- Share the existing pure event-integrity rule with the bounded storage reader; retain journal v1 bytes and execution behavior.

## Non-goals
No deletion/apply, journal writes, cache invalidation, credential reads, project imports,
provider calls, installed-control upgrade, automatic retention, cross-project shared
workspaces, artifact deduplication or claims of actual reclaimable filesystem space.
The report is a non-atomic private observation and never executable cleanup authority.
