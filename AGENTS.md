# AGENTS.md

## Agent skills

### Issue tracker

GitHub Issues via the best available GitHub interface (`gh` as portable fallback). Claim work with
`gh issue edit <number> --add-assignee @me`. See `docs/agents/issue-tracker.md`.

### Triage labels

Default roles mapped 1:1: category `bug`/`enhancement`, artifact `spec`, readiness/disposition
`needs-triage`, `needs-info`, `ready-for-tickets`, `ready-for-agent`, `ready-for-human`, `wontfix`.
See `docs/agents/triage-labels.md`.

### Domain docs

Single-context repo: `CONTEXT.md` and `docs/adr/` at the root. See `docs/agents/domain.md`.
