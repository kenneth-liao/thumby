# Integration checklist (PR / merge gate)

Use only for the **Integration** axis of a PR merge review.

## Own (must check)

### Design & fit
- Interactions of the changed pieces make sense together
- Belongs in this module/repo (vs a library or different layer)
- Integrates cleanly with surrounding code and existing invariants
- Over-engineering / speculative generality for needs the PR does not have
- Complexity: can the next reader understand this quickly?

### Cross-cutting correctness
- Cross-file / cross-module consistency (types, contracts, dual call sites)
- Concurrency, ordering, multi-step workflows if present
- User-facing behavior that only shows end-to-end
- Regression risk outside the author's local mental model

### Test strategy (not "is CI green?")
- Right level of test for the risk (unit vs integration vs e2e)
- Tests would fail if the protected behavior broke
- Missing regression coverage for the bug class being fixed
- Tests are maintainable (not brittle mocks of internals)

### Maintainability & docs
- Naming and comments explain *why* where needed
- Living docs updated when behavior, ops, or vocabulary changes
  (CONTEXT.md, ADRs, ARCHITECTURE, runbooks — only where load-bearing)
- Consistency with repo conventions (AGENTS.md, domain glossary)

### System-level smells (judgement calls)
Prefer these when they show up in the *merge* surface:
- **Shotgun Surgery** — one logical change scattered across many files
- **Divergent Change** — one module edited for unrelated reasons
- **Speculative Generality** — abstractions without a present need
- **Message Chains** / **Middle Man** that harden bad coupling
- **Duplicated Code** across modules that will drift

Repo-documented standards override smell heuristics. Skip tooling-enforced style.

## Defer

- Line-level secrets scan, pure unit bugs, plan checklist → local + CI
- Full migration/rollback/threat model → Production axis (sibling sub-agent)
