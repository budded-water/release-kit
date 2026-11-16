## 1. Contract and implementation
- [x] Record boundaries, strict selection, scope, credential and compatibility decisions.
- [x] Implement shared read context and lightweight query services.
- [x] Implement sanitized fact collection and pure metadata assessment.
- [x] Expose and document three CLI operations and Node APIs.

## 2. Verification and adoption
- [x] Test exact selection, lifecycle/build separation, incomplete inventory and cancellation.
- [x] Verify real generated-key authentication, pagination and read-only request boundaries.
- [x] Run required package checks, npm/pnpm packed consumer verification and spec validation.
- [x] Obtain current-head upstream independent review after applicable PR preflight.
- [x] Merge upstream with owner authorization.
- [x] Pin the reviewed merged source in the consumer and verify its locked install and local release regressions.
- [x] Verify consumer hosted checks and current-head independent review after applicable PR preflight.
- [ ] Verify authorized read-only acceptance in a second real project using private evidence. Deferred: owner postponed credential setup; synthetic tests are not acceptance.

## 3. Finalization
- [ ] Record installed-control adoption separately if requested. Deferred: source-only delivery does not upgrade installed control.
- [ ] Promote implemented specs and archive only when acceptance scope is fulfilled.

## Evidence ownership

The source implementation and consumer integration are distinct delivery records.
Exact heads, hosted check results and reviews belong to their PR records; the
consumer manifest/lockfile owns the adopted Git revision. Private provider reads,
credentials, operational journals and installed-control evidence remain consumer-owned
and are not copied into this public change. Source adoption does not satisfy the
deferred real-project/provider or installed-control acceptance tasks above.
