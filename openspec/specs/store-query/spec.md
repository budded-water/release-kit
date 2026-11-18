# store-query Specification

## Purpose
Provide independent, bounded store observations: App Store Connect version
inventory/status, Google Play selected-track releases and exact versionCode status,
and CN Harmony exact formal/test version status. Preserve provider identity,
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

#### Scenario: Unsupported inventory or selectors
- **WHEN** Harmony inventory or incompatible provider selectors are requested
- **THEN** the command refuses before authentication rather than claiming coverage

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
