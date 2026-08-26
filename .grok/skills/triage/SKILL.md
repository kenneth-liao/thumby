---
name: triage
description: Triage issues through a state machine driven by triage roles. Use when user wants to create an issue, triage issues, review incoming bugs or feature requests, prepare issues for an AFK agent, or manage issue workflow.
---

# Triage

Move issues on the project issue tracker through a small state machine of triage roles.

## Reference docs

- [AGENT-BRIEF.md](AGENT-BRIEF.md) — how to write durable agent briefs
- [OUT-OF-SCOPE.md](OUT-OF-SCOPE.md) — how the `.out-of-scope/` knowledge base works

## Roles

Read `docs/agents/triage-labels.md` for role meanings, tracker strings, and what counts as a human-owned step — run `/setup-project-skills` if it is missing. If state roles conflict, flag it and ask the maintainer before doing anything else.

State transitions: an unlabeled issue normally goes to `needs-triage`. A settled spec gets `spec` + `ready-for-tickets`; successful decomposition removes its readiness role. An implementation ticket gets `ready-for-agent` or `ready-for-human`. `needs-info` returns to `needs-triage` after a reply; `wontfix` is terminal. Replace, never stack, readiness roles. Flag unusual transitions.

## Invocation

The maintainer invokes `/triage` and describes what they want in natural language. Interpret the request and act. Examples:

- "Show me anything that needs my attention"
- "Let's look at #42"
- "Move #42 to ready-for-agent"
- "What's ready for agents to pick up?"

## Show what needs attention

Query the issue tracker and present three buckets, oldest first:

1. **Unlabeled** — never triaged.
2. **`needs-triage`** — evaluation in progress.
3. **`needs-info` with reporter activity since the last triage notes** — needs re-evaluation.

Show counts and a one-line summary per issue. Let the maintainer pick.

When showing work agents can pick up, include only the true dependency frontier: open `ready-for-agent` tickets whose blockers are closed, with no tracker claim and no active linked change request.

## Triage a specific issue

1. **Gather context.** Read the full issue (body, comments, labels, reporter, dates). Parse prior triage notes so you don't re-ask resolved questions. Explore the codebase using the project's domain glossary and relevant ADRs. Run two checks against the codebase: (a) redundancy — search for an existing implementation of the requested behavior by domain concept (not just the request's wording), and report where you looked. If found, it's an already-implemented wontfix (step 5). (b) prior rejection — read .out-of-scope/*.md and surface any that resembles this request.

2. **Recommend.** Tell the maintainer your category and state recommendation with reasoning, plus a brief codebase summary—including whether the behavior already exists. Wait for direction.

3. **Verify the claim.** Before grilling, check that the report holds up. For a bug, reproduce it from the reporter's steps. For a PR, confirm the diff does what it claims — check it out, run the relevant tests or commands. Report what happened: confirmed (with code path), failed, or insufficient detail (a strong needs-info signal). A confirmed verification makes a much stronger agent brief.


4. **Grill (if needed).** If the request needs fleshing out, run the /grilling and /domain-modeling skills together — grill it into shape a round of questions at a time, sharpening domain terms and updating CONTEXT.md/ADRs inline as decisions land.

5. **Apply the outcome:**
   - `ready-for-tickets` — apply with `spec` to a settled specification awaiting `/to-tickets`.
   - `ready-for-agent` — post an agent brief comment ([AGENT-BRIEF.md](AGENT-BRIEF.md)).
   - `ready-for-human` — same structure as an agent brief, and record the specific human step from `docs/agents/triage-labels.md` as the readiness rationale.
   - `needs-info` — post triage notes (template below).
   - `wontfix` — close, with the record determined by the reason:
     - **Already implemented** — point to the existing behavior and where it was verified. Do **not** write to `.out-of-scope/`; that knowledge base records rejected enhancements, not built features.
     - **Rejected bug** — explain politely, then close.
     - **Rejected enhancement** — write to `.out-of-scope/`, link it from the closing comment, then close ([OUT-OF-SCOPE.md](OUT-OF-SCOPE.md)).
   - `needs-triage` — apply the role. Optional comment if there's partial progress.

## Quick state override

If the maintainer says "move #42 to ready-for-agent", trust them and replace the current state role directly. Confirm what you're about to do (role changes, comment, close), then act. Skip grilling. If moving to `ready-for-agent` without a grilling session, ask whether they want to write an agent brief.

## Needs-info template

```markdown
## Triage Notes

**What we've established so far:**

- point 1
- point 2

**What we still need from you (@reporter):**

- question 1
- question 2
```

Capture everything resolved during grilling under "established so far" so the work isn't lost. Questions must be specific and actionable, not "please provide more info".

## Resuming a previous session

If prior triage notes exist on the issue, read them, check whether the reporter has answered any outstanding questions, and present an updated picture before continuing. Don't re-ask resolved questions.
