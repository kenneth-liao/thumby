# Craft checklist (local / pre-PR)

Use only for the **Craft** axis of a local diff review. This is an
author-facing gate: catch defects while context is hot, before opening a PR.

## Own (must check)

### Correctness
- Logic bugs, off-by-ones, inverted conditions, wrong comparisons in touched code
- Edge cases on new/changed paths (empty, null/undefined, boundaries, errors)
- Error handling: fail fast at boundaries; no silent swallow of real failures
- Type safety / invariants on the new surface (where the language allows)

### Tests
- New or changed behavior has tests that would fail if the bug returned
- Assertions check real outcomes, not only mock call shapes
- Local project suite is green (run it — e.g. `bun test`, `uv run pytest`)
- No tests that lock implementation details without protecting behavior

### Line-level security
- Secrets, tokens, credentials, or private keys in the diff
- Injection risks on new input paths (SQL, shell, HTML, path traversal)
- Unsafe defaults or missing validation at new trust boundaries
- New log/error messages that leak PII or secrets

### Standards & smells
- Documented repo coding standards (AGENTS.md, CONTRIBUTING.md, CODING_STANDARDS.md, etc.)
- Smell baseline (see `smell-baseline.md`) — judgement calls only; repo overrides
- Skip anything tooling already enforces (formatter, linter, typecheck in CI)

## Defer (not this review's job)

| Concern | Owner |
| --- | --- |
| Format / lint / import order | Pre-commit / CI |
| Full system architecture fit | PR merge review |
| Cross-service contracts, rollout, rollback | PR merge review |
| AuthZ model / attack-surface threat modeling | PR merge review |
| Migration expand/contract strategy | PR merge review |
| Living docs / ADR promotion for merge | PR merge review |
| Merge approval | PR merge review + CI |
