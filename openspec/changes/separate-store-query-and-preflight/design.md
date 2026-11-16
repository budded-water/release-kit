# Design

## Boundaries

`apple-store-read` owns input validation, team-key session, remote app identity,
bounded GET transport, cancellation/deadline and sanitized diagnostics. One operation
owns one reader; no global session/cache or project module is discovered.
`store-query` resolves iOS versions and reads only selected-build facts for an exact
candidate. `apple-version-state` owns the new read services' lifecycle interpretation.
`store-preflight` collects sanitized listing facts and evaluates them through a pure
`assessStorePreflight`. CLI adapters select operations and serialize their results.
Solura adds source/profile/product checks and writes its original journal.

## Identity and results

Targets include provider, ASC app ID, bundle ID, IOS platform and App Store destination.
An exact candidate resolves as found/not-found/ambiguous/unavailable. No match is
not-found only after a complete successful inventory; provider failures remain unknown.
Version ID and selected build are separate. Build matching never proves source or
review-attempt ownership. Unknown bounded provider enums are retained and interpreted
as unknown; absent state is an explicit diagnostic. Lists expose their coverage.
Read completion is independent of review approval, publication and assessment.
Reports include start/end times; multi-request reads are not atomic snapshots.

## Assessment

Facts omit contact values/passwords, listing text and private URLs. Assessment uses
booleans/counts and exact identity facts, needs no network and grants no approval.
Conclusions are blocked (confirmed missing), incomplete (unknown/attention), or
clear-within-scope. Scope is submission metadata and candidate/build comparison,
not complete submit readiness. Rules version is recorded. Product truthfulness,
App Privacy, device/locale screenshot coverage, agreements, access and production
runtime remain external evidence. `publicReleaseReady` stays false for compatibility.
Saved facts are not authenticated evidence just because evaluation is repeatable.

## Side effects, security and failure

Reads never persist journals or execute builds/store writes. Local configuration is
explicit; credentials and operational reports stay outside repositories. CLI limits
are 1–300 seconds; Node API defaults to 120 seconds and permits up to one hour for
existing consumer timeout contracts. Providers must honor cancellation; the deadline
requests cancellation and is checked again before returning. There is no automatic
retry or browser fallback. Read budget covers the whole operation. Errors include
bounded codes/reasons/status only; permissions failures never mean absent resources.

## Adoption and compatibility

Do not replace the existing artifact-owned `statusStore`, `status --remote`, passive
`observe`, content preparation or publication paths: their historical ownership and
reconciliation checks have different purposes. This phase centralizes interpretation
within the new queries/preflight only; moving legacy classifiers requires separate
behavioral evidence. The Solura adapter preserves kind, source/profile binding and
hash-chained journal mechanism. Its mismatch behavior intentionally becomes strict.
Upstream must be reviewed/merged before the consumer advances to the merged pin and
revalidates. Source adoption does not upgrade installed control.

## Extension and acceptance

Current new operations support ASC/IOS only, failing explicitly for other providers.
Google track and Harmony version semantics require their own implementations and
scenarios before being advertised. MCP, if needed, calls these services without a
second interpretation. Synthetic npm/pnpm consumers test installation independence;
a second real project with authorized credentials must validate reuse separately.
Its evidence stays private. This acceptance remains pending while credentials are
unavailable; do not relabel fixture success as live acceptance.
