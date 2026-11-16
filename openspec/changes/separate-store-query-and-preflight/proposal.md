# Separate store query and preflight

## Why

A full iOS metadata preflight is too broad for a single review-status question.
Duplicated interpretations, implicit version fallback and journal-bound observations
make reuse and safe automation harder. This change revises the unmerged extraction
candidate, rather than claiming the existing runner is a general store query API.

## What Changes

- Add independent `store-versions` and exact `store-status` reads alongside preflight.
- Share one identity/authentication/read budget per operation; enforce GET-only ASC reads.
- Separate sanitized fact collection from pure submission-metadata assessment.
- Preserve raw bounded lifecycle values and distinct review/publication/build facts.
- Require an exact preflight candidate; remove fallback to a different draft.
- Keep Solura policy and journal persistence in its adapter and existing formats.
- Pin OpenSpec as development tooling; keep the change active until acceptance is complete.

## Impact

The new CLI/API candidate requires `--version` for status and preflight. This is an
intentional revision of an unmerged interface. Solura already supplies a candidate;
its check report gains additive facts/scope metadata, keeps schema-v1 identity and
records unknowns conservatively. No historical journal rewrite is introduced.

## Non-goals

No credential migration, live provider operations, new MCP server, Google/Harmony
parity, runtime dependency upgrades in consumers, background polling, generic plugin
framework or modifications to upload/submission/publication/recovery authorization.
