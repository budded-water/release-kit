# Release Kit

Keep this repository independent of any business project. Project modules are trusted executable policy, supplied explicitly by an operator. Never load plugins from a release journal or automatically from candidate source.

Preserve request identity, append-only history, cancellation cleanup, artifact binding and publication gates. Missing evidence is not a pass. Unknown provider responses never authorize a duplicate submission. Changing a journal/request format requires an explicit compatibility decision and migration tests.

Use topic branches and pull requests. Use the pnpm version pinned in `package.json` and commit only `pnpm-lock.yaml` as the dependency lockfile. Run `pnpm run check` and `pnpm run verify:package` to inspect packed pnpm and npm consumers, and obtain an independent review before merge readiness. Tests use synthetic projects/providers; keep real credentials, account configuration, screenshots, machine paths and operational records out of this public repository.

For owner-requested work in this repository, the owner grants agents standing authorization to merge their pull requests after required checks pass and independent review clears the current head. Honor branch protection and any explicit draft or no-merge instruction. Production deployment, store submission, public release, and destructive operations retain their own authorization requirements.

Public source does not imply a license grant or package publication. This project is UNLICENSED and not published to a package registry. No service, registry, dependency or hosted runner is required by this initial extraction.
