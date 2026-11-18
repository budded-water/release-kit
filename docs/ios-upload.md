# Bounded iOS upload

```sh
release-kit --project ./release.project.mjs upload <release-id> \
  --config /absolute/private/release.json --state-dir /absolute/private/state
release-kit --project ./release.project.mjs resume <release-id> \
  --config /absolute/private/release.json --state-dir /absolute/private/state
```

`upload` requires an existing single-platform iOS release with a successful build,
inspected artifact and passing native acceptance. It does not build, import a
binary or provide unconditional acceptance. The trusted iOS adapter must expose
`upload(ctx)`, usually delegating to `uploadStore` from the `/stores` module. A
publish-only adapter is refused rather than called with an ignorable flag.
Embedding callers use `runner.execute(plan, { uploadOnly: true })` on that same
existing release. The command does not accept `--publish`, acceptance replacement,
build retry or auto/GitHub execution. Use the normal build/acceptance workflow
first; use local resume for an admitted upload task.

The source/UI gates are revalidated, the exact artifact is inspected again, and
current default-source, provider preflight, target ownership and cleanup fences
remain enforced. The shared uploader records the existing `ios-upload` intent
before `pilot upload --skip_submission true`. It stops before build selection,
release-policy changes and review, even when Apple immediately reports VALID.
It does not consume review-submission declarations. Existing required listing
checks remain; an upload receipt is not listing visual/compliance approval.

## Durable intent and recovery

The existing schema-v1 journal gains optional `uploadRequested: true` and an
`upload-ios` execution stage. `publicationRequested` stays false. Plan/release IDs,
the exact artifact, acceptance and `ios-upload` checkpoints are unchanged. Plain
`resume` retains the upload bound. An unknown/lost upload response is reconciled
against the exact provider build; missing visibility never permits a second
upload. Keep all events and diagnostics. The content observer and native/store
read-only status commands retain their distinct meanings.

For this bounded intent, `uploaded` or `processing` returns exit zero; `unknown`,
blocked/missing evidence and merely `accepted` do not. Generic full publication
still does not count `uploaded` as completed execution. Neither result proves
review, release or availability. Full status and summaries expose both intents.

`resume --publish` is an explicit escalation to the existing complete publication
workflow, including its review and release policy. Obtain authorization for that
scope before using it. `upload` refuses a journal with existing full publication
intent, publish-stage work or a review checkpoint; it cannot revoke broad intent.
Once upload execution starts, content changes and build retry remain fenced.

The command and bounded resume are local-only. Request schemas are not extended;
new CLIs refuse dispatch before request creation. Old CLIs reject `upload`; old
cores ignore the additive intent on plain resume and, with publication false,
do not enter their publisher, but may report a build-only outcome. They cannot
resume this contract correctly: keep a reviewed upload-aware core and explicit
adapter together. Read-only historical access is not execution compatibility.
Project hooks are trusted executable policy, not sandboxed code.

## Attach the confirmed build to a manual draft

Get the draft ID from `store-status --version <version>` using the private Apple
query config. Then use the original release config and state store for the write:

```sh
release-kit --project ./release.project.mjs attach <release-id> \
  --config /absolute/private/release.json --state-dir /absolute/private/state \
  --version-id <apple-draft-id>
```

`attach` uses an existing single-platform iOS upload-only journal. The task must
still own the App Store target and have a matching built artifact, passing native
acceptance and `ios-upload` checkpoint with the exact Apple build ID. If upload
processing was still pending, use the bounded upload resume to observe the build
before attaching it. The operator-supplied draft ID must match the visible version
and any recorded prepared draft. The build must be `VALID` and unexpired. This
operation supports manual drafts in `PREPARE_FOR_SUBMISSION` and refuses to
replace a different selected build.

The first write requires the existing production source gate and, when configured,
prepared Apple content verification. Before a write, version inventory, the
draft snapshot and the relationship read must agree. The runner rechecks the build and current source before saving
`ios-attach` intent and making one Apple build relationship PATCH.
Exit `0` means a separate read confirmed the exact attachment, including when the
same build was already selected. Exit `2` means the operation was refused or the
attachment cannot be confirmed. Cancellation through the CLI returns `130` and
keeps any saved intent. `writeAttempted` describes whether that invocation sent a
write attempt, while the provider read establishes the selected build. Use
`store-status` or `store-preflight` for a fresh read after attachment.

Rerun `attach` with the same release and draft to reconcile an unknown result.
A missing relationship cannot authorize another PATCH after intent. The journal
preserves the upload receipt and original approval scope. Plain resume continues
its prior upload-only behavior. Explicit full publication requires a confirmed attachment if this operation was
attempted. The built-in iOS publisher verifies the draft state and the
recorded build through independent draft and relationship reads. A confirmed attachment can
use the existing unsubmitted-upload handoff when fresh provider evidence still
matches the recorded build and independently confirms the recorded draft
relationship or that the draft was deleted. An unresolved attachment blocks ownership transfer, including
when an observation reports a terminal outcome. A confirmed attachment also
requires a fresh matching terminal observation before a terminal-state transfer. `attach` itself changes only the build linkage. It does not
schedule work, run Fastlane, upload, change release settings or submit for review.

The runner method is `runner.attachBuild(plan, { versionId })`. It uses the same
release and target locks and existing state admission. It does not initiate
resource lifecycle execution or reclamation. An activated state root still needs
the live admission required by that root. A managed consumer must integrate the
command with its existing admission rules before adoption.

`ios-attach` is an additive checkpoint in the existing schema 1 journal. Upload
journals without that checkpoint can attach when their exact confirmed upload
is recorded. Older cores can read the history, but do not enforce the attachment
fence, so use an attach-aware core for further publication from these journals.
The `release-kit` store query subcommands remain read-only. Separate
state stores or external clients can still race between the final Apple read and
write. The relationship API exposes no conditional update for that interval.

[Apple build relationship API](https://developer.apple.com/documentation/appstoreconnectapi/patch-v1-appstoreversions-_id_-relationships-build)

## Continuing a confirmed draft after source advances

A new current descendant may retain the same prepared iOS draft only before the
previous task has any binary/provider intent. Both artifacts must exist, the new
build must be strictly higher at the same version/app/configuration, and the old
preparation must be `prepared` with matching readback and all steps confirmed.
The new source's separately reviewed content proposal must bind the same input
digest and exact draft ID. Changed content/drafts, partial or unknown preparation,
upload/review intents and conflicting target ownership remain blocked. Before
revoking the predecessor, a fresh read under both locks must confirm the exact
provider draft ID and content, then revalidate the successor against the current
default source before any predecessor revocation. The transfer records that
observation time. A
provider replacement with identical content still blocks the handoff.

This uses the existing target and predecessor locks and append-only supersession
records. It copies no successful build, UI or acceptance stages. New content apply
still checks the provider snapshot before and after taking ownership and reads
back its own result. The old task cannot later upload or publish. A source advance
still requires the consumer's current-source build and verification policy; this
handoff is not permission to reuse obsolete binary bytes. Upload/publication also
rechecks the prepared draft identity and content at its provider boundary. A
legacy preparation without a recorded draft identity must be observed and
reconciled before execution.

The normative contract is in the
[store publication spec](../openspec/specs/store-publication/spec.md).
Synthetic tests establish routing/recovery and provider-call boundaries only.
Consumer adoption, installed-control maintenance and authorized actual upload
require separate evidence; do not claim them from package tests.

## Acceptance scope

Bounded live acceptance has separately exercised a reviewed consumer adoption,
managed controller upgrade, current-source build/native evidence, confirmed
unused-draft handoff and an actual upload reaching Apple PROCESSING. Independent
official reads confirmed the same manual draft, no selected build and no review
submission; the journal kept full publication false and recorded no review or
release checkpoint. Operational evidence and account identifiers remain private.

This acceptance does not establish review, public availability, a TestFlight/App
Store installation, exhaustive device/business coverage or live provider-failure
recovery. Immediate VALID and uncertain-response/restart cases remain synthetic
test evidence. Query current provider state for later decisions; a saved success
or missing visibility never authorizes another upload.
