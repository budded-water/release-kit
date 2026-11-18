# store-preflight Specification

## Purpose
Collect sanitized store observations and supported metadata, then evaluate their
provider-specific scope through pure rules without granting publication approval
or moving consumer-owned release records.

## Requirements

### Requirement: Composable scoped metadata assessment
For App Store Connect, the system SHALL reuse the exact version query in one reader
and evaluate sanitized listing facts through pure rules with a declared scope and
version.

#### Scenario: Scoped successful inspection
- **WHEN** required metadata exists and explicit candidate/build checks match
- **THEN** the report identifies its scope and does not certify public release readiness

#### Scenario: Assessment replay
- **WHEN** the same collected facts and expectations are evaluated again
- **THEN** the same checks result without network or persistence
- **AND** sanitized failed-read diagnostics remain in facts so unknown evidence survives replay

#### Scenario: Missing and unavailable evidence
- **WHEN** a resource is confirmed absent or cannot be read
- **THEN** assessment distinguishes missing from unknown and reports incomplete reads

#### Scenario: Private provider content
- **WHEN** inspection reads contacts, passwords, text or URLs
- **THEN** reports retain presence/syntax facts but omit those private values

### Requirement: Consumer-owned policy and record compatibility
The system SHALL keep product acceptance and journal persistence in the consumer
without changing existing publication ownership or recovery contracts.

#### Scenario: Solura wrapper
- **WHEN** Solura performs a journal-bound preflight
- **THEN** it retains its report kind, source/profile identity, product checks and original journal
- **AND** shared queries do not execute validation/build/submission or change TestFlight state

#### Scenario: Real second consumer
- **WHEN** another project adopts the shared package
- **THEN** its independent identity/authorization read is verified before real reuse is claimed
- **AND** fixtures or package checks alone do not satisfy that acceptance

### Requirement: Scoped provider preflight assessment
The system SHALL assess sanitized provider observations separately from querying,
with explicit unsupported facts and without claiming full publication readiness.

#### Scenario: Pure assessment and unavailable capabilities
- **WHEN** sanitized Play or Harmony facts are assessed
- **THEN** assessment performs no I/O, retains unknown/unsupported checks and keeps
  publicReleaseReady false regardless of transport or lifecycle success

#### Scenario: Sensitive Harmony metadata
- **WHEN** AGC returns listing, reviewer credentials, contacts or document URLs
- **THEN** only approved presence/syntax/count facts leave the collector and neither
  private values nor free-text provider diagnostics enter reports

#### Scenario: Required Harmony localization collection
- **WHEN** a Harmony preflight response omits the required languages array or returns a non-array value
- **THEN** observation is incomplete with sanitized diagnostics and the CLI returns exit code 2
- **AND** an explicit empty array remains a complete observation of missing localization, while status-only reads do not require listing metadata
