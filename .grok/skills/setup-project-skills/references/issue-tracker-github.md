# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues. Use the best available GitHub interface in the current harness; use the `gh` CLI commands below as the portable fallback. Run commands inside the correct clone so the remote identifies the repository.

## Conventions

- **Create an issue:** `gh issue create --title "..." --body-file -`
- **Read an issue:** `gh issue view <number> --comments`, also fetching labels, assignees, state, and relationships as needed
- **List issues:** `gh issue list --state open --json number,title,body,labels,assignees,comments` with appropriate filters
- **Comment:** `gh issue comment <number> --body-file -`
- **Apply/remove labels:** `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close:** post any Markdown explanation first, then `gh issue close <number>`

Use quoted heredocs or `--body-file` for Markdown and multiline content so the shell cannot expand it.

## Claiming implementation work

Assignment shows other GitHub users and agents that the issue is claimed. On your machine, `/implement-ticket` always uses the same branch and worktree for an issue, so another local run will find the existing work instead of starting a duplicate.

- **Check:** read issue state and assignees; also inspect linked open PRs before treating it as available
- **Claim:** `gh issue edit <number> --add-assignee @me`
- **Release an abandoned claim:** `gh issue edit <number> --remove-assignee @me`
- **Active-work signals:** an assignee, an open linked PR, or the ticket's deterministic branch/worktree

Assignment is cooperative, not a distributed lock. Never start duplicate work merely because the current account is also the existing assignee; inspect the branch/PR and require an explicit resume or handoff.

## Pull requests

- **Create:** open a PR from the deterministic ticket branch that is ready for review
- **Read:** `gh pr view <number> --comments` and `gh pr diff <number>`
- **Close a ticket on merge:** put `Closes #<number>` (or another GitHub closing keyword) in the PR body

## Pull requests as a triage surface

**PRs as a request surface: no.** Set to `yes` only when external PRs should enter `/triage` as requests with attached code.

When enabled, discovery includes external contributors' PRs, not collaborators' ordinary in-flight work. A bare `#42` may be an issue or PR; resolve it before acting.

## Relationships and blockers

Use GitHub's native sub-issue and issue-dependency relationships when available. Otherwise record durable `Parent:` and `Blocked by:` references in issue bodies/comments. A ticket is on the implementation frontier only when it is open, ready, unblocked, unassigned, and has no active linked PR.

## Skill vocabulary

- **Publish to the issue tracker:** create a GitHub issue
- **Fetch the relevant ticket:** read the full issue body, comments, labels, assignees, state, parent/children, blockers, and linked PRs
