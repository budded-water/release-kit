# Store queries and metadata preflight

## Configuration and private data

The three new read commands support App Store Connect / IOS / App Store only.
Unsupported providers/platform flags fail explicitly; Google/Harmony parity and
TestFlight queries are not advertised. No project adapter is required.

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
