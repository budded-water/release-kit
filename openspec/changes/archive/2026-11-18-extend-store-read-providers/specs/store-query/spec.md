## ADDED Requirements

### Requirement: Provider-specific standalone release reads
The system SHALL expose standalone Google Play and Harmony release queries without
a project module, build or journal, preserving existing default Apple commands.

#### Scenario: Exact Play release in an explicit track
- **WHEN** a caller queries a package, track and versionCode
- **THEN** the reader uses only that track's bounded nonobsolete summaries and
  distinguishes one match, multiple matches and not-observed within that scope

#### Scenario: Exact Harmony formal or test version
- **WHEN** a caller selects app identity, releaseType and versionId
- **THEN** package and returned version identity must match and the raw lifecycle
  is interpreted within that release type without another-version fallback

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
