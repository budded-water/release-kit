## ADDED Requirements

### Requirement: Standalone WeChat Mini Program reads

The system SHALL allow read-only current version and review observations from
the official WeChat API using one explicit mini program identity and authorized
short-lived token. The standalone CLI and API SHALL work without a project module,
release journal, resource lifecycle admission or build.

#### Scenario: Provider identity and read-only routes

- **WHEN** a caller uses an authorized WeChat configuration for a selected AppID
- **THEN** the same credential must identify that AppID as a mini program before any version or audit request
- **AND** one observation uses only the bounded identity and selected fact endpoint with redirects disabled
- **AND** a mismatched AppID, unavailable identity or missing authorization yields incomplete evidence before any version or audit request

#### Scenario: Current version slots

- **WHEN** a caller requests WeChat version discovery
- **THEN** the system reports current experience and production slots with their own provider labels and timestamps
- **AND** missing or malformed slots remain incomplete, preserving other verified rows
- **AND** experience visibility and current production state do not imply a specific audit result or identify the latest developer upload

#### Scenario: Latest or exact review

- **WHEN** a caller selects either the latest review or an exact positive decimal audit ID
- **THEN** the system observes the selected audit and preserves its raw and interpreted review state
- **AND** the review observation does not establish publication and never falls back to another audit
- **AND** invalid IDs, unsupported selectors and result mismatches cannot resolve to an approved audit

#### Scenario: Bounded evidence

- **WHEN** a read fails, returns malformed data, is cancelled, or exceeds the response or time budget
- **THEN** no late successful observation is emitted and failures cannot establish approval, absence or publication
- **AND** only bounded requested fields and sanitized diagnostics are exposed, without tokens, raw error messages or screenshot media identifiers
