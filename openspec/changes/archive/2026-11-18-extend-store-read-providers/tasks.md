## Implementation
- [x] Add bounded Play reads reusing JSON/keyless auth and exact track/versionCode.
- [x] Add exact Harmony formal/test reads reusing sanitized AGC projection.
- [x] Add provider-aware standalone CLI and pure scoped preflight.
- [x] Synchronize usage, coverage/unsupported capabilities and package verification.

## Verification
- [x] Cover actual HTTP/auth/CLI boundaries and Apple regression behavior.
- [x] Cover ambiguity, incomplete/unknown state, malformed input and secret redaction.
- [x] Cover cancellation, deadlines, request/response bounds and no-write behavior.
- [x] Run required checks and packed consumers.
- [x] Complete separately authorized real read acceptance with private evidence.
- [x] Adopt the reviewed standalone query client, preserve its read-only guard and rollback copy, and verify installed queries.
- [x] Promote the accepted requirements to canonical specs and archive this change with scoped evidence boundaries.

Scoped real acceptance covers one Google Play production track and one CN Harmony
app with exact formal/test reads and pure assessment replay. It does not cover
other tracks, complete history, reviewer login or device installation. Harmony test
identity discovery used a separate official read-only list API; inventory remains
unsupported by the implemented CLI. Private operational records remain outside
this repository.

Source delivery and standalone query-client adoption completed through separate
recorded gates. Installed-launcher observations cover the same Play production and
CN Harmony formal/test targets plus existing Apple inventories in two projects.
The immutable pin and installed file bytes were verified, the read-only command
guard was preserved, and the prior client remains available for rollback.

This archive promotes the accepted provider-read contracts. It does not establish
complete history, other-track visibility, reviewer login, device acceptance or
publication readiness, and does not adopt an App release controller or activate
resource reclamation.

The source PR is canonical for mutable source-delivery outcomes and authorization;
private operational receipts own actual account access, installation identity and
read observations. This archived checklist records their validated scope without
duplicating private identities or live store states.
