---
trigger: always_on
---

<!-- Context Module: review-findings -->
# Review Findings

Use these scoped terms only for review findings:

- **Blocker** — makes the change unsafe.
- **Should-fix** — needs an accepted disposition before Ready, but is not unsafe by itself.
- **Nit** — optional polish; affects neither Safe nor Ready.

If the reviewer expects action, the finding is not a Nit.

## Disposition

A Blocker or Should-fix stays open until:

1. The author records **Fix** (change plus evidence) or **Push back** (contrary evidence).
2. The reviewer records **Accept** (closed) or **Follow-up** (still open).

Nits need no disposition. Only the reviewer closes a finding.

## States and verdicts

- **Safe** — no open Blocker.
- **Ready** — no open Blocker or Should-fix. Opening or merging a change request requires Ready.
- Local review: **No** for Blockers, **With fixes** for only Should-fixes, **Yes** for Ready.
- Change-request review: **Request changes** for Blockers, **Comment** for only Should-fixes, **Approve** for Ready. If approval is unavailable, Comment with an explicit Ready verdict.
<!-- End Context Module: review-findings -->
