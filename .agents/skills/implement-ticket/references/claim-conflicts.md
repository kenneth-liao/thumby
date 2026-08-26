# Claim conflicts

Read this only when a worktree, branch, assignee, or open change request already represents the ticket.

## Existing work

- A branch checked out in another worktree means another local session owns it: stop.
- An open linked change request means resume only when explicitly asked; otherwise stop.
- An existing branch with no worktree or change request may be abandoned: show the evidence and ask whether to resume or release it.
- An existing tracker assignee is active work unless the user explicitly confirms a handoff or resume.

A bare request to implement an already-active ticket is not permission to duplicate it.

## Failed or missing tracker claim

If tracker claiming fails after creating a new empty worktree, remove that worktree and branch so the local claim is released.

A tracker with no shared claim operation relies on the deterministic branch/worktree for local exclusion. That is cooperative coordination, not a distributed lock across unrelated clones.
