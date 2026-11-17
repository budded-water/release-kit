# Add bounded iOS artifact upload

## Why
The existing publication command can upload, submit review and enable automatic
release in one invocation. An operator authorizing only upload needs a supported
boundary that remains bounded after processing completes or execution resumes.

## What Changes
- Add local `upload <release-id>` for an existing, built and accepted iOS release.
- Persist upload intent separately from full publication intent and reuse the
  existing source, artifact, acceptance, target ownership and upload journal gates.
- Expose an explicit platform `upload` hook and shared `uploadStore` API; never
  substitute a `publish` hook when upload support is missing.
- Stop at uploaded/processing, including when Apple immediately reports VALID.
  Ordinary resume retains this bound; explicit `resume --publish` grants the
  existing full publication intent separately.
- Permit a newer accepted descendant to retain the same confirmed prepared draft
  before any binary intent, with matching configuration/content and exact draft ID.

## Non-goals
No Android upload-only support, new builds, upload dispatch, account setup,
credential changes, store build selection, review submission or public release.
Legacy full-publication intent is not silently narrowed. Live acceptance and
installed-controller adoption remain separate from implementation.
