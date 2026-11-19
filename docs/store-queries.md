# Store queries and metadata preflight

## Configuration and private data

The three read commands default to App Store Connect / IOS / App Store for
compatibility. Explicit provider selection adds the scoped Google Play/Harmony
reads described below. Provider selectors are validated independently; unsupported
combinations fail explicitly. TestFlight queries are not advertised. No project
adapter is required.

A private regular JSON file supplies existing authorized app/key references:

```json
{
  "schemaVersion": 1,
  "stores": {
    "ios": {
      "appId": "123456789",
      "bundleId": "com.example.app",
      "apiKeyPathEnv": "EXAMPLE_ASC_KEY_PATH"
    }
  }
}
```

The named environment variable resolves to an absolute private team API key JSON
file containing `key_id`, `issuer_id` and `key`, optionally `is_key_content_base64`.
Prefer user configuration outside the repository, with separate per-project config
and state, directory mode 700 and credential mode 600. The reader does not provision
permissions or migrate credentials. Keep only synthetic examples in source control.
Do not relocate existing journal directories merely to adopt a naming convention.

## Interfaces

```js
import { listStoreVersions, getStoreVersion } from '@budded-water/release-kit/store-query';
import { inspectAppStore, assessStorePreflight } from '@budded-water/release-kit/store-preflight';

const options = {
  appId: '123456789', bundleId: 'com.example.app', apiKeyPathEnv: 'EXAMPLE_ASC_KEY_PATH',
  candidateVersion: '1.0.0', expectedAppleBuildId: 'expected-build-id'
};
const status = await getStoreVersion(options);
const report = await inspectAppStore(options);
const checks = assessStorePreflight(report.facts, options);
```

`listStoreVersions` does not need candidate/build expectations. `getStoreVersion`
and `inspectAppStore` require an exact candidate. Optional `environment` and `signal`
select the existing credential environment/cancellation. Public operations own the
same deadline for all entry points: API `timeoutMs` defaults to 120000 and accepts
1–3600000, preserving existing consumer timeout contracts. CLI `--timeout-seconds`
accepts 1–300 (default 120). Callers never receive the authenticated session.

CLI operations are `store-versions`, `store-status`, `store-preflight`, all requiring
`--config`. Status/preflight require `--version` and optionally `--build-id`.
They print one JSON report, perform no local journal writes and accept no release ID,
publication/build flags or state directory. Exit 0 means observation completed,
including a successful not-found result, rejected review or missing metadata.
Unavailable required reads return 2. Invalid inputs, identity mismatch and
cancellation fail. Agent/CI consumers must inspect the structured business result.

## Result semantics

Reports declare schema version, operation, exact app/platform/destination target,
source, start/end timestamps, bounded sanitized errors and observation completion.
Inventory coverage is complete only after traversal finishes; pagination failures
cannot establish version absence. Status resolves found/not-found/ambiguous/unavailable.
It retains a bounded raw Apple state, interpreted review/publication states and
release type. Missing lifecycle state is explicitly diagnosed; future enums remain
visible with unknown interpretation. Selected build reads may be unavailable even
when lifecycle facts were observed. Expected build matching is separate evidence.
Neither an approved version nor a matching build establishes source ownership,
a particular review attempt, territory/device availability or a complete rollout.

Preflight collects only sanitized presence/syntax/count facts and records rules version,
checks, counts, scope and blocked/incomplete/clear-within-scope conclusion. Confirmed
missing facts take precedence over unknowns in the conclusion; both remain in checks.
The pure assessor requires sanitized read diagnostics inside facts, repeats the same
checks for successful and failed reads without networking, and does not authenticate
saved facts. Missing diagnostic inventories are rejected rather than treated as complete. `publicReleaseReady` remains false. Metadata checks do not establish review
admission, truthful privacy/rights declarations, App Privacy publication, screenshot
coverage, agreements, reviewer access or production device/service acceptance.

Requests enforce ASC-origin GET-only transport, refuse redirects, bound pagination
and share a 200-request budget across one operation. Cancellation is propagated to
all reads and checked before reporting; providers must honor the supplied signal.
Reports span multiple requests and are not transactional snapshots. No retry,
global cache, automatic browser fallback, scheduling or store writes are added.

## Consumer and legacy boundaries

Consumers supply private configuration and project rules, and may save reports in
their own existing journal. They own native build/signing and real product acceptance.
The generic reader owns app verification, network constraints and sanitized facts.
Legacy artifact-owned `statusStore`, journal `status --remote`, passive `observe`,
content preparation and publication are separate contracts and are not rewritten
by this change. A read result never authorizes recovery/retry or adopts a remote build.

The canonical [query](../openspec/specs/store-query/spec.md) and
[preflight](../openspec/specs/store-preflight/spec.md) specs own the implemented
requirements. Synthetic tests and npm/pnpm packed consumers establish code/installation
behavior, not real account authorization. Authorized private acceptance has separately
verified inventory, exact found/not-found status, sanitized preflight and pure replay
in two real projects with independent app/key configurations. The private records
retain incomplete assessments when expected build identity is unknown; successful
reads do not certify full release readiness. Installed managed-controller rollout
remains a separate deferred operation; a standalone query-client install does not
perform that upgrade.

## Independent execution and publication conflicts

Another machine may provision the same reviewed CLI and project adapter for new
release work with its own private configuration, credentials and execution state.
Historical journal migration is needed only for explicitly continuing or recovering
an old task; it is not a prerequisite for querying a store or building a new package.
An independent fresh executor must still inspect the current provider version,
build selection and publication/review state before its existing write boundary.

For iOS publication, ambiguous exact versions and editable drafts selecting a
different Apple build stop execution before Fastlane. A recorded upload build ID
must match subsequent observations; matching version/build numbers alone cannot
replace that binding. A draft with no selected build remains eligible for the
owned candidate. The existing explicitly handled correction of an older rejected
build remains available; this does not authorize replacing another editable draft.
Already-existing remote binaries without the task's upload journal are not adopted
as the current artifact. Standalone `store-status` remains available for their
version/build observations without claiming local artifact ownership.

Existing upload/review/commit uncertainty remains reconciliation-only. Provider
conflicts or invalidated Play edits do not authorize blind retries, replacement
edits or overriding another selection. The Play path retains its hash-bound bundle
checks and the specific provider-confirmed, uncommitted review-conflict retry rule.
These are optimistic observations and explicit failure handling, not atomic
cross-machine exclusion or automatic task takeover. Existing machine-local locks
still protect local invocation; saved journals retain operation identity.

## Google Play and Harmony reads

```sh
release-kit store-versions --provider google-play --config /absolute/private/store.json --track production
release-kit store-status --provider google-play --config /absolute/private/store.json --track production --version-code 42
release-kit store-preflight --provider google-play --config /absolute/private/store.json --track internal --version-code 42
release-kit store-versions --provider appgallery-connect --config /absolute/private/store.json
release-kit store-status --provider appgallery-connect --config /absolute/private/store.json --release-type 1 --version-id 123456789
release-kit store-preflight --provider appgallery-connect --config /absolute/private/store.json --release-type 6 --version-id 123456789
```

`--provider` defaults to `app-store-connect`; it is never inferred from credentials.
Apple retains `--version` and optional `--build-id`. Play requires an explicit track;
status/preflight also require a decimal `--version-code` in Android's supported
range. Named tracks use bounded letters/digits, dots, hyphens, underscores or
colons (including form-factor prefixes). Harmony status/preflight require an exact
numeric `--version-id` and `--release-type 1` (formal) or `6` (test). A configured
Harmony versionId must agree with the detail selector. Harmony `store-versions`
accepts no version selectors and queries the app independently of the optional
config `versionId` and `language`, which apply to detail reads. Cross-provider
selectors, release IDs and state/publish/dispatch options are refused.
There is no fallback to another track or version.

Private Play configuration reuses `stores.android.packageName` and either
`serviceAccountPathEnv` or the existing explicit `auth.type=gcloud-impersonation`
mode from the README. Harmony reuses `stores.harmony.appId`, `bundleId`,
`serviceAccountPathEnv` and optional language/versionId. Neither requires Expo
configuration or a managed-publishing assertion. Reads do not change publisher
policy gates, install tools, create credentials, grant permissions or log in.
The selected existing Google SDK is trusted and may maintain its own auth cache;
the runner creates no release/task/diagnostic files and does not provision keys.

The Node APIs retain provider-specific identities:

```js
import { listPlayReleases, getPlayRelease, listHarmonyReleases, getHarmonyRelease }
  from '@budded-water/release-kit/provider-store-query';
import { inspectProviderStore, assessProviderPreflight }
  from '@budded-water/release-kit/provider-store-preflight';

const report = await getPlayRelease({ store: privateConfig.stores.android,
  track: 'production', versionCode: '42', environment: process.env });
const versions = await listHarmonyReleases({ store: privateConfig.stores.harmony });
const harmony = await getHarmonyRelease({ store: privateConfig.stores.harmony,
  releaseType: 6, versionId: '123456789', environment: process.env });
const preflight = await inspectProviderStore({ provider: 'google-play',
  store: privateConfig.stores.android, track: 'production', versionCode: '42' });
const replay = assessProviderPreflight(preflight.facts);
```

APIs share the existing 1–3600000 ms overall deadline contract (default 120000);
CLI accepts 1–300 seconds. Parent cancellation reaches auth, the optional Google
command and provider reads. Late responses cannot produce a completed report.
Play bodies are bounded to 4 MiB, with at most four requests for one operation;
only exact OAuth/configured-IAM authentication POSTs and the selected package/track
GET are allowed, with no edit creation, redirects or automatic retries. Harmony
uses PS256 Service Account signing and a package lookup GET to bind the app. The
second request is the existing app-info GET for detail or the official read-only
version-list POST for inventory. The list sends the verified `appId` header and
`packageName` body to the exact CN endpoint. Both operations permit at most two
requests with a 60-second deadline and 4 MiB body limit per request, no redirects
and no retries. The combined per-request signal is checked after headers and
during/after body consumption. A request timeout cannot advance a timed-out lookup
or produce a successful observation before the overall deadline expires.

Reports retain exact targets, observation times, coverage, sanitized errors and
`observationComplete`. Play coverage is `selected-track-nonobsolete-max20`; an
unmatched code is `not-observed`, not global absence. Multiple matching releases
are `ambiguous`; inaccessible or malformed responses are `unavailable`. Release
names are omitted. Harmony detail coverage is `exact-selected-version`. A mismatched app or
version identity is unavailable, never another-version selection. Missing state
is incomplete; future states retain raw values and unknown interpretation.

Google review approval and publication are separate. Only an explicit
APPROVED_NOT_PUBLISHED state establishes review approval in this summary adapter;
PUBLISHED retains unknown review approval because internal tests may not undergo
standard policy/security reviews. Published on a track can include partial/halted
rollout and never proves full device/country availability.
Harmony test availability is `testing`, not formal `published`; formal/test raw
state interpretation differs. Raw review codes are retained without inventing
approval from optional reviewState. Neither report establishes source/binary
ownership, a particular review attempt, tester installation or permission to write.

Play preflight reports listing, reviewer access, declarations and managed
publishing as `unsupported`, without opening an edit. Harmony preflight projects
only policy-URL syntax, reviewer-credential presence and localized name/description
presence from the same app-info response; values, contacts, document URLs and audit
opinions remain private. Screenshot coverage, policy truth and actual reviewer
login remain unsupported. Missing optional reviewer credentials stay unknown;
whether the product needs them is a project-specific requirement. Pure replay validates the fact envelope and performs no
I/O or authentication. Reports include checks/counts and remain `incomplete` for
unsupported guarantees, or `blocked` for observed missing metadata;
`publicReleaseReady` is always false. CLI exit 0 means observation completed, even
for rejection, bounded not-observed or incomplete preflight; unavailable reads
return 2. Invalid selectors and cancellation fail without success JSON.

Official sources: [Play summaries](https://developers.google.com/android-publisher/api-ref/rest/v3/applications.tracks.releases/list),
[Play lifecycle](https://developers.google.com/android-publisher/api-ref/rest/v3/applications.tracks.releases),
[internal-test review limits](https://support.google.com/googleplay/android-developer/answer/9845334?hl=en),
[Harmony version queries](https://developer.huawei.com/consumer/cn/doc/app/agc-help-publish-api-appinfo-query-0000002236041422/),
[Harmony state meanings](https://developer.huawei.com/consumer/cn/doc/App/agc-help-publish-api-data-appinfo-0000002236041454/).

Synthetic auth/HTTP/CLI and packed-consumer checks establish implementation behavior,
not live account access. Separate authorized operational acceptance has verified one
Google Play production track through inventory, exact status and preflight using
existing gcloud impersonation, plus exact CN Harmony formal and available test
versions through status and preflight. Pure assessment replay matched without extra
requests. This is one app/account per provider, not other tracks, complete history,
reviewer login, device installation or publication readiness. Private identities
and evidence remain outside the repository. Separate standalone query-client
adoption has verified an immutable reviewed package pin, all installed package
bytes, the existing three-command read-only launcher and its write-command guard.
Installed-launcher observations passed for the same Play production and CN Harmony
formal/test targets, plus the existing Apple inventories in two projects. The prior
client is retained for rollback. This adoption does not upgrade App release
controllers, activate lifecycle policy or perform store writes.

Harmony inventory coverage is `cn-harmony-returned-formal-test-versions`. It
preserves provider order and exposes each supported `releaseType`/`versionId` pair
as exact detail selectors. IDs remain strings. Entries include raw and interpreted
lifecycle and, when supplied, package version names/codes. An omitted release
type uses Huawei’s formal default (`1`). An omitted state remains unknown. Other release types are
counted under `excludedReleaseCount`. The query accepts at most 1,000 returned
records and 1,000 package summaries per supported record. Empty inventory is a
successful scoped observation. Malformed, duplicate or over-limit supported
records make the inventory unavailable (CLI exit 2) without partial rows. Use
`observationComplete` and `errors` to distinguish that result from a valid empty
list. This coverage does not imply full history, device availability or the most
recent release. Scoped live acceptance verified the list and exact follow-up
for returned formal and test IDs on one authorized CN app. [Harmony version-list contract](https://developer.huawei.com/consumer/cn/doc/app/agc-help-publish-api-query-brief-info-list-0000002236201254/).

Harmony preflight requires the documented localization array to be present and
well formed. An omitted/non-array collection is an incomplete read with sanitized
diagnostics and CLI exit 2; an explicit empty array is a complete observation of
missing listing data. Status-only queries do not require listing metadata.

Store-read dispatch remains independent of task-resource lifecycle admission,
leases and reclamation; the shared CLI does not activate those hooks for reads.

## WeChat Mini Program reads

Use the standalone client with a private configuration. Supply a current
third-party `authorizer_access_token` through the named environment variable.
Set the token using an existing authorized credential source. The configuration
stores the environment variable name and AppID. The reader checks the AppID and
mini program account type with the same token before reading version or audit data.
Confirm permission set 18 for [code queries](https://developers.weixin.qq.com/doc/oplatform/openApi/miniprogram-management/code-management/api_getversioninfo.html)
and the applicable permission for [account identity](https://developers.weixin.qq.com/doc/oplatform/openApi/miniprogram-management/basic-info-management/api_getaccountbasicinfo.html)
(30 for mini program account management). Token issuance and refresh belong to
the consumer's authorized third-party platform.

```json
{
  "schemaVersion": 1,
  "stores": {
    "wechat": {
      "appId": "wx1111111111111111",
      "authorizerAccessTokenEnv": "EXAMPLE_WECHAT_AUTHORIZER_TOKEN"
    }
  }
}
```

```sh
release-kit store-versions --provider wechat-mini-program --config /private/wechat-query.json
release-kit store-status --provider wechat-mini-program --config /private/wechat-query.json --latest
release-kit store-status --provider wechat-mini-program --config /private/wechat-query.json --audit-id 1234567
```

```js
import { listWechatVersions, getWechatAudit } from '@budded-water/release-kit/wechat-store-query';

const options = { store: { appId: 'wx1111111111111111', authorizerAccessTokenEnv: 'EXAMPLE_WECHAT_AUTHORIZER_TOKEN' } };
const versions = await listWechatVersions(options);
const latest = await getWechatAudit({ ...options, latest: true });
const exact = await getWechatAudit({ ...options, auditId: '1234567' });
```

`store-versions` reports `current-experience-production` coverage and at most
two `versions` rows. Each row identifies the channel, version label, provider
timestamp in epoch seconds and observed channel state. Missing or malformed
slots yield incomplete coverage with errors and any verified rows still present.
The coverage describes only the current experience and production slots.

Status reads return `audit` for one explicit selector. Latest may include the
reported version and submission time. Exact status binds to the requested
decimal audit ID and reports fields supported by that endpoint. Interpret
`rawState` and `reviewState` separately from `publicationState`, which stays
unknown in audit reads. Future status values retain the raw number. Invalid
IDs, permission failures and malformed responses produce an unavailable
observation. A completed observation can report a rejected audit with exit 0.
CLI exit 2 denotes incomplete evidence. Reports with descriptions or reasons
may contain private review information. Share them within the release team.

The allowlist uses bounded HTTPS requests and disables redirects. Identity,
version and exact-audit reads use POST as specified by WeChat. Latest audit uses
GET. The only WeChat endpoints are `getaccountbasicinfo`, `getversioninfo`,
[`get_latest_auditstatus`](https://developers.weixin.qq.com/doc/oplatform/openApi/miniprogram-management/code-management/api_getlatestauditstatus.html)
and [`get_auditstatus`](https://developers.weixin.qq.com/doc/oplatform/openApi/miniprogram-management/code-management/api_getauditstatus.html).
The separate [developer-upload journal](wechat-uploads.md) owns upload state and
its current developer-version observation. This scoped query has no complete
upload history, and the current experience/production slots cannot establish the
most recent developer upload. Preflight and release actions have separate contracts.
Synthetic contract verification covers the adapter. Authorized live acceptance
and installed-client adoption remain pending.
