/**
 * YouTube safe-area validation (REQ-012, DEC-002) — the one home for the
 * protected regions and the violation geometry.
 *
 * A protected region is a rectangle of the 1280×720 canvas where YouTube's
 * own UI overlays the thumbnail: the duration badge (bottom-right corner)
 * and the watched-progress bar (full-width bottom strip). Visible layer
 * content intersecting a region risks being covered by that UI, so it is
 * reported as an actionable, layer-specific violation.
 *
 * Violations are warnings, never render failures (ADR-0005): a full-canvas
 * plate legitimately intersects both regions, and the acceptance call
 * belongs to the agent reviewing the render. `scene validate` reports the
 * structured violations, `scene render` surfaces `safeAreaWarnings` strings,
 * and `scene guidelines` renders the regions as an inspectable overlay view
 * that never enters the final output.
 *
 * The geometry is a conservative over-approximation of painted content:
 * image/text/shape layers count their full rotated bounding box (rotation
 * can only grow it), group children transform through their group's
 * scale/rotation/mirror, and connectors count the convex hull of their
 * quadratic path — every footprint inflated by the renderer-supported paint
 * extents beyond the nominal box (shape borders, text strokes and shadows,
 * image/group effects, connector strokes and arrowheads), so content that
 * paints into a region violates even when its box misses. Chained and nested
 * paint composes additively: the renderer's filter chain stages each paint
 * from the previous stage's output, and a group's filter paints on its
 * children's already-filtered output, so extents accumulate along the chain
 * rather than taking the maximum. Rotation collapses a directional pad to a
 * symmetric bound (a rotated offset swaps axes) — every pad collapses at the
 * point where a rotation stands between it and the canvas.
 * Content that stays outside all inflated footprints never violates;
 * content an inflated box over-covers may still be reported — the region
 * figures themselves are conservative boxes sized for YouTube's largest
 * display surfaces and are tuned here, in this one place.
 */
import { LAYER_DEFAULTS, type ResolvedScene, type SceneLayer, type GroupLayer, type ImageLayer, type TextLayer, type ShapeLayer, type Effects } from "./scene.js";
import { connectorGeometry, arrowPad, type Box } from "./scene-geometry.js";

/** One protected rectangle of the YouTube thumbnail canvas. */
export interface ProtectedRegion {
  id: string;
  /** Human-readable name used in warnings and the guideline overlay. */
  label: string;
  /** Why the region is protected — surfaced in the guideline view's markup. */
  reason: string;
  box: Box;
}

/**
 * The protected regions of the 1280×720 YouTube thumbnail canvas — the
 * single definition every consumer (validate, render warnings, guideline
 * view) reads. Anchored to the canvas edges so the constants state only
 * their size: the badge is the bottom-right 192×64, the progress strip the
 * full-width bottom 16px.
 */
export const PROTECTED_REGIONS: ProtectedRegion[] = [
  {
    id: "duration-badge",
    label: "duration badge",
    reason:
      "YouTube pins the video-length badge to the thumbnail's bottom-right corner at every display size",
    box: { x: 1280 - 192, y: 720 - 64, width: 192, height: 64 },
  },
  {
    id: "progress-bar",
    label: "progress bar",
    reason:
      "YouTube draws the watched-progress bar across the thumbnail's full width at the bottom edge",
    box: { x: 0, y: 720 - 16, width: 1280, height: 16 },
  },
];

/** One layer-specific safe-area violation. */
export interface SafeAreaViolation {
  /** The visible layer whose footprint intersects the region. */
  layer: string;
  /** The protected region id (PROTECTED_REGIONS). */
  region: string;
  /** The layer's axis-aligned frame footprint that intersects. */
  box: Box;
  /** The protected region's box. */
  regionBox: Box;
}

// --- affine transforms (group children → frame coordinates) ----------------------

/**
 * An affine transform in SVG-matrix form: x' = a·x + c·y + e, y' = b·x + d·y + f.
 * Composition of group mirror/scale/rotation down the layer tree.
 */
interface Affine {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

const IDENTITY: Affine = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

const compose = (outer: Affine, inner: Affine): Affine => ({
  a: outer.a * inner.a + outer.c * inner.b,
  b: outer.b * inner.a + outer.d * inner.b,
  c: outer.a * inner.c + outer.c * inner.d,
  d: outer.b * inner.c + outer.d * inner.d,
  e: outer.a * inner.e + outer.c * inner.f + outer.e,
  f: outer.b * inner.e + outer.d * inner.f + outer.f,
});

const apply = (t: Affine, x: number, y: number): { x: number; y: number } => ({
  x: t.a * x + t.c * y + t.e,
  y: t.b * x + t.d * y + t.f,
});

/**
 * The transform mapping a group's local (child) coordinates into its parent's
 * frame: mirror → rotate → scale around the group-box center (the CSS order
 * scene-render emits: `scale(s) rotate(θ) scaleX(-1)` applies right-to-left),
 * then translate to the group's position. Mirrors the markup exactly, so the
 * validated geometry cannot drift from what renders.
 */
function groupTransform(layer: GroupLayer): Affine {
  const s = layer.scale ?? 1;
  const m = layer.mirror ? -1 : 1;
  const θ = ((layer.rotation ?? 0) * Math.PI) / 180;
  const cos = Math.cos(θ);
  const sin = Math.sin(θ);
  const a = s * m * cos;
  const b = s * m * sin;
  const c = -s * sin;
  const d = s * cos;
  const cx = layer.size.width / 2;
  const cy = layer.size.height / 2;
  return {
    a,
    b,
    c,
    d,
    e: layer.position.x + cx - (a * cx + c * cy),
    f: layer.position.y + cy - (b * cx + d * cy),
  };
}

/** The axis-aligned box that covers `box` rotated by `deg` around its center. */
function rotatedAabb(box: Box, deg: number): Box {
  if (!deg) return box;
  const θ = (deg * Math.PI) / 180;
  const cos = Math.cos(θ);
  const sin = Math.sin(θ);
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of [
    [box.x, box.y],
    [box.x + box.width, box.y],
    [box.x, box.y + box.height],
    [box.x + box.width, box.y + box.height],
  ]) {
    const dx = x - cx;
    const dy = y - cy;
    minX = Math.min(minX, cx + dx * cos - dy * sin);
    minY = Math.min(minY, cy + dx * sin + dy * cos);
    maxX = Math.max(maxX, cx + dx * cos - dy * sin);
    maxY = Math.max(maxY, cy + dx * sin + dy * cos);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** The axis-aligned box covering the four corners mapped through `t`. */
function cornersAabb(box: Box, t: Affine): Box {
  const p1 = apply(t, box.x, box.y);
  const p2 = apply(t, box.x + box.width, box.y);
  const p3 = apply(t, box.x, box.y + box.height);
  const p4 = apply(t, box.x + box.width, box.y + box.height);
  const xs = [p1.x, p2.x, p3.x, p4.x];
  const ys = [p1.y, p2.y, p3.y, p4.y];
  return {
    x: Math.min(...xs),
    y: Math.min(...ys),
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  };
}

/**
 * The authored (unrotated) top-level boxes — the same anchor geometry
 * connector paths use at render time.
 */
function topLevelBoxes(layers: SceneLayer[]): Map<string, Box> {
  const boxes = new Map<string, Box>();
  for (const l of layers) {
    if (l.type === "connector" || boxes.has(l.id)) continue;
    boxes.set(l.id, { x: l.position.x, y: l.position.y, width: l.size.width, height: l.size.height });
  }
  return boxes;
}

/**
 * A connector's visible footprint: the AABB of its quadratic path's control
 * hull (endpoints plus the bowed control point) — the curve lies inside it.
 * Connectors are top-level only (the load gate rejects nested ones), so the
 * target boxes are always in frame coordinates.
 */
function connectorBox(layer: Extract<SceneLayer, { type: "connector" }>, boxes: Map<string, Box>): Box {
  const g = connectorGeometry(boxes.get(layer.from)!, boxes.get(layer.to)!, layer.bow ?? 0);
  const xs = [g.x1, g.cx, g.x2];
  const ys = [g.y1, g.cy, g.y2];
  return {
    x: Math.min(...xs),
    y: Math.min(...ys),
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  };
}

/**
 * How far paint can extend beyond a footprint's nominal box, per axis, in
 * the coordinate space the footprint is about to be tested in. Directional
 * (a text shadow with `x: 40` pads only horizontally); passing through any
 * nonzero rotation mixes the axes, so pads collapse to the symmetric bound
 * there — over-covering, never under.
 */
interface Pad {
  x: number;
  y: number;
}

const ZERO_PAD: Pad = { x: 0, y: 0 };

const collapse = (p: Pad): Pad => ({ x: Math.max(p.x, p.y), y: Math.max(p.x, p.y) });

/**
 * Compose two pads that apply to the same painted output in sequence: the
 * second stage paints from the first stage's already-padded output, so the
 * extents accumulate per axis. (Maximum would undercount a chain — a 20px
 * shadow inside a group with its own 20px shadow paints 40px out.)
 */
const addPad = (a: Pad, b: Pad): Pad => ({ x: a.x + b.x, y: a.y + b.y });

/** Inflate an axis-aligned box symmetrically by a pad. */
const inflate = (box: Box, p: Pad): Box => ({
  x: box.x - p.x,
  y: box.y - p.y,
  width: box.width + 2 * p.x,
  height: box.height + 2 * p.y,
});

/**
 * Text paint beyond the box: stroke paints entirely outside the glyphs, and
 * each shadow reaches |offset| + blur from glyph edges — the glyphs stay
 * inside the box, so those bounds hold for the box too.
 */
function textPad(layer: TextLayer): Pad {
  let p: Pad = { x: 0, y: 0 };
  if (layer.stroke) {
    p = { x: layer.stroke.width, y: layer.stroke.width };
  }
  for (const s of layer.shadows ?? []) {
    p = {
      x: Math.max(p.x, Math.abs(s.x) + s.blur),
      y: Math.max(p.y, Math.abs(s.y) + s.blur),
    };
  }
  return p;
}

/**
 * Image/group effects beyond the content box. The renderer emits one CSS
 * filter chain — blur → colorAdjust → glow → shadow — and each stage paints
 * from the previous stage's output, so the extents accumulate: a blur-20
 * image with a 20px rightward shadow paints 40px right, not max(20, 20).
 * blur and glow (a centered drop-shadow) spread `radius` in every direction;
 * a drop-shadow reaches |offset| + blur. colorAdjust moves no pixels.
 * (A text layer's shadows are one `text-shadow` painting every shadow from
 * the glyphs simultaneously — textPad's per-shadow maximum is correct there.)
 */
function effectsPad(effects: Effects | undefined): Pad {
  if (!effects) return ZERO_PAD;
  const blur = effects.blur ?? 0;
  let p: Pad = { x: blur, y: blur };
  if (effects.glow) p = addPad(p, { x: effects.glow.radius, y: effects.glow.radius });
  const sh = effects.shadow;
  if (sh) p = addPad(p, { x: Math.abs(sh.x) + sh.blur, y: Math.abs(sh.y) + sh.blur });
  return p;
}

/** Shape paint beyond the box: a border strokes half outside the edge. */
function shapePad(layer: ShapeLayer): Pad {
  return layer.border ? { x: layer.border.width / 2, y: layer.border.width / 2 } : ZERO_PAD;
}

/** Connector paint beyond the path hull: half the stroke, plus the arrowhead. */
function connectorPad(layer: Extract<SceneLayer, { type: "connector" }>): Pad {
  const w = layer.width ?? LAYER_DEFAULTS.connectorWidth;
  const p = Math.max(w / 2, layer.arrow ? arrowPad(w) : 0);
  return { x: p, y: p };
}

function leafPad(layer: ImageLayer | TextLayer | ShapeLayer | Extract<SceneLayer, { type: "connector" }>): Pad {
  if (layer.type === "text") return textPad(layer);
  if (layer.type === "shape") return shapePad(layer);
  if (layer.type === "connector") return connectorPad(layer);
  return effectsPad(layer.effects);
}

/** The uniform scale a transform applies (no skew — only scale·rotation·mirror). */
const transformScale = (t: Affine): number => Math.hypot(t.a, t.b);

/**
 * Every painted leaf (image, text, shape, connector) with its axis-aligned
 * frame footprint, inflated by the paint pads. `env` is the inherited pad in
 * the current layers' own coordinate space; the leaf's own pad composes with
 * it additively (a group's filter paints on its children's already-filtered
 * output, so extents accumulate — never max) and the sum converts to frame px
 * by the accumulated transform scale. Every pad collapses where a rotation
 * stands between it and the canvas (a rotated directional pad swaps axes).
 * CSS filters apply before their transform, so group effects pads scale with
 * the group's scale — ignoring that would under-cover a scaled-up group.
 * Groups are containers, not painted content: their children are the visible
 * leaves. A hidden or fully transparent layer paints nothing, so its whole
 * subtree is skipped.
 */
function* leafFootprints(
  layers: SceneLayer[],
  t: Affine,
  boxes: Map<string, Box>,
  env: Pad = ZERO_PAD,
): Generator<{ layer: SceneLayer; box: Box }> {
  for (const layer of layers) {
    if (layer.visible === false || layer.opacity === 0) continue;
    if (layer.type === "group") {
      const s = layer.scale ?? 1;
      // Parent-space env → this group's local space; a rotation between the
      // two spaces mixes axes, so collapse before converting. (Pads from
      // above an ancestor rotation are already collapsed — each pad collapses
      // at the point where a rotation stands between it and the canvas.)
      const inherited = layer.rotation
        ? collapse({ x: env.x / s, y: env.y / s })
        : { x: env.x / s, y: env.y / s };
      // This group's own effects paint on its children's already-filtered
      // output, so its pad composes additively with the inherited one — and
      // it passes through this group's rotation and any ancestor rotation
      // (in t) on the way to the canvas, either of which mixes its axes.
      let own = effectsPad(layer.effects);
      if (layer.rotation || t.b !== 0 || t.c !== 0) own = collapse(own);
      yield* leafFootprints(layer.layers, compose(t, groupTransform(layer)), boxes, addPad(inherited, own));
    } else if (layer.type === "connector") {
      yield { layer, box: inflate(connectorBox(layer, boxes), connectorPad(layer)) };
    } else {
      let own = leafPad(layer);
      // The leaf's own rotation, or any ancestor rotation inside `t`, mixes
      // the pad's axes on the way to frame space.
      if (layer.rotation || t.b !== 0 || t.c !== 0) own = collapse(own);
      // The leaf's own paint and the inherited filter chain paint the same
      // output in sequence — extents accumulate, never max.
      const total = addPad(own, env);
      const frame = { x: total.x * transformScale(t), y: total.y * transformScale(t) };
      const local = rotatedAabb(
        { x: layer.position.x, y: layer.position.y, width: layer.size.width, height: layer.size.height },
        layer.rotation ?? 0,
      );
      yield { layer, box: inflate(cornersAabb(local, t), frame) };
    }
  }
}

/** Strict rectangle overlap — edges touching exactly is not an intersection. */
const intersects = (a: Box, b: Box): boolean =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

/**
 * Every visible layer footprint that intersects a protected region, one
 * violation per (layer, region) pair. Pure geometry over an already-gated
 * scene — no browser, no assets, no I/O.
 */
export function findSafeAreaViolations(resolved: ResolvedScene): SafeAreaViolation[] {
  const violations: SafeAreaViolation[] = [];
  const boxes = topLevelBoxes(resolved.scene.layers);
  for (const { layer, box } of leafFootprints(resolved.scene.layers, IDENTITY, boxes)) {
    for (const region of PROTECTED_REGIONS) {
      if (intersects(box, region.box))
        violations.push({ layer: layer.id, region: region.id, box, regionBox: region.box });
    }
  }
  return violations;
}

const round = (v: number) => Math.round(v);

/**
 * The render-channel form of the violations — actionable strings naming the
 * layer, its footprint, the region, and the escape hatches. Surfaced in the
 * render output's `warnings` and recorded in the Render manifest.
 */
export function safeAreaWarnings(resolved: ResolvedScene): string[] {
  return findSafeAreaViolations(resolved).map(({ layer, region, box, regionBox }) =>
    `safe-area: visible layer "${layer}" (box ${round(box.x)},${round(box.y)} ` +
    `${round(box.width)}×${round(box.height)}) intersects the ${region} region ` +
    `(x ${regionBox.x}–${regionBox.x + regionBox.width}, y ${regionBox.y}–${regionBox.y + regionBox.height}) — ` +
    `YouTube's UI may cover it; move, resize, or accept the overlap`,
  );
}
