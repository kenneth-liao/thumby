# Issue tracker: GitLab

Issues and specs for this repo live as GitLab issues. Use the [`glab`](https://gitlab.com/gitlab-org/cli) CLI inside the correct clone.

## Conventions

- **Create an issue:** `glab issue create --title "..." --description "..."`
- **Read an issue:** `glab issue view <number> --comments`; use `-F json` when machine-readable output is needed
- **List issues:** `glab issue list -F json` with appropriate filters
- **Comment:** `glab issue note <number> --message "..."`
- **Apply/remove labels:** `glab issue update <number> --label "..."` / `--unlabel "..."`
- **Close:** post any explanation with `glab issue note`, then `glab issue close <number>`

Use quoted heredocs or files for Markdown and multiline content so the shell cannot expand it.

## Claiming implementation work

Assignment is the tracker-visible claim; the deterministic issue branch/worktree used by `/implement-ticket` supplies local exclusion.

- **Check:** read issue state and assignees; also inspect linked open merge requests
- **Claim:** `glab issue update <number> --assignee @me`
- **Release an abandoned claim:** update the issue to remove the current assignee using the supported `glab`/GitLab API operation
- **Active-work signals:** an assignee, an open linked MR, or the ticket's deterministic branch/worktree

Assignment is cooperative, not a distributed lock. An existing assignee requires inspection and an explicit resume or handoff before continuing.

## Merge requests

GitLab calls pull requests merge requests. Use `glab mr create`, `glab mr view`, `glab mr diff`, and `glab mr note`. Open the MR from the deterministic ticket branch and use GitLab's closing relationship so merge closes the ticket.

## Merge requests as a triage surface

**MRs as a request surface: no.** Set to `yes` only when external MRs should enter `/triage` as requests with attached code.

## Relationships and blockers

Use GitLab's native issue relationships and blocking links when available. Otherwise record durable `Parent:` and `Blocked by:` references. A ticket is on the implementation frontier only when it is open, ready, unblocked, unassigned, and has no active linked MR.

## Skill vocabulary

- **Publish to the issue tracker:** create a GitLab issue
- **Fetch the relevant ticket:** read the full issue body, comments, labels, assignees, state, parent/children, blockers, and linked MRs
