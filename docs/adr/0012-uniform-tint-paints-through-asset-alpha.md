# ADR-0012: Uniform tint paints through Asset alpha at render time

- Status: Accepted (from ticket #55, DEC-021)
- Context: US-034/US-035 need a predictable uniform recolor for monochrome
  logos and icons — one authored color, no Asset duplication, no byte
  mutation — with the same semantics for raster and vector Image Assets. The
  masked `adjust` (ADR-0007) already recolors through a *named mask*,
  preserving shading; it needs a Creator Asset with named masks and is the
  wrong tool for flat logo recolors.

## Decision

`tint` on an Image layer paints one authored color through the layer's
resolved Asset alpha:

- **Full replacement, not a blend.** Every pixel the resolved image covers
  with alpha renders exactly the tint at the asset's own alpha
  (`out = tint × alpha` over the backdrop); every transparent pixel is
  byte-identical to the untinted render. There is no luminance carry-over: a
  gradient logo tinted flat is flat — that is what "uniform" means.
  Shading-preserving recolor remains `adjust`'s job through a named mask.
- **The Asset is the mask.** The render draws the tint as a solid-color
  element masked by the asset's own bytes (`mask-image` + `mask-size`
  mirroring `object-fit` — ADR-0007's machinery), so raster and vector
  Assets share one code path and one semantics. No second Asset, no
  dimension gate, no new manifest identity: the tint lives in the Scene
  bytes, the manifest's asset identity stays the source's, and
  manifest-backed rerender verifies it like any Scene (US-036).
- **Composition order is fixed.** Crop and `fit` select the silhouette
  exactly as they shape the raw image; the tint replaces the content's
  colors; `effects` then grade the result (one filter chain: blur →
  colorAdjust → glow → shadow); layer `opacity` composites the finished
  layer. The asset's own colors never reappear downstream of the tint.
- **One content-color treatment per layer.** `tint` and `adjust` are
  mutually exclusive at the schema boundary (`layers[i].tint`, "mutually
  exclusive" — one friendly-message home in src/scene.ts), like the text and
  shape color-vs-fill contracts. A Variant patch that merges the two fails
  the merged-document gate: the combination is rejected, never silently
  composed.
- **The source Asset is never rewritten** (TEST-015, ADR-0002): no pipeline
  stage produces a "tinted" copy; two differently tinted Layers share one
  Asset identity.

## Rationale

The pixel contract is "the authored color wherever the image has alpha" —
exactly what a mask built from the asset's own alpha gives, with the Asset
itself as the single source of the silhouette. A bake-time recolor or a
second Asset per color would fork identity for what is one render parameter
(the ADR-0002/ADR-0007 reasoning, one step further). Rejecting `tint` +
`adjust` keeps one content-color treatment per layer: both repaint the same
silhouette, so their composition would be a degenerate flat-over-flat
result, not a meaningful contract — and fail-fast at the gate beats a
deterministic-but-incoherent pixel soup.

## Rollback

`tint` is an optional image-layer property; older binaries reject tinted
Scenes with an unknown-property error before any render. The manifest
version did not change.