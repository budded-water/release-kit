## Implementation
- [x] Implement bounded shared Apple upload and explicit adapter capability.
- [x] Add local CLI/runner entry and durable bounded resume semantics.
- [x] Preserve source/evidence/ownership/recovery gates and truthful status/exit codes.
- [x] Document API, journal compatibility, consumer adoption and operational limits.

## Verification
- [x] Cover immediately VALID builds without review/policy writes.
- [x] Cover unknown upload/restart reconciliation without duplicate upload.
- [x] Cover missing adapters/evidence, conflicting legacy intent, stale source,
      content/retry fencing, target ownership and explicit escalation.
- [x] Run required checks and packed pnpm/npm consumer verification.
- [x] Complete implementation-head hosted checks and independent reviews.
- [x] Adopt through the consumer PR and managed maintenance after authorized merges.
- [x] Complete authorized real upload-only acceptance with private evidence:
      a newly built and accepted consumer artifact reached Apple PROCESSING;
      independent official reads confirmed the same manual draft, no selected
      build and no review submission. Journal upload intent remained separate
      from publication intent, with no review/release checkpoint.

Source delivery uses the owner-authorized PR workflow. PR records are canonical
for exact reviewed heads, hosted checks and merge status; consumer hosted CI
availability follows its own policy and must not be represented as a pass when
unexecuted. Private operational evidence remains outside this repository.

## Closeout boundary
- [x] Promote the implemented requirements and archive after bounded live acceptance.

This closes upload-only acceptance, not review, public availability or a fresh
TestFlight/App Store installation. Unknown-response recovery, conflicting inputs
and immediately VALID routing were verified with synthetic provider tests;
those failure conditions were not induced in the real account. Future provider
processing outcomes remain operational observations, not a reason to repeat upload.
