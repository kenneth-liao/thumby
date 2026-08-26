---
name: resolve-pr-review
description: Resolve a PR review by addressing all issues raised, posting replies, and pushing fixes to update the PR for re-review. Use after a PR review has posted.
---

A PR requires review. If the user does not identify it, follow `docs/agents/issue-tracker.md` to find the most recent open pull or merge request. If more than one request could be the right one, ask the user which one to use.

Use the Review Findings Profile Context; stop if unavailable. Collect every finding ID from the review body, inline threads, and later PR comments.

Fix or Push back on every Blocker and Should-fix; Nits are optional. Follow project practices in the existing branch/worktree. Run focused verification per Fix, then the required final verification once.

Reply with ID, disposition, and evidence in the inline thread or, for a body-only finding, a PR comment. Do not resolve threads. Push, then report ready for `/re-review`; only the reviewer can declare Ready.
