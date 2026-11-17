# Extend standalone store reads to Google Play and Harmony

## Why
Standalone version/status/preflight commands currently understand only Apple.
Existing Play and Harmony provider inspection can be reused, but depends on a
different entry point and does not expose precise cross-project release queries.
Agents need official read-only operations without a build, project module or
release journal, while retaining each provider's identity and coverage limits.

## What Changes
- Add explicit Google Play and AppGallery Connect provider selection to the
  standalone CLI, preserving the default Apple commands and APIs.
- Query one explicit Play track and resolve an exact versionCode within its
  bounded nonobsolete release summaries. Never create an edit to inspect status.
- Query one exact Harmony versionId for formal or test release; interpret state
  using releaseType. Do not advertise a complete Harmony inventory API.
- Expose provider-specific query APIs and a pure, scoped preflight assessment.
  Unsupported facts remain unknown and publicReleaseReady remains false.
- Reuse existing authorized authentication and sanitized AGC projection; enforce
  bounded reads, shared cancellation/deadlines and no mutation/journal boundary.

## Non-goals
No lifecycle/reclamation changes, build or installed-controller upgrade, new
credentials/permissions, upload, edit creation, review, publication, scheduling,
MCP server or complete historical inventory. Existing publisher/observer semantics
and consumer distribution holds remain unchanged.

## Acceptance
Synthetic HTTP/auth/CLI tests must cover exact identity, provider state mappings,
ambiguous/absent/incomplete observations, malformed and unknown states, redaction,
request boundaries, cancellation, deadlines and Apple compatibility. Real account
acceptance needs separately supplied authorized private inputs; until performed,
the change remains active and live acceptance must be reported as pending.
