# Design

## Entry points and ownership
Keep Apple's listStoreVersions/getStoreVersion/inspectAppStore behavior unchanged.
Add listPlayReleases/getPlayRelease and getHarmonyRelease APIs, plus
inspectProviderStore/assessProviderPreflight. The CLI reuses store-versions,
store-status and store-preflight with an explicit --provider. Omitted provider
retains Apple. No automatic provider inference from credentials or fallback.

Google requires packageName and an explicit track; status/preflight additionally
require a decimal versionCode. Reuse JSON-key or explicitly configured existing
gcloud impersonation. Tokens remain in memory; the only POSTs are the exact OAuth
or configured IAM authentication endpoints. The sole provider resource operation
is GET of that package/track's release summary. No edits, listings or upload calls.

Harmony requires appId, bundleId, authorized Service Account reference, explicit
releaseType 1 or 6 and versionId. Reuse package lookup, PS256 signing and sanitized
app-info projection. Existing provider-inspect continues formal/default behavior.
store-versions for Harmony is explicitly unsupported before authentication; the
existing selected formal observation is not a complete inventory.

## Reports and interpretation
Reports carry schema version, operation, target, source, start/completion times,
coverage, sanitized errors and observationComplete. Releases retain raw lifecycle
values alongside review/publication interpretations. Unknown enums remain unknown;
missing or malformed required identity/state fields make observation incomplete.

Play lists at most 20 nonobsolete releases in one track. An absent versionCode is
not-observed, not proof of global absence; multiple matches are ambiguous. Release
names do not identify builds and are omitted. Published means published on the
selected track; it does not establish full rollout, country/device coverage or
installation. Published Play state alone retains unknown review approval because
internal testing can be available without standard review. Harmony binds versionId and interprets formal/test states separately;
test availability never implies formal publication. A failed or mismatched exact
read cannot fall back to another version or become a not-found assertion.

## Preflight and trust boundaries
Preflight reuses one query and only sanitized facts. Play listing/review access,
declarations and managed publishing are unsupported without creating an edit or
additional approved capabilities. Harmony may report syntax/presence/count facts
from the already-read app-info; contacts, review credentials, private URLs and
identity documents never leave the collector. Presence does not prove approval or
actual reviewer access. Unobserved/unsupported checks remain explicit; no preflight
can authorize publication or claim complete store readiness.

Each operation owns a bounded overall deadline and propagates parent cancellation
through authentication, command execution and reads. Late responses cannot produce
a completed report. Play response bodies are bounded; redirects, extra origins,
unexpected methods/routes and retries are refused. Existing AGC bounded GETs are
reused. No query writes a journal, task directory, credential or diagnostics file.
An explicitly selected existing gcloud installation may maintain its own auth
cache; the read-only claim concerns store resources and runner-managed output,
not a filesystem sandbox around the trusted Google SDK.

AGC's combined per-request signal is checked after response headers, during body
consumption and before accepting parsed data. Expiry of that request alone must
make the read unavailable even while the operation-wide deadline remains open;
a timed-out package lookup must not advance to app-info. This also corrects the
shared legacy inspector's late-response handling without changing its endpoints.

## Verification and rollout
Test generated synthetic credentials through the actual HTTP/CLI boundary, including
two unrelated app identities, keyless command confinement, secret-bearing error
bodies, wrong package/track/version, duplicate matches, bounded missing records,
formal/test mappings and incomplete metadata. Verify pure replay performs no I/O.
Run full repository checks, packed npm/pnpm consumers, hosted CI and independent
current-head review. Keep real acceptance distinct from synthetic success. This
change does not adopt a new runtime in any installed controller or alter lifecycle
resource registration; read-only commands require neither mechanism.

Official contracts:
- https://developers.google.com/android-publisher/api-ref/rest/v3/applications.tracks.releases/list
- https://developers.google.com/android-publisher/api-ref/rest/v3/applications.tracks.releases
- https://support.google.com/googleplay/android-developer/answer/9845334?hl=en
- https://developer.huawei.com/consumer/cn/doc/app/agc-help-publish-api-appinfo-query-0000002236041422/
- https://developer.huawei.com/consumer/cn/doc/App/agc-help-publish-api-data-appinfo-0000002236041454/
