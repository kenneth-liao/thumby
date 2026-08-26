---
name: setup-project-skills
description: Configure a repo for the engineering skills by recording its issue
  tracker, triage-role mapping, claim workflow, and domain-doc layout. Run once
  before first use of the other engineering skills or whenever they lack project
  workflow context.
metadata:
  agent-profile-kit.model-invocation: disabled
# Agent Profile Kit: keep Skill invocation explicit.
disable-model-invocation: true
---

# Setup Project Skills

Scaffold the per-repo configuration that the engineering skills assume:

- **Issue tracker** — where specs and tickets live
- **Triage labels** — category, `spec`, and readiness/disposition strings
- **Claiming work** — how active ownership is made visible, when the tracker supports it
- **Domain docs** — where `CONTEXT.md` and ADRs live

This is a prompt-driven skill. Explore, recommend, confirm, then write; do not guess silently.

## 1. Explore

Read whatever exists:

- `git remote -v` and `.git/config`
- Root `AGENTS.md` and `CLAUDE.md`, including any existing `## Agent skills` section
- Root `CONTEXT.md` and `CONTEXT-MAP.md`
- `docs/adr/` and context-scoped ADR directories
- Existing `docs/agents/`
- `.scratch/` as a local-markdown tracker signal
- Monorepo signals such as `pnpm-workspace.yaml`, a `workspaces` manifest field, or populated packages with independent source trees

## 2. Present findings and ask

Summarize what is present and missing. Take the sections in order, one answer at a time. Lead with the recommended choice so the user can accept it briefly. Skip questions exploration has already settled.

### Section A — Issue tracker

> The issue tracker is where specs and tickets live. Skills need to know whether to use a tracker integration/CLI or local Markdown.

Recommend the tracker implied by the remote or existing docs. Offer:

- **GitHub** — GitHub Issues; use the best available GitHub interface, with `gh` as the portable fallback
- **GitLab** — GitLab Issues; use `glab`
- **Local Markdown** — one spec and one file per ticket under `.scratch/<feature>/`
- **Other** — Jira, Linear, or another workflow described by the user

Record the result in `docs/agents/issue-tracker.md`. Tracker templates may include optional request-surface settings; keep their defaults unless the user already configured otherwise.

### Section B — Triage vocabulary

Ask exactly one initial question:

> Do you want to keep the default triage labels? (recommended: **yes**)

Defaults:

- Category: `bug`, `enhancement`
- Artifact: `spec`
- Readiness/disposition: `needs-triage`, `needs-info`, `ready-for-tickets`, `ready-for-agent`, `ready-for-human`, `wontfix`

Only collect overrides if the user says no. Role meanings, including the `ready-for-human` boundary, live in the triage-labels seed and are copied into `docs/agents/triage-labels.md`.

### Section C — Domain docs

Default to **single-context** (`CONTEXT.md` and `docs/adr/` at the root) without asking. Offer **multi-context** (`CONTEXT-MAP.md` plus per-context docs) only when exploration found genuine monorepo/context signals.

## 3. Confirm the draft

Show the user drafts of:

- The `## Agent skills` block for the existing root agent-instruction file
- `docs/agents/issue-tracker.md`, including claim/check/release operations when the tracker supports them
- `docs/agents/domain.md`
- `docs/agents/triage-labels.md`

Let the user edit the drafts before writing.

## 4. Write

Choose the root instruction file consistently:

- If `CLAUDE.md` exists, edit it.
- Else if `AGENTS.md` exists, edit it.
- If neither exists, ask which one to create.

Never create the other file when one already exists. Update an existing `## Agent skills` block in place without overwriting surrounding user content.

```markdown
## Agent skills

### Issue tracker

[Where specs and tickets are tracked, including the claim mechanism]. See `docs/agents/issue-tracker.md`.

### Triage labels

[One-line role mapping]. See `docs/agents/triage-labels.md`.

### Domain docs

[Single-context or multi-context summary]. See `docs/agents/domain.md`.
```

Use these relative seed templates:

- [references/issue-tracker-github.md](references/issue-tracker-github.md)
- [references/issue-tracker-gitlab.md](references/issue-tracker-gitlab.md)
- [references/issue-tracker-local.md](references/issue-tracker-local.md)
- [references/triage-labels.md](references/triage-labels.md)
- [references/domain.md](references/domain.md)

For another tracker, write `docs/agents/issue-tracker.md` from the user's description. Include operations for reading, publishing, relationships/blockers, and—when available—checking, claiming, and releasing active ownership. Do not invent a distributed lock when the tracker has no claim primitive; state that the deterministic Git branch/worktree supplies local exclusion.

For trackers with managed labels, ensure the mapped labels exist.

## 5. Done

Report which files changed and which engineering skills consume them. The user can edit `docs/agents/*.md` directly later; rerun setup only to switch workflows or start over.
