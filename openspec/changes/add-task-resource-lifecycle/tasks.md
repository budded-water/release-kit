# Implementation and acceptance tasks

Checked items describe implemented core contracts, not installed adoption or native
acceptance. Unchecked verification and consumer/rollout gates remain required;
proposal/schema validation alone never authorizes deletion.

## 1. Freeze interfaces and resource policy
- [x] Define the resource event schema, generation identity, index recovery and bounded reports; preserve release/request identities and journal bytes.
- [x] Freeze reclaim CLI/API inputs and distinct success, protected/capacity, incomplete and cancellation outcomes; retain existing storage read contracts.
- [x] Define trusted adapter registration, reconstruction/reference rules, source-cleanliness checks and exact intermediate leaves; reject arbitrary target paths and candidate-selected hooks.
- [ ] Define the stable feature fence, old-control refusal, disable behavior and safe rollback/reconstruction procedure before enabling mutation.
- [ ] Define positive cache budget, phase allocation estimates and free-space policy from measured consumer workloads; do not infer authority from TTL.

## 2. Implement lifecycle and admission
- [x] Persist registration before allocation and identity confirmation before use; recover interrupted creation without adopting unrelated files.
- [x] Implement retained/pending/reclaiming/reclaimed generations and owned/release-pending/released sessions, with durable reasons for incomplete actions.
- [x] Add mandatory admission capability checks to local, worker and direct heavy execution paths while retaining read-only/status and uncertain-operation recovery access.
- [x] Extend and test atomic maintenance/activity transitions, capacity reservations and lock ordering using the existing coordination boundary.
- [x] Add admission reconciliation and settlement disposition hooks using one collector; preserve busy/cancellation and subprocess cleanup fences.
- [x] Make cache reuse consult generation/file availability and revoke affected reuse before deletion without resetting build/publication side effects.

## 3. Implement bounded reclamation and running-resource release
- [x] Under exclusive maintenance, validate fresh owners, dispatch/target settlement, all retained references, source/reconstruction inputs and target identity.
- [x] Keep legacy/untyped/unknown resources protected; reject incomplete scans, redirected paths, unexpected mounts and ambiguous link ownership.
- [x] Implement intent-first, non-following bounded removal, completion verification, partial-delete recovery and actual volume before/after measurement.
- [x] Reclaim eligible resources by last-use order and refuse new heavy work when protected overage or free-space requirements remain unsatisfied.
- [x] Release only verified task-owned sessions after the last user and children settle; exclude device erasure, runtime uninstall, shared services and swap.
- [x] Preserve dry-run as no-write/no-stop and report task success independently from deferred or failed maintenance.

## 4. Verify at actual boundaries
- [ ] Use real temporary files, durable event writes and separate OS processes to test competing admission, maintenance transitions and reservation accounting.
- [ ] Inject crashes before/after registration, intent, reuse revocation, partial deletion, deletion completion and admission/settlement handoff.
- [ ] Test stale owners, unknown children, cancellation, ledger corruption/ENOSPC, interrupted completion writes and missing/replaced generations.
- [ ] Inject task-result/evidence/pending-disposition ENOSPC or verification failure before teardown; prove bounded owned-session cleanup still runs, the original error survives, disk resources stay intact and uncertain owners retain their fences.
- [ ] Test cross-release/historical/relative references, legacy policy, symlink/ancestor replacement, mount/link ambiguity and evidence preservation.
- [ ] Test resume after reclamation and unchanged native-build/upload/submission/publication idempotency; no provider writes during collection.
- [ ] Test exact API/CLI dry-run/read-only behavior, bounded reports, secret omission, old-control refusal and safe disable/rollback.
- [ ] Exercise two synthetic project adapters and repeated generations, including protected-overage and interrupted-recovery cases.
- [ ] Run required repository checks, packed pnpm/npm consumer verification and independent final-head review; inspect behavioral test quality for implementation.

## 5. Consumer integration and authorized rollout
- [ ] In a separate consumer PR, pin the reviewed core and add trusted App cache/reference/session policy plus stable bootstrap admission and fencing.
- [ ] Synchronize consumer release/UI-eval contracts and installed companion provenance; retain exact source/native/evidence gates.
- [ ] Obtain concrete authorization for installed policy activation and any legacy deletion list; repository publication alone is insufficient.
- [ ] Under managed maintenance, reconcile active requests/owners, preserve required inputs/history and verify the no-write classification first.
- [ ] Activate only declared new-generation intermediate resources and verify final packages, receipts and user-visible task outcomes remain usable.
- [ ] Measure identical cold/warm workloads: complete checks, peak/settled cache bytes, protected bytes, rebuild/maintenance time, running sessions and admission failures.
- [ ] Demonstrate steady retention after multiple generations and crash recovery, with unchanged store state and no duplicate operations; retain private receipts.
- [ ] Keep manual historical build directories outside automatic collection; prepare any one-off cleanup as a separate reviewed operational action.
- [ ] Promote/archive this proposal only after accepted implementation and required adoption/acceptance evidence; do not mark blocked live work complete.
