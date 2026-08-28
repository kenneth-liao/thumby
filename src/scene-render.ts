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
import type { Page, BrowserContext } from "playwright";
import { getBrowser } from "./browser.js";
import {
  fontFaceCss,
  familyResolved,
  resolveFace,
  type FontFace,
} from "./fonts.js";
import type { ResolvedScene, ImageLayer, TextLayer } from "./scene.js";

export interface SceneRenderResult {
  png: Buffer;
  width: number;
  height: number;
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

/** Rounding that keeps geometry readable without visible drift. */
const n = (v: number) => Number(v.toFixed(4));

/** The bundled faces a scene's text layers name, deduped in scene order. */
export function sceneFaces(resolved: ResolvedScene): FontFace[] {
  const faces: FontFace[] = [];
  for (const layer of resolved.scene.layers) {
    if (layer.type !== "text") continue;
    const face = resolveFace(layer.font);
    if (!faces.includes(face)) faces.push(face);
  }
  return faces;
}

function transformCss(layer: { rotation?: number; mirror?: boolean }): string {
  const parts: string[] = [];
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
): string {
  const fit = layer.fit ?? "cover";
  if (!layer.crop) {
    return `<img src="${uri}" style="width:100%;height:100%;object-fit:${fit};display:block;">`;
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
    `<img src="${uri}" style="position:absolute;left:${img.x}px;top:${img.y}px;width:${img.width}px;height:${img.height}px;display:block;">` +
    `</div>`
  );
}

function textMarkup(layer: TextLayer): string {
  // The family comes from the bundled-face registry, not the raw scene field —
  // the validated scene can only name fonts whose bytes the renderer ships.
  const face = resolveFace(layer.font);
  const lineHeight = layer.lineHeight ?? 1.1;
  return `<div style="width:100%;height:100%;font-family:'${face.family}';font-weight:${face.weight};font-size:${layer.fontSize}px;color:${layer.color ?? "#000"};text-align:${layer.align ?? "left"};line-height:${lineHeight};white-space:pre-line;overflow-wrap:break-word;">${esc(
    layer.text,
  )}</div>`;
}

function layerMarkup(
  resolved: ResolvedScene,
  layer: ImageLayer | TextLayer,
  natural: Map<string, ImageSize>,
): string {
  const { position, size, opacity, visible } = layer;
  const styles = [
    `left:${position.x}px`,
    `top:${position.y}px`,
    `width:${size.width}px`,
    `height:${size.height}px`,
  ];
  if (opacity !== undefined) styles.push(`opacity:${opacity}`);
  if (visible === false) styles.push("display:none");
  const crop = layer.type === "image" && layer.crop ? "overflow:hidden;" : "";
  const inner =
    layer.type === "image"
      ? imageMarkup(layer, imageUri(resolved, layer.id), natural.get(layer.id))
      : textMarkup(layer);
  return `<div class="scene-layer" data-layer-id="${esc(layer.id)}" style="position:absolute;${crop}${styles.join(
    ";",
  )};${transformCss(layer)}">${inner}</div>`;
}

function imageUri(resolved: ResolvedScene, layerId: string): string {
  const asset = resolved.assets.get(layerId)!;
  return `data:${asset.mediaType};base64,${Buffer.from(asset.bytes).toString("base64")}`;
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
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  * { margin:0; padding:0; box-sizing:border-box; }
  ${fontCss}
  body { width:${scene.canvas.width}px; height:${scene.canvas.height}px; overflow:hidden; position:relative; background:#fff; }
  .scene-layer { transform-origin:center; }
</style></head><body>
  ${scene.layers.map((layer) => layerMarkup(resolved, layer, natural)).join("\n  ")}
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

/** Intrinsic sizes for every cropped image layer, measured from the real bytes. */
async function measureCroppedImages(
  page: Page,
  resolved: ResolvedScene,
): Promise<Map<string, ImageSize>> {
  const natural = new Map<string, ImageSize>();
  for (const layer of resolved.scene.layers) {
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
 * Render a resolved Scene to a PNG. Fails loudly when a text face does not
 * resolve from its bundled bytes — silent fallback never reaches a screenshot.
 * Pass `page` to render in an existing page (tests inject route-blocked ones).
 */
export async function renderScene(
  resolved: ResolvedScene,
  opts?: { page?: Page },
): Promise<SceneRenderResult> {
  let ctx: BrowserContext | undefined;
  const page =
    opts?.page ??
    (await (async () => {
      ctx = await (await getBrowser()).newContext({
        viewport: {
          width: resolved.scene.canvas.width,
          height: resolved.scene.canvas.height,
        },
        deviceScaleFactor: 1,
      });
      return ctx.newPage();
    })());
  try {
    const natural = await measureCroppedImages(page, resolved);
    await page.setContent(scenePageHtml(resolved, natural), { waitUntil: "load" });

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

    const png = await page.screenshot({ type: "png" });
    return { png, width: resolved.scene.canvas.width, height: resolved.scene.canvas.height };
  } finally {
    await ctx?.close();
  }
}
