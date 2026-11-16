## 1. Contract and implementation
- [x] Record boundaries, strict selection, scope, credential and compatibility decisions.
- [x] Implement shared read context and lightweight query services.
- [x] Implement sanitized fact collection and pure metadata assessment.
- [x] Expose and document three CLI operations and Node APIs.

## 2. Verification and adoption
- [x] Test exact selection, lifecycle/build separation, incomplete inventory and cancellation.
- [x] Verify real generated-key authentication, pagination and read-only request boundaries.
- [x] Run required package checks, npm/pnpm packed consumer verification and spec validation.
- [ ] Pin the consumer candidate and verify its complete release regressions and required checks.
- [ ] Obtain current-head independent review after applicable PR preflight.
- [ ] Merge upstream only with owner authorization; repin and reverify consumer afterward.
- [ ] Verify authorized read-only acceptance in a second real project using private evidence. Deferred: owner postponed credential setup; synthetic tests are not acceptance.

## 3. Finalization
- [ ] Record installed-control adoption separately if requested. Deferred: source-only delivery does not upgrade installed control.
- [ ] Promote implemented specs and archive only when acceptance scope is fulfilled.
