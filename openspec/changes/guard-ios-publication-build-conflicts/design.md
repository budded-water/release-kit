# Design

Keep these checks at the existing shared Apple observation boundary used by
publication and journal-bound status. Reject multiple exact versions. Treat a
different selected build on PREPARE_FOR_SUBMISSION as a conflict, just as existing
in-review/live selections are protected. A draft with an empty selection remains
valid; the existing publication-only replacement of a strictly older rejected
build remains explicit and unchanged.

When the current task already recorded an Apple upload build ID, require the exact
observed build to retain that ID. Do not overwrite it merely because another ID
has the same version/build number. Status converts these failures to unavailable
without changing checkpoints; publication refuses before new provider work.
Standalone version queries do not need upload journals and do not establish local
artifact ownership.

Keep the existing observations before upload and again after listing preflight,
before review. A changed draft at the latter check must stop before review intent
or Fastlane. These checks are non-atomic with provider writes. Provider conflicts
and uncertain responses retain existing fail-closed/reconciliation rules; no
cross-machine mutual exclusion or automatic recovery is claimed.

Use synthetic provider responses to exercise competing drafts, changed selection,
ambiguous versions and remote-ID drift, plus the empty-draft and rejected-build
compatibility cases. Existing upload, review, Play conflict and invalidated-edit
tests retain their ownership/no-duplicate behavior. Real read-only observations
are separate from actual native signing, build or publication acceptance.
