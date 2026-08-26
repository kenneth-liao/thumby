---
name: local-diff-review
description: Author-facing pre-PR review of local changes. Use when completing a unit of work, before opening a PR, before committing, reviewing work-in-progress, or when the user asks for a local/diff/pre-PR review. Not for reviewing an open GitHub PR — use /pr-merge-review.
---

# Local Diff Review

Pre-PR quality gate for the author's machine. Catch defects while context is
hot, before they cascade into a PR or more work.

**Verdict this skill owns:** Ready to open a PR?
**Verdict this skill does not own:** Ready to merge? (that is `pr-merge-review`)

Two axes run as **parallel sub-agents** so they do not pollute each other's
context; this skill aggregates without re-ranking across axes.

| Axis | Question |
| --- | --- |
| **Spec** | Does the diff faithfully implement the originating issue / PRD / plan? |
| **Craft** | Is the implementation correct, tested, line-secure, and within standards? |

A change can pass one and fail the other — report them separately so one cannot
mask the other.

The issue tracker should have been provided to you — run `/setup-project-skills`
if `docs/agents/issue-tracker.md` is missing.

Use the Review Findings Profile Context; stop if it is unavailable.

## Process

### 1. Pin the fixed point

Whatever the user said is the fixed point — a commit SHA, branch name, tag,
`main`, `origin/main`, `HEAD~5`, etc.

If they did not specify one:

1. Prefer `origin/main` if it exists, else `main` / `master`.
2. State the choice and proceed unless the ref is ambiguous.

Resolve and fail early:

```bash
git rev-parse --verify <fixed-point>
MERGE_BASE=$(git merge-base <fixed-point> HEAD)
```

A bad ref fails here — not inside two parallel sub-agents.

### 2. Capture the review surface

Local review is **what would land if they committed and opened a PR now** —
committed branch commits **plus** uncommitted working-tree changes.

```bash
git status --short
git log --oneline "$MERGE_BASE"..HEAD
git diff --stat "$MERGE_BASE"          # tracked working tree vs merge-base
git diff "$MERGE_BASE"
git ls-files --others --exclude-standard
```

Include every listed untracked file in the review surface and size estimate;
identify binary files without inventing text.

If the user asks for **committed branch only**, use three-dot instead:

```bash
git diff --stat <fixed-point>...HEAD
git diff <fixed-point>...HEAD
git log --oneline <fixed-point>..HEAD
```

**Empty surface → stop.** Only stop when the commit list, tracked diff, and
untracked-file list are all empty. Report that there is nothing to review and
exit. Do not spawn sub-agents.

Note rough size. If the diff is huge (rule of thumb: well over ~400 changed
lines), say so and offer to review a tighter range or split — do not silently
skim.

### 3. Identify the Spec source

Look for the originating spec, in this order:

1. Issue references in commit messages or branch name (`#123`, `Closes #45`,
   GitLab `!67`, etc.) — fetch via `docs/agents/issue-tracker.md`.
2. A path the user passed as an argument (plan file, PRD path).
3. A PRD/spec/plan under `docs/`, `specs/`, `.scratch/`, or the conversation
   plan matching the branch or feature.
4. If nothing is found, ask the user where the spec is. If they say there isn't
   one, the **Spec** sub-agent is skipped and the report notes
   `Spec: no spec available`.

### 4. Identify Craft sources

Collect anything that documents how code should be written in this repo, e.g.:

- `AGENTS.md` / `Agents.md` / `CLAUDE.md`
- `CONTRIBUTING.md`, `CODING_STANDARDS.md`
- `CONTEXT.md`, relevant `docs/adr/*`, `docs/ARCHITECTURE.md`
- Project test/docs conventions if they constrain code shape

Also load in full (paste into the Craft sub-agent prompt — it has no other access):

- The full Review Findings context from Profile Context
- [references/craft-checklist.md](references/craft-checklist.md)
- [references/smell-baseline.md](references/smell-baseline.md)

Rules for standards vs smells:

- **Repo overrides.** Documented repo standard wins over the smell baseline.
- **Smells are judgement calls.** Never hard-fail solely on a baseline smell.
- **Skip tooling.** Do not report format/lint/import issues CI or pre-commit enforce.

### 5. Spawn both sub-agents in parallel

Send a single message with two general-purpose sub-agent dispatches
(e.g. Agent tool / `spawn_subagent`, `subagent_type: general-purpose`).
Isolated context — pass everything they need in the prompt; do not rely on
your session history.

**Craft sub-agent prompt** — include:

- Fixed point, merge-base, and the exact diff commands from step 2
- Commit list (`git log`)
- Paths (or pasted excerpts) of standards sources from step 4
- The full Review Findings context, craft checklist, and smell baseline (pasted)
- The brief:

  > You are reviewing a **local pre-PR diff** (author gate), not a merge decision.
  > Report findings only for this surface. Apply the supplied Review Findings
  > context exactly. Give each finding a stable `CRAFT-<n>` ID. For each:
  > classification, file:line (or hunk), what's wrong, why it matters, and how
  > to fix it if not obvious.
  >
  > Cover: (a) correctness and edge cases in touched code; (b) tests — quality
  > and suite green if runnable; (c) line-level security (secrets, injection,
  > unsafe defaults, PII in logs); (d) documented standard violations — cite
  > file + rule; (e) baseline smells — name the smell, quote the hunk, mark as
  > judgement. Repo standards override smells. Skip tooling-enforced style.
  >
  > Do **not** review system architecture, rollout/rollback, or merge readiness.
  > Under 500 words. List strengths briefly first.

**Spec sub-agent prompt** — include:

- Same fixed point, diff commands, and commit list
- Path or fetched contents of the spec / issue / plan
- The full Review Findings context (pasted)
- The brief:

  > You are reviewing a **local pre-PR diff** for plan alignment only.
  > Report: (a) requirements the spec asked for that are missing or partial;
  > (b) behaviour in the diff that wasn't asked for (scope creep);
  > (c) requirements that look implemented but where the implementation looks
  > wrong. Quote the spec line (or issue criterion) for each finding. Apply the
  > supplied Review Findings context exactly and assign stable `SPEC-<n>` IDs.
  > Under 400 words.
  > Do not review style, architecture-at-large, or production rollout.

If the spec is missing, skip the Spec sub-agent.

Run the project test suite yourself (or instruct Craft to) when practical; if
tests cannot run, say so in the aggregate rather than inventing a pass.

### 6. Aggregate

Present reports under `## Spec` and `## Craft` headings, verbatim or lightly
cleaned. **Do not merge or re-rank findings across axes.**

Then:

### Verdict

Report **Ready to open PR?** with the Review Findings Context's local verdict.

One-line summary: finding counts per axis, and the worst issue *within each
axis* (if any). Do not pick a single winner across axes.

### Act on feedback (when you are also the implementer)

During implementation, Fix or Push back on every Blocker and Should-fix. Group
findings by axis and send each affected axis to one fresh follow-up sub-agent
with the findings, evidence, changed diff, and full Review Findings context.
Repeat to Ready; do not self-accept. Nits are optional.

If invoked as a pure review, report only — do not edit unless the user asks.

## Why two axes (and not a PR review)

- **Standards-clean but wrong feature** → Craft pass, Spec fail
- **Right feature but buggy / untested / insecure lines** → Spec pass, Craft fail

Local review optimizes for **fast author feedback**. Merge-facing concerns
(system design, production security, migrations, observability) belong in
`pr-merge-review` so this pass stays cheap and high-signal.

## Red flags

**Never:**

- Skip because "it's simple"
- Spawn sub-agents on an empty or unresolved range
- Mark nitpicks as Blocker
- Claim tests pass without running them (or explicitly saying they weren't run)
- Treat this verdict as merge approval

**Do:**

- Fail early on bad refs / empty diffs
- Keep axes separate
- Be specific (file:line, quoted criterion)
- Acknowledge strengths so the author trusts the rest
