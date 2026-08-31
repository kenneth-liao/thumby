# ADR-0007: Masked colorization is a render-time blend

- Status: Accepted (from ticket #18, `REQ-019`)
- Context: REQ-019 requires a masked color adjustment — "make my shirt blue" — that changes only the pixels a named mask selects and leaves every other pixel untouched, without a model call

## Decision

A masked colorization (`adjust: { mask, color }` on an image layer) is a
**render-time CSS blend**, never a baked pixel edit and never a second model
hop:

- The adjustment renders as an overlay element whose alpha comes from the
  mask PNG (`mask-image`) and whose color blends with the asset's own pixels
  through `mix-blend-mode: color` — hue and saturation from the adjustment,
  luminance from the asset, so shading survives recoloring. Pixels the mask
  does not select are byte-identical to the unadjusted render.
- The blend is **local and deterministic**: same Scene + same Assets → same
  pixels, offline, with the mask traveling as `data:` URI bytes. The
  adjustment lives in the Scene as an editable property (one whole field, so
  Variants swap colors without touching the base Scene) and recomputes at
  every render.
- The selection is defined on the **asset's pixel grid**: mask dimensions
  equal the asset's, and where a render draws the asset 1:1 the pixel
  contract is exact — every pixel outside the mask is byte-identical to the
  unadjusted render. When a render scales the asset, the browser resamples
  the mask like the image, so display pixels along a mask edge blend partial
  selection with neighboring source content — the same soft edge any masked
  scaling produces, not a second selection.
- **The source Asset is never rewritten.** No pipeline stage, adoption path,
  or edit command produces a "recolorder" cutout; there is no second Asset
  and no lineage fork per color. The one Asset identity keeps serving every
  color Variant (ADR-0002: content identity is the bytes).
- **Masks are a first-class library kind**, not files referenced by path:
  `assets/masks/<id>/mask.png` + meta, written through the one adoption write
  path, resolved through the one resolution contract, pinned by content
  identity (sha-256), recorded in render manifests (v4) and verified by
  rerender. A mask must be a PNG with exactly its asset's pixel dimensions —
  enforced at the load gate, not at render time.
- Creator Assets reference masks **by name** (`masks: { "shirt": "ken-shirt" }`
  in `meta.json`); the name is the asset's editing vocabulary, and the layer
  adjusts through the name (`adjust.mask: "shirt"`). Kind-restricted
  resolution (`{ kind: "mask" }`) keeps a cutout or plate from serving as a
  mask.

## Rationale

REQ-019's contract is pixel-precise: every pixel outside the mask unchanged.
A model edit cannot honor that boundary — the tested edit pass drifts,
re-encodes, and cannot guarantee untouched pixels — and it would fork the
Asset per color, multiplying identity for what is really one render
parameter. A bake-time recolor has the same defect one step earlier: it
destroys the original, so the "same unchanged Creator Asset" clause and the
no-generation-call guarantee both fail. The CSS blend gives the boundary
exactly (mask alpha = selection), preserves shading for free, and re-derives
on every render, which is what lets Variants carry only the color.

As a render-time property, the colorization is also reversible and inspectable
like every other layer field — `scene inspect` surfaces it, `scene validate`
gates it before any browser exists, and removing it restores the base render
byte-for-byte.

Mask discovery (segmenting where the shirt is) stays out of scope (ticket
#18): masks are human-authored assets, subject to the same library bar as
every other kind.
