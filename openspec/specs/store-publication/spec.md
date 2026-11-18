# store-publication Specification

## Purpose
Define bounded iOS artifact upload and build attachment, durable recovery, and
confirmed prepared-draft continuity without granting review or public-release intent. Full publication
remains a separately authorized workflow with its existing gates.

## Requirements

### Requirement: Bounded existing-artifact upload
The system SHALL provide local upload of an existing accepted iOS artifact without
granting review or release intent, using its existing release identity and gates.

#### Scenario: Immediately processed build
- **WHEN** Apple reports the exact uploaded build VALID during upload execution
- **THEN** the result is uploaded without selecting a build, changing release policy
  or invoking review submission

#### Scenario: Resume a bounded task
- **WHEN** an operator resumes a release with only persisted upload intent
- **THEN** execution retains upload-only behavior and full publication remains false

#### Scenario: Explicit publication escalation
- **WHEN** the operator explicitly grants full publication on a bounded task
- **THEN** existing publication gates apply and its exact upload checkpoint is reused

#### Scenario: Existing broad authorization
- **WHEN** upload is requested on a journal with full publication or review work
- **THEN** the command refuses without downgrading intent or executing provider work

### Requirement: Fail-closed upload recovery and capability
The system SHALL require a distinct upload-capable adapter and retain exact
artifact, evidence, ownership, cancellation and unknown-result protections.

#### Scenario: Missing capability or evidence
- **WHEN** upload support, a built artifact or passing native acceptance is absent
- **THEN** no upload intent is admitted and no publish hook or new build is invoked

#### Scenario: Uncertain upload result
- **WHEN** upload response is lost or its recorded intent is not yet visible
- **THEN** resume inspects the exact provider identity and never sends a duplicate upload

#### Scenario: Unsupported scheduling
- **WHEN** upload or bounded resume is requested through auto/GitHub dispatch
- **THEN** admission fails before request creation or provider work

#### Scenario: Stale or conflicting task
- **WHEN** source, artifact, native evidence or destination ownership fails validation
- **THEN** upload remains blocked under the existing release gates

### Requirement: Confirmed prepared-draft continuity
The system SHALL retain the existing locked supersession mechanism for a newer
accepted current-source build adopting the same confirmed draft before any binary
intent, without transferring successful validation or build evidence.

#### Scenario: Same prepared draft and content
- **WHEN** the predecessor has only fully confirmed prepared iOS content and the
  newer higher-build task binds the same app/version/config/content digest/draft ID
- **THEN** a fresh read under target and predecessor locks must confirm that exact
  provider draft identity and content, then revalidate current default source
  before ownership can transfer with
  append-only revocation of the predecessor
  and the new task's normal source/evidence/provider gates still apply

#### Scenario: Ambiguous or changed preparation
- **WHEN** content or draft identity differs, preparation is incomplete or a binary
  intent already exists
- **THEN** this prepared-draft handoff refuses without revoking the predecessor
  or repeating provider writes

#### Scenario: Provider changes after saved preparation
- **WHEN** the provider replaces a draft with identical content or changes its
  content after the saved preparation/proposal snapshots
- **THEN** the fresh handoff read refuses before predecessor revocation or upload
  intent, and upload/publication independently requires the prepared draft identity

#### Scenario: Default source advances during continuity reads
- **WHEN** the default source advances while the fresh provider continuity read is pending
- **THEN** source revalidation refuses before predecessor revocation or upload intent

### Requirement: Bounded iOS build attachment
The system SHALL attach only the exact build of an existing owned, accepted,
upload-only iOS release to an explicit existing manual draft before review.

#### Scenario: Single relationship update and readback
- **WHEN** the current app, draft and uploaded build match the recorded identities, the draft is ready for submission with no selected build, and required source and content gates pass
- **THEN** the runner saves attachment intent and sends exactly one relationship PATCH for the uploaded build
- **AND** completion requires an independent read confirming the same draft and build in the expected pre-review state
- **AND** the action leaves upload, release settings, review submission and publication intent unchanged

#### Scenario: Identity or ownership conflict
- **WHEN** another build is selected, provider reads disagree on the relationship, the draft or build is missing or stale, or local ownership or acceptance is invalid
- **THEN** the runner refuses the write instead of claiming or replacing the target

#### Scenario: Source changes during provider verification
- **WHEN** the source is no longer currently eligible after the provider checks
- **THEN** the runner refuses before recording intent or sending the PATCH

#### Scenario: Reconciliation without another write
- **WHEN** the same build is already selected or an earlier attachment attempt exists
- **THEN** the runner only reconciles the recorded relationship; a missing or unknown result cannot authorize another PATCH
- **AND** the runner blocks publication while attachment intent is unresolved, and the built-in iOS publisher confirms the draft state and saved build relationship directly before proceeding

#### Scenario: Existing unsubmitted-upload handoff
- **WHEN** a higher build requests an otherwise eligible unsubmitted-upload handoff
- **THEN** a confirmed attachment permits that handoff only with fresh matching unsubmitted evidence for the saved build and a direct read confirming the saved draft remains pre-review with the expected relationship or confirming its absence
- **AND** unresolved attachment intent blocks ownership transfer even with a saved terminal outcome
- **AND** a saved terminal outcome with a confirmed attachment requires fresh terminal verification before ownership transfer

#### Scenario: Explicit local scope
- **WHEN** the operator uses ordinary resume, a read-only launcher or dispatch
- **THEN** it cannot initiate the attachment operation
- **AND** attachment uses the existing upload checkpoint and locks without creating another release or advancing its approval scope

#### Scenario: Managed attachment admission
- **WHEN** the installed local entry requests attachment from an activated state root using its active activity lease
- **THEN** the runner verifies the installed policy and settled lifecycle state before admitting the exact saved release for attachment
- **AND** the command preserves the activity lease and resource journal without scheduling reclamation, building or using other execution capabilities
- **AND** interrupted ownership or a changed policy blocks attachment checkpoints and dispatch, preserving any recorded intent for reconciliation under a new lease
- **AND** an unsettled source command keeps activity ownership for reconciliation
