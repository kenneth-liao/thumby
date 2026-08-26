# Issue tracker: Local Markdown

Issues and specs for this repo live as Markdown files under `.scratch/`.

## Conventions

- One feature per directory: `.scratch/<feature-slug>/`
- The spec is `.scratch/<feature-slug>/spec.md`
- Implementation tickets are one file each at `.scratch/<feature-slug>/issues/<NN>-<slug>.md`, numbered in dependency order
- Category and readiness are recorded near the top of each file using the configured role strings
- Parent and blocker relationships are explicit references to the relevant files
- Comments and history append under `## Comments`
- Closing a ticket means recording delivery evidence and setting its tracker state to closed using the repository's documented local convention

## Claiming implementation work

This tracker has no shared assignment service. The deterministic issue branch/worktree created by `/implement-ticket` is the local claim.

- **Check:** inspect the ticket, `git worktree list`, local/remote branches, and any linked change request
- **Claim:** atomically create/check out the deterministic branch in `.worktrees/<branch>`
- **Release an abandoned claim:** remove the empty worktree and branch after confirming no durable work or change request needs preservation
- **Active-work signals:** the deterministic branch/worktree or an open linked change request

This prevents duplicate work among worktrees belonging to the same repository. It is not a distributed lock across unrelated clones; do not add a lock file or new lifecycle label unless the project explicitly configures one.

## Skill vocabulary

- **Publish to the issue tracker:** create the appropriate file under `.scratch/<feature-slug>/`
- **Fetch the relevant ticket:** read the referenced file plus its parent, blockers, comments, and sibling relationship records as needed
