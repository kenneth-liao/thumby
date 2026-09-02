/**
 * Reference comparison (REQ-020, DEC-003): the local, deterministic review
 * loop between an editable Scene's Render and its associated Reference
 * Thumbnail. The reference is review metadata, never Render input — it is
 * associated at the Scene's top level (`reference.path`), the renderer and
 * the manifest ignore it entirely, and only `scene validate` and
 * `scene compare` read the file itself.
 *
 * Two seams live here:
 *
 * - `checkReference` — the one validator for the association: containment
 *   (a relocatable bundle never references files outside its directory),
 *   existence, format (PNG — JPEG and friends get a convert-locally hint
 *   instead of a new decoder), and exact canvas alignment (1280×720, so
 *   overlay and difference views are pixel-aligned). It decodes once and
 *   hands the pixels to the only consumer that needs them.
 *
 * - `diffPng` / `renderCompareSheet` — the compare artifacts: a per-channel
 *   absolute difference PNG and an offline HTML sheet showing reference and
 *   Render side by side at full size and 168px, an adjustable alpha overlay
 *   (CSS-only radio steps — the sheet keeps the script-free CSP, so the
 *   adjustment cannot be a JavaScript slider), and the difference view.
 *   Same executable-document boundary as the creator review sheet: every
 *   interpolation is context-escaped, image srcs go through `pathToFileURL`,
 *   and the CSP forbids script and remote loading.
 *
 * The artifacts are derived output — regenerable at any time from the scene
 * and the reference file. Nothing here writes a manifest or feeds back into
 * Scenes, the library, or the Render layer list. No pixel matching, OCR, or
 * decomposition (OOS-004, OOS-005): the sheet is evidence for the external
 * agent, which reads it and writes the next Scene edit.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { decodePng, encodePngRgba, PngParseError } from "./png.js";
import type { Scene, SceneError } from "./scene.js";
import { escapeHtml, fileUrl } from "./html.js";
import { outsideDir, escapesDirReal } from "./paths.js";

/** The canvas a reference must align with — the one output profile (DEC-002). */
export const REFERENCE_WIDTH = 1280;
export const REFERENCE_HEIGHT = 720;

export interface CheckedReference {
  /** Absolute path the reference resolved to. */
  path: string;
  width: number;
  height: number;
  /** Decoded RGBA pixels — read once here, consumed by the difference pass. */
  rgba: Buffer;
  /** The exact encoded PNG bytes read once at validation — a consumer that
   *  re-serves the reference (the author session) uses these, never a reread
   *  that could pick up drifted file content. */
  bytes: Buffer;
}

export type ReferenceCheck =
  | { ok: true; reference?: CheckedReference }
  | { ok: false; errors: SceneError[] };

/**
 * Validate the Scene's reference association. Absent `reference` is a no-op —
 * the field is optional review metadata. Every failure names `reference.path`
 * and says what would fix it.
 */
export async function checkReference(projectRoot: string, scene: Scene): Promise<ReferenceCheck> {
  const authored = scene.reference?.path;
  if (!authored) return { ok: true };
  const absolute = path.resolve(projectRoot, authored);
  const fail = (message: string): { ok: false; errors: SceneError[] } => ({
    ok: false,
    errors: [{ path: "reference.path", message }],
  });
  if (outsideDir(projectRoot, absolute))
    return fail(
      `"${authored}" must stay inside the scene's directory (${projectRoot}) — a project bundle is ` +
        `relocatable and cannot reference files outside itself. Move the reference beside the scene.`,
    );
  let bytes: Buffer;
  try {
    bytes = await readFile(absolute);
  } catch {
    return fail(
      `reference thumbnail not found: "${authored}" (resolved to ${absolute}). ` +
        `Save the reference image at that path, or update reference.path.`,
    );
  }
  // Containment is checked on the file actually read — an in-project symlink
  // to an out-of-tree file is still an escape (src/paths.ts, the project-
  // asset precedent in src/assets.ts).
  if (await escapesDirReal(projectRoot, absolute))
    return fail(
      `reference "${authored}" escapes the scene's directory (${projectRoot}) through a symlink — ` +
        `a project bundle cannot reference files outside itself, even through an in-project alias. ` +
        `Move the target file beside the scene.`,
    );
  let width: number;
  let height: number;
  let rgba: Buffer;
  try {
    // Decode (not just header): the difference pass needs the pixels, and a
    // layout this parser cannot represent (palette, 16-bit, interlaced) must
    // fail here with the same actionable contract, not in the compare command.
    const decoded = decodePng(bytes);
    width = decoded.width;
    height = decoded.height;
    rgba = decoded.rgba;
  } catch (err) {
    if (!(err instanceof PngParseError)) throw err;
    return fail(
      `reference "${authored}" is not a PNG file this tool can read. Reference thumbnails must be ` +
        `8-bit PNG — convert a copy locally (e.g. \`sips -s format png "${authored}" --out "${authored}.png"\`) ` +
        `and point reference.path at the PNG.`,
    );
  }
  if (width !== REFERENCE_WIDTH || height !== REFERENCE_HEIGHT)
    return fail(
      `reference "${authored}" is ${width}×${height} — a reference must be exactly ` +
        `${REFERENCE_WIDTH}×${REFERENCE_HEIGHT} so overlay and difference views align with the ` +
        `Render canvas. Scale or crop it locally, then update reference.path.`,
    );
  return { ok: true, reference: { path: absolute, width, height, rgba, bytes } };
}

/**
 * The per-channel absolute difference between a rendered PNG and the decoded
 * reference, output opaque (alpha 255) so the evidence has no hidden holes.
 * Inputs are aligned by construction — the reference gate enforces the exact
 * canvas — and a mismatch would mean a caller skipped the gate, so it fails.
 */
export function diffPng(renderPng: Buffer, reference: CheckedReference): Buffer {
  const render = decodePng(renderPng);
  if (render.width !== reference.width || render.height !== reference.height)
    throw new Error(
      `diff inputs are misaligned: render is ${render.width}×${render.height}, reference is ` +
        `${reference.width}×${reference.height} — checkReference must gate the reference first`,
    );
  const n = render.width * render.height * 4;
  const out = Buffer.alloc(n);
  for (let i = 0; i < n; i += 4) {
    out[i] = Math.abs(render.rgba[i]! - reference.rgba[i]!);
    out[i + 1] = Math.abs(render.rgba[i + 1]! - reference.rgba[i + 1]!);
    out[i + 2] = Math.abs(render.rgba[i + 2]! - reference.rgba[i + 2]!);
    out[i + 3] = 255;
  }
  return encodePngRgba(render.width, render.height, out);
}

export interface CompareSheetInput {
  /** The scene's basename — the sheet's title. */
  scene: string;
  referencePath: string;
  renderPath: string;
  diffPath: string;
}

/**
 * The compare sheet. Views, in order: side by side at full size, side by side
 * at 168px (the YouTube-row size, REQ-027), the adjustable alpha overlay, and
 * the difference. The overlay is CSS-only: radio inputs before the image
 * stack drive opacity through sibling selectors — adjustable without script,
 * so the CSP stays `default-src 'none'` and the sheet stays inert.
 */
export function renderCompareSheet(input: CompareSheetInput): string {
  const src = (p: string) => escapeHtml(fileUrl(p));
  // Opacity steps 0..100 by 10 — discrete, deterministic, no script. 50% is
  // the default view: neither image privileged. The inputs sit directly
  // before the stack (its siblings) so `:checked ~ .stack` drives opacity
  // from pure CSS; the labels stay in the control bar and target by `for`.
  const steps = Array.from({ length: 11 }, (_, i) => i * 10);
  const radios = steps
    .map((v) => `<input type="radio" name="alpha" id="alpha-${v}"${v === 50 ? " checked" : ""}>`)
    .join("");
  const labels = steps.map((v) => `<label for="alpha-${v}">${v}</label>`).join("");
  const rules = steps
    .map(
      (v) =>
        `#alpha-${v}:checked ~ .stack .render{opacity:${v / 100}}` +
        `#alpha-${v}:checked ~ .controls label[for="alpha-${v}"]{background:#26282e;color:#e7e7ea}`,
    )
    .join("\n");
  const frame = (cls: string, srcUrl: string, caption: string) =>
    `<figure class="${cls}"><img src="${srcUrl}" alt="${escapeHtml(caption)}"><figcaption>${escapeHtml(caption)}</figcaption></figure>`;

  return `<!doctype html><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src file:; style-src 'unsafe-inline'">
<title>reference compare — ${escapeHtml(input.scene)}</title>
<style>
${rules}
body{background:#0b0b0d;color:#e7e7ea;font:14px/1.5 -apple-system,sans-serif;margin:0;padding:32px}
h1,h2{font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:#8a8a94;margin:24px 0}
h1{font-size:15px}h2{font-size:12px}
.meta{color:#8a8a94;font-size:12px;margin:0 0 8px}
.pair{display:flex;gap:20px;flex-wrap:wrap;align-items:flex-start}
figure{margin:0;background:linear-gradient(160deg,#16181d,#0e1013);border:1px solid #26282e;border-radius:8px;padding:14px;display:flex;flex-direction:column;align-items:center;gap:10px}
.full img{display:block;width:1280px;max-width:100%;height:auto;border-radius:4px}
.small img{display:block;width:168px;height:auto;border-radius:2px}
figcaption{font-size:11px;color:#8a8a94;font-family:ui-monospace,monospace;text-align:center}
.controls{display:flex;align-items:center;gap:6px;margin:0 0 12px;font-size:11px;color:#8a8a94}
input[name="alpha"]{position:absolute;opacity:0;pointer-events:none}
.controls label{border:1px solid #26282e;border-radius:4px;padding:2px 8px;cursor:pointer;pointer-events:auto}
.stack{position:relative;width:1280px;max-width:100%;aspect-ratio:16/9;border-radius:4px;overflow:hidden}
.stack img{position:absolute;inset:0;width:100%;height:100%;display:block}
.stack .render{opacity:.5}
</style>
<h1>Reference compare · ${escapeHtml(input.scene)}</h1>
<p class="meta">reference: ${escapeHtml(input.referencePath)} · the reference is a structural and stylistic target (DEC-003), not a pixel goal — the difference view shows where pixels disagree, the agent decides what matters</p>
<h2>side by side — full size</h2>
<div class="pair">
  ${frame("full", src(input.referencePath), "reference")}
  ${frame("full", src(input.renderPath), "render")}
</div>
<h2>side by side — 168px (YouTube row)</h2>
<div class="pair">
  ${frame("small", src(input.referencePath), "reference · 168px")}
  ${frame("small", src(input.renderPath), "render · 168px")}
</div>
<h2>alpha overlay — render over reference, adjustable</h2>
${radios}
<div class="controls">opacity ${labels}</div>
<div class="stack">
  <img src="${src(input.referencePath)}" alt="reference (under)">
  <img class="render" src="${src(input.renderPath)}" alt="render (over)">
</div>
<h2>difference — per-channel |render − reference|</h2>
${frame("full", src(input.diffPath), "difference")}
</body>`;
}
