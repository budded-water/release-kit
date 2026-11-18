# store-query Specification

## Purpose
Provide independent, bounded store observations: App Store Connect version
inventory/status, Google Play selected-track releases and exact versionCode status,
and CN Harmony formal/test version inventory and exact status. Preserve provider identity,
coverage and lifecycle uncertainty without project execution or a release journal.

## Requirements

### Requirement: Standalone bounded store reads
For App Store Connect, the system SHALL provide version inventory and exact version
status without project execution or a release journal, sharing bounded read-only
ASC authentication.

#### Scenario: Lightweight review query
- **WHEN** an operator queries an exact version
- **THEN** only app identity, version inventory and selected-build reads occur
- **AND** no listing, screenshot, journal, build or publication operation occurs

#### Scenario: Independent identities
- **WHEN** separate consumers query different configured apps
- **THEN** each operation validates its own remote bundle identity and isolates its session

### Requirement: Exact resolution and honest coverage
The App Store Connect reader SHALL distinguish found, not-found, ambiguous and
unavailable results.

#### Scenario: Different sole version
- **WHEN** a requested version is absent but a different sole version exists
- **THEN** the result is not-found and no fallback version details are inspected

#### Scenario: Incomplete inventory
- **WHEN** pagination, permission or request-budget validation fails
- **THEN** the result is unavailable and does not assert global absence

#### Scenario: Multiple matches
- **WHEN** more than one remote version matches the candidate
- **THEN** resolution is ambiguous and no build is attributed to the candidate

### Requirement: Distinct lifecycle and build evidence
The App Store Connect reader SHALL retain bounded raw version states and separate
their interpretation from publication, build matching and query completion.

#### Scenario: Unknown or missing state
- **WHEN** the provider returns a new state or omits the state
- **THEN** interpretation is unknown, new raw values are retained, and missing state is diagnosed

#### Scenario: Approved but awaiting release
- **WHEN** the version awaits developer release
- **THEN** approval is separate from publication and expected-build matching

#### Scenario: Cancellation
- **WHEN** the shared operation deadline or caller cancellation occurs
- **THEN** no successful late report is returned and no retry is attempted

### Requirement: Provider-specific standalone release reads
The system SHALL expose standalone Google Play and Harmony release queries without
a project module, build or journal, preserving existing default Apple commands.

#### Scenario: Play inventory and exact release in an explicit track
- **WHEN** a caller queries one package and track for inventory or exact versionCode status
- **THEN** the reader accepts at most 20 nonobsolete release summaries from that track
- **AND** exact lookup distinguishes one match, multiple matches and not-observed
  only within that accepted selected-track coverage

#### Scenario: Over-limit Play response
- **WHEN** the selected track returns more than 20 release summaries
- **THEN** the observation is incomplete with read diagnostics, without silently
  truncating the response into a successful inventory
- **AND** exact lookup resolves unavailable rather than not-observed

#### Scenario: Exact Harmony formal or test version
- **WHEN** a caller selects app identity, releaseType and versionId
- **THEN** package and returned version identity must match and the raw lifecycle
  is interpreted within that release type without another-version fallback

#### Scenario: Harmony test availability is not formal publication
- **WHEN** Harmony reports available raw state 0 for an exact selected formal or test version
- **THEN** releaseType 1 yields published evidence and releaseType 6 yields testing evidence
- **AND** available test evidence does not establish publication of a formal version

#### Scenario: Incompatible provider selectors
- **WHEN** a caller supplies selectors belonging to another provider or detail selectors to Harmony inventory
- **THEN** the command refuses before authentication

### Requirement: Read isolation and truthful lifecycle evidence
The system SHALL reuse authorized authentication while enforcing bounded reads,
sanitized results and explicit coverage without store mutations, release-state
writes or credential provisioning. An explicitly selected existing Google SDK may
maintain its own authentication cache outside runner-managed state.

#### Scenario: Authentication and no resource writes
- **WHEN** Google authenticates through a JSON key or explicit keyless impersonation
- **THEN** only its exact authentication POSTs and selected release GET are allowed,
  with no edit creation, upload, review, publication or credential provisioning

#### Scenario: Unavailable, malformed or unknown state
- **WHEN** reads fail, required fields are absent, or a future lifecycle appears
- **THEN** failures remain incomplete and unknown states retain their raw value;
  neither becomes approval, publication, absence or permission to retry a write

#### Scenario: Cancellation and late responses
- **WHEN** the overall deadline or parent cancellation fires
- **THEN** authentication and reads receive cancellation and no late completed report
  or successful CLI output is produced after the signal is observed

#### Scenario: Published internal test without review evidence
- **WHEN** Play reports a release as published on the selected track
- **THEN** publication is observed without inferring a review approval, since
  internal testing may be available without standard policy/security review

#### Scenario: Request deadline expires before the operation deadline
- **WHEN** a provider returns headers or body after its per-request deadline
  while the operation-wide deadline remains open
- **THEN** the read is unavailable and cannot establish successful status or
  advance a timed-out identity lookup to another provider request

#### Scenario: Task-resource isolation
- **WHEN** a caller supplies task-resource lifecycle hooks to a shared CLI store read
- **THEN** the read does not acquire task/session leases or invoke resource reclamation

### Requirement: Bounded Harmony version discovery
The system SHALL list CN Harmony formal and test version summaries for an explicitly
configured app and package through a standalone CLI and API, using the existing
Service Account and verifying the package-to-app mapping before listing versions.

#### Scenario: Read-only inventory and exact follow-up
- **WHEN** a caller requests Harmony inventory without version selectors
- **THEN** the reader performs the bounded package lookup GET and the single documented read-only version-list POST for that app and package
- **AND** the report includes string versionIds, release types, raw and interpreted lifecycle states and optional package version summaries, so formal/test records can be passed to the existing exact reader
- **AND** other release types are counted and omitted, provider order is preserved, and coverage applies only to the returned formal/test inventory
- **AND** an omitted release type uses the documented formal default (1), while an omitted lifecycle state remains unknown

#### Scenario: App identity remains bound throughout a read
- **WHEN** a caller changes its config object while the read is pending
- **THEN** lookup, inventory request and report retain the app and package verified at the start

#### Scenario: Empty inventory
- **WHEN** the provider explicitly returns an empty list or only other release types
- **THEN** the supported inventory is empty and the observation is complete within scope

#### Scenario: Unavailable inventory
- **WHEN** the list is unavailable, malformed, exceeds 1,000 entries, exceeds 1,000 package summaries for a supported record, or repeats a supported type/version identity
- **THEN** observation is incomplete with sanitized diagnostics and no partial inventory is returned

#### Scenario: Read isolation
- **WHEN** a caller requests inventory or cancels a pending read
- **THEN** the reader allows only the two fixed reads, bounds request time and body size, refuses redirects and does not retry or return a late successful observation
- **AND** the report omits non-inventory fields, credentials and raw provider diagnostics
