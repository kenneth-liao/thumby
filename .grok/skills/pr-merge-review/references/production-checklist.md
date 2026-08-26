# Production checklist (PR / merge gate)

Use only for the **Production** axis of a PR merge review. This is a
merge-facing gate: is it safe and healthy to land this in the shared product?

## Own (must check)

### System-level security
- AuthN/AuthZ model changes; privilege escalation paths
- New public surface (endpoints, parsers, webhooks, deserializers) without
  appropriate auth, validation, rate limits, or audit signals
- Data exposure: what is stored, logged, returned to clients, or sent off-box
- Trust-boundary crossings (client→server, service→service, worker→DB)
- Secure defaults for new config; fail closed where appropriate
- Dependency / lockfile changes that expand supply-chain risk

### Ship readiness
- Schema/data migrations: expand→contract, idempotency, staging-before-prod
- Backward compatibility and dual-write / dual-read windows if needed
- Rollback story (feature flag, revert safety, forward-fix migration?)
- Observability for new failure modes (logs, metrics, alerts — not noise)
- Config / env / deploy surface called out for operators

### Scope honesty (light)
- PR title/body match the actual diff
- Linked issue/PRD still the right contract; flag scope drift only
  (do not re-litigate full Spec — local review owns that)

## Defer (not this review's job)

| Concern | Owner |
| --- | --- |
| Format / lint / types / suite green | CI (assume green; only dig if red/flaky) |
| Plan/requirements line-by-line | Local diff review (flag scope drift only) |
| Unit-level logic bugs CI/tests should catch | Local + CI; note process gap if found |
| Style nits and personal preference | Nit. Never a Blocker or Should-fix. |
| Mentoring asides unrelated to merge risk | Optional, non-blocking |
