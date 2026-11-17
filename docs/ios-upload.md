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

## Continuing a confirmed draft after source advances

A new current descendant may retain the same prepared iOS draft only before the
previous task has any binary/provider intent. Both artifacts must exist, the new
build must be strictly higher at the same version/app/configuration, and the old
preparation must be `prepared` with matching readback and all steps confirmed.
The new source's separately reviewed content proposal must bind the same input
digest and exact draft ID. Changed content/drafts, partial or unknown preparation,
upload/review intents and conflicting target ownership remain blocked.

This uses the existing target and predecessor locks and append-only supersession
records. It copies no successful build, UI or acceptance stages. New content apply
still checks the provider snapshot before and after taking ownership and reads
back its own result. The old task cannot later upload or publish. A source advance
still requires the consumer's current-source build and verification policy; this
handoff is not permission to reuse obsolete binary bytes.

The proposed normative contract is in the active
[upload change](../openspec/changes/add-ios-upload-only/specs/store-publication/spec.md).
Synthetic tests establish routing/recovery and provider-call boundaries only.
Consumer adoption, installed-control maintenance and authorized actual upload
require separate evidence; do not claim them from package tests.
