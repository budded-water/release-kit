## ADDED Requirements

### Requirement: Exact remote identity before iOS publication
The system SHALL reject ambiguous version selection, conflicting editable build
selection and drift from the task's recorded upload build ID before new publication
work, without treating matching numbers as artifact ownership.

#### Scenario: Another build selected in an editable draft
- **WHEN** the exact version is editable but selects a different build
- **THEN** publication stops without Fastlane or a new review intent even if that build number is lower
- **AND** journal-bound status reports unavailable without changing task history

#### Scenario: Multiple exact versions
- **WHEN** the provider returns multiple versions matching the intended version
- **THEN** no first match is selected and publication stops before provider writes

#### Scenario: Recorded remote build changes
- **WHEN** an observed build ID differs from the task's recorded upload build ID
- **THEN** publication stops and the original checkpoint remains unchanged

#### Scenario: Selection changes during preflight
- **WHEN** another build becomes selected after initial observation but before the final pre-review check
- **THEN** the new observation stops execution before review intent or Fastlane

#### Scenario: Empty draft and explicit rejected correction
- **WHEN** the draft has no selected build or the existing explicit older-rejected-build correction rule applies
- **THEN** the owned candidate retains its existing publication path and acceptance gates
- **AND** no atomic cross-machine exclusion, automatic task adoption or publication success is inferred
