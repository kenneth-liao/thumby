---
name: re-review
description: Perform a follow-up review after fixes have been pushed to address issues raised in a previous review. Use whenever an initial review has already ran and you need a re-review.
---

Use the Review Findings Profile Context; stop if unavailable. Collect every finding ID from the review body, threads, disposition comments, and diff since review.

Verify each Blocker and Should-fix: a Fix is complete without regression; Push-back evidence holds. Reply Accept or Follow-up under the same ID. Resolve an inline thread only after Accept; record body-only results in the summary or a PR comment. Use `RE-<n>` only for a new finding.

Nits are optional. Post Ready only when every Blocker and Should-fix is accepted; otherwise post Not Ready with every open ID.
