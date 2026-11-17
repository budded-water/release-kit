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
