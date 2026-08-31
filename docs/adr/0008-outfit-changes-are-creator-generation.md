# ADR-0008: Outfit and style changes are Creator generation, not masked recolor

- Status: Accepted (from ticket #22, `REQ-017`/`REQ-019` boundary of #7; product call after #21 human qualification — AC3, the masked shirt recolor, failed production quality)
- Context: REQ-019 shipped `adjust: { mask, color }` (ADR-0007) as the masked recolor tool. Human qualification (#21) accepted the Creator workflow but rejected the masked shirt recolor at production quality, forcing an explicit boundary between the two edit paths

## Decision

What a creator change touches decides its path:

- **Layer facts** — position, size, mirror, visibility, effects: edit the
  Scene layer. Local and instant.
- **Named-mask recolor** (`adjust: { mask, color }`) — a **limited local
  recolor tool**, retained for what it is good at: repainting hue/saturation
  inside one named mask of an existing approved Creator Asset, at render
  time, with no generation (ADR-0007 unchanged).
- **Outfit, garment type, garment style, pose, and expression changes** —
  these are **intrinsic edits to the person**. They go through **Creator
  generation** (`jobs creators` with typed `outfit`/`style`/`pose`
  references, nano-2 on the Gateway) plus the **local matting pass**
  (ADR-0006), producing a new trial Creator Asset. Adopt, obtain Kenneth's
  approval, then swap the Creator layer's `asset` reference. No masked
  recolor is attempted for these, and nothing else in the Scene (plate,
  text, logos, other objects) is regenerated.

A masked recolor cannot stand in for an intrinsic edit even where a mask
exists: it changes color inside a fixed region, never the garment's shape,
type, or style. Where the change is intrinsic, the mask boundary itself is
wrong — the pixels that should change are not the pixels the old mask
selects.

## Rationale

The masked recolor was accepted as a mechanism (byte-exact outside the mask,
render-time blend) but failed as a product path: production-quality clothing
changes need new pixels — new folds, new silhouette, new lighting — which a
render-time color blend cannot synthesize. The Creator pipeline, qualified
through #21, already produces almost-indistinguishable intrinsic edits with
full lineage and the human approval gate; routing outfit changes through it
keeps one quality bar instead of two.

The cost is a generation call per intrinsic edit where a recolor is free.
That is the correct trade: intrinsic edits are rare and human-reviewed by
contract (DEC-004), while recolors are cheap iterations that stay local.

## Consequences

- `adjust: { mask, color }` stays supported for masked color changes only;
  its documentation must not present it as the outfit path.
- Outfit/style/type changes require a Generation Job and human approval —
  they are never a zero-generation Scene edit.
- The decision record for "which path does this creator edit take" lives in
  `CONTEXT.md` (Creator edits — what changes what); this ADR holds the why.
