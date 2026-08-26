---
trigger: always_on
---

<!-- Context Module: documentation-conventions -->
# Documentation Conventions

## Documentation map

Where each kind of fact lives — read the one that matches your task, don't duplicate across them. Each fact has **one canonical home**:

- **README.md** — Public overview: what the project is, how it works, quick-start. (Living)
- **AGENTS.md** — Agent operating manual: engineering principles, infra, key files, dev/CI/CD, versioning. (Living)
- **CONTEXT.md** — Domain glossary + cross-cutting invariants. Canonical home for **terms**. (Living)
- **docs/adr/** — Accepted **decisions** with rationale (one per file). Canonical home for "why we chose X". (Living, append-only)
- **docs/ARCHITECTURE.md** — System architecture + component detail. Canonical home for **structural** facts. (Living)
- **docs/agents/** — How engineering skills consume this repo (issue tracker, triage labels, domain docs). (Living)
- **docs/runbooks/** — Operator playbooks for risky/HITL prod operations + incident postmortems. (Living; a finished rollout archives)
- **docs/archive/** — Shipped plans + spent research. Provenance only — never linked as current guidance. (Frozen)
- **Issue tracker** — Work backlog: bugs, enhancements, specs, and implementation tickets. Canonical home for *what to do* and each item's content/state. (Live tracker)

This is a default structure for repos that adopt it — not every project needs every file. Use whatever subset a given project actually has, and check that project's own AGENTS.md/CLAUDE.md for its specific doc layout first.

## Domain docs

**Before exploring, read these:**

- **`CONTEXT.md`** at the repo root, or
- **`CONTEXT-MAP.md`** at the repo root if it exists — it points at one `CONTEXT.md` per context. Read each one relevant to the topic.
- **`docs/adr/`** — read ADRs that touch the area you're about to work in. In multi-context repos, also check `src/<context>/docs/adr/` for context-scoped decisions.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. They get created lazily when terms or decisions actually need to be resolved, by whatever skill or workflow handles documentation in that repo.

**File structure.** A **single-context** repo has one `CONTEXT.md` + `docs/adr/` at the repo root. A multi-context repo has a `CONTEXT-MAP.md` at the root pointing to per-context `CONTEXT.md` files, each with its own `docs/adr/`.

**Use the glossary's vocabulary.** When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap worth noting.

**Flag ADR conflicts.** If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0003 (plugin identity decoupled from slug) — but worth reopening because…_

## CONTEXT.md as canonical vocabulary

Canonical vocabulary and cross-cutting invariants. When naming a domain concept (in code, an issue, a test, a proposal), use the term as defined here — don't drift to synonyms. Decisions that resolve terminology or a real tradeoff are recorded as ADRs under `docs/adr/`.

## Archive rule

Frozen documents kept for provenance, not for day-to-day reference. Nothing here is maintained; git history is the source of truth for how it changed. Living docs (`CONTEXT.md`, `docs/ARCHITECTURE.md`, the guides, `docs/adr/`, `docs/runbooks/`) never link *into* archive — if an archived doc still holds a load-bearing fact, that fact belongs in a living doc instead.

**What lives here:**

- **`plans/`** — completed design + implementation plans. A plan is a working artifact for one piece of work; once shipped it stops being a guide and becomes a record.
- **`research/`** — market, competitor, and early-user research that informed a decision. Archived once it has served its purpose (the decision it fed is made and captured in an ADR or a living doc).

**When a doc graduates to archive** — move a plan or research doc here when **all** of these hold:

1. The work it describes has **shipped** (or the question it explored has been **decided**).
2. Any still-true, load-bearing conclusion has been **promoted** into a living doc — an ADR (`docs/adr/`) for a decision, `CONTEXT.md` for an invariant or term, `ARCHITECTURE.md` for a structural fact, or a runbook for an operation.
3. Nothing in the living docs **links to it** as current guidance.

In practice: archive a plan **when its spec/issue closes**. Use `git mv` so history follows the file.

> Why archive instead of delete: plans and research are cheap to keep and occasionally answer "why did we decide X?". A pure duplicate of a canonical source (e.g. a GitHub-issue spec mirror) is **not** archived — it is deleted, since keeping a second home for a maintained fact only invites drift.
<!-- End Context Module: documentation-conventions -->
