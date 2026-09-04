# Thumby

Canonical vocabulary and cross-cutting invariants for thumby. Workflow and
command documentation lives in `README.md`; architectural decisions live in
`docs/adr/`.

## Language

**Scene**:
The canonical editable definition of one visual: a versioned JSON document with
a 1280×720 canvas, ordered Layers, and optional Variants and Reference
Thumbnail metadata.

**Layer**:
One positioned item in a Scene. Layer types are `image`, `text`, `shape`,
`connector`, and `group`; later Layers paint over earlier Layers.

**Asset**:
Immutable image content with metadata and a sha-256 content identity derived
from its bytes. An Asset can live in the shared library or be referenced as a
project-local file.

**Plate**:
A full-canvas generated background Asset with intentionally flattened content.
Final editorial text and exact logos are not part of a Plate.

**Object Asset**:
An isolated true-alpha non-text object intended for placement as an Image
Layer.

**Creator Asset**:
An isolated true-alpha representation of a person or character derived from
caller-supplied References. A generated Creator Asset is `trial` until a human
explicitly approves it.

**Generation Job**:
An online request that produces candidate Assets and records its model, prompt,
ordered typed References, warnings, cost, and run lineage. A Generation Job
does not render a Scene.

**Reference**:
An arbitrary image file supplied directly by a Generation Job caller, with an
explicit semantic role and a content identity. References keep caller order;
they are Job inputs, not entries in a discovery catalog.

**Variant**:
A named sparse set of changes to stable Layer IDs in one Scene. A Variant never
starts generation.

**Render**:
The flattened 1280×720 PNG produced locally from a resolved Scene, with a
portable manifest that records the exact Scene and Asset identities used.

**Reference Thumbnail**:
An image associated with a Scene for structural and stylistic review. It is
review metadata, not a Render input or a pixel-perfect target.

**Mask**:
A PNG whose alpha selects a named region for local color adjustment.

## Cross-cutting invariants

- Final text and final composition are local (ADR-0001, ADR-0004). Models can
  produce source Assets, but never the final composite.
- Assets are immutable and content-addressed (ADR-0002). Replacing bytes
  creates a different content identity.
- Generation References come from the caller. Thumby preserves their order,
  records their identities, verifies them before generation, and does not own
  source discovery or reference policy.
- Creator generation requires at least one caller-supplied `identity`
  Reference. A likeness is never generated from text alone.
- Human approval is the Creator Asset likeness gate. Normal rendering rejects
  trial Creator Assets unless an explicit experimental render is requested.
- Local edits, validation, inspection, review, and rendering do not use the
  network. Only Generation Jobs call image providers.
- Invalid Scenes, unresolved Assets, changed pinned content, and font fallback
  fail loudly.
- An element is independently editable only when it is a Layer or named Mask.
- Creator Layer transforms and effects are local Scene edits. A named Mask can
  recolor a fixed region locally. Pose, expression, outfit shape, and style are
  intrinsic changes that require a new Creator Asset through a Generation Job
  (ADR-0008).
