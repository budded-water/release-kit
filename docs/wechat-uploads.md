# WeChat developer uploads

## Scope and compatibility

The opt-in `wechat` command is a separate operation contract. Existing Expo
plans, native platform names, request IDs and journal schemas are unchanged.
The trusted project module explicitly supplies `wechatProject`; saved journals
never select executable modules. No registry package or installed-control upgrade
is implied by source delivery.

This first workflow uploads a **development code version** only. It cannot select
an experience version, submit review or publish publicly. Those outcomes remain
false in its derived summary. Official confirmation and MFA remain interactive.

## Trusted project and evidence

The selected module's default export is `{ repo, wechatProject }`. Its project has
`schemaVersion: 1`, `appId`, `artifactDirectory` relative to the checkout,
`policy`, `driver: { binary, clientName, skillVersion }`, and asynchronous
`validate`/`revalidate` hooks. Driver selection is trusted operator configuration;
no token or credential field is supported by this contract.

`validate({ root, source, command, signal })` executes the consumer's required
checks and build and returns `{ path, sha256 }` for a receipt inside that source
checkout. `revalidate({ root, source, validation, command, signal })` interprets
the receipt and its linked evidence before reuse. The core checks its bytes and
the exact clean source, but a weak trusted hook can defeat its own policy. It does
not interpret business tests, visual acceptance, privacy declarations or real GPS.

Artifacts must contain a matching mini-program `project.config.json`. All regular
files participate in the digest. Symlinks, traversal, more than 10,000 entries,
files over 32 MiB and total content over 100 MiB are rejected. These are local
inspection budgets, not WeChat package-size certification. Source and package
fingerprints do not attest every byte read by DevTools between observations.

## Version and intent

Prepare requires an explicit observation with only
`{ appId, version, source: "owner" | "provider", observedAt }`. The baseline must
be from the preceding 24 hours; a historical local log is not an accepted source.
The proposed plain `x.y.z` version must be newer. Other version-label policies are
not supported by this first workflow. The operator must obtain a truthful current
observation; its declared source is not independent provider attestation.

The plan binds source/repository, AppID, current-version observation, proposed
version, artifact/validation digests, trusted policy, driver and description.
Origins use credential-free HTTP(S), Git, SSH or `git@host:path` URLs. Embedded
credentials, queries/fragments and unsupported local/opaque origins are rejected
before their values can enter a saved plan or CLI projection.
`upload` requires its exact SHA256 approval digest. The CLI cannot grant owner or
platform authorization: pass that approval only after the actual task authorizes
the concrete developer upload. Preparing and observing do not authorize it.

## Recovery and current summaries

Existing private atomic-journal, locking and cleanup-fence helpers are reused in
a separate `wechat/` namespace. A state store must be explicit, absolute and
outside the candidate checkout. Keep the same store for the same consumer/AppID.
Containment resolves existing ancestors while preserving nonexistent suffixes;
macOS `/tmp` and `/var` aliases cannot hide an in-checkout store. Other symlink
ancestors remain rejected before state writes.
The store and repository must also be disjoint in the ancestor direction, so a
store's managed `wechat/` or `locks/` namespace can never become the checkout.
Runner construction/status perform filesystem reads only. Before business-state
writes, protected initialization verifies Git's actual top-level checkout; a
subdirectory cannot hide sibling journals inside the real checkout.

Initialization admission is separate from release history. A standard checkout
uses `.git/release-kit-wechat/`; a registered worktree uses that worktree's Git
administrative directory. These unversioned Git-metadata paths hold only
initialization locks/cleanup fences, never plans, receipts or command output.
Filesystem-only discovery locates them before the first child process. An
initial-probe cleanup failure retains exclusion there even when its fence cannot
be written. Business commands retain this admission plus the private store's
target lock/shared fence. Root validation still precedes all business journals.
The Git administration directory must be writable; separate-git-dir/submodule
layouts are not supported by this first adapter. Do not move/prune Git metadata
or clear either admission barrier until owned-process recovery is established.
The AppID lock and immutable version ownership apply within that selected store;
this is not machine-wide coordination across arbitrarily different stores.
Existing designated-machine coordination remains necessary for shared targets.

Before the external call, an `upload-unknown` event is committed. Top-level
`ok` or `success` is never completion. A confirmation response stores the original
task as `pending-confirmation`; explicit `resume` performs **one query**, without
background polling. Pending, unknown, cancelled, expired and failed operations
are never automatically submitted again. Unknown results without a saved task
require operator/provider reconciliation outside this first adapter. A new plan
cannot bypass another active operation, and a different plan cannot reuse a
claimed version. This first workflow offers no automatic retry/version reset.
Prepare also rejects an active pending/unknown operation before invoking build
hooks. Keep that operation's source and package frozen until it is reconciled;
this guard coordinates the selected store and does not control unrelated builds.

Admission also checks successful operation histories in the same store (including
uploaded-unverified). A prepared older version cannot follow a newer upload, even
if a later cancelled/failed operation replaced the active pointer. History scans
are bounded to 10,000 operation entries. Cleanup uncertainty preserves the target
lock as well as the shared fence, including failure to create the initial fence.

The selected trusted adapter must still match the saved policy and driver before
resuming. Policy/installation changes require deliberate compatibility review;
do not retarget a historical journal to different code or a new private store.

An official success whose prepared source/package evidence can no longer be
revalidated is `uploaded-unverified`: the upload happened, while artifact identity
is unaccepted. The distinction survives in the derived summary. A contradictory
current observation/state or an unknown prose field is rejected. Original events
remain append-only; summaries are projections, not another mutable status ledger.
Post-success hooks must propagate `cleanupIncomplete` on unsettled children.
Their error preserves the confirmed result as uploaded-unverified while blocking
admission with both fence and retained lock, even if initial fence creation fails.
Successful provider observations are first journaled as uploaded-unverified,
before invoking post-validation, so a stalled/crashed hook cannot erase success.
After process recovery, explicit resume of that state reruns verification only;
it makes no upload or provider query. Ordinary upload calls never replay it.

## Verification plan

Use synthetic projects and official-response fixtures. Prove version/source and
receipt rejection before mutation, wrong-client/tool/task rejection, pending
versus completion, exact approval, unknown-write recovery across runner instances,
same-store concurrency, immutable version ownership, cancelled-task non-replay,
changed-package success classification and shared cleanup fencing. Run all native
regressions and packed pnpm/npm consumer checks to preserve compatibility.

Real WeChat and production publication are deliberately absent from these tests.
Consumer installed-source adoption, current provider observation and any future
authorized upload retain their own operational evidence and approval.
