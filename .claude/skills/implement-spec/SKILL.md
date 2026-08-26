---
name: implement-spec
description: Use when the user wants a spec delivered, or to resume that work.
---

# Implement Spec

Orchestrate delivery of one tracked spec. This agent stands in for the user — approve plans, splits, and review judgment; do not write product code. Dispatch isolated workers through the configured agent orchestration mechanism for implementation, review, and close-out.

Invocation authorizes the workflow through merge of every child. Escalate only for an irreducible human step.

The issue tracker and triage vocabulary should have been provided in `docs/agents/` — run `/setup-project-skills` if not.

## 1. Preconditions and bindings

Fetch the spec, its children, labels, and linked change requests. Stop unless the item is marked `spec` and children are already published. If it is still `ready-for-tickets`, tell the user to run `/to-tickets`.

Before any worker is dispatched, select the configured orchestration mechanism and bind four roles. Each role binding identifies a model and thinking/effort level. Use preferences from loaded local context or the invocation, verify that they are available through the selected mechanism, and ask for any missing, invalid, or ambiguous selection. Never guess a mechanism, model, or provider. If no configured mechanism can start an isolated worker, exchange follow-up prompts, and return its result, stop and explain the missing capability.

| Role | Runs |
| --- | --- |
| implementer | `/implement-ticket`, `/resolve-pr-review`, merge and clean up |
| reviewer | `/pr-merge-review`, `/re-review` |
| closer | spec acceptance audit against `main` |
| upgrade | replaces the implementer once, if that worker cannot land review |

Use these bindings for every ticket. Where the mechanism supports names or labels, label the orchestrator `orchestrator-<spec>` and use stable worker slugs: `implementer-<ticket>`, `reviewer-<ticket>`, `upgrade-<ticket>`, and `closer-<spec>`.

Inspect children, linked change requests, and reviews. Resume at the first unfinished step of the first unfinished ticket; recreate only the missing role. The tracker and change request, not worker transcripts, are authoritative, so a role may resume in a fresh isolated context.

## 2. Pick the next ticket

Work one ticket at a time unless the user asked to parallelize.

Recompute the dependency frontier after every merge:

1. Unblocked `ready-for-agent` tickets with no tracker claim and no open change request.
2. If none remain, unblocked `ready-for-human` tickets.

On `ready-for-human`, run the implementer through every agent-executable step and stop at the step named in the readiness rationale. Notify and wait. After the user confirms that step, continue with the implementer role.

## 3. Drive one ticket

Start each role as an isolated worker in the project working directory. Release workers created for one ticket before starting the next ticket unless the configured mechanism manages their lifecycle automatically.

**Implement.** Start the implementer and prompt `/implement-ticket <ticket>`. When it presents a plan or split, judge it and reply. After it settles, require an open ready-for-review change request linked to the ticket.

**Review.** Start the reviewer. Prompt `/pr-merge-review <pr>`.

**Resolve loop.** Apply the Review Findings Profile Context to every finding ID in the review body, threads, and change-request comments.

- Any open Blocker or Should-fix → implementer `/resolve-pr-review` → reviewer `/re-review`. That is one cycle.
- Repeat until Ready.
- Cap is 3. At the cap, if the loop is still fixing distinct issues and the extra cap has not been used, grant one more cap of 3.
- If the implementer cannot land Ready (deadlock, the same Blocker returning, or the extra cap is exhausted), release it and start the upgrade role once. That worker takes `/resolve-pr-review` through merge.
- If the upgrade worker cannot get Ready, escalate.

**Merge.** On Ready, tell the current implementer or upgrade worker to merge and clean up. Verify the change request merged and the leaf ticket closed. Notify.

Check threads and body-only finding IDs directly. If an artifact is missing after a worker settles, inspect its result: answer what this orchestrator can, retry a stalled prompt, or escalate only for a human-only step.

## 4. Close the spec

When every child is closed with delivery evidence, start the closer in a fresh isolated context. Prompt it to verify every spec acceptance criterion against `main`, then close the spec if it is still open, or list outstanding items and reopen it if it was closed incorrectly. Notify when the audit finishes. Do not wait for the user.

## Human steps and notifications

A human step is one named on a `ready-for-human` ticket, or an irreducible action from `docs/agents/triage-labels.md`: personal authentication, subjective visual or experiential qualification, privileged or irreversible production access, legal, compliance, or security approval, or a decision that cannot be reduced to acceptance criteria. Notify and wait. Do not guess secrets, log in, or touch production.

Notify the user when waiting on a human step, when swapping in the upgrade worker, when a ticket merges, when the spec audit finishes, and when escalating. Also use the configured orchestration mechanism's notification capability when one is available.
