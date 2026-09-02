/**
 * Reference Thumbnail import (DEC-002, DEC-003, DEC-004): one normalization
 * boundary plus one validated atomic transaction.
 *
 * Normalization accepts a supported local raster file — anything the bundled
 * browser decodes (PNG, JPEG, WebP, GIF first frame, AVIF, BMP) — and produces
 * an exact 1280×720 PNG (the one output profile, src/compare.ts). The policy
 * is deliberately non-distorting and non-subjective: a 16:9 input is uniformly
 * rescaled (1:1 when already exact); any other aspect is refused before
 * anything is written, because fitting it would require an unstated subjective
 * crop or a distortion. The input may live anywhere — it is external source
 * material; only the stored copy must be contained.
 *
 * The transaction never mutates canonical state before the complete resulting
 * Scene passes the existing validation gate (loadScene + checkReference, the
 * same boundary `scene validate` reads through):
 *
 *   1. read + parse the Scene          — failures change nothing,
 *   2. read + normalize the input      — refusals happen before any write,
 *   3. pick the stored path            — contained by construction and never
 *      conflicting: an existing file, directory, or symlink alias is skipped,
 *      never overwritten, so a write can never escape through an alias,
 *   4. write the normalized PNG        — temp + rename inside the bundle,
 *   5. validate the resulting document — a failure unlinks the new copy,
 *   6. commit the Scene JSON           — temp + rename; a commit failure
 *      unlinks the new copy and leaves the previous Scene and its associated
 *      files byte-identical and usable.
 *
 * Provenance (DEC-003) is user-supplied free text recorded as `reference.source`.
 * It is never resolved as a path — the relocatable bundle gains no external
 * file dependency — and content identity continues to derive from the PNG's
 * bytes, so no second hash is stored (ADR-0002).
 */
import { lstat, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { MAX_ENCODED_BYTES } from "./png.js";
import { withRenderPage } from "./browser.js";
import { checkReference, REFERENCE_HEIGHT, REFERENCE_WIDTH } from "./compare.js";
import { loadScene, type SceneError } from "./scene.js";
import { LIBRARY_ROOT, scanLibrary, type Library } from "./assets.js";

/** How many `-N` suffixed names to try before giving up on storage. */
const MAX_NAME_ATTEMPTS = 1000;

/**
 * The in-page mechanics of normalization: decode, then — only when the source
 * aspect matches the target canvas exactly — draw with high-quality resampling
 * and encode a PNG. No policy lives here: the profile dimensions arrive from
 * the caller, so the canonical constants have exactly one home (src/compare.ts).
 * Runs inside the shared render page, serialized with every other render.
 */
const decodeAndScale = async (input: {
  dataUrl: string;
  width: number;
  height: number;
}): Promise<
  | { ok: true; sourceWidth: number; sourceHeight: number; pngDataUrl: string }
  | { ok: false; reason: "decode" | "empty" | "aspect" | "canvas"; sourceWidth?: number; sourceHeight?: number }
> => {
  const img = new Image();
  const settled = new Promise<string | null>((resolve) => {
    img.onload = () => resolve(null);
    img.onerror = () => resolve("decode");
  });
  img.src = input.dataUrl;
  const failed = await settled;
  if (failed) return { ok: false, reason: "decode" };
  const sourceWidth = img.naturalWidth;
  const sourceHeight = img.naturalHeight;
  if (!sourceWidth || !sourceHeight) return { ok: false, reason: "empty" };
  // The one safe fit: identical aspect ratio. Integer cross-multiplication —
  // exact, so 1281×720 can never slip through as "close enough".
  if (sourceWidth * input.height !== sourceHeight * input.width)
    return { ok: false, reason: "aspect", sourceWidth, sourceHeight };
  const canvas = document.createElement("canvas");
  canvas.width = input.width;
  canvas.height = input.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return { ok: false, reason: "canvas" };
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, input.width, input.height);
  return {
    ok: true,
    sourceWidth,
    sourceHeight,
    pngDataUrl: canvas.toDataURL("image/png"),
  };
};

/** Run the in-page mechanics on one page — the shared one, or a test's. */
function decodeOnPage(page: Page, dataUrl: string) {
  return page.evaluate(decodeAndScale, {
    dataUrl,
    width: REFERENCE_WIDTH,
    height: REFERENCE_HEIGHT,
  });
}

const decodeMessage = (reason: string, file: string, sourceWidth?: number, sourceHeight?: number): string => {
  if (reason === "aspect")
    return (
      `"${file}" is ${sourceWidth}×${sourceHeight} — not 16:9, so it cannot be normalized to a ` +
      `${REFERENCE_WIDTH}×${REFERENCE_HEIGHT} Reference Thumbnail without an unstated subjective crop or a ` +
      `distortion, and import refuses to choose either. Crop or resize the image to exactly 16:9 yourself ` +
      `(e.g. \`sips -z 720 1280 "${file}"\` to scale, or \`sips --cropToHeightWidth 720 1280 "${file}"\` to crop ` +
      `with stated intent), then import the result.`
    );
  const supported =
    "Supported input: any local raster image the bundled browser decodes — PNG, JPEG, WebP, GIF (first frame), AVIF, BMP.";
  return reason === "canvas"
    ? `the browser could not provide a ${REFERENCE_WIDTH}×${REFERENCE_HEIGHT} canvas to normalize "${file}" into. ${supported}`
    : `"${file}" cannot be read as an image. ${supported}`;
};

export interface ImportedReference {
  /** The association exactly as recorded in the Scene. */
  reference: { path: string; source?: string };
  /** Absolute path of the updated Scene file. */
  sceneFile: string;
  /** Absolute path of the stored normalized copy. */
  storedPath: string;
  normalized: {
    width: number;
    height: number;
    bytes: number;
    source: { width: number; height: number };
  };
}

export type ImportResult =
  | { ok: true; imported: ImportedReference }
  | { ok: false; errors: SceneError[] };

export interface ImportOptions {
  /** User-supplied source provenance, recorded verbatim as `reference.source`. */
  source?: string;
  /** Library provider for the validation gate (scanned only if the Scene names a library asset). */
  library?: () => Promise<Library>;
  /**
   * Test seam: run the in-page normalization on this page instead of the
   * shared render page (e.g. a route-blocked page proving the import is
   * offline) — the same seam renderScene offers.
   */
  page?: Page;
  /**
   * Fault-injection seam for the Scene commit: when set, the Scene JSON write
   * goes through here. Production always performs the real atomic write;
   * injecting a failing commit is the honest way to prove the rollback branch
   * without mocking the filesystem (the shutdownShared precedent).
   */
  writeScene?: (file: string, bytes: Buffer) => Promise<void>;
}

/** Write bytes so an interrupted write can never leave a partial file at the target. */
async function atomicWrite(file: string, bytes: Buffer): Promise<void> {
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  try {
    await writeFile(tmp, bytes);
    await rename(tmp, file);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

/**
 * Import one local raster file as the Scene's Reference Thumbnail: normalize
 * to the canonical profile, store the copy inside the bundle at a contained,
 * non-conflicting path, validate the complete resulting Scene through the
 * existing gate, then commit atomically. Every failure path leaves the
 * previous Scene file and its associated files byte-identical and usable.
 */
export async function importReference(
  sceneFile: string,
  inputFile: string,
  opts?: ImportOptions,
): Promise<ImportResult> {
  const scenePath = path.resolve(sceneFile);
  const sceneDir = path.dirname(scenePath);
  const fail = (path: string, message: string): ImportResult => ({
    ok: false,
    errors: [{ path, message }],
  });

  // 1 — read + parse the Scene. Nothing has been written; every failure here
  // is a pure refusal. Read and parse fail separately, with their own messages
  // (the readSceneFile precedent in src/scene-cli.ts).
  let sceneText: string;
  try {
    sceneText = (await readFile(scenePath)).toString("utf8");
  } catch (err) {
    return fail("scene", `cannot read scene file "${sceneFile}": ${(err as Error).message}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(sceneText);
  } catch (err) {
    return fail("scene", `invalid JSON in scene file "${sceneFile}": ${(err as Error).message}`);
  }

  // 2 — read the input and normalize it, all before any file changes.
  let input: Buffer;
  try {
    input = await readFile(inputFile);
  } catch (err) {
    return fail(
      "file",
      `cannot read the input image "${inputFile}": ${(err as Error).message}. ` +
        `Check the path — import never writes anything when the input cannot be read.`,
    );
  }
  if (input.length > MAX_ENCODED_BYTES)
    return fail(
      "file",
      `"${inputFile}" is ${(input.length / 1024 / 1024).toFixed(1)} MB — over the ` +
        `${MAX_ENCODED_BYTES / 1024 / 1024} MB import limit. Export a smaller copy and import that.`,
    );
  // SVG is vector, not one of the supported raster formats — and its
  // rasterization would silently depend on viewBox/intrinsic-size guessing.
  // Refuse with the local-render hint instead.
  if (input
    .toString("latin1", 0, Math.min(512, input.length))
    .toLowerCase()
    .includes("<svg"))
    return fail(
      "file",
      `"${inputFile}" is an SVG document — vector, not a supported raster format. ` +
        `Rasterize it locally first (e.g. open it in a browser and save a PNG, or ` +
        `\`qlmanage -t -s 1920 -o <dir> "${inputFile}"\`), then import the PNG.`,
    );
  const dataUrl = `data:application/octet-stream;base64,${input.toString("base64")}`;
  const outcome = opts?.page
    ? await decodeOnPage(opts.page, dataUrl)
    : await withRenderPage((page) => decodeOnPage(page, dataUrl));
  if (!outcome.ok)
    return fail(
      "file",
      decodeMessage(outcome.reason, inputFile, outcome.sourceWidth, outcome.sourceHeight),
    );
  const png = Buffer.from(outcome.pngDataUrl.replace(/^data:image\/png;base64,/, ""), "base64");

  // 3 — the stored path is contained by construction (a plain name inside the
  // scene's directory) and never conflicting: any existing entry — file,
  // directory, or symlink alias — is skipped, never overwritten, so a write
  // can never pass through an escaping alias and the previous association's
  // file always survives.
  const base = path.basename(scenePath, ".json");
  let storedName: string | undefined;
  for (let n = 1; n <= MAX_NAME_ATTEMPTS && !storedName; n++) {
    const candidate = n === 1 ? `${base}.reference.png` : `${base}.reference-${n}.png`;
    let taken = false;
    try {
      await lstat(path.join(sceneDir, candidate));
      taken = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    if (!taken) storedName = candidate;
  }
  if (!storedName)
    return fail(
      "reference",
      `no free "${base}.reference[-N].png" name inside the scene's directory (${sceneDir}) — clean up old copies and import again`,
    );
  const storedPath = path.join(sceneDir, storedName);

  // 4 — the copy lands first (temp + rename inside the bundle): the gate
  // below reads the file at its recorded path, exactly like `scene validate`.
  await atomicWrite(storedPath, png);

  // 5 — the complete resulting document passes the existing validation gate
  // before the Scene file changes. The reference is real review metadata at
  // this point — the gate checks format, dimensions, and containment on disk.
  const updated = {
    ...(raw as Record<string, unknown>),
    reference: {
      path: storedName,
      ...(opts?.source !== undefined ? { source: opts.source } : {}),
    },
  };
  const gate = await loadScene(sceneDir, opts?.library ?? (() => scanLibrary(LIBRARY_ROOT)), updated);
  let errors: SceneError[] | undefined;
  if (!gate.ok) errors = gate.errors;
  else {
    const ref = await checkReference(sceneDir, gate.resolved.scene);
    if (!ref.ok) errors = ref.errors;
  }
  if (errors) {
    await unlink(storedPath).catch(() => {});
    return { ok: false, errors };
  }

  // 6 — commit the Scene atomically. A commit failure rolls the new copy back
  // and reports loudly: the previous Scene and its associated files are
  // byte-identical and usable.
  const json = Buffer.from(JSON.stringify(updated, null, 2) + "\n", "utf8");
  try {
    if (opts?.writeScene) await opts.writeScene(scenePath, json);
    else await atomicWrite(scenePath, json);
  } catch (err) {
    await unlink(storedPath).catch(() => {});
    return fail(
      "scene",
      `the Scene update could not be committed: ${(err as Error).message}. ` +
        `The previous Scene and its Reference Thumbnail are unchanged and usable.`,
    );
  }

  return {
    ok: true,
    imported: {
      reference: {
        path: storedName,
        ...(opts?.source !== undefined ? { source: opts.source } : {}),
      },
      sceneFile: scenePath,
      storedPath,
      normalized: {
        width: REFERENCE_WIDTH,
        height: REFERENCE_HEIGHT,
        bytes: png.length,
        source: { width: outcome.sourceWidth, height: outcome.sourceHeight },
      },
    },
  };
}
