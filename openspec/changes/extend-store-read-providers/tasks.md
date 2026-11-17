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
- [ ] Complete separately authorized real read acceptance with private evidence.

Keep this change active until live acceptance completes. Source merge and installed
consumer adoption require their own recorded gates; synthetic tests do not grant
account access or establish deployment/publication readiness.

Current-head hosted CI, independent code/test-quality review and owner merge
authorization remain source-delivery gates. The PR is canonical for these mutable
delivery outcomes; this checklist does not duplicate its head-bound state.
