/**
 * Generic Scene renderer — ordered layers composited into a 1280×720 PNG.
 *
 * Built like src/compose.ts but without any specialized branches: the Scene's
 * array order is the compositing order, every layer is one positioned element,
 * and nothing here knows about plates, cutouts, or style presets.
 *
 * Offline by construction: fonts load from bundled TTF bytes and images from
 * resolved Asset bytes, both as data: URIs — the page never fetches. Text is
 * local CSS only (ADR-0001); the renderer adds no text or watermark of its own.
 */
import type { Page } from "playwright";
import { withRenderPage } from "./browser.js";
import {
  fontFaceCss,
  familyResolved,
  resolveFace,
  type FontFace,
} from "./fonts.js";
import type {
  ResolvedScene,
  ImageLayer,
  TextLayer,
  ShapeLayer,
  TextSpan,
  SceneLayer,
  Effects,
  ConnectorLayer,
} from "./scene.js";
import { LAYER_DEFAULTS } from "./scene.js";
import { PROTECTED_REGIONS, safeAreaWarnings } from "./safe-area.js";

export interface SceneRenderResult {
  png: Buffer;
  width: number;
  height: number;
  /**
   * Non-fatal render signals — the complete set a consumer should surface:
   * scene-level signals (e.g. an auto-fit layer that could not fit at its
   * `min` floor) plus safe-area violations (ADR-0005). renderScene is the
   * one home for assembling them, so every render path reports both
   * without remembering to merge. The PNG still renders; consumers
   * surface these.
   */
  warnings: string[];
}

/** Intrinsic pixel dimensions of an image asset. */
export interface ImageSize {
  width: number;
  height: number;
}

const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

// Connector/box geometry lives in src/scene-geometry.ts — geometry consumers
// (src/safe-area.ts) import it without importing this browser-backed module.
// The re-export keeps the renderer the one import surface for existing callers.
export { connectorGeometry } from "./scene-geometry.js";
export type { Box } from "./scene-geometry.js";
import { connectorGeometry, n, ARROW_MARKER } from "./scene-geometry.js";
import type { Box } from "./scene-geometry.js";

/** Every layer in the scene tree, depth-first — groups yield their children. */
export function* layerTree(layers: SceneLayer[]): Generator<SceneLayer> {
  for (const layer of layers) {
    yield layer;
    if (layer.type === "group") yield* layerTree(layer.layers);
  }
}

/** Total layers in the scene tree, including group children. */
export function countLayers(layers: SceneLayer[]): number {
  let count = 0;
  for (const _ of layerTree(layers)) count++;
  return count;
}

/** The bundled faces a scene's text layers and spans name, deduped in scene order. */
export function sceneFaces(resolved: ResolvedScene): FontFace[] {
  const faces: FontFace[] = [];
  const add = (family: string) => {
    const face = resolveFace(family);
    if (!faces.includes(face)) faces.push(face);
  };
  for (const layer of layerTree(resolved.scene.layers)) {
    if (layer.type !== "text") continue;
    add(layer.font);
    for (const span of layer.spans ?? []) if (span.font) add(span.font);
  }
  return faces;
}

function transformCss(layer: {
  rotation?: number;
  mirror?: boolean;
  scale?: number;
}): string {
  const parts: string[] = [];
  // Scale first in the list — CSS applies right-to-left, so a group mirrors,
  // then rotates, then scales; a uniform scale commutes with both.
  if (layer.scale !== undefined && layer.scale !== 1) parts.push(`scale(${layer.scale})`);
  if (layer.rotation) parts.push(`rotate(${layer.rotation}deg)`);
  if (layer.mirror) parts.push("scaleX(-1)");
  return parts.length ? ` transform:${parts.join(" ")};` : "";
}

/**
 * Crop-then-fit geometry: the percent insets select a window of the source,
 * and that window is fitted into the layer box per `fit` — matching the
 * schema's contract, not CSS object-fit's fit-the-whole-image semantics.
 *
 * Returns the clip window in layer-box coordinates and the full image's
 * position (window-local — the img is a child of the clip window) and display
 * size, in px. The source point at the window's center lands at the layer
 * box's center.
 */
export function cropFitGeometry(
  size: { width: number; height: number },
  crop: { left: number; top: number; right: number; bottom: number },
  fit: "cover" | "contain" | "fill" | "none",
  natural: ImageSize,
): {
  window: { x: number; y: number; width: number; height: number };
  image: { x: number; y: number; width: number; height: number };
} {
  const x0 = (crop.left / 100) * natural.width;
  const y0 = (crop.top / 100) * natural.height;
  const w = (1 - (crop.left + crop.right) / 100) * natural.width;
  const h = (1 - (crop.top + crop.bottom) / 100) * natural.height;
  const { width: W, height: H } = size;

  // Uniform scale per mode; fill stretches each axis independently, none is s=1.
  const s =
    fit === "cover"
      ? Math.max(W / w, H / h)
      : fit === "contain"
        ? Math.min(W / w, H / h)
        : 1;
  const winW = fit === "fill" ? W : w * s;
  const winH = fit === "fill" ? H : h * s;
  const winX = (W - winW) / 2;
  const winY = (H - winH) / 2;

  const sx = winW / w;
  const sy = winH / h;
  return {
    window: { x: n(winX), y: n(winY), width: n(winW), height: n(winH) },
    image: { x: n(-x0 * sx), y: n(-y0 * sy), width: n(winW * natural.width / w), height: n(winH * natural.height / h) },
  };
}

function imageMarkup(
  layer: ImageLayer,
  uri: string,
  natural: ImageSize | undefined,
  maskUri: string | undefined,
): string {
  const fit = layer.fit ?? LAYER_DEFAULTS.fit;
  if (!layer.crop) {
    return (
      (layer.tint
        ? tintMarkup(layer, uri, maskSizeFor(fit))
        : `<img src="${uri}" style="width:100%;height:100%;object-fit:${fit};display:block;">`) +
      adjustOverlayMarkup(layer, maskUri, maskSizeFor(fit))
    );
  }
  if (!natural)
    throw new Error(
      `layer "${layer.id}" crops its asset but its intrinsic size is unknown — ` +
        `declare width/height (or a viewBox) so crop+fit geometry can be computed`,
    );
  // The clip window shows exactly the cropped source; the img inside is the
  // full image positioned so the window's content lands per `fit`.
  const { window: win, image: img } = cropFitGeometry(layer.size, layer.crop, fit, natural);
  return (
    `<div style="position:absolute;left:${win.x}px;top:${win.y}px;width:${win.width}px;height:${win.height}px;overflow:hidden;">` +
    (layer.tint
      ? tintMarkup(layer, uri, "100% 100%", { x: img.x, y: img.y, width: img.width, height: img.height })
      : `<img src="${uri}" style="position:absolute;left:${img.x}px;top:${img.y}px;width:${img.width}px;height:${img.height}px;display:block;">`) +
    adjustOverlayMarkup(layer, maskUri, "100% 100%", { x: img.x, y: img.y, width: img.width, height: img.height }) +
    `</div>`
  );
}
/**
 * The CSS mask-size that makes a mask track the same geometry object-fit
 * gives the layer's img — same intrinsic image pair (mask dimensions equal
 * the asset's, enforced at the gate), so equal rules land equal pixels.
 */
function maskSizeFor(fit: "cover" | "contain" | "fill" | "none"): string {
  return fit === "fill" ? "100% 100%" : fit === "none" ? "auto" : fit;
}

/**
 * The uniform tint (DEC-021): the layer's resolved Asset painted in one
 * authored color. The Asset's own bytes double as the alpha mask, so every
 * pixel the image covers with alpha renders exactly `tint` and every
 * transparent pixel stays untouched — full color replacement, not the hue
 * blend the masked adjustment performs. It reuses ADR-0007's mask machinery
 * (mask-image + mask-size mirroring object-fit) with the Asset itself as the
 * mask, so raster and vector Assets share one code path and one semantics.
 * The `box` form is for cropped layers: the overlay takes the img's exact
 * geometry (mask-size 100% 100%, since the mask IS the asset,
 * pixel-for-pixel).
 */
function tintMarkup(
  layer: ImageLayer,
  uri: string,
  maskSize: string,
  box?: { x: number; y: number; width: number; height: number },
): string {
  const pos = box
    ? `left:${box.x}px;top:${box.y}px;width:${box.width}px;height:${box.height}px;`
    : `left:0;top:0;width:100%;height:100%;`;
  // Standard mask-* first, -webkit- alongside — Chromium supports both, and
  // the code then says what the schema and README say (`mask-image`).
  const mask = (prop: string, value: string) =>
    `${prop}:${value};-webkit-${prop}:${value};`;
  return (
    `<div style="position:absolute;${pos}background:${layer.tint};` +
    mask("mask-image", `url('${uri}')`) +
    mask("mask-size", maskSize) +
    mask("mask-position", "center") +
    mask("mask-repeat", "no-repeat") +
    `"></div>`
  );
}

/**
 * The masked colorization overlay (REQ-019): one absolutely-positioned color
 * layer whose alpha comes from the mask PNG (`-webkit-mask-image`) and whose
 * color blends with the backdrop via `mix-blend-mode: color` — hue and
 * saturation from the adjustment, luminance from the asset's own pixels, so
 * shirt shading survives recoloring. Where the mask's alpha is 0 the overlay
 * paints nothing and the backdrop is untouched. The `box` form is for
 * cropped layers: the overlay takes the img's exact geometry (mask-size is
 * then trivially 100% 100%, since the mask matches the asset pixel-for-pixel).
 */
function adjustOverlayMarkup(
  layer: ImageLayer,
  maskUri: string | undefined,
  maskSize: string,
  box?: { x: number; y: number; width: number; height: number },
): string {
  if (!layer.adjust) return "";
  if (!maskUri)
    throw new Error(
      `layer "${layer.id}" has an "adjust" but its named mask did not resolve — the load gate should have rejected this scene`,
    );
  const pos = box
    ? `left:${box.x}px;top:${box.y}px;width:${box.width}px;height:${box.height}px;`
    : `left:0;top:0;width:100%;height:100%;`;
  // Standard mask-* first, -webkit- alongside — Chromium supports both, and
  // the code then says what the schema and README say (`mask-image`).
  const mask = (prop: string, value: string) =>
    `${prop}:${value};-webkit-${prop}:${value};`;
  return (
    `<div style="position:absolute;${pos}background:${layer.adjust.color};` +
    mask("mask-image", `url('${maskUri}')`) +
    mask("mask-size", maskSize) +
    mask("mask-position", "center") +
    mask("mask-repeat", "no-repeat") +
    `mix-blend-mode:color;"></div>`
  );
}

function textMarkup(layer: TextLayer): string {
  // The family comes from the bundled-face registry, not the raw scene field —
  // the validated scene can only name fonts whose bytes the renderer ships.
  const face = resolveFace(layer.font);
  const lineHeight = layer.lineHeight ?? LAYER_DEFAULTS.lineHeight;
  // Auto-fit layers start markup at their max; renderScene shrinks to fit
  // after fonts resolve, so the shipped markup is deterministic either way.
  const startSize = layer.fontSize ?? layer.autoFit!.max;
  const styles = [
    `font-family:'${face.family}'`,
    `font-weight:${layer.weight ?? face.weight}`,
    `font-size:${startSize}px`,
    `text-align:${layer.align ?? LAYER_DEFAULTS.align}`,
    `line-height:${lineHeight}`,
    "white-space:pre-line",
    "overflow-wrap:break-word",
  ];
  // Explicit scene values land as inline styles on the element they style —
  // no CSS class carries scene state, so nothing can out-specify them.
  if (layer.tracking !== undefined) styles.push(`letter-spacing:${layer.tracking}em`);
  if (layer.casing && layer.casing !== "none")
    styles.push(`text-transform:${CASING_CSS[layer.casing]}`);
  if (layer.fill) {
    // Gradient text paints through background-clip; spans with explicit
    // colors must restate the fill color or the clip would hide them.
    styles.push(
      "color:transparent",
      `background:linear-gradient(${layer.fill.angle ?? LAYER_DEFAULTS.fillAngle}deg,${layer.fill.from},${layer.fill.to})`,
      "-webkit-background-clip:text",
      "background-clip:text",
      "-webkit-text-fill-color:transparent",
    );
  } else {
    styles.push(`color:${layer.color ?? LAYER_DEFAULTS.color}`);
  }
  if (layer.stroke)
    styles.push(
      `-webkit-text-stroke:${layer.stroke.width}px ${layer.stroke.color}`,
      "paint-order:stroke fill",
    );
  if (layer.shadows?.length)
    // CSS paints the first text-shadow on top; the scene lists back to
    // front, so emit reversed — the last-listed shadow lands front-most.
    styles.push(
      `text-shadow:${layer.shadows
        .map((s) => `${s.x}px ${s.y}px ${s.blur}px ${s.color}`)
        .reverse()
        .join(",")}`,
    );
  const inner = layer.spans
    ? layer.spans.map((span) => spanMarkup(span, Boolean(layer.fill))).join("")
    : esc(layer.text ?? "");
  return `<div style="width:100%;height:100%;${styles.join(";")}">${inner}</div>`;
}

/** Scene casing vocabulary → CSS text-transform. "none" never reaches markup. */
const CASING_CSS = { upper: "uppercase", lower: "lowercase" } as const;

/**
 * The effects object as one CSS filter chain, in the documented order
 * blur → colorAdjust → glow → shadow: blur and the adjustments grade the
 * content, then glow and shadow are drop-shadows computed from that result,
 * following its alpha. Only set fields emit — unset fields are the CSS
 * defaults (unchanged), so the markup states exactly the scene's values.
 */
function effectsFilter(effects: Effects | undefined): string {
  if (!effects) return "";
  const parts: string[] = [];
  if (effects.blur !== undefined) parts.push(`blur(${effects.blur}px)`);
  const c = effects.colorAdjust;
  if (c) {
    if (c.brightness !== undefined) parts.push(`brightness(${c.brightness})`);
    if (c.contrast !== undefined) parts.push(`contrast(${c.contrast})`);
    if (c.saturate !== undefined) parts.push(`saturate(${c.saturate})`);
    if (c.hueRotate !== undefined) parts.push(`hue-rotate(${c.hueRotate}deg)`);
  }
  if (effects.glow)
    parts.push(`drop-shadow(0px 0px ${effects.glow.radius}px ${effects.glow.color})`);
  if (effects.shadow)
    parts.push(
      `drop-shadow(${effects.shadow.x}px ${effects.shadow.y}px ${effects.shadow.blur}px ${effects.shadow.color})`,
    );
  return parts.length ? `filter:${parts.join(" ")}` : "";
}

/**
 * Per-page linearGradient factory: converts the CSS-gradient `angle` contract
 * (0° = to top, clockwise) into objectBoundingBox coordinates. Direction
 * vector (sin θ, −cos θ) centered on the box: 90° (the default) runs
 * left→right, 0° bottom→top. Ids are numbered per page in layer order, so
 * every gradient in one document has a unique anchor.
 */
function gradientFactory(): (
  fill: { from: string; to: string; angle?: number },
) => { defs: string; fill: string } {
  let next = 0;
  return (fill) => {
    const id = `grad-${++next}`;
    const a = ((fill.angle ?? LAYER_DEFAULTS.fillAngle) * Math.PI) / 180;
    const dx = Math.sin(a) / 2;
    const dy = -Math.cos(a) / 2;
    return {
      defs:
        `<defs><linearGradient id="${id}" x1="${n(0.5 - dx)}" y1="${n(0.5 - dy)}" ` +
        `x2="${n(0.5 + dx)}" y2="${n(0.5 + dy)}">` +
        `<stop offset="0" stop-color="${fill.from}"/><stop offset="1" stop-color="${fill.to}"/>` +
        `</linearGradient></defs>`,
      fill: `url(#${id})`,
    };
  };
}

/**
 * One shape as an inline SVG sized exactly to its layer box (viewBox = box),
 * so shape geometry needs no scaling math: rect fills the box, ellipse is
 * inscribed, triangle has its apex top-center. `overflow:visible` lets a
 * centered border stroke paint outside the box — the same outside-the-glyphs
 * contract text stroke has.
 */
function shapeMarkup(
  layer: ShapeLayer,
  gradient: ReturnType<typeof gradientFactory>,
): string {
  const W = n(layer.size.width);
  const H = n(layer.size.height);
  let fill = layer.color ?? LAYER_DEFAULTS.color;
  let defs = "";
  if (layer.fill) {
    const g = gradient(layer.fill);
    defs = g.defs;
    fill = g.fill;
  }
  const border = layer.border
    ? ` stroke="${layer.border.color}" stroke-width="${n(layer.border.width)}"`
    : "";
  // Clamp here with CSS border-radius semantics — radius ≥ half the shorter
  // side is a pill — rather than the browser's SVG clamp, which narrows only
  // the axis it hits and would not round into a pill.
  const r = layer.radius !== undefined ? Math.min(layer.radius, W / 2, H / 2) : 0;
  const radius = layer.shape === "rect" && r > 0 ? ` rx="${n(r)}" ry="${n(r)}"` : "";
  const geom =
    layer.shape === "rect"
      ? `<rect x="0" y="0" width="${W}" height="${H}"${radius}`
      : layer.shape === "ellipse"
        ? `<ellipse cx="${n(W / 2)}" cy="${n(H / 2)}" rx="${n(W / 2)}" ry="${n(H / 2)}"`
        : `<polygon points="${n(W / 2)},0 0,${H} ${W},${H}"`;
  return (
    `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:100%;overflow:visible;display:block">` +
    `${defs}${geom} fill="${fill}"${border}/></svg>`
  );
}

/**
 * Per-page arrowhead marker factory: the overlay's auto-oriented triangle,
 * sized relative to the stroke width (markerUnits strokeWidth) and colored
 * with its connector's line. Ids are numbered per page in layer order.
 */
function markerFactory(): (color: string) => { defs: string; ref: string } {
  let next = 0;
  return (color) => {
    const id = `arrow-${++next}`;
    const m = ARROW_MARKER;
    return {
      defs:
        `<defs><marker id="${id}" viewBox="0 0 ${m.viewBox} ${m.viewBox}" refX="${m.refX}" refY="${m.refY}" ` +
        `markerWidth="${m.markerWidth}" markerHeight="${m.markerWidth}" orient="auto" markerUnits="strokeWidth">` +
        `<path d="M ${m.tipMin} ${m.tipMin} L ${m.tipMax} ${m.refY} L ${m.tipMin} ${m.tipMax} Z" fill="${color}"/></marker></defs>`,
      ref: `url(#${id})`,
    };
  };
}

/**
 * One connector as a pixel-space full-canvas SVG (viewBox = canvas, so
 * stroke-width means frame px — the non-scaling-stroke trap stays out).
 * `boxes` maps every top-level non-connector id to its box; the load gate
 * guarantees both targets resolve.
 */
function connectorMarkup(
  layer: ConnectorLayer,
  canvas: { width: number; height: number },
  boxes: Map<string, Box>,
  marker: ReturnType<typeof markerFactory>,
): string {
  const g = connectorGeometry(boxes.get(layer.from)!, boxes.get(layer.to)!, layer.bow ?? 0);
  const color = layer.color ?? LAYER_DEFAULTS.color;
  const width = layer.width ?? LAYER_DEFAULTS.connectorWidth;
  const dash = layer.dash ? ` stroke-dasharray="${layer.dash.map(n).join(" ")}"` : "";
  let defs = "";
  let markerRef = "";
  if (layer.arrow) {
    const m = marker(color);
    defs = m.defs;
    markerRef = ` marker-end="${m.ref}"`;
  }
  return (
    `<svg viewBox="0 0 ${canvas.width} ${canvas.height}" style="width:100%;height:100%;overflow:visible;display:block">` +
    `${defs}<path d="M ${g.x1} ${g.y1} Q ${g.cx} ${g.cy} ${g.x2} ${g.y2}" ` +
    `fill="none" stroke="${color}" stroke-width="${n(width)}"${dash}${markerRef}/></svg>`
  );
}

/**
 * One span as an inline element carrying only its overrides — everything
 * unset inherits the layer element's inline styles through CSS inheritance.
 */
function spanMarkup(span: TextSpan, layerHasGradient: boolean): string {
  const styles: string[] = [];
  if (span.font) styles.push(`font-family:'${resolveFace(span.font).family}'`);
  if (span.weight !== undefined) styles.push(`font-weight:${span.weight}`);
  if (span.fontSize !== undefined) styles.push(`font-size:${span.fontSize}px`);
  if (span.tracking !== undefined) styles.push(`letter-spacing:${span.tracking}em`);
  if (span.casing && span.casing !== "none")
    styles.push(`text-transform:${CASING_CSS[span.casing]}`);
  if (span.color !== undefined)
    styles.push(
      layerHasGradient ? `-webkit-text-fill-color:${span.color}` : `color:${span.color}`,
    );
  const attr = styles.length ? ` style="${styles.join(";")}"` : "";
  return `<span${attr}>${esc(span.text)}</span>`;
}

function layerMarkup(
  resolved: ResolvedScene,
  layer: SceneLayer,
  natural: Map<string, ImageSize>,
  gradient: ReturnType<typeof gradientFactory>,
  boxes: Map<string, Box>,
  marker: ReturnType<typeof markerFactory>,
): string {
  const { opacity, visible } = layer;
  const canvas = resolved.scene.canvas;
  // A connector is canvas-sized — its geometry is the SVG path, so the
  // wrapper positions the full frame rather than a layer box.
  const styles =
    layer.type === "connector"
      ? ["left:0px", "top:0px", `width:${canvas.width}px`, `height:${canvas.height}px`]
      : [
          `left:${layer.position.x}px`,
          `top:${layer.position.y}px`,
          `width:${layer.size.width}px`,
          `height:${layer.size.height}px`,
        ];
  if (opacity !== undefined) styles.push(`opacity:${opacity}`);
  if (visible === false) styles.push("display:none");
  if (layer.type === "image" || layer.type === "group") {
    const filter = effectsFilter(layer.effects);
    if (filter) styles.push(filter);
  }
  // A masked adjustment blends against this layer's own content (REQ-019) —
  // isolate the wrapper's stacking context so the blend can never see
  // layers underneath it.
  if (layer.type === "image" && layer.adjust) styles.push("isolation:isolate");
  const crop = layer.type === "image" && layer.crop ? "overflow:hidden;" : "";
  // A group is a positioned container: children render at their group-local
  // coordinates inside it and transform with it. Nothing flattens — every
  // child stays an addressable layer element. Connectors are top-level only
  // (the load gate rejects nested ones), so the recursion never sees one.
  const children =
    layer.type === "group"
      ? layer.layers.map((c) => layerMarkup(resolved, c, natural, gradient, boxes, marker)).join("")
      : layer.type === "image"
        ? imageMarkup(layer, imageUri(resolved, layer.id), natural.get(layer.id), maskUri(resolved, layer.id))
        : layer.type === "shape"
          ? shapeMarkup(layer, gradient)
          : layer.type === "connector"
            ? connectorMarkup(layer, canvas, boxes, marker)
            : textMarkup(layer);
  return `<div class="scene-layer" data-layer-id="${esc(layer.id)}" style="position:absolute;${crop}${styles.join(
    ";",
  )};${layer.type === "connector" ? "" : transformCss(layer)}">${children}</div>`;
}

function imageUri(resolved: ResolvedScene, layerId: string): string {
  const asset = resolved.assets.get(layerId)!;
  return `data:${asset.mediaType};base64,${Buffer.from(asset.bytes).toString("base64")}`;
}

/** The data URI of the mask resolved for an adjusted layer, if any (REQ-019). */
function maskUri(resolved: ResolvedScene, layerId: string): string | undefined {
  const mask = resolved.masks.get(layerId);
  return mask ? `data:${mask.mediaType};base64,${Buffer.from(mask.bytes).toString("base64")}` : undefined;
}

/**
 * The page HTML for a resolved Scene. `natural` supplies each cropped image
 * layer's intrinsic size (layer id → size); renderScene measures the real
 * bytes in the browser, tests can pass known fixture sizes.
 */
export function scenePageHtml(
  resolved: ResolvedScene,
  natural: Map<string, ImageSize> = new Map(),
): string {
  const { scene } = resolved;
  const fontCss = fontFaceCss(...sceneFaces(resolved));
  const gradient = gradientFactory();
  const marker = markerFactory();
  // Connector targets resolve against the scene's top-level boxes (the load
  // gate has already rejected dangling ids and connectors-as-targets).
  const boxes = new Map<string, Box>();
  for (const l of scene.layers) {
    if (l.type === "connector" || boxes.has(l.id)) continue;
    boxes.set(l.id, { x: l.position.x, y: l.position.y, width: l.size.width, height: l.size.height });
  }
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  * { margin:0; padding:0; box-sizing:border-box; }
  ${fontCss}
  body { width:${scene.canvas.width}px; height:${scene.canvas.height}px; overflow:hidden; position:relative; background:#fff; }
  .scene-layer { transform-origin:center; }
</style></head><body>
  ${scene.layers.map((layer) => layerMarkup(resolved, layer, natural, gradient, boxes, marker)).join("\n  ")}
</body></html>`;
}

/**
 * Browser-side intrinsic-size probe for one data-URI image. Must stay
 * self-contained — Playwright serializes it into the page.
 */
const loadImageSize = (uri: string): Promise<{ w: number; h: number }> =>
  new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => reject(new Error("image failed to decode"));
    img.src = uri;
  });

/**
 * The guideline overlay (REQ-012): one labeled div per protected region, in
 * a <style> block (nested quotes inside a style attribute truncate silently).
 * Scoped to .safe-guide so the selectors can never touch scene-layer or SVG
 * marker elements. Only the guideline page ever includes this markup —
 * scenePageHtml cannot, so the overlay structurally cannot enter a final
 * render's output.
 */
function guidelineOverlayMarkup(): string {
  const regions = PROTECTED_REGIONS.map(
    (r) =>
      `<div class="safe-guide" data-region-id="${esc(r.id)}" data-region-label="${esc(r.label)}" ` +
      `title="${esc(r.reason)}" ` +
      `style="left:${r.box.x}px;top:${r.box.y}px;width:${r.box.width}px;height:${r.box.height}px;">` +
      `<span>${esc(r.label)}</span></div>`,
  ).join("");
  return (
    `<style>` +
    `.safe-guide{position:absolute;outline:3px dashed #ff00ff;outline-offset:-3px;background:rgba(255,0,255,0.18);}` +
    `.safe-guide span{position:absolute;left:6px;top:6px;font:bold 14px/18px sans-serif;color:#cc00cc;}` +
    `</style>${regions}`
  );
}

/**
 * The guideline-view page: the resolved Scene's own page with the protected-
 * region overlay appended before </body> — the scene markup itself is byte-
 * identical to a final render's, so the view shows exactly what would render
 * plus the regions YouTube's UI covers.
 */
export function guidelinePageHtml(
  resolved: ResolvedScene,
  natural: Map<string, ImageSize> = new Map(),
): string {
  return scenePageHtml(resolved, natural).replace(
    "</body>",
    `${guidelineOverlayMarkup()}\n</body>`,
  );
}

/** Intrinsic sizes for every cropped image layer (at any depth), measured from the real bytes. */
async function measureCroppedImages(
  page: Page,
  resolved: ResolvedScene,
): Promise<Map<string, ImageSize>> {
  const natural = new Map<string, ImageSize>();
  for (const layer of layerTree(resolved.scene.layers)) {
    if (layer.type !== "image" || !layer.crop || natural.has(layer.id)) continue;
    const { w, h } = await page.evaluate(loadImageSize, imageUri(resolved, layer.id));
    if (!w || !h)
      throw new Error(
        `layer "${layer.id}" crops its asset but the image has no intrinsic size — ` +
          `declare width/height (or a viewBox) so crop+fit geometry can be computed`,
      );
    natural.set(layer.id, { width: w, height: h });
  }
  return natural;
}

/**
 * Browser-side shrink-to-fit for one auto-fit text layer, addressed by its
 * stable `data-layer-id` — a missing element is a render-contract bug and
 * throws, never a silently skipped layer. Binary-searches the largest size
 * in [min, max] whose text stays inside the layer box; if even `min`
 * overflows, `min` renders and the caller is told the floor was hit — the
 * floor is honored, not a guarantee. Span font sizes are absolute and never
 * scaled. Stroke width is an explicit scene value and stays fixed — unlike
 * compose.ts's headline loop, which rescales stroke with size by design.
 * Returns whether the final size actually fits.
 * Must stay self-contained — Playwright serializes it into the page.
 */
const fitTextLayer = ({
  id,
  min,
  max,
}: {
  id: string;
  min: number;
  max: number;
}): boolean => {
  const layer = [...document.querySelectorAll<HTMLElement>(".scene-layer")].find(
    (el) => el.dataset.layerId === id,
  );
  const box = layer?.firstElementChild;
  if (!box) throw new Error(`auto-fit layer "${id}" has no render element`);
  const el = box as HTMLElement;
  let lo = min;
  let hi = max;
  let best = min;
  for (let i = 0; i < 22; i++) {
    const mid = (lo + hi) / 2;
    el.style.fontSize = `${mid}px`;
    const fits =
      el.scrollWidth <= el.clientWidth + 1 &&
      el.scrollHeight <= el.clientHeight + 1;
    if (fits) {
      best = mid;
      lo = mid;
    } else {
      hi = mid;
    }
  }
  el.style.fontSize = `${best}px`;
  return (
    el.scrollWidth <= el.clientWidth + 1 && el.scrollHeight <= el.clientHeight + 1
  );
};

/**
 * The browser pipeline renderScene and renderGuidelines share: measure
 * cropped images, build the page HTML, verify fonts resolved, run auto-fit,
 * screenshot. The page's HTML — and nothing else — is what distinguishes a
 * final render from the guideline view.
 */
async function renderResolvedToPng(
  resolved: ResolvedScene,
  buildHtml: (natural: Map<string, ImageSize>) => string,
  opts?: { page?: Page },
): Promise<SceneRenderResult> {
  const render = async (page: Page): Promise<SceneRenderResult> => {
    const natural = await measureCroppedImages(page, resolved);
    await page.setContent(buildHtml(natural), { waitUntil: "load" });

    // Same probe compose.ts uses: if a requested family did not resolve from
    // its bundled bytes, fail naming it before a screenshot is accepted.
    const unresolved: string[] = [];
    for (const face of sceneFaces(resolved)) {
      if (!(await page.evaluate(familyResolved, face.family))) unresolved.push(face.family);
    }
    if (unresolved.length) {
      throw new Error(
        `Font(s) failed to resolve from bundled bytes: ${unresolved.join(", ")}. ` +
          `Silent fallback is not allowed — check assets/fonts/.`,
      );
    }

    // Auto-fit runs only after every face is force-loaded, so measurements
    // see final glyph metrics, not fallback shapes. A layer that cannot fit
    // even at its `min` floor still renders — but is reported, never silent.
    const warnings: string[] = [];
    for (const layer of layerTree(resolved.scene.layers)) {
      if (layer.type !== "text" || !layer.autoFit) continue;
      const fitted = await page.evaluate(fitTextLayer, {
        id: layer.id,
        ...layer.autoFit,
      });
      if (!fitted)
        warnings.push(
          `auto-fit could not fit layer "${layer.id}" — rendered at the ` +
            `${layer.autoFit.min}px floor and the text overflows its box`,
        );
    }

    const png = await page.screenshot({ type: "png" });
    return {
      png,
      width: resolved.scene.canvas.width,
      height: resolved.scene.canvas.height,
      warnings,
    };
  };
  // An injected page is caller-owned: used as-is, never closed or replaced,
  // and not subject to the shared page's serialization. Otherwise the render
  // runs on the one shared page — a viewport resize, not a context cycle.
  if (opts?.page) return render(opts.page);
  return withRenderPage(async (page) => {
    await page.setViewportSize({
      width: resolved.scene.canvas.width,
      height: resolved.scene.canvas.height,
    });
    return render(page);
  });
}

/**
 * Render a resolved Scene to a PNG. Fails loudly when a text face does not
 * resolve from its bundled bytes — silent fallback never reaches a screenshot.
 * Pass `page` to render in an existing page (tests inject route-blocked ones).
 *
 * The returned `warnings` are the complete set — scene-level signals plus
 * safe-area violations (ADR-0005) — assembled here, at the one home every
 * render path (base, variants, rerender) reads through.
 */
export async function renderScene(
  resolved: ResolvedScene,
  opts?: { page?: Page },
): Promise<SceneRenderResult> {
  const result = await renderResolvedToPng(resolved, (natural) => scenePageHtml(resolved, natural), opts);
  return { ...result, warnings: [...result.warnings, ...safeAreaWarnings(resolved)] };
}

/**
 * Render the guideline view: the resolved Scene exactly as renderScene would
 * draw it, plus the protected-region overlay (REQ-012). A review artifact —
 * it never passes through finalize/manifest, and the overlay markup exists
 * only on this code path, so a final render cannot contain it. Its warnings
 * are scene-level signals only: the regions are visible in the image itself.
 */
export async function renderGuidelines(
  resolved: ResolvedScene,
  opts?: { page?: Page },
): Promise<SceneRenderResult> {
  return renderResolvedToPng(resolved, (natural) => guidelinePageHtml(resolved, natural), opts);
}

// --- contact sheet ---------------------------------------------------------------

/** One reviewed output: its label (variant name) and rendered full-size PNG. */
export interface ContactSheetEntry {
  label: string;
  png: Buffer;
}

/**
 * Batch-review sheet: every rendered output side by side at 168px wide —
 * YouTube's review size — with its label underneath, on one white canvas.
 * The PNGs arrive as data URIs; the sheet never touches the network. The
 * cell width is the review contract: 168px per output, 8px padding and gaps.
 */
export const CONTACT_CELL = 168;
const CONTACT_PAD = 8;
const CONTACT_GAP = 8;

export async function renderContactSheet(entries: ContactSheetEntry[]): Promise<{
  png: Buffer;
  width: number;
  height: number;
}> {
  if (entries.length === 0) throw new Error("a contact sheet needs at least one rendered output");
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { background:#fff; padding:${CONTACT_PAD}px; display:flex; gap:${CONTACT_GAP}px; width:max-content; }
  .cell { width:${CONTACT_CELL}px; }
  .cell img { width:${CONTACT_CELL}px; display:block; }
  .cell .label { height:22px; line-height:22px; font:12px/22px sans-serif; color:#333;
                 overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  </style></head><body>
  ${entries
    .map(
      (e) =>
        `<div class="cell"><img src="data:image/png;base64,${e.png.toString("base64")}">` +
        `<div class="label">${esc(e.label)}</div></div>`,
    )
    .join("\n")}
  </body></html>`;
  // The shared render page: a viewport resize, not a context cycle (issue #27).
  // Playwright's default viewport is 1280×720 — restated so the sheet's cell
  // layout is identical however a previous render left the shared page.
  return withRenderPage(async (page) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.setContent(html, { waitUntil: "load" });
    const png = await page.locator("body").screenshot({ type: "png" });
    const box = await page.locator("body").boundingBox();
    if (!box) throw new Error("contact sheet body did not render a measurable box");
    return {
      png,
      width: CONTACT_PAD + entries.length * CONTACT_CELL + (entries.length - 1) * CONTACT_GAP + CONTACT_PAD,
      height: Math.round(box.height),
    };
  });
}
