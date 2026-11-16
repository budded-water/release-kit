# Guard iOS publication build conflicts

## Why
Independent executors can observe a store version that another task has already
selected. A draft's older selected build must not be silently replaced merely
because review has not begun. Version numbers also cannot replace the task's
recorded remote build identity.

## What Changes
- Reject ambiguous exact App Store versions before choosing a publication target.
- Reject a different selected build in an editable draft, preserving the existing
  explicit older-rejected-build correction path.
- Preserve recorded upload build IDs across subsequent provider observations.
- Document independent fresh-machine provisioning and the existing conflict/unknown
  result boundaries without requiring historical migration.

## Non-goals
No shared coordinator, distributed lock, cross-machine takeover, historical journal
rewrite, new publication authority or changes to build/upload/review retry policy.
Source acceptance does not install a controller or establish native/store readiness.
