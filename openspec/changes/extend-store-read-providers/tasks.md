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

Scoped real acceptance covers one Google Play production track and one CN Harmony
app with exact formal/test reads and pure assessment replay. It does not cover
other tracks, complete history, reviewer login or device installation. Harmony test
identity discovery used a separate official read-only list API; inventory remains
unsupported by the implemented CLI. Private operational records remain outside
this repository.

Keep this change active through standalone query-client adoption and documentation
closeout. Source merge and installed consumer adoption require their own recorded
gates; synthetic tests do not grant account access or establish deployment/publication
readiness. Managed release-controller adoption remains separate.

Current-head hosted CI, independent code/test-quality review and owner merge
authorization remain source-delivery gates. The PR is canonical for these mutable
delivery outcomes; this checklist does not duplicate its head-bound state.
