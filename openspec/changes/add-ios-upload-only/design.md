# Design

Use a dedicated local command on the existing release identity. It requires a
single iOS plan, a successful recorded build, its inspected artifact and a passing
native receipt before admitting upload intent. Run the normal source/UI reuse
validation, fresh artifact inspection, acceptance validation, provider preflight,
current-default-source checks and publication-target ownership. There is no new
state store, provider identity, credential layout or artifact import route.

Persist optional schema-v1 `uploadRequested: true` while retaining
`publicationRequested: false`. Record execution in `upload-ios`; reuse the same
`ios-upload` intent/result checkpoints used by full publication. Plain resume
continues through the explicit `adapter.upload` hook. Missing support fails before
provider work; a publish-only adapter cannot accidentally receive bounded work.
Explicit `--publish` retains its existing durable full-release meaning and is the
only escalation. An upload command refuses a journal that already has full intent
or review work, instead of pretending to narrow its authorization.

The shared Apple uploader stops before release-policy changes, build selection and
review, even when the exact uploaded build becomes VALID immediately. An intent or
unknown result is reconciled through exact provider identity before any further
operation; absent visibility never permits another upload. Uploaded is successful
for a bounded upload task only, not generic publication or verified availability.
Status summaries expose both intents. Remote status may refresh upload outcomes;
passive observation remains separate.

Compatibility is additive: existing journal/event/plan identities, full publishing,
build-only behavior and request schemas remain unchanged. Upload is local-only;
the CLI refuses auto/GitHub upload or bounded-resume dispatch. Old CLIs reject the
new command. An old core does not understand persisted upload intent: with full
intent false it does not enter its publisher, but may report an old build-only
outcome. It is unsupported for resuming these tasks; do not claim an old runtime
honors upload progress. Trusted project and platform adapters remain executable
policy; the core cannot sandbox a malicious upload hook.

Keep content preparation and build retry fenced once upload execution starts.
Supersession and target ownership must recognize upload stages alongside publish
stages. Preserve old receipts/events, unknown upload records, cleanup fences and
target claims. Consumer adoption adds only the narrow hook and reviewed dependency
pin; current merged-source build requirements still apply.

An actual consumer upgrade can advance source after a draft was prepared. Allow
the existing locked supersession path to transfer that exact draft only when the
old preparation is fully confirmed, its readback matches, no binary intent exists,
and a new content proposal binds the same digest/draft. Retain both artifacts and
all original preparation evidence. Under the target and predecessor locks, read
the provider again and require the exact draft ID and content before recording
the transfer or revoking the old task. Record the fresh observation time; saved
snapshots alone are insufficient. Upload/publication rechecks draft identity and
content at its provider boundary; missing historical identity fails closed.
Normal current-source, higher-build and provider snapshot checks remain required.
