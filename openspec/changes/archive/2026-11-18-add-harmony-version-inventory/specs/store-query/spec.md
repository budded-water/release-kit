## ADDED Requirements

### Requirement: Bounded Harmony version discovery
The system SHALL list CN Harmony formal and test version summaries for an explicitly
configured app and package through a standalone CLI and API, using the existing
Service Account and verifying the package-to-app mapping before listing versions.

#### Scenario: Read-only inventory and exact follow-up
- **WHEN** a caller requests Harmony inventory without version selectors
- **THEN** the reader performs the bounded package lookup GET and the single documented read-only version-list POST for that app and package
- **AND** the report includes string versionIds, release types, raw and interpreted lifecycle states and optional package version summaries, so formal/test records can be passed to the existing exact reader
- **AND** other release types are counted and omitted, provider order is preserved, and coverage applies only to the returned formal/test inventory

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
