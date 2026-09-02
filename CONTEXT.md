# Context

Canonical vocabulary and cross-cutting invariants for thumby. When naming a
domain concept — in a Scene field, a CLI result, an issue title, a commit, a
doc — use the terms exactly as defined here. Source of the vocabulary:
the design spec (#7). Workflow documentation lives in `README.md` (→ Scenes).

## Glossary

- **Scene** — the canonical editable definition of one thumbnail: a versioned,
  runtime-validated JSON document with a 1280×720 canvas and an explicitly
  ordered layer list, plus optional Variants and Reference Thumbnail metadata.
  The single source of truth — a Render never depends on reconstructing a
  shell command.
- **Layer** — one positioned instance in a Scene. Types: `image`, `text`,
  `shape`, `connector`, `group`. Array order is compositing order (later on
  top). Every layer has a stable unique `id`; Variants target layers by id.
- **Asset** — immutable content (raster, vector, font, or mask) with metadata
  and a content identity (sha-256 of its bytes, derived at scan time, never
  stored). Library Assets live under `assets/`; project-local Assets are
  referenced by scene-relative path. Both scopes use the same resolution
  contract; `@<hash>` pins exact bytes.
- **Plate** — a full-canvas generated background Asset whose contents are
  intentionally flattened (ADR-0011). The agent's requested subject is
  authoritative for its visual content: UI, products, devices, and complex
  background elements are permitted; only final editorial text (ADR-0001) and
  exact logos stay local. Composability is an authoring policy, not
  validation — prefer an independent Asset and Layer when an element benefits
  from movement, resizing, recoloring, replacement, reuse, provenance, or
  Variants; keep environmental or tightly integrated detail flattened when
  separate control adds little.
- **Cutout Asset** — an isolated true-alpha PNG in the library. Two roles:
  **Object Asset** (a lamp, terminal, device — any isolated non-text object,
  placed as an independent Image layer) and **Creator Asset** (below).
- **Creator Asset** — an isolated representation of Kenneth, sourced from a
  real capture or generated from typed identity anchors. Enters the library
  as `trial`; becomes `approved` only through explicit human approval
  (`library approve`). Normal/final rendering rejects trial Creator Assets
  unless `--experimental` is explicitly given (`scene render --experimental`
  or deprecated `thumb --experimental`), producing clearly-marked non-final
  output.
- **Generation Job** — an online operation that produces candidate Assets
  (`jobs plates`, `jobs objects`, `jobs creators`). Records model, full
  effective prompt, typed references with exact identities, cost, warnings,
  and every candidate. It never renders and never overwrites an adopted Asset
  or Scene content; reruns append candidates under the job lineage.
- **Variant** — a named sparse set of changes against stable layer IDs of one
  Scene (text/style, transform/visibility, Asset swap, effect/color). Stores
  only differences; renders individually or in a batch; never triggers
  generation.
- **Render** — the flattened 1280×720 thumbnail produced locally from a fully
  resolved Scene, recorded in a portable Render manifest (scene identity,
  Asset identities, tool version, outputs, warnings) so it can be re-rendered
  offline after project relocation.
- **Reference Thumbnail** — an input image associated with a Scene as review
  metadata, used by the agent as a structural and stylistic target — never a
  Render input, never a pixel goal.
- **Reference (typed)** — an image input to a Generation Job carrying an
  explicit role: `identity`, `pose`, `expression`, `outfit`, `style`, `edit`
  (source-to-edit). Roles, not order-and-prose, are the recorded contract.
- **Mask (named semantic mask)** — a PNG whose alpha selects a region of a
  Creator Asset (e.g. `shirt`), referenced by name from a Scene's
  `adjust: { mask, color }`.
- **Scene workflow** — the supported default path: generate or adopt Assets
  through Generation Jobs, author a Scene (or initialize from a template),
  `scene validate`, `scene render`, iterate via Variants. See README → Scenes.

## Cross-cutting invariants

- **Final text and the final composite are always local** (ADR-0001,
  ADR-0004). The model may produce isolated non-text source Assets — plates,
  objects, creators — never final text, never the final composite.
- **Assets are immutable and content-addressed** (ADR-0002). Content identity
  is derived from bytes, never stored; replacing content creates a new
  identity and never silently changes an old Scene.
- **Human approval is the likeness gate** (DEC-004, ADR-0006). Automated
  measures may rank; only explicit approval promotes a trial Creator Asset.
- **Local edits and renders never touch the network** (DEC-001, REQ-004).
  Only Generation Jobs are online; a missing intrinsic Asset change surfaces
  as a required Job, never an implicit repaint.
- **Rendering fails loudly, before the browser starts** (REQ-003). Invalid
  Scenes are rejected with field-specific errors; silent fallback (fonts,
  assets) is forbidden.
- **Editability boundary** (DEC-006): an element is independently editable
  only when it is its own layer or named mask.

## Creator edits — what changes what

The one place that decides which edit path a creator change takes (REQ-017,
DEC-006, ADR-0008):

- **Layer facts** (position, size, mirror, visibility, effects) — edit the
  Scene layer. Local, instant, no generation.
- **Simple recolor of a masked region** — `adjust: { mask, color }` on the
  Image layer. Local render-time blend (ADR-0007); the Asset's bytes never
  change. A limited tool: it repaints hue/saturation inside one named mask —
  it cannot change the garment's shape, type, or style.
- **Outfit / garment type / style / pose / expression changes** — these are
  intrinsic edits to the person. They go through **Creator generation**
  (`jobs creators`, typed references incl. `outfit`/`style`) plus the **local
  matting pass**, producing a new candidate Creator Asset; adopt it, approve
  it, then swap the Creator layer's `asset` reference. Only that layer
  changes — the plate, text, logos, and other objects are never regenerated.
