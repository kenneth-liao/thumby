---
name: implement-ticket
description: Implement one dependency-frontier ticket from the configured issue tracker. Use when the user wants to execute a specific implementation ticket or resume its existing work.
---

# Implement Ticket

Implement one ticket from the configured issue tracker. Invocation authorizes the workflow through opening a change request. Ask once for plan alignment; do not ask for routine permission after that.

The issue tracker, claim operations, and triage vocabulary should have been provided in `docs/agents/` — run `/setup-project-skills` if not.

## Process

### 1. Gather and validate the ticket

Work from the conversation context. If the user passes a ticket reference, fetch its full body, comments, relationships, labels, assignees, and linked change requests using `docs/agents/issue-tracker.md`. Read `docs/agents/triage-labels.md` for role meanings, including what counts as a human-owned step.

Before planning, stop unless:

- The item is not marked `spec` and has one category role plus `ready-for-agent` or `ready-for-human`.
- Every blocker is closed with tracker-appropriate delivery evidence. A readiness label on a closed blocker is not evidence.
- No open change request, tracker claim, deterministic branch, or worktree already represents this ticket. Resume only when explicitly asked, after inspecting that work.

On `ready-for-human`, lead every agent-executable step. Request the human action only at the step named in the ticket's readiness rationale; never cross it.

### 2. Size and risk

Stop and propose a concrete split before changing code when the ticket has eight or more substantive criteria, independently demonstrable outcomes, or multiple high-risk boundaries. If the user approves a split, publish the child tickets and continue with one unblocked child.

Classify risk before choosing how to execute. Filesystem, security, identity, transaction, migration, concurrency, and compatibility boundaries need a stronger implementer and systematic boundary verification. State the selected model/effort and why; if no separate implementer is available, say the current agent will implement it.

### 3. Explore and plan

Explore enough to understand current behavior, public seams, and whether any criterion is already satisfied. Draft a compact plan: user-visible behaviors to test, the seams that verify them, how each acceptance criterion is satisfied, plus material assumptions, non-goals, and risk boundaries.

Surface unexpected requirements or architecture decisions. Ask once whether the plan and dependency assumptions are correct. That approved plan is the `/tdd` confirmation — do not open a second planning gate. After approval, proceed autonomously through implementation, review, commit, push, and opening the change request.

### 4. Claim

Claim after plan approval, immediately before implementation.

Inspect `git worktree list`, local and remote branches, and linked change requests. On any existing worktree, branch, assignee, or open change request, follow [references/claim-conflicts.md](references/claim-conflicts.md).

Otherwise create one deterministic branch from the ticket identifier and a short slug (`issue/123-add-output-options`) in an in-repo worktree at `.worktrees/<branch>` as a single Git operation. After that succeeds, apply the configured tracker claim.

### 5. Implement, review, open

Implement in the claimed worktree with `/tdd` at the approved seams, one red-green tracer bullet at a time. Run focused tests and typechecking during implementation. Run the full required suite once after the implementation is complete.

Run `/local-diff-review` against the intended base and reach Ready before opening the change request. For high-risk boundaries, verify the complete invariant/threat set in that pass.

Commit and push the issue branch. Open a pull or merge request that is **ready for review**. When merge should close the ticket, use the platform's native closing relationship (for example, `Closes #123` on GitHub).

Only after the change request exists: update the ticket with a concise implementation and verification summary, link the change request, and check off satisfied acceptance criteria.

### 6. Summarize and close out

Report the change-request link, selected model/effort, verification evidence, version/changelog changes when applicable, unresolved risks, and any human-owned next step. Offer cleanup after merge.

When the user confirms merge:

1. Verify the change request merged and the leaf ticket closed. Together they are the delivery evidence.
2. Perform the approved cleanup from the project's worktree hygiene: stop runtimes, `git worktree remove`, prune, delete the merged local branch, and verify remote-branch cleanup. Release any tracker claim that should not remain on a closed item.
3. If the ticket belongs to a tracked parent spec, inspect every recorded child and the approved requirement-ownership map. When every child is closed with delivery evidence, no source requirement remains deferred or unfinished, and required human qualification has passed, post a concise delivery summary and close the parent. Otherwise leave the parent open and report the next unblocked, unclaimed frontier tickets.
