---
name: pr-merge-review
description: >
  Merge-facing review of an open GitHub pull request along two axes —
  Integration (design fit, cross-module correctness, test strategy, maintainability)
  and Production (system security, migrations, compatibility, observability, rollback).
  Runs both axes as parallel sub-agents, then posts one GitHub PR review with
  overview plus line-level comments. Use when a PR is open, before merge, or when
  the user asks for a PR review / merge review (/pr-merge-review). Not for local
  uncommitted or pre-PR work — use local-diff-review.
---

# PR Merge Review

Merge gate for an open pull request. Assume CI owns green builds and
`local-diff-review` already covered plan fit and unit craft. This pass answers:

**Is this pull request Ready to merge into the shared product?**

This is a **read-only** task for the reviewer: do not edit files or fix issues —
only report (and post the review to GitHub).

Two axes run as **parallel sub-agents**; this skill aggregates and posts one
review. Do not re-rank findings across axes.

| Axis | Question |
| --- | --- |
| **Integration** | Does this fit the system — design, cross-module correctness, tests-as-design, docs? |
| **Production** | Is it safe to ship — system security, data, migrations, rollback, observability? |

The issue tracker should have been provided to you — run `/setup-project-skills`
if `docs/agents/issue-tracker.md` is missing.

Use the Review Findings Profile Context; stop if it is unavailable.

## Process

### 1. Resolve the PR

Target: the GitHub PR the user named. If none, list recent open PRs and confirm.

Gather context with `gh` only (local working tree is **out of scope** unless the
checkout matches the PR head and you need surrounding file context via Read):

```bash
gh pr view <n> --json number,title,body,author,baseRefName,headRefName,state,additions,deletions,changedFiles,labels,url,headRefOid
gh pr diff <n>
gh pr view <n> --comments   # optional; prior discussion
```

Fail early if the PR is closed/merged without the user asking for a historical
read, or if the diff is empty.

### 2. Light scope check (parent only — not a full Spec axis)

Do **not** re-run a full local Spec review. In the parent agent only:

1. Note linked issues from PR body / branch (`Closes #123`, etc.).
2. If useful, fetch the issue once for context.
3. Flag **scope drift** only: PR body claims X but diff does Y; issue asks for
   Z but PR never mentions it. Put scope drift in the overview, not as a third
   competing axis.

Full plan alignment is `local-diff-review`'s job.

### 3. Load axis references

Sub-agents have no shared context. Paste the full Review Findings context into
both; paste [references/integration-checklist.md](references/integration-checklist.md)
or [references/production-checklist.md](references/production-checklist.md) into
its axis. Point Integration at `AGENTS.md` / `Agents.md`, `CONTEXT.md`,
`docs/ARCHITECTURE.md`, and relevant ADRs when present.

### 4. Spawn both sub-agents in parallel

Send a single message with two general-purpose sub-agent dispatches
(isolated context; pass the PR number, title, body summary, and full `gh pr diff`
or instruct them to run the exact `gh` commands).

**Integration sub-agent prompt** — include:

- PR number, title, base/head, file stats
- How to fetch the diff (`gh pr diff <n>`) and that **only the PR diff** is in scope
- The full Review Findings context and Integration checklist (pasted)
- Paths of architecture/context docs if any
- The brief:

  > You are a **merge-gate Integration** reviewer. CI owns suite green; local
  > review owns plan fit and unit craft. Focus on design/fit with surrounding
  > system, cross-module consistency, complexity and over-engineering, test
  > *strategy* (would these tests catch the failure?), maintainability, and
  > load-bearing docs/ADR/CONTEXT updates.
  >
  > Apply the supplied Review Findings context exactly. Give every finding a
  > stable `INT-<n>` ID. For each: classification, path
  > and line in the PR diff when one exists, what's wrong, why it matters for
  > merge, and a suggested fix. Skip format/lint and pure unit nits. Under 500
  > words. Strengths first.

**Production sub-agent prompt** — include:

- Same PR identity and diff access
- The full Review Findings context and Production checklist (pasted)
- The brief:

  > You are a **merge-gate Production** reviewer. Focus on system-level security
  > (authz, new attack surface, data exposure, trust boundaries, deps),
  > migrations and expand/contract, backward compatibility, rollback, and
  > observability for new failure modes. Light scope honesty only (PR body vs
  > diff). Apply the supplied Review Findings context exactly. Give every
  > finding a stable `PROD-<n>` ID and include path:line
  > where possible. Do not re-do unit correctness or full Spec review. Under
  > 500 words. Strengths first.

### 5. Aggregate (do not re-rank across axes)

Build:

1. **Overview** — what the PR does (2–4 sentences), light scope-drift note if any
2. **## Integration** — findings (or "no issues")
3. **## Production** — findings (or "no issues")
4. **Verdict**

### Verdict

Use the Review Findings Context's change-request verdict and event. If that
event is unavailable, Comment with the explicit verdict.

One-line summary: finding counts per axis, worst issue *within each axis*.

### 6. Post to GitHub

`gh pr review` only supports a single summary body — it does **not** create
file/line inline comments. Use the Reviews API:

1. Resolve head commit and repo:

```bash
gh pr view <n> --json headRefOid,url -q '{headRefOid,url}'
```

2. Create one review containing every finding ID, with inline comments where a
diff line exists:

```bash
# VERDICT_EVENT is REQUEST_CHANGES, COMMENT, or APPROVE.
# OWNER/REPO comes from the checkout; COMMIT is headRefOid.
gh api --method POST "repos/{OWNER}/{REPO}/pulls/<n>/reviews" \
  --input - <<'EOF'
{
  "commit_id": "COMMIT",
  "event": "VERDICT_EVENT",
  "body": "Overview + ## Integration summary + ## Production summary + Verdict",
  "comments": [
    {
      "path": "path/to/file.ts",
      "line": 42,
      "side": "RIGHT",
      "body": "**[INT-1 · Integration · Blocker]** …\n\nSuggestion: …"
    }
  ]
}
EOF
```

Rules:

- `"side": "RIGHT"` for lines on the PR head
- `line` must appear in the diff (or use `start_line` / `line` for a range)
- Prefer **one** review with many `comments` over many POSTs
- Put every finding and ID in the review body; add an inline comment when possible
- Findings without a diff line are **body-only**; do not invent lines
- Tag ID, axis, and class: `[INT-1 · Integration · Blocker]`, `[PROD-1 · Production · Nit]`
- `/resolve-pr-review` answers inline findings in-thread and body-only findings in a PR comment
- If you want it fixed, use Should-fix, not Nit.

Also print the same overview and verdict in the local conversation so the user
sees it without opening GitHub.

## Why this is not a local review

| Local (`local-diff-review`) | This skill |
| --- | --- |
| Working tree + branch vs fixed point | Open PR diff via `gh` only |
| Spec + Craft | Integration + Production |
| Ready to open a PR? | Ready to merge? |
| Author iteration | Shared ownership + GitHub record |

Re-checking format, suite green, or full Spec here wastes budget and still
misses system risk. Shift those left; spend PR attention on merge altitude.

## Red flags

**Never:**

- Edit the branch to "fix" findings as part of this skill
- Review local uncommitted files as if they were the PR
- Block merge on personal style preferences
- Rubber-stamp without reading the Integration and Production surfaces
- Invent line numbers for the Reviews API

**Do:**

- Keep axes separate in the posted overview
- Assume CI green; dig into test *design* not test *exit code*
- Call out strengths when the design or ship story is solid
- Prefer continuous improvement over perfection — Blockers only for real
  code-health or production risk (Google-style standard of code review)
