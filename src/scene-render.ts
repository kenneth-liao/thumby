/**
 * Generic Scene renderer — ordered layers composited into a 1280×720 PNG.
 *
 * Built without specialized layout branches: the Scene's
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

/** One mask-* declaration, standard then -webkit- — Chromium supports both, and
 *  the code then says what the schema and README say (`mask-image`). */
function maskCss(prop: string, value: string): string {
  return `${prop}:${value};-webkit-${prop}:${value};`;
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
  return (
    `<div style="position:absolute;${pos}background:${layer.tint};` +
    maskCss("mask-image", `url('${uri}')`) +
    maskCss("mask-size", maskSize) +
    maskCss("mask-position", "center") +
    maskCss("mask-repeat", "no-repeat") +
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
  // Standard mask-* first, -webkit- alongside — see maskCss.
  return (
    `<div style="position:absolute;${pos}background:${layer.adjust.color};` +
    maskCss("mask-image", `url('${maskUri}')`) +
    maskCss("mask-size", maskSize) +
    maskCss("mask-position", "center") +
    maskCss("mask-repeat", "no-repeat") +
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
 * Text stroke rescales with size by design.
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
 * final render from the guideline view. `inspect` adds the canonical layer
 * inspection (#59) to the same pass: bounds are measured from the rendered
 * DOM after crop sizing, fonts, and auto-fit — never before — so the PNG
 * and the inspection describe one render.
 */
async function renderResolvedToPng(
  resolved: ResolvedScene,
  buildHtml: (natural: Map<string, ImageSize>) => string,
  opts?: { page?: Page; inspect?: boolean },
): Promise<SceneRenderResult & { layers?: RenderedLayer[] }> {
  const render = async (page: Page): Promise<SceneRenderResult> => {
    const natural = await measureCroppedImages(page, resolved);
    await page.setContent(buildHtml(natural), { waitUntil: "load" });

    // If a requested family did not resolve from
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

    // Canonical layer inspection (#59) — same pass, measured after auto-fit:
    // the spec (ids/types/order/effective visibility) comes from the one
    // resolved tree walk; bounds come only from the browser DOM of the exact
    // rendered elements (wrapper for non-connectors, the connector's own
    // path). Measuring paints nothing, so the screenshot is unchanged.
    let layers: RenderedLayer[] | undefined;
    if (opts?.inspect) {
      const spec = [...inspectionLayers(resolved.scene.layers)];
      const measured = await page.evaluate(collectLayerBounds, spec);
      layers = spec.map((s, i): RenderedLayer => {
        const { box, basis, fullBasis, corners } = measured[i]!;
        return box === null
          ? { id: s.id, type: s.type as SceneLayer["type"], visible: false, bounds: null }
          : { id: s.id, type: s.type as SceneLayer["type"], visible: true, bounds: box, basis, fullBasis, corners };
      });
    }

    const png = await page.screenshot({ type: "png" });
    return {
      png,
      width: resolved.scene.canvas.width,
      height: resolved.scene.canvas.height,
      warnings,
      ...(layers ? { layers } : {}),
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

/** The exact frame-px box of rendered paint. */
export interface LayerBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The measured 2×2 linear map from the space a Layer's authored `position`
 * lives in (canvas px at top level, the parent Group's local px when nested)
 * to frame px, row-major: frame = [[a, c], [b, d]] · local. Measured from the
 * rendered DOM's computed ancestor transforms in the same inspection pass
 * (DEC-007: the one transform model is the renderer's own CSS — this only
 * reads what the browser actually applied). Identity at top level.
 */
export interface Basis {
  a: number;
  b: number;
  c: number;
  d: number;
}

/**
 * One resolved Layer as the render pass actually drew it (#59) — a
 * discriminated union, so a hidden Layer carrying bounds (or a visible one
 * without them) is unrepresentable:
 *
 * - `visible: true` carries the exact bounds of the rendered paint in frame
 *   px, browser-measured: the wrapper element for non-connectors
 *   (post-transform — nested, scaled, rotated, and mirrored geometry is
 *   Chromium's own measurement, never a second transform model) and the
 *   connector's exact painted extent (see `collectLayerBounds`).
 * - `visible: false` — `visible: false` or exactly `opacity: 0` on the layer
 *   itself or any ancestor Group — paints nothing, so bounds are absent:
 *   null, never a zero-size box.
 */
/** One authored box corner's frame-px position, DOM-measured (#61). */
export interface LayerPoint {
  x: number;
  y: number;
}

/** The four authored box corners of a positioned Layer, in frame px (#61). */
export interface LayerCorners {
  nw: LayerPoint;
  ne: LayerPoint;
  se: LayerPoint;
  sw: LayerPoint;
}

export interface VisibleRenderedLayer {
  id: string;
  type: SceneLayer["type"];
  visible: true;
  bounds: LayerBox;
  /**
   * The measured local→frame linear map for this Layer's position (#60):
   * inverting it turns a frame-px drag delta into the authored delta. A
   * Connector has no authored position; its basis is the identity map.
   */
  basis: Basis;
  /**
   * The measured local→frame linear map including the Layer's own transform
   * (#61): the box-corner map a resize drag decomposes. A Connector has no
   * authored box; its full basis is the identity map.
   */
  fullBasis: Basis;
  /**
   * The four authored box corners, measured directly in the render DOM (#61):
   * paintless zero-size markers at the box's corners, read through the
   * browser's own ancestor+own transforms — never inferred from the painted
   * AABB. Null only for a Connector (no authored box of its own).
   */
  corners: LayerCorners | null;
}

/** A Layer that paints nothing — hidden or fully transparent, at any depth. */
export interface HiddenRenderedLayer {
  id: string;
  type: SceneLayer["type"];
  visible: false;
  bounds: null;
}

export type RenderedLayer = VisibleRenderedLayer | HiddenRenderedLayer;

export interface SceneInspectionResult extends SceneRenderResult {
  /** Every layer in the scene tree, depth-first — the render's own order. */
  layers: RenderedLayer[];
}

/**
 * The inspection spec: every layer in tree order with its effective paint
 * visibility — a layer paints nothing when it or any ancestor Group is
 * `visible: false` or exactly `opacity: 0`. Ids are unique (the load gate
 * rejects duplicates), so the browser can address each element by its stable
 * `data-layer-id`.
 */
function* inspectionLayers(
  layers: SceneLayer[],
  painted = true,
): Generator<{ id: string; type: string; visible: boolean }> {
  for (const layer of layers) {
    const own =
      (layer.visible ?? LAYER_DEFAULTS.visible) &&
      (layer.opacity ?? LAYER_DEFAULTS.opacity) !== 0;
    yield { id: layer.id, type: layer.type, visible: painted && own };
    if (layer.type === "group") yield* inspectionLayers(layer.layers, painted && own);
  }
}

/*
 * Browser-side bounds probe for the inspection pass (#59). Non-connectors
 * measure their wrapper element — post-transform, so nested, scaled,
 * rotated, and mirrored geometry is Chromium's own measurement, never a
 * second transform model.
 *
 * A connector's wrapper is the full canvas; its bounds are its exact painted
 * AABB: the connector's own rendered SVG — the same svg/path/marker markup
 * the browser painted — is cloned (the live DOM is never touched), given
 * explicit pixel dimensions, and rasterized through an unattached canvas
 * from a data URI; scanning nonzero alpha yields the pixel AABB of what
 * actually painted, covering stroke, dash, curve bow, and the auto-oriented
 * arrow marker with no transform model and no conservative envelope. Only
 * when nothing painted (degenerate geometry) does it fall back to the path's
 * geometry box widened by its own computed stroke. The rasterization is
 * inlined because Playwright serializes only this function into the page —
 * it must stay self-contained.
 *
 * The rasterization is bounded (PROD-1): connector scans run strictly
 * sequentially and share one reused full-canvas buffer, cleared between
 * scans — a connector-heavy Scene holds at most one canvas and one decoded
 * ImageData at a time, never one allocation per connector.
 */
const collectLayerBounds = async (
  spec: { id: string; type: string; visible: boolean }[],
): Promise<{ box: LayerBox | null; basis: Basis; fullBasis: Basis; corners: LayerCorners | null }[]> => {
  const els = [...document.querySelectorAll<HTMLElement>(".scene-layer")];
  const round = (v: number) => Number(v.toFixed(4));
  /*
   * The measured local→frame linear bases (#60, #61): the accumulated 2×2
   * linear part of computed transforms along the ancestor .scene-layer chain
   * — the same CSS the renderer emitted, as the browser actually resolved it
   * (transform origins affect only translation, so the linear part composes
   * directly; the Layer's own transform moves its content within its box and
   * never enters the ancestor basis). Reading the DOM — never recomputing
   * scene math — keeps this a consumer of the one transform model (DEC-007).
   */
  const composeLinear = (chain: HTMLElement[]): Basis => {
    let a = 1;
    let b = 0;
    let c = 0;
    let d = 1;
    // Outermost first: frame = M_outer · (M_inner · local).
    for (let i = chain.length - 1; i >= 0; i--) {
      const t = getComputedStyle(chain[i]!).transform;
      if (!t || t === "none") continue;
      const v = t.startsWith("matrix3d(")
        ? t.slice(9, -1).split(",").map(parseFloat)
        : t.startsWith("matrix(")
          ? t.slice(7, -1).split(",").map(parseFloat)
          : null;
      if (!v || v.length < 6) continue;
      const ma = v[0]!;
      const mb = v[1]!;
      const mc = t.startsWith("matrix3d(") ? v[4]! : v[2]!;
      const md = t.startsWith("matrix3d(") ? v[5]! : v[3]!;
      const na = a * ma + c * mb;
      const nb = b * ma + d * mb;
      const nc = a * mc + c * md;
      const nd = b * mc + d * md;
      a = na;
      b = nb;
      c = nc;
      d = nd;
    }
    return {
      // Full measured precision: the movement and resize consumers invert
      // these bases, and rounding here would zero out valid small positive
      // Group scales.
      a,
      b,
      c,
      d,
    };
  };
  const basisOf = (el: HTMLElement): Basis => {
    const chain: HTMLElement[] = [];
    for (let p = el.parentElement; p; p = p.parentElement) {
      if (p.classList.contains("scene-layer")) chain.push(p);
    }
    return composeLinear(chain);
  };
  const fullBasisOf = (el: HTMLElement): Basis => {
    const chain: HTMLElement[] = [el];
    for (let p = el.parentElement; p; p = p.parentElement) {
      if (p.classList.contains("scene-layer")) chain.push(p);
    }
    // Outermost first — the Layer's own transform sits innermost, mapping its
    // authored box axes before the ancestors apply.
    return composeLinear(chain);
  };
  /*
   * The four authored box corners, measured directly in the render DOM (#61):
   * paintless zero-size markers placed at the box's local corners read their
   * own transformed positions through the browser (ancestor + own transforms
   * included) — the corner facts come from the same DOM the pixels came
   * from, never from an AABB reconstruction. The markers are removed before
   * this pass returns, so the screenshot is unchanged (they paint nothing).
   */
  const measureCorners = (el: HTMLElement): LayerCorners => {
    const marker = (left: string, top: string) => {
      const m = document.createElement("span");
      m.style.cssText =
        "position:absolute;width:0;height:0;margin:0;border:0;padding:0;pointer-events:none;";
      m.style.left = left;
      m.style.top = top;
      el.appendChild(m);
      return m;
    };
    const marks = [marker("0", "0"), marker("100%", "0"), marker("100%", "100%"), marker("0", "100%")];
    const points = marks.map((m) => {
      const r = m.getBoundingClientRect();
      return { x: round(r.x), y: round(r.y) };
    });
    for (const m of marks) m.remove();
    return { nw: points[0]!, ne: points[1]!, se: points[2]!, sw: points[3]! };
  };
  let canvas: HTMLCanvasElement | null = null;
  let ctx: CanvasRenderingContext2D | null = null;
  const rasterizePaintedAabb = (
    svg: Element,
    frame: { x: number; y: number; width: number; height: number },
  ): Promise<LayerBox | null> =>
    new Promise((resolve, reject) => {
      const w = Math.max(1, Math.round(frame.width));
      const h = Math.max(1, Math.round(frame.height));
      const clone = svg.cloneNode(true) as SVGSVGElement;
      clone.setAttribute("width", String(w));
      clone.setAttribute("height", String(h));
      clone.removeAttribute("style");
      const uri =
        "data:image/svg+xml;charset=utf-8," +
        encodeURIComponent(new XMLSerializer().serializeToString(clone));
      const img = new Image();
      img.onload = () => {
        if (!canvas) {
          canvas = document.createElement("canvas");
          ctx = canvas.getContext("2d");
          if (!ctx) return reject(new Error("no 2d context for connector rasterization"));
        }
        if (canvas.width !== w) canvas.width = w;
        if (canvas.height !== h) canvas.height = h;
        ctx!.clearRect(0, 0, w, h);
        ctx!.drawImage(img, 0, 0, w, h);
        let data: Uint8ClampedArray;
        try {
          data = ctx!.getImageData(0, 0, w, h).data;
        } catch (err) {
          return reject(err as Error);
        }
        let minX = w;
        let minY = h;
        let maxX = -1;
        let maxY = -1;
        for (let y = 0; y < h; y++) {
          const row = y * w * 4;
          for (let x = 0; x < w; x++) {
            if (data[row + x * 4 + 3] > 0) {
              if (x < minX) minX = x;
              if (x > maxX) maxX = x;
              if (y < minY) minY = y;
              if (y > maxY) maxY = y;
            }
          }
        }
        if (maxX < 0) return resolve(null);
        resolve({ x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 });
      };
      img.onerror = () => reject(new Error("connector rasterization failed to decode"));
      img.src = uri;
    });
  // Strictly sequential: one layer measured at a time, so at most one
  // rasterization canvas and one marker set exist for the whole pass.
  const out: { box: LayerBox | null; basis: Basis; fullBasis: Basis; corners: LayerCorners | null }[] = [];
  for (const s of spec) {
    const el = els.find((e) => e.dataset.layerId === s.id);
    if (!el) throw new Error(`layer "${s.id}" has no rendered element`);
    if (!s.visible) {
      // Self-contained: Playwright serializes only this function into the
      // page, so the identity bases are inline, never a module constant.
      const identity = { a: 1, b: 0, c: 0, d: 1 };
      out.push({ box: null, basis: identity, fullBasis: identity, corners: null });
      continue;
    }
    const basis = basisOf(el);
    if (s.type === "connector") {
      // A Connector has no authored box: corners stay absent; the full basis
      // is still measured (its wrapper carries no own transform, so it equals
      // the ancestor basis — measured, never assumed).
      const fullBasis = fullBasisOf(el);
      const svg = el.querySelector("svg");
      if (!svg) throw new Error(`connector "${s.id}" has no rendered svg`);
      const frame = svg.getBoundingClientRect();
      const painted = await rasterizePaintedAabb(svg, frame);
      if (painted) {
        out.push({
          box: {
            x: round(frame.x + painted.x),
            y: round(frame.y + painted.y),
            width: round(painted.width),
            height: round(painted.height),
          },
          basis,
          fullBasis,
          corners: null,
        });
      } else {
        // Nothing painted (degenerate geometry) — the path's own geometry,
        // widened by its computed stroke so the extent stays nonzero.
        const path = el.querySelector<SVGGeometryElement>("svg > path");
        if (!path) throw new Error(`connector "${s.id}" has no rendered path`);
        const r = path.getBoundingClientRect();
        const sw = parseFloat(getComputedStyle(path).strokeWidth) || 0;
        out.push({
          box: {
            x: round(r.x - sw / 2),
            y: round(r.y - sw / 2),
            width: round(r.width + sw),
            height: round(r.height + sw),
          },
          basis,
          fullBasis,
          corners: null,
        });
      }
    } else {
      const r = el.getBoundingClientRect();
      out.push({
        box: { x: round(r.x), y: round(r.y), width: round(r.width), height: round(r.height) },
        basis,
        fullBasis: fullBasisOf(el),
        corners: measureCorners(el),
      });
    }
  }
  return out;
};

/**
 * Render a resolved Scene and inspect it in the same pass (#59): the PNG is
 * byte-identical to renderScene's, and `layers` reports every resolved Layer
 * once, in tree order, with bounds measured from the rendered DOM after crop
 * sizing, fonts, and auto-fit. Hidden layers (own or ancestor) are listed
 * with `visible: false` and null bounds. Pass `page` to render in an
 * existing page (tests inject route-blocked ones).
 */
export async function renderSceneInspection(
  resolved: ResolvedScene,
  opts?: { page?: Page },
): Promise<SceneInspectionResult> {
  const result = await renderResolvedToPng(
    resolved,
    (natural) => scenePageHtml(resolved, natural),
    { ...opts, inspect: true },
  );
  if (!result.layers) throw new Error("the inspection render produced no layer measurements");
  return {
    png: result.png,
    width: result.width,
    height: result.height,
    warnings: [...result.warnings, ...safeAreaWarnings(resolved)],
    layers: result.layers,
  };
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
