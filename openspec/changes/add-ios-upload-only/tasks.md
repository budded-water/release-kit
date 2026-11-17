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
- [ ] Complete current-head hosted checks and independent reviews.
- [ ] Adopt through the consumer PR and managed maintenance after authorized merges.
- [ ] Complete authorized real upload-only acceptance with private evidence;
      retain no-review/no-release postconditions. Do not archive before this step.
