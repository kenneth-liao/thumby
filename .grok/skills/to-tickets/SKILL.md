---
name: to-tickets
description: Break a plan, spec, or the current conversation into a set of
  tracer-bullet tickets, each declaring its blocking edges, published to the
  configured tracker — edges as text in one file per ticket locally, or native
  blocking links on a real tracker.
metadata:
  agent-profile-kit.model-invocation: disabled
disable-model-invocation: true
---

# To Tickets

Break a plan, spec, or conversation into a set of **tickets** — tracer-bullet vertical slices, each declaring the tickets that **block** it.

The issue tracker and triage label vocabulary should have been provided in `docs/agents/` — run `/setup-project-skills` if not. Read `docs/agents/triage-labels.md` before classifying executor or readiness.

## Process

### 1. Gather context

Work from whatever is already in the conversation context. If the user passes a reference (a spec path, an issue number or URL) as an argument, fetch it and read its full body and comments.

Identify the source being decomposed: a durable spec, PRD, plan, or parent issue, or the current conversation. Preserve stable requirement identifiers already defined by a durable source. If the source has no stable identifiers, assign temporary `SRC-NNN` identifiers for decomposition only and tell the user that they do not provide durable traceability. If durable issue-to-spec traceability is wanted, recommend running `/to-spec` first; do not publish a spec implicitly.

When the durable source is tracked, verify that it has `spec` and `ready-for-tickets`.

### 2. Inspect the existing implementation

When working in an existing repository, perform bounded reconnaissance before assigning requirement ownership or sizing tickets. Skip this only for greenfield work with no implementation, or when the source explicitly covers work outside a codebase.

Inspect only enough to identify:

- The current canonical owner of each affected behavior
- Existing behavior that already satisfies source requirements
- The highest public interface through which each outcome can be verified
- Contracts delivered by predecessor tickets that later slices can rely on
- Likely components and reasons to change
- New state, identity, transaction, trust, migration, or concurrency boundaries
- Likely overlap between proposed slices
- A rough implementation and review surface

Read the relevant domain glossary and ADRs before naming tickets or criteria.

Stop reconnaissance once there is enough evidence to assign ownership, judge cohesion, identify blockers, and estimate review size. Do not design internal implementation details or enumerate exact edits. Use implementation paths and test locations as planning evidence, but do not publish them in tickets unless they encode an accepted contract that cannot be referenced more durably.

If the existing implementation cannot be inspected enough to distinguish new, already-satisfied, and overlapping requirements, do not label the breakdown ready. Mark the affected sizing or ownership as uncertain and surface the missing evidence during user approval.

### 3. Build the requirement ownership map

Extract the source into atomic delivery requirements before grouping them into tickets. Classify every delivery requirement as exactly one of:

- **Owned by a ticket** — new work for one ticket to deliver
- **Already satisfied** — existing behavior, with concise evidence
- **Deferred or out of scope** — requires explicit user approval

Each delivery requirement has exactly one owning ticket. A later ticket may rely on behavior delivered by an earlier ticket, but must not repeat that behavior as one of its own acceptance criteria.

Treat source decisions and constraints separately from delivery ownership:

- `DEC-*` entries may constrain multiple tickets, but tickets must not redefine them.
- `TEST-*` entries guide verification and are referenced where relevant.
- `OOS-*` entries are global guardrails and are never owned as implementation work.

An integration acceptance criterion owns only the new interaction between previously delivered capabilities. It must not restate the complete contracts of its dependencies.

Before presenting the breakdown, verify:

- Every source delivery requirement is accounted for.
- No delivery requirement has more than one owner.
- Every ticket's acceptance criteria describe work introduced by that ticket.
- Existing behavior is not turned into new implementation work merely to make a ticket appear self-contained.

### 4. Draft vertical slices

Break the work into **tracer bullet** tickets.

<vertical-slice-rules>

- Each slice cuts a narrow but COMPLETE path through every layer (schema, API, UI, tests) — vertical, NOT a horizontal slice of one layer
- A completed slice is demoable or verifiable on its own
- Each slice is sized for implementation and adversarial review in one fresh session

</vertical-slice-rules>

Size each ticket so one fresh implementation session has room to:

1. Understand the affected code and invariants.
2. Complete vertical TDD.
3. Run required verification.
4. Review the complete diff adversarially.
5. Address at least one focused correction pass.

A ticket merely fitting in the context window is not sufficient. A normal tracer-bullet ticket should have:

- One primary observable outcome
- At most one newly introduced state machine, identity lifecycle, transaction boundary, or trust boundary
- Normally 3–7 substantive acceptance criteria
- A review surface expected to remain roughly below 500 meaningful changed lines and 10 files

These are warning thresholds, not hard limits. Small security-sensitive changes may still need splitting, while a cohesive mechanical refactor may justifiably exceed them. Do not pad, merge, or split criteria merely to hit the numeric targets.

Split the ticket further, or state why it must remain atomic, when:

- It contains more than one independently demonstrable or reversible outcome.
- It introduces multiple high-risk boundaries such as filesystem ownership, transactions, concurrency, identity continuity, migrations, or security.
- It has eight or more substantive acceptance criteria.
- Its title or outcome enumerates several independent capabilities.
- Its expected review surface exceeds the normal target.
- A reviewer would need different threat models for different criterion groups.

Verify slice cohesion. Keep requirements in one ticket only when they must change together. A cohesive ticket should be describable as one primary outcome established through one state transition or invariant family. Split it when the description requires "and" to join capabilities that can be demonstrated, fail, be reviewed, be reverted, or be delivered independently.

Requirements sharing files, modules, terminology, or a broad product area does not make them one slice. Implementation convenience and sequential development order are not cohesion. Keep otherwise distinct behavior together only when splitting would:

- Leave an invalid or unusable intermediate state
- Require a temporary compatibility layer more complex than the combined change
- Prevent either slice from being verified through a real public interface
- Break one atomic migration or transaction contract

For every ticket, answer:

- What is its one primary outcome?
- What state transition or invariant family unifies its criteria?
- Could any criterion group be demonstrated or reverted independently?
- What invalid intermediate state would splitting create?

If splitting creates no invalid intermediate state, split independently demonstrable groups.

Give each ticket its **blocking edges** — the other tickets that must complete before it can start. A ticket with no blockers can start immediately.

For each ticket, distinguish:

- **Owns** — source delivery requirements assigned to this ticket
- **Relies on** — capabilities provided by blocking tickets
- **Constrained by** — source decisions and out-of-scope guardrails that shape the slice

Ticket acceptance criteria refine the owned source requirements into verifiable behavior for that slice. They do not replace or duplicate the canonical source statements.

Plan enabling refactors conservatively. Do not create prefactoring work merely because a cleaner structure is possible. Create only the smallest enabling change required by a concrete delivery slice. Include the enabling refactor in the first delivery ticket that needs it when the combined ticket remains within its sizing and cohesion budget.

Create a separate enabling-refactor ticket only when all of these hold:

- It preserves externally observable behavior.
- It can land and remain green independently.
- Existing code shape is a proven blocker, not merely inconvenient.
- It enables at least two delivery tickets, or combining it with one consumer would exceed that consumer's sizing or review budget.
- Its acceptance criteria prove behavior preservation and the specific seam or capability required by its consumers.
- At least one immediate consuming ticket is already identified.

An enabling-refactor ticket does not own a source delivery requirement. Record instead:

- **Enables** — the delivery tickets that require it
- **Supports** — the source requirement identifiers those tickets own
- **Behavioral change** — `None`

Make each consuming ticket depend on the enabler. Do not duplicate the enabler's behavior-preservation criteria in its consumers. Do not use an enabler ticket for general cleanup, speculative abstractions, future extensibility, style consistency, or unrelated debt. If no approved delivery ticket consumes the result, do not create it.

**Wide refactors are the exception to vertical slicing.** A **wide refactor** is one mechanical change — rename a column, retype a shared symbol — whose **blast radius** fans across the whole codebase, so a single edit breaks thousands of call sites at once and no vertical slice can land green. Don't force it into a tracer bullet; sequence it as **expand–contract**. First expand: add the new form beside the old so nothing breaks. Then migrate the call sites over in batches sized by blast radius (per package, per directory), each batch its own ticket blocked by the expand, keeping CI green batch to batch because the old form still exists. Finally contract: delete the old form once no caller remains, in a ticket blocked by every migrate batch. When even the batches can't stay green alone, keep the sequence but let them share an integration branch that all block a final integrate-and-verify ticket — green is promised only there.

Classify who can safely execute each ticket using the `ready-for-agent` and `ready-for-human` definitions in `docs/agents/triage-labels.md`. Write the specific human step, when there is one, as the ticket's readiness rationale.

If a ticket combines agent-executable preparation with a human-only action, split it when each part can be verified independently. Make the human ticket depend on the agent preparation ticket. If required information or a material decision is missing, do not label the ticket ready; return it to the configured triage workflow with the appropriate `needs-info` or `needs-triage` role.

A ticket's blocking edges describe when it can start; its readiness role describes who can execute it. Work only the dependency frontier, even when a blocked ticket is otherwise fully specified for an agent or human.

### 5. Quiz the user

Before asking for approval, state the recommended breakdown and why it is the smallest set of cohesive, safely reviewable tickets. Do not present multiple equivalent decompositions without a recommendation. When reasonable alternatives exist, recommend one and explain the material tradeoff.

Present the proposed breakdown as a numbered list. For each ticket, show:

- **Title**: short descriptive name
- **Blocked by**: which other tickets (if any) must complete first
- **What it delivers**: the end-to-end behaviour this ticket makes work
- **Owns**: stable source requirement identifiers, or temporary `SRC-*` identifiers
- **Relies on**: capabilities supplied by blocking tickets
- **Constrained by**: relevant source decision and out-of-scope identifiers
- **Size**: small, medium, or large
- **Risk boundaries**: filesystem, transaction, identity, etc., or `None`
- **Sizing rationale**: why the slice fits, or why exceeding a warning threshold is atomic
- **Cohesion rationale**: why these requirements must land together
- **Not included**: adjacent requirements owned by other tickets or deliberately excluded from this slice
- **Open uncertainty**: unresolved evidence affecting ownership, size, cohesion, or blocking, or `None`
- **Executor**: agent or human
- **Readiness rationale**: why that executor can complete the ticket safely

For an enabling-refactor ticket, show **Enables**, **Supports**, and **Behavioral change** instead of claiming source requirement ownership.

When recommending a large ticket or one that exceeds a sizing warning, show at least one plausible further split and explain why the combined form remains safer or more coherent.

After the tickets, show a coverage summary containing:

- Requirements owned by tickets
- Requirements already satisfied, with evidence
- Requirements deferred or out of scope with user approval
- Unaccounted requirements, which must be `None` before publishing
- Duplicate owners, which must be `None` before publishing

Ask the user to approve the recommended breakdown and answer only material open questions. Explicitly call out:

- Tickets whose ownership remains uncertain
- Blocking edges that depend on an unproven contract
- Large tickets retained as atomic
- Requirements classified as already satisfied
- Requirements proposed for deferral

Do not ask the user to infer these concerns from the ticket list. Ask: `Do you approve this breakdown and its requirement ownership? The material decisions requiring attention are: <list, or None>.`

Iterate until the user approves the breakdown and every uncertainty affecting ownership or blocking is resolved.

### 6. Publish the tickets to the configured tracker

Publish the approved tickets. **How** depends on the tracker `/setup-project-skills` configured — the tickets are the same either way, only the shape of the blocking edges changes:

- **Local files** → write one file per ticket under `.scratch/<feature-slug>/issues/<NN>-<slug>.md`, numbered from `01` in dependency order (blockers first). Each file's "Blocked by" lists the numbers/titles it depends on. Use the per-ticket file template below — one ticket per file, never a single combined file.
- **A real issue tracker (GitHub, Linear, …)** → publish one issue per ticket in dependency order (blockers first) so each ticket's blocking edges can reference real identifiers. Use the platform's native blocking / sub-issue relationship where it has one (e.g. GitHub's blocked-by relationship); otherwise set each ticket's "Blocked by" to the blocking issues. Apply exactly one category role and one state role. Inherit `bug` or `enhancement` from a tracked parent; without one, classify from the approved source. Apply `ready-for-agent` or `ready-for-human` according to the approved executor classification.

For a tracked parent spec, record each child and its requirement ownership as it publishes. Prefer native parent/sub-issue relationships; otherwise maintain one concise parent record. Remove `ready-for-tickets` only after the complete decomposition is recorded. Keep `spec` and leave the parent open until `/implement-ticket` verifies every child delivered.

Work the **frontier**: any ticket whose blockers are all done. A claim, open linked change request, or open blocker removes a ticket from the available frontier. For a purely linear chain that means top to bottom.

<local-ticket-template>

# <NN> — <Ticket title>

**Source:** the durable source reference, or `Current conversation (temporary planning identifiers)`.

**Delivers:** the stable source requirement identifiers, or temporary `SRC-*` identifiers, owned by this ticket.

**Constrained by:** relevant source decision and out-of-scope identifiers, or "None".

**What to build:** the end-to-end behaviour this ticket makes work, from the user's perspective — not a layer-by-layer implementation list.

**Not included:** adjacent requirements owned by sibling tickets, or "None".

**Blocked by:** the numbers/titles of the tickets that gate this one, or "None — can start immediately".

**Executor:** agent or human.

**Readiness rationale:** why that executor can complete the ticket safely.

**Status:** ready-for-agent or ready-for-human.

**Category:** bug or enhancement.

- [ ] Acceptance criterion 1
- [ ] Acceptance criterion 2

</local-ticket-template>

<issue-template>

## Parent

A reference to the parent issue on the tracker (if the source was an existing issue, otherwise omit this section).

## Source

- **Spec or plan:** a reference to the durable source, or `Current conversation (temporary planning identifiers)`
- **Delivers:** the stable source requirement identifiers, or temporary `SRC-*` identifiers, owned by this ticket
- **Constrained by:** relevant source decision and out-of-scope identifiers, or "None"

## What to build

The end-to-end behaviour this ticket makes work, from the user's perspective — not layer-by-layer implementation.

## Not included

Adjacent requirements owned by sibling tickets, or "None".

## Execution

- **Executor:** agent or human
- **Readiness rationale:** why that executor can complete the ticket safely

## Acceptance criteria

- [ ] Criterion 1
- [ ] Criterion 2

## Blocked by

- A reference to each blocking ticket, or "None — can start immediately".

</issue-template>

In either form, avoid specific file paths or code snippets — they go stale fast. Exception: if a prototype produced a snippet that encodes a decision more precisely than prose can (state machine, reducer, schema, type shape), inline it and note briefly that it came from a prototype. Trim to the decision-rich parts — not a working demo, just the important bits.

Reference source identifiers instead of copying their canonical prose into each ticket. The ticket's own acceptance criteria should contain only the narrower, verifiable behavior introduced by that slice.

For an enabling-refactor ticket, set `Delivers` to `None — enabling refactor` and add its **Enables**, **Supports**, and **Behavioral change** fields.

This skill stops after publishing the approved tickets. Do not implement them in this session.

Implement each dependency-frontier ticket in a fresh session with `/implement-ticket`. Each ticket is intended to produce its own reviewed branch and PR unless the approved breakdown explicitly identifies a shared integration branch. After a ticket PR merges, start a fresh session for the next available frontier ticket.
