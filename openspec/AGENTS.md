# Store capability specifications

Read repository AGENTS.md. The locked OpenSpec development dependency owns structural
validation (`pnpm run spec:check`); it does not certify semantics or authorize writes.
Keep proposed changes in `changes/`. Promote deltas into `specs/` only after accepted
implementation and its required evidence; do not archive unmet live acceptance.
Requirements need observable scenarios and tests or explicit private acceptance evidence.
Shared store contracts live here; consumers reference them and document only their
project policy, dependency adoption and operational evidence. README owns usage examples,
not another definition of state semantics. No assistant configuration is generated.
