## ADDED Requirements

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
