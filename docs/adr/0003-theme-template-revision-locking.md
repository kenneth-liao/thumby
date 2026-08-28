# ADR-0003: Theme and template revision identity is content-derived, and themes resolve at the load gate

- Status: Accepted (from ticket #2, `REQ-007` of #7)
- Context: Scenes need named style defaults that cannot silently change an old Render (`DEC-001`, `DEC-006`)

## Decision

A Scene may reference one bundled **theme** by name, pinned with
`revision: <sha-256-or-prefix>`. The revision identity of a theme is the
sha-256 of its rendering-relevant content — its defaults sections, canonically
(key-sorted) serialized — **derived never stored** (the same shape ADR-0002
chose for Asset content). Names and descriptions cannot change a render, so
editing them does not invalidate pinned Scenes.

Theme defaults are applied at exactly one point: the load gate
(`loadScene` in `src/scene.ts`), after schema and semantic validation, before
resolution. The precedence rule has one home and one form: **explicit layer
value > theme default > renderer built-in default** (`LAYER_DEFAULTS` in
`src/scene.ts` is the single home of the built-ins, shared by the renderer
and the inspector). Defaults are contract-aware: a theme `color` applies only
where a layer sets neither `color` nor `fill`; a theme `radius` only to rects.

**Templates** bake into a Scene at init (`buildScene` in `src/templates.ts`):
the emitted document is plain layers with stable ids and no runtime template
reference; a template's named theme is pinned to its current revision at
init, and the result is validated through the load gate before it is handed
to the agent.

## Rationale

Version locking must make the invalid state — an old Scene silently rendering
with changed theme content — unrepresentable. A derived hash cannot drift
from the content it describes; a stored revision number or a runtime template
reference that re-reads current theme content are both second homes that can
disagree with what a Render actually used. Baking template layers gives the
same guarantee by construction: nothing left to re-resolve, nothing to drift.

Resolving defaults in the load gate rather than scattering fallbacks through
the renderer keeps one place where precedence is decided, so the resolved
Scene is unambiguous — `scene inspect` reports effective values that cannot
disagree with what the renderer draws.

## Consequences

- Editing a bundled theme changes its revision; Scenes pinned to the old
  revision fail loudly at load with the actual hash and a re-pin hint.
- Themes default only optional style properties — never layout facts or
  schema-required fields — so a themed Scene stays schema-valid standalone
  and the text/shape fill contracts survive untouched. Shapes carry border
  styling rather than an `effects` object, so themes default shape color,
  fill, border, and radius but no shape effects.
- Template edits never affect Scenes already initialized from them.
- The bundled registries (`THEMES`, `TEMPLATES`) are code data, offline by
  construction; the pin-verify mechanism does not assume bundled data.
