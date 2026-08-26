# Triage Labels

This file defines the canonical tracker roles and maps them to this tracker's strings.

## Category roles

| Canonical role | Label in our tracker | Meaning                    |
| -------------- | -------------------- | -------------------------- |
| `bug`          | `bug`                | Something is broken        |
| `enhancement`  | `enhancement`        | New feature or improvement |

## Artifact marker

| Canonical role | Label in our tracker | Meaning              |
| -------------- | -------------------- | -------------------- |
| `spec`         | `spec`               | Specification        |

The `spec` marker is authoritative. A `[SPEC]` title prefix is a display aid only.

## Readiness and disposition roles

| Canonical role      | Label in our tracker | Meaning                                     |
| ------------------- | -------------------- | ------------------------------------------- |
| `needs-triage`      | `needs-triage`       | Maintainer needs to evaluate this request   |
| `needs-info`        | `needs-info`         | Waiting on the reporter                     |
| `ready-for-tickets` | `ready-for-tickets`  | Settled spec awaiting decomposition         |
| `ready-for-agent`   | `ready-for-agent`    | Executable ticket an agent can complete     |
| `ready-for-human`   | `ready-for-human`    | Executable ticket requiring a human step    |
| `wontfix`           | `wontfix`            | Request will not be actioned                 |

Every triaged item has one category role. Every open actionable item has one readiness/disposition role. After decomposition, a parent keeps `spec` and its category but has no readiness role; its children carry the next actions.

- Active ownership is the configured tracker claim plus the deterministic Git branch/worktree and any open change request.
- Delivery is a merged change request and a closed tracker item.

Use `ready-for-agent` only when an agent can finish the work from repository and tracker context with ordinary authorized tools.

Use `ready-for-human` when completion inherently requires at least one of:

- Personal authentication
- Subjective visual or experiential qualification
- Privileged or irreversible production access
- Legal, compliance, or security approval
- A decision that cannot be reduced to approved acceptance criteria

A ticket that mixes agent-executable preparation with a human-only action should be split when each part can be verified independently. The human ticket depends on the agent preparation ticket. Record the specific human step on the ticket as its readiness rationale.

When a skill mentions a canonical role, use the corresponding tracker string from this table. Edit the right-hand column to match the repository's vocabulary.
