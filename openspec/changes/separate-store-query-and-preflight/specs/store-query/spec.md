## ADDED Requirements

### Requirement: Standalone bounded store reads
The system SHALL provide version inventory and exact version status without project
execution or a release journal, sharing bounded read-only ASC authentication.

#### Scenario: Lightweight review query
- **WHEN** an operator queries an exact version
- **THEN** only app identity, version inventory and selected-build reads occur
- **AND** no listing, screenshot, journal, build or publication operation occurs

#### Scenario: Independent identities
- **WHEN** separate consumers query different configured apps
- **THEN** each operation validates its own remote bundle identity and isolates its session

### Requirement: Exact resolution and honest coverage
The system SHALL distinguish found, not-found, ambiguous and unavailable results.

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
The system SHALL retain bounded raw version states and separate their interpretation
from publication, build matching and query completion.

#### Scenario: Unknown or missing state
- **WHEN** the provider returns a new state or omits the state
- **THEN** interpretation is unknown, new raw values are retained, and missing state is diagnosed

#### Scenario: Approved but awaiting release
- **WHEN** the version awaits developer release
- **THEN** approval is separate from publication and expected-build matching

#### Scenario: Cancellation
- **WHEN** the shared operation deadline or caller cancellation occurs
- **THEN** no successful late report is returned and no retry is attempted
