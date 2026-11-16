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
- [x] Verify authorized read-only acceptance in a second real project using private evidence. Inventory, exact found/not-found status, sanitized preflight and pure replay were verified with independent app/key configuration; operational records remain private.

## 3. Finalization
- [x] Record the installed-control boundary: adoption was not requested for this acceptance slice and remains a separate deferred rollout. The private query client does not upgrade the managed release controller.
- [x] Promote implemented specs and archive after source, consumer and second-project read acceptance. No full release-readiness or installed-control acceptance is claimed.

## Evidence ownership

The source implementation and consumer integration are distinct delivery records.
Exact heads, hosted check results and reviews belong to their PR records; the
consumer manifest/lockfile owns the adopted Git revision. Private provider reads,
credentials, operational journals and installed-control evidence remain consumer-owned
and are not copied into this public change. The authorized second-project read gate
is now satisfied by private evidence.
This includes an exact absent source-candidate result and a separately selected
existing-version assessment; it does not invent a new store version or establish
source/build ownership. Both real-project assessments conservatively retain unknown
build expectations. Installed-control rollout remains outside this completed slice.
