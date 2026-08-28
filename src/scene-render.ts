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

const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** Rounding that keeps crop math readable without visible drift. */
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

function imageMarkup(layer: ImageLayer, uri: string): string {
  const fit = layer.fit ?? "cover";
  if (!layer.crop) {
    return `<img src="${uri}" style="width:100%;height:100%;object-fit:${fit};display:block;">`;
  }
  // The visible window is the source minus the insets; the img is scaled so
  // exactly that window fills the box, then shifted to hide the cropped edges.
  const wv = 100 - layer.crop.left - layer.crop.right;
  const hv = 100 - layer.crop.top - layer.crop.bottom;
  const width = n((100 * 100) / wv);
  const left = n((-100 * layer.crop.left) / wv);
  const height = n((100 * 100) / hv);
  const top = n((-100 * layer.crop.top) / hv);
  return `<img src="${uri}" style="position:absolute;width:${width}%;height:${height}%;left:${left}%;top:${top}%;object-fit:${fit};">`;
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

function layerMarkup(resolved: ResolvedScene, layer: ImageLayer | TextLayer): string {
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
      ? imageMarkup(layer, imageUri(resolved, layer.id))
      : textMarkup(layer);
  return `<div class="scene-layer" data-layer-id="${esc(layer.id)}" style="position:absolute;${crop}${styles.join(
    ";",
  )};${transformCss(layer)}">${inner}</div>`;
}

function imageUri(resolved: ResolvedScene, layerId: string): string {
  const asset = resolved.assets.get(layerId)!;
  return `data:${asset.mediaType};base64,${Buffer.from(asset.bytes).toString("base64")}`;
}

export function scenePageHtml(resolved: ResolvedScene): string {
  const { scene } = resolved;
  const fontCss = fontFaceCss(...sceneFaces(resolved));
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  * { margin:0; padding:0; box-sizing:border-box; }
  ${fontCss}
  body { width:${scene.canvas.width}px; height:${scene.canvas.height}px; overflow:hidden; position:relative; background:#fff; }
  .scene-layer { transform-origin:center; }
</style></head><body>
  ${scene.layers.map((layer) => layerMarkup(resolved, layer)).join("\n  ")}
</body></html>`;
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
    await page.setContent(scenePageHtml(resolved), { waitUntil: "load" });

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
