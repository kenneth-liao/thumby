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
- **The named-mask contract is untouched.** The masked `adjust` (ADR-0007)
  composes over the tinted result: the tint div paints first and the adjust
  overlay blends on top of it (`mix-blend-mode: color` — hue and saturation
  from the adjust color, luminance from the tint inside the mask; outside
  the mask the tint shows byte-identically). DEC-021 excludes changes to
  named semantic masks, so tint adds no rule to them — a Creator Asset with
  named masks can carry a tint, and the composition is pinned by a focused
  pixel regression.
- **The source Asset is never rewritten** (TEST-015, ADR-0002): no pipeline
  stage produces a "tinted" copy; two differently tinted Layers share one
  Asset identity.

## Rationale

The pixel contract is "the authored color wherever the image has alpha" —
exactly what a mask built from the asset's own alpha gives, with the Asset
itself as the single source of the silhouette. A bake-time recolor or a
second Asset per color would fork identity for what is one render parameter
(the ADR-0002/ADR-0007 reasoning, one step further). The composition order
is the markup's paint order — the tint replaces the content's colors and
the adjustment blends on top — so tint cannot change what `adjust` means;
an earlier draft rejected the combination at the schema boundary and was
reversed in review (SPEC-1) because it changed the named-mask contract's
surface, which the spec excluded.

## Rollback

`tint` is an optional image-layer property; older binaries reject tinted
Scenes with an unknown-property error before any render. The manifest
version did not change.