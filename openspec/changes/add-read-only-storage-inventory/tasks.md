## 1. Contracts and implementation
- [x] Record measurement, read-only, reference and non-executable-preview boundaries.
- [x] Implement bounded inventory, shared journal rule and pure cleanup preview.
- [x] Expose standalone CLI/API and synchronize package/usage documentation.

## 2. Validation and delivery
- [x] Verify two synthetic project layouts and reference/failure/no-write boundaries.
- [x] Run required checks, strict specs and packed npm/pnpm consumers.
- [ ] Deliver source through owner-authorized merge after hosted CI and current-head independent review (results owned by the PR record).
- [ ] Record separate private real-journal acceptance. Deferred until original state arrives; local fixtures and metadata-only filesystem smoke do not satisfy it.

## 3. Follow-up boundary
- [ ] Promote specs and archive after the required acceptance is fulfilled.

Cleanup execution/cache invalidation and real old-machine storage recovery remain
separate future work. No source merge activates or upgrades an installed controller.
