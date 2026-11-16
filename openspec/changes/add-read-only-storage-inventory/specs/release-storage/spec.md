## ADDED Requirements

### Requirement: Bounded read-only storage observation
The system SHALL inventory one explicit existing state root without writes,
project execution, credentials, providers or symlink traversal.

#### Scenario: Independent consumer layouts
- **WHEN** separate projects inspect their state roots
- **THEN** each report measures only its own root without a project module or release configuration
- **AND** logical sizes, observed unique allocations and opaque symlinks remain distinct

#### Scenario: Incomplete measurement
- **WHEN** entry/time/read budgets are exhausted or a path cannot be read
- **THEN** the report declares partial coverage and exposes no review candidates

#### Scenario: Cancellation
- **WHEN** the caller cancels
- **THEN** the operation fails without a late successful report or state writes

### Requirement: Evidence-aware non-executable cleanup preview
The system SHALL validate retained event chains, preserve historical references and
explain workspace protection before suggesting reconstructable review candidates.

#### Scenario: Historical and cross-release references
- **WHEN** any retained snapshot references a workspace or a file inside it
- **THEN** that workspace is protected even if the latest snapshot no longer carries the reference
- **AND** an ancestor reference protects descendant workspaces

#### Scenario: Unknown state and ownership
- **WHEN** history is corrupt, changes during observation, contains unresolved operations or cannot establish reference scope
- **THEN** preview conservatively reports protection or incomplete analysis without deletion authority

#### Scenario: Reconstructable workspace
- **WHEN** a known workspace has no observed protection in the declared scope
- **THEN** it is only a review candidate with future maintenance, source, reference and cache invalidation checks
- **AND** actual reclaimable bytes remain unknown and apply is unsupported

#### Scenario: Pure preview replay
- **WHEN** the same inventory is assessed again
- **THEN** the same preview results without I/O and no saved report authenticates or authorizes cleanup
