## ADDED Requirements

### Requirement: Bounded iOS build attachment
The system SHALL attach only the exact build of an existing owned, accepted,
upload-only iOS release to an explicit existing manual draft before review.

#### Scenario: Single relationship update and readback
- **WHEN** the current app, draft and uploaded build match the recorded identities, the draft is ready for submission with no selected build, and required source and content gates pass
- **THEN** the runner saves attachment intent and sends exactly one relationship PATCH for the uploaded build
- **AND** completion requires an independent read confirming the same draft and build in the expected pre-review state
- **AND** the action leaves upload, release settings, review submission and publication intent unchanged

#### Scenario: Identity or ownership conflict
- **WHEN** another build is selected, the draft or build is missing or stale, or local ownership or acceptance is invalid
- **THEN** the runner refuses the write instead of claiming or replacing the target

#### Scenario: Reconciliation without another write
- **WHEN** the same build is already selected or an earlier attachment attempt exists
- **THEN** the runner only reconciles the recorded relationship; a missing or unknown result cannot authorize another PATCH
- **AND** the runner blocks publication while attachment intent is unresolved, and the built-in iOS publisher refuses to proceed if the previously confirmed draft/build relationship has changed

#### Scenario: Explicit local scope
- **WHEN** the operator uses ordinary resume, a read-only launcher or dispatch
- **THEN** it cannot initiate the attachment operation
- **AND** attachment uses the existing upload checkpoint and locks without creating another release or advancing its approval scope
