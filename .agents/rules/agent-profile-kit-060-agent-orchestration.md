---
trigger: always_on
---

<!-- Context Module: agent-orchestration -->
# Agent Orchestration

Use Herdr only when the user explicitly requests it or the active workflow explicitly requests the "configured agent orchestration mechanism." This binding does not authorize delegation or add workflow steps.

Use host-native subagents when requested; never replace them with Herdr or add unrequested workers, roles, reviews, or audits.

## `/implement-spec` Herdr bindings

A role with more than one row lists tiered fallback options in priority order. Use the first; fall to the next only when that harness is unavailable or its usage limit is reached.

| Role | Priority | Kind | Model | Thinking/effort |
| --- | --- | --- | --- | --- |
| implementer | 1 | agy | `gemini-3.7-flash-high` | — |
| implementer | 2 | pi | `oc-sdk-go/glm-5.3-flash` | high |
| implementer | 3 | pi | `openai-codex/gpt-5.6-sol` | medium |
| implementer | 4 | claude | `opus` | medium |
| reviewer | 1 | claude | `opus` | medium |
| reviewer | 2 | pi | `xai/grok-4.6` | high |
| closer | 1 | pi | `openai-codex/gpt-5.6-sol` | high |
| closer | 2 | claude | `opus` | medium |
| closer | 3 | pi | `xai/grok-4.6` | high |
| upgrade | 1 | claude | `opus` | medium |
| upgrade | 2 | pi | `openai-codex/gpt-5.6-sol` | high |
<!-- End Context Module: agent-orchestration -->
