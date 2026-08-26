# Agent Profile Kit Context

Profile: engineering

This Context is reusable Profile material. Repository-owned project instructions, including AGENTS.md, take precedence when they conflict with this material.

<!-- Context Module: communication-and-behavior -->
# Communication and Behavior

- Prioritize efficient communication when possible. E.g. use concise responses, bulleted lists, and multiple choice options when asking the user questions.
- Use clear, plain language by default, following ASD-STE100 Simplified Technical English. Prefer ordinary words and concise sentences without losing technical precision.
- Always respect the project's ubiquitous language from `CONTEXT.md` if available. Keep its established terms, even when simpler synonyms exist, and explain them plainly when needed.
- All content written to a forge or issue tracker (issues, comments, pull/merge requests, etc.) should be written as if it is by the user. Never add AI co-author attribution (Claude, Codex, Pi, etc.).
<!-- End Context Module: communication-and-behavior -->
<!-- Context Module: engineering-principles -->
# Engineering Principles & Practices

## Poka-yoke — design so it's impossible to break

Prefer designs where an invalid state **cannot be represented** over designs that detect and handle an invalid state after the fact. When a class of bug appears, fix the *shape* that allowed it, not just the instance. In practice:

- **One canonical home per fact** *(Single Source of Truth).* Every piece of data has exactly one authoritative location. If the same fact can be stored in two places, readers will eventually disagree — and that divergence *is* the bug. A `?? fallback` between two storage locations for the same fact is the smell that this principle is being violated.
- **Normalize at one boundary** *(Parse, Don't Validate).* Untyped or external input becomes trusted internal data at a single ingestion point. Coerce *and relocate* there, so every downstream reader can assume the canonical shape. Adding a new read/comparison site must never require knowing about alternate representations.
- **One reader, not N** *(low coupling / Law of Demeter).* When several call sites need the same derived fact, give them a single shared function to call, so no site can read it the wrong way.
- **Layer the defenses, but make each layer independently sufficient** *(Shift Left / Defense in Depth)* — stop bad input at the creator's machine → reject it at ingestion → tolerate it at comparison → migrate existing data. A later layer is never an excuse to leave the shape breakable.

## Minimal change — the simplest solution that *completely* solves the problem

*(KISS + YAGNI, applied with DRY.)* The standing goal is to **minimize tech debt while solving real problems**. Every change should be the simplest implementation that fully satisfies the requirement — no more, no less:

- **Completeness first, then minimalism.** Writing less code is never the top priority; a change must *completely* solve the problem. Among solutions that all do, prefer the one that adds the least surface (code, config, tests, gates) — less surface is less to drift, less to maintain, less to break.
- **Every artifact solves a real problem.** Don't add tests, gates, or abstractions for their own sake. A test must protect against a failure that can actually happen (ideally one already seen); a gate must block a break that can actually ship. If you can't name the concrete failure it prevents, it's debt, not protection.
- **DRY + poka-yoke are non-negotiable.** A second home for a fact, a duplicated assertion, or a `?? fallback` between two storage locations must be flagged — even when it would be the quicker path. If a change can't satisfy these, surface it rather than quietly shipping the smell.

## Single Responsibility Principle — one reason to change

A module, function, or file should have exactly one reason to change. When two unrelated concerns share a home, a change to one risks breaking the other — and the blast radius is invisible until it happens.

- **One concern per unit.** If you find yourself describing what a function does with "and," it's two functions.
- **Split along reasons to change, not along code size.** A 20-line function doing two unrelated things is worse than a 200-line function doing one.

## Fail Fast — reject invalid states immediately

When a state can't be made unrepresentable (poka-yoke's first choice), reject it loudly at the boundary instead of letting it silently propagate downstream.

- **Validate at the edge, not deep in the call stack.** A check buried three calls deep means everything above it already trusted bad data.
- **Surface the failure, don't swallow it.** An empty catch block or a silently-substituted default turns a real failure into an invisible one — it resurfaces later, somewhere harder to trace back to the cause.

## Test-Driven Development — red, green, refactor

Code changes follow the red-green-refactor loop: write a failing test, write the minimal code to make it pass, then refactor. See the `tdd` skill for the full workflow (tracer bullets, vertical slicing, anti-patterns to avoid).

- **Exceptions:** trivial changes, docs-only changes, and throwaway prototypes/spikes don't require a test-first approach.
- **Use judgment at the edges.** If a "trivial" change is actually easy to get subtly wrong, write the test first regardless of size.
<!-- End Context Module: engineering-principles -->
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
<!-- Context Module: versioning-and-changelogs -->
# Versioning & Changelogs

Projects use [Semantic Versioning](https://semver.org/). The version lives in the project's manifest file (`package.json`, `plugin.json`, `pyproject.toml`, etc. — check the project's own docs for the exact path; a repo with multiple sub-packages may version each independently).

## Rules

- **Every functional commit** (`feat:`, `fix:`, `refactor:`, `perf:`) MUST bump the version in the relevant manifest AND add an entry to `CHANGELOG.md`
- **Non-functional commits** (`docs:`, `chore:`, `test:`) do NOT require a version bump
- `feat:` bumps **minor** (0.x.0)
- `fix:`, `refactor:`, `perf:` bump **patch** (0.0.x)
- Breaking changes bump **major** (x.0.0) — annotate with `BREAKING:` in the commit message
- The `[Unreleased]` section in `CHANGELOG.md` collects changes until deploy/release
- **Git tags** (`v0.1.0`, etc.) are created at deploy time, not per commit

## Changelog Format

Use [Keep a Changelog](https://keepachangelog.com/) sections under `[Unreleased]`:
- **Added** for new features
- **Changed** for changes to existing functionality
- **Fixed** for bug fixes
- **Removed** for removed features

**Keep entries to what changed + the issue/PR ref** (one or two lines). Deep root-cause analysis and rejected alternatives belong in the **commit body** or an **ADR** (`docs/adr/`), not the changelog — putting them here is a second home for the "why" that bloats the file and drifts from the canonical record. Link out instead of restating.
<!-- End Context Module: versioning-and-changelogs -->
<!-- Context Module: development-workflow -->
# Development Workflow

## Git worktree hygiene

Per-issue worktrees live **inside the repo** at `.worktrees/<branch>` (gitignored) — never as a sibling dir in `~/projects/`. They are disposable; the PR stack is the source of truth.

- **Create:** `git worktree add .worktrees/<branch> <branch>` (or `-b <branch>` for a new branch). Make sure `.worktrees/` is in `.gitignore` (add it if missing). A branch with slashes (`fix/foo`) nests under `.worktrees/`, still ignored.

To avoid leaking resources:

- **Never commit `node_modules`.** A shared-deps worktree symlinks it to the main checkout; `.gitignore` must ignore both the directory *and* the symlink (the pattern is `node_modules`, not `node_modules/` — a trailing slash misses the symlink). A committed symlink holds an absolute path that breaks CI's `bun install --frozen-lockfile` with `ENOENT: could not open the "node_modules" directory`.
- **Before removing a worktree, stop its test/dev runtimes.** Deleting the directory while a runtime is running orphans the processes (e.g. `pkill -f 'workerd serve --binary'` for a Workers project — match the pattern to whatever the project's dev/test server actually is).
- **Remove cleanly:** `git worktree remove <path>` (not `rm -rf`), then `git worktree prune`. Delete the merged local branch (`git branch -d <branch>`); `gh pr merge --delete-branch` removes the remote branch only if no local worktree still holds it, so verify after with `git ls-remote --heads origin`.

## Local Tooling

- `bun` over `npm` for JavaScript/TypeScript projects
- `uv` over `pip` for Python projects
- `rg` over `grep` for improved performance

## Cross-repo sync check

*(Applies to projects that document a "Related Repos" table or equivalent — skip if a project has no sibling repos.)*

Sibling repos often share terminology, install commands, tool/schema names, or skill references. After a significant change in one repo (a rename, a changed schema, a new/removed tool or endpoint), scan the related repos for stale references before considering the change done — don't wait for a buyer/consumer repo to break silently.

Use whatever repo list and search method the project's own docs define (e.g. a "Related Repos" table in AGENTS.md); this rule doesn't hardcode a repo list or command, since that's project-specific.

## Database migration discipline

*(Applies to projects with a database/migration pipeline — skip if not relevant.)*

Migrations always run **before** the code deploy, and **staging before prod** — a schema/data migration is proven against a prod-shaped DB before it can touch a real record.

Follow **expand → contract**: a migration must be deployable one release ahead of the code that reads it (add nullable + dual-write first; flip reads and drop columns a release later). Rehearse any data migration on staging seeded from a prod snapshot before tagging.

Make every migration **idempotent** (`IF NOT EXISTS`, `DROP … IF EXISTS` before `CREATE`) so a replay against a built schema can't error. A CI `migrations` job that applies every migration to a clean Postgres is the gate that catches broken/non-idempotent migrations.
<!-- End Context Module: development-workflow -->
<!-- Context Module: agent-orchestration -->
# Agent Orchestration

Use Herdr only when the user explicitly requests it or the active workflow explicitly requests the "configured agent orchestration mechanism." This binding does not authorize delegation or add workflow steps.

Use host-native subagents when requested; never replace them with Herdr or add unrequested workers, roles, reviews, or audits.

## `/implement-spec` Herdr bindings

A role with more than one row lists tiered fallback options in priority order. Use the first; fall to the next only when that harness is unavailable or its usage limit is reached.

| Role | Priority | Kind | Model | Thinking/effort |
| --- | --- | --- | --- | --- |
| implementer | 1 | agy | `gemini-3.7-flash-high` | — |
| implementer | 2 | pi | `oc-sdk-go/glm-5.3-flash` | high |
| implementer | 3 | pi | `openai-codex/gpt-5.6-sol` | medium |
| implementer | 4 | claude | `opus` | medium |
| reviewer | 1 | claude | `opus` | medium |
| reviewer | 2 | pi | `xai/grok-4.6` | high |
| closer | 1 | pi | `openai-codex/gpt-5.6-sol` | high |
| closer | 2 | claude | `opus` | medium |
| closer | 3 | pi | `xai/grok-4.6` | high |
| upgrade | 1 | claude | `opus` | medium |
| upgrade | 2 | pi | `openai-codex/gpt-5.6-sol` | high |
<!-- End Context Module: agent-orchestration -->
<!-- Context Module: review-findings -->
# Review Findings

Use these scoped terms only for review findings:

- **Blocker** — makes the change unsafe.
- **Should-fix** — needs an accepted disposition before Ready, but is not unsafe by itself.
- **Nit** — optional polish; affects neither Safe nor Ready.

If the reviewer expects action, the finding is not a Nit.

## Disposition

A Blocker or Should-fix stays open until:

1. The author records **Fix** (change plus evidence) or **Push back** (contrary evidence).
2. The reviewer records **Accept** (closed) or **Follow-up** (still open).

Nits need no disposition. Only the reviewer closes a finding.

## States and verdicts

- **Safe** — no open Blocker.
- **Ready** — no open Blocker or Should-fix. Opening or merging a change request requires Ready.
- Local review: **No** for Blockers, **With fixes** for only Should-fixes, **Yes** for Ready.
- Change-request review: **Request changes** for Blockers, **Comment** for only Should-fixes, **Approve** for Ready. If approval is unavailable, Comment with an explicit Ready verdict.
<!-- End Context Module: review-findings -->
