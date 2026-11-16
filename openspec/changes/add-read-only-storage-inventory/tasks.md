## 1. Contracts and implementation
- [x] Record measurement, read-only, reference and non-executable-preview boundaries.
- [x] Implement bounded inventory, shared journal rule and pure cleanup preview.
- [x] Expose standalone CLI/API and synchronize package/usage documentation.

## 2. Validation and delivery
- [x] Verify two synthetic project layouts and reference/failure/no-write boundaries.
- [x] Run required checks, strict specs and packed npm/pnpm consumers.
- [ ] Complete private original-state/workspace read acceptance. Metadata-only real-journal reads and conservative partial results were recorded privately; they do not establish full old-machine/workspace coverage.

Source delivery requires owner-authorized merge after hosted CI and current-head
independent review. The PR is the canonical record of those gate outcomes and
merge status; this checklist does not duplicate that mutable delivery state.

## 3. Follow-up boundary
- [ ] Promote specs and archive after the required acceptance is fulfilled.

Cleanup execution/cache invalidation and real old-machine storage recovery remain
separate future work. No source merge activates or upgrades an installed controller.
