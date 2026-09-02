# ADR-0011: A Plate is a full-canvas generated background whose contents are intentionally flattened

- Status: Accepted (from ticket #51, `DEC-010`–`DEC-013` of spec #50)
- Context: `REQ-014`'s narrow Plate contract made every Plate Job a "bare backdrop by definition" — no person, product, device, or independently editable foreground object baked in — and the plate prompt appended that ban (plus a ban on UI elements) to every job's effective prompt

## Decision

The prior narrow Plate contract is superseded. A **Plate** is a full-canvas
generated background Asset whose contents are **intentionally flattened**: the
model paints the whole canvas, and nothing inside it is independently
editable — anything that needs separate control enters the Scene as its own
Asset and Layer.

- The Plate Job subject supplied by the agent is **authoritative for visual
  content** (`DEC-010`). Prompt construction may add format, resolution/zone,
  and cross-cutting invariant guidance, but must never append blanket bans on
  UI, products, devices, or foreground objects — those are requestable
  content, not contract violations.
- The **local-composition boundaries are unchanged** (`DEC-012`, OOS-013):
  final editorial text is rendered locally (ADR-0001) and exact official
  logos are sourced Assets, so the plate prompt still hard-bans text and
  logos. Immutability of Assets (ADR-0002) and the human Creator-approval
  gate (ADR-0006) are untouched.
- **Composability is an agent authoring policy, not Scene validation**
  (`DEC-013`): prefer an independent Asset and Layer when separate control
  has practical value — movement, resizing, recoloring, replacement, reuse,
  provenance, or Variants — and keep environmental or tightly integrated
  detail flattened when decomposition adds little. Nothing in Scene
  validation rewards decomposition or penalizes a fully flattened Plate.

## Rationale

The bare-backdrop ban was written when Plates were ambience behind a cutout,
but it contradicts the workflows agents actually need: recognizable
application surfaces, product scenes, devices — content whose macrostructure
matters at thumbnail size. The prohibition made the tool refuse, in the
effective prompt, exactly what the agent asked for. Flattening is a real
tradeoff, not a defect: a simplified application surface baked into the
canvas is correct when nothing about it will be edited separately, and
mandatory decomposition would create authoring work with no payoff. The
economic and determinism rationale of ADR-0001 — free, exact, local iteration
on text and composition — never depended on the plate staying empty; that
boundary lives where the finished pixels come from (ADR-0004), not in what
the background may depict.

## Consequences

- The plate prompt drops the backdrop and UI prohibitions; the text/logo ban
  remains. The recorded effective prompt of a Plate Job must preserve the
  agent's requested content (protected by the public Generation Job prompt
  contract test, TEST-009).
- The legacy `thumb --cutout` flow keeps its explicit subjectless backdrop
  mode — there the agent chose a backdrop for a local cutout, and the path is
  deprecated and receives no further work.
- The glossary's Plate definition is updated accordingly; agent-facing
  guidance (README, `jobs` help) documents the composability policy.
- This supersedes the plate-as-ambience reading of ADR-0001's "background
  plate" phrasing (already narrowed for the source-Asset boundary by
  ADR-0004); ADR-0001 remains authoritative for text.