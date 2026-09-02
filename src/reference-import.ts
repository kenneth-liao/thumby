/**
 * Reference Thumbnail import (DEC-002, DEC-003, DEC-004): one normalization
 * boundary plus one validated, serialized, atomic transaction.
 *
 * Supported input is exactly PNG, JPEG, and WebP (src/raster-meta.ts decides
 * which — never "whatever a decoder happens to open"). The input may live
 * anywhere — it is external source material; only the stored copy must be
 * contained. Normalization is deliberately non-distorting and non-subjective:
 * a 16:9 input is uniformly rescaled (1:1 when already exact); any other
 * aspect is refused before anything is written, because fitting it would
 * require an unstated subjective crop or a distortion.
 *
 * Ingestion is resource-bounded before any decoder runs (PROD-2): the input is
 * opened first and the OPEN HANDLE is fstat-ed — never a stat-then-read on the
 * path — only a regular file proceeds, the encoded cap is enforced on the
 * observed size and re-bounded by the read window itself, and the header's
 * declared geometry must fit the decoded-pixel budget before Chromium
 * rasterizes anything.
 *
 * The transaction is serialized per Scene by a filesystem-backed lock — an
 * exclusive-create file beside the scene's real path, so every alias of one
 * Scene file contends on one lock. A crashed holder's lock is stolen only
 * after a staleness deadline; the Scene byte comparison (step 6) is the
 * fail-closed backstop for any residual overlap. Inside the lock:
 *
 *   1. read + parse the Scene          — failures change nothing,
 *   2. ingest + normalize the input    — refusals happen before any write,
 *   3. reserve the stored path         — exclusive no-replace create; the
 *      create IS the free-name check, so a destination that appears after any
 *      earlier scan is skipped, never replaced. The reservation is the
 *      transaction's ownership proof: cleanup removes exactly this path and
 *      nothing else,
 *   4. write the normalized PNG        — into the reserved handle,
 *   5. validate the resulting document — a failure unlinks the reservation,
 *   6. compare Scene bytes             — the Scene file's current bytes must
 *      equal the bytes read in step 1; an intervening edit fails closed,
 *   7. commit the Scene JSON           — temp + rename; a commit failure
 *      unlinks the reservation and leaves the previous Scene and its
 *      associated files byte-identical and usable.
 *
 * Rollback is never silent (PROD-3): a failed removal is reported as a second,
 * actionable error naming the retained contained path and the remediation.
 *
 * Provenance (DEC-003) is user-supplied free text recorded as `reference.source`.
 * It is never resolved as a path — the relocatable bundle gains no external
 * file dependency — and content identity continues to derive from the PNG's
 * bytes, so no second hash is stored (ADR-0002).
 *
 * Identity (DEC-009, INT-2): the renderer never reads the reference and the
 * Render manifest never records it as a Render input — importing changes
 * neither rendered pixels nor resolved Asset identities. The manifest does
 * record the Scene's byte identity (its sha256), and the reference metadata is
 * part of the Scene bytes, so that identity necessarily changes on import:
 * that is the Scene bytes changing, not the Render.
 */
import { constants as fsConstants } from "node:fs";
import { open as fsOpen, lstat, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { MAX_DIMENSION, MAX_ENCODED_BYTES, MAX_PIXELS } from "./png.js";
import { withRenderPage } from "./browser.js";
import { checkReference, REFERENCE_HEIGHT, REFERENCE_WIDTH } from "./compare.js";
import { loadScene, type SceneError } from "./scene.js";
import { LIBRARY_ROOT, contentHash, scanLibrary, type Library } from "./assets.js";
import { readRasterMeta, type RasterMeta } from "./raster-meta.js";

/** How many `-N` suffixed names to scan before giving up on storage. */
const MAX_NAME_ATTEMPTS = 1000;

/** How long a transaction waits for a contended Scene lock before refusing. */
const LOCK_TIMEOUT_MS = 30_000;
/** A lock older than this belongs to a crashed holder and is stolen. */
const LOCK_STALE_MS = 120_000;
const LOCK_POLL_MS = 50;

/**
 * Acquire the Scene's transaction lock: an exclusive-create file beside the
 * scene's REAL path, so every alias of one Scene serializes on one lock. A
 * lock held past the staleness deadline belongs to a crashed process and is
 * stolen; the Scene byte comparison before commit is the fail-closed backstop
 * for any residual overlap. The returned release drops the lock — a release
 * that cannot remove the lock file self-heals through the same staleness
 * deadline, and the transaction's data guarantees (exclusive reservation,
 * Scene byte comparison) never depend on the release.
 */
async function acquireSceneLock(lockPath: string): Promise<() => Promise<void>> {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    let fh: FileHandle;
    try {
      fh = await fsOpen(lockPath, "wx");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (Date.now() >= deadline)
        throw new Error(
          `another Reference Thumbnail import holds this Scene's lock ("${lockPath}") — ` +
            `wait for it to finish, or if that process crashed, remove the lock file and re-run`,
        );
      const holder = await stat(lockPath).catch(() => undefined);
      if (holder && Date.now() - holder.mtimeMs > LOCK_STALE_MS)
        await unlink(lockPath).catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
      continue;
    }
    await fh.write(`${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`);
    await fh.close();
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      await unlink(lockPath).catch(() => {
        // A retained lock self-heals through the staleness deadline; the
        // committed Scene is already complete and the next import's data
        // guarantees hold either way.
      });
    };
  }
}

/**
 * Reserve the stored path with an exclusive no-replace create — the create IS
 * the free-name check, so a destination that appears after any earlier scan is
 * skipped, never replaced (PROD-1). The returned handle is the transaction's
 * ownership proof: rollback removes exactly this path, never another
 * transaction's file.
 */
async function reserveStored(
  sceneDir: string,
  base: string,
): Promise<{ name: string; path: string; fh: FileHandle }> {
  for (let n = 1; n <= MAX_NAME_ATTEMPTS; n++) {
    const name = n === 1 ? `${base}.reference.png` : `${base}.reference-${n}.png`;
    const at = path.join(sceneDir, name);
    try {
      return { name, path: at, fh: await fsOpen(at, "wx") };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
  throw new Error(
    `no free "${base}.reference[-N].png" name inside the scene's directory (${sceneDir}) — clean up old copies and import again`,
  );
}

/**
 * Roll the reservation back. A failed removal is never silent: the returned
 * error names the retained contained path and how to remediate it (PROD-3) —
 * the command can never claim a rollback it did not perform.
 */
async function rollbackStored(
  reserved: { path: string },
  removeStored: (file: string) => Promise<void>,
): Promise<SceneError | undefined> {
  try {
    await removeStored(reserved.path);
    return undefined;
  } catch (err) {
    return {
      path: "reference",
      message:
        `the import failed, and the stored copy could not be removed during rollback — it is retained at ` +
        `"${reserved.path}" (inside the scene's directory). Delete that file, or re-import to replace it. ` +
        `The previous Scene is unchanged and usable. (removal failed: ${(err as Error).message})`,
    };
  }
}

const fileKind = (st: { isDirectory(): boolean; isSymbolicLink(): boolean; isFIFO(): boolean; isSocket(): boolean; isBlockDevice(): boolean; isCharacterDevice(): boolean }): string =>
  st.isDirectory()
    ? "a directory"
    : st.isSymbolicLink()
      ? "a symlink"
      : st.isFIFO()
        ? "a fifo"
        : st.isSocket()
          ? "a socket"
          : st.isBlockDevice() || st.isCharacterDevice()
            ? "a device"
            : "not a regular file";

/**
 * One bounded ingestion pass for the input raster (PROD-2): open first,
 * fstat the OPEN HANDLE (never stat-then-read on the path — a file swapped
 * between the two would be measured as one thing and read as another), require
 * a regular file, enforce the encoded cap on the observed size, and read
 * exactly that bounded window — a file that grows mid-read can only yield the
 * bounded window, and one that shrinks fails closed. The header's declared
 * geometry then bounds the decoded pixels before any rasterization.
 */
async function ingestInput(
  inputFile: string,
): Promise<{ ok: true; bytes: Buffer; meta: RasterMeta } | { ok: false; error: SceneError }> {
  const refuse = (message: string) => ({ ok: false as const, error: { path: "file", message } });
  // O_NONBLOCK so a fifo open returns instead of blocking on a writer; the
  // fstat regular-file check below refuses everything that is not a file.
  let fh: FileHandle;
  try {
    fh = await fsOpen(inputFile, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
  } catch (err) {
    return refuse(
      `cannot read the input image "${inputFile}": ${(err as Error).message}. ` +
        `Check the path — import never writes anything when the input cannot be read.`,
    );
  }
  try {
    const st = await fh.stat();
    if (!st.isFile())
      return refuse(
        `"${inputFile}" is not a regular file (${fileKind(st)}) — supported input is a regular local PNG, JPEG, or WebP file`,
      );
    if (st.size > MAX_ENCODED_BYTES)
      return refuse(
        `"${inputFile}" is ${(st.size / 1024 / 1024).toFixed(1)} MB — over the ` +
          `${MAX_ENCODED_BYTES / 1024 / 1024} MB import limit. Export a smaller copy and import that.`,
      );
    // The read window is the observed size — already at or under the cap — so
    // the cap holds during the read too; growth past it is never read.
    const window = Buffer.alloc(st.size);
    let read = 0;
    while (read < window.length) {
      const { bytesRead } = await fh.read(window, read, window.length - read, read);
      if (bytesRead <= 0)
        return refuse(
          `"${inputFile}" changed while it was being read (${read} of ${window.length} bytes) — ` +
            `import refuses to guess; run it again`,
        );
      read += bytesRead;
    }
    const meta = readRasterMeta(window, inputFile);
    if (typeof meta === "string") return refuse(meta);
    if (meta.width > MAX_DIMENSION || meta.height > MAX_DIMENSION)
      return refuse(
        `"${inputFile}" declares a ${meta.width}×${meta.height} canvas — over the ` +
          `${MAX_DIMENSION}px per-axis decoded budget. Export a smaller copy and import that.`,
      );
    if (meta.width * meta.height > MAX_PIXELS)
      return refuse(
        `"${inputFile}" declares a ${meta.width}×${meta.height} canvas — over the ` +
          `${MAX_PIXELS.toLocaleString("en-US")}-pixel decoded budget. Export a smaller copy and import that.`,
      );
    return { ok: true, bytes: window, meta };
  } finally {
    await fh.close().catch(() => {});
  }
}

/**
 * The in-page mechanics of normalization: decode, then — only when the source
 * aspect matches the target canvas exactly — draw with high-quality resampling
 * and encode a PNG. No policy lives here: the profile dimensions arrive from
 * the caller, so the canonical constants have exactly one home (src/compare.ts).
 * The aspect check is the decode-time backstop to the pre-decode metadata
 * budget: it sees the EXIF-oriented bitmap Chromium will actually draw.
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

const decodeMessage = (
  reason: string,
  file: string,
  sourceWidth?: number,
  sourceHeight?: number,
): string => {
  if (reason === "aspect")
    return (
      `"${file}" is ${sourceWidth}×${sourceHeight} — not 16:9, so it cannot be normalized to a ` +
      `${REFERENCE_WIDTH}×${REFERENCE_HEIGHT} Reference Thumbnail without an unstated subjective crop or a ` +
      `distortion, and import refuses to choose either. Crop or resize the image to exactly 16:9 yourself ` +
      `(e.g. \`sips -z 720 1280 "${file}"\` to scale, or \`sips --cropToHeightWidth 720 1280 "${file}"\` to crop ` +
      `with stated intent), then import the result.`
    );
  const supported = "Supported input: a regular local PNG, JPEG, or WebP file.";
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
  /**
   * Fault-injection seam for the Scene reads (the initial read and the
   * pre-commit comparison): production always reads the real file. Injecting
   * changed bytes on the comparison call is the deterministic way to prove the
   * fail-closed branch without racing a real writer.
   */
  readScene?: (file: string) => Promise<Buffer>;
  /**
   * Fault-injection seam for rollback removal: when set, the reserved copy's
   * removal goes through here. Production always unlinks the reservation.
   */
  removeStored?: (file: string) => Promise<void>;
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
 * Import one local raster file as the Scene's Reference Thumbnail: acquire the
 * Scene's transaction lock, normalize to the canonical profile, store the copy
 * at a reserved contained path, validate the complete resulting Scene through
 * the existing gate, compare the Scene bytes to what was read, and commit
 * atomically. Every failure path rolls the reservation back — reporting a
 * composite error when the rollback itself fails — and leaves the previous
 * Scene file and its associated files byte-identical and usable.
 */
export async function importReference(
  sceneFile: string,
  inputFile: string,
  opts?: ImportOptions,
): Promise<ImportResult> {
  const scenePath = path.resolve(sceneFile);
  const fail = (path: string, message: string): ImportResult => ({
    ok: false,
    errors: [{ path, message }],
  });

  // The lock lives beside the scene's real path, so every alias of one Scene
  // file — including a symlink into the same bundle — serializes on one lock.
  let realScene: string;
  try {
    realScene = await realpath(scenePath);
  } catch (err) {
    return fail("scene", `cannot read scene file "${sceneFile}": ${(err as Error).message}`);
  }
  let releaseLock: () => Promise<void>;
  try {
    releaseLock = await acquireSceneLock(`${realScene}.lock`);
  } catch (err) {
    return fail("scene", `the Scene could not be locked for this import: ${(err as Error).message}`);
  }
  try {
    return await importTransaction(scenePath, sceneFile, inputFile, opts);
  } finally {
    await releaseLock();
  }
}

async function importTransaction(
  scenePath: string,
  sceneFile: string,
  inputFile: string,
  opts: ImportOptions | undefined,
): Promise<ImportResult> {
  const sceneDir = path.dirname(scenePath);
  const readScene = opts?.readScene ?? ((file: string) => readFile(file));
  const fail = (path: string, message: string): ImportResult => ({
    ok: false,
    errors: [{ path, message }],
  });

  // 1 — read + parse the Scene, inside the lock. Nothing has been written;
  // every failure here is a pure refusal. Read and parse fail separately,
  // with their own messages (the readSceneFile precedent in src/scene-cli.ts).
  let sceneBytes: Buffer;
  try {
    sceneBytes = await readScene(scenePath);
  } catch (err) {
    return fail("scene", `cannot read scene file "${sceneFile}": ${(err as Error).message}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(sceneBytes.toString("utf8"));
  } catch (err) {
    return fail("scene", `invalid JSON in scene file "${sceneFile}": ${(err as Error).message}`);
  }

  // 2 — ingest (bounded) + normalize the input, all before any file changes.
  const ingest = await ingestInput(inputFile);
  if (!ingest.ok) return { ok: false, errors: [ingest.error] };
  const dataUrl = `data:application/octet-stream;base64,${ingest.bytes.toString("base64")}`;
  const outcome = opts?.page
    ? await decodeOnPage(opts.page, dataUrl)
    : await withRenderPage((page) => decodeOnPage(page, dataUrl));
  if (!outcome.ok)
    return fail(
      "file",
      decodeMessage(outcome.reason, inputFile, outcome.sourceWidth, outcome.sourceHeight),
    );
  const png = Buffer.from(outcome.pngDataUrl.replace(/^data:image\/png;base64,/, ""), "base64");

  // 3 — reserve the stored path with an exclusive no-replace create: the
  // create is the check, so a name taken after any earlier scan is skipped,
  // never replaced. The reservation handle is the transaction's ownership
  // proof — rollback removes exactly this path and nothing else. The stored
  // name is contained by construction: a plain name inside the scene's
  // directory, derived from the scene basename.
  let reserved: { name: string; path: string; fh: FileHandle };
  try {
    reserved = await reserveStored(sceneDir, path.basename(scenePath, ".json"));
  } catch (err) {
    return fail("reference", (err as Error).message);
  }

  // 4 — write the copy into the reserved handle, then release the fd. A write
  // that cannot complete fails closed below (validation never runs).
  try {
    let written = 0;
    while (written < png.length) {
      const { bytesWritten } = await reserved.fh.write(png, written, png.length - written, written);
      if (bytesWritten <= 0)
        throw new Error(
          `the stored copy could not be written (${written} of ${png.length} bytes)`,
        );
      written += bytesWritten;
    }
  } finally {
    await reserved.fh.close().catch(() => {});
  }

  const removeStored = opts?.removeStored ?? ((file: string) => unlink(file));
  const rollback = async (errors: SceneError[]): Promise<ImportResult> => {
    const cleanup = await rollbackStored(reserved, removeStored);
    return { ok: false, errors: cleanup ? [...errors, cleanup] : errors };
  };

  // 5 — the complete resulting document passes the existing validation gate
  // before the Scene file changes. The reference is real review metadata at
  // this point — the gate checks format, dimensions, and containment on disk.
  const updated = {
    ...(raw as Record<string, unknown>),
    reference: {
      path: reserved.name,
      ...(opts?.source !== undefined ? { source: opts.source } : {}),
    },
  };
  const gate = await loadScene(sceneDir, opts?.library ?? (() => scanLibrary(LIBRARY_ROOT)), updated);
  let gateErrors: SceneError[] | undefined;
  if (!gate.ok) gateErrors = gate.errors;
  else {
    const ref = await checkReference(sceneDir, gate.resolved.scene);
    if (!ref.ok) gateErrors = ref.errors;
  }
  if (gateErrors) return rollback(gateErrors);

  // 6 — Scene byte comparison: the file on disk must still be the bytes this
  // import read in step 1. An intervening edit fails closed — the import
  // never overwrites it — and the reservation rolls back.
  let current: Buffer;
  try {
    current = await readScene(scenePath);
  } catch (err) {
    return rollback([
      {
        path: "scene",
        message:
          `the Scene file could not be re-read before commit: ${(err as Error).message} — ` +
          `the import fails closed and commits nothing; the previous Scene is unchanged.`,
      },
    ]);
  }
  if (!current.equals(sceneBytes))
    return rollback([
      {
        path: "scene",
        message:
          `the Scene file changed after this import read it (${contentHash(sceneBytes).slice(0, 12)}… → ` +
          `${contentHash(current).slice(0, 12)}…) — the import refuses to overwrite an intervening edit. ` +
          `Nothing was committed; the previous Scene and its associated files are unchanged and usable. ` +
          `Re-run the import on the current Scene.`,
      },
    ]);

  // 7 — commit the Scene atomically. A commit failure rolls the new copy back
  // and reports loudly: the previous Scene and its associated files are
  // byte-identical and usable.
  const json = Buffer.from(JSON.stringify(updated, null, 2) + "\n", "utf8");
  try {
    if (opts?.writeScene) await opts.writeScene(scenePath, json);
    else await atomicWrite(scenePath, json);
  } catch (err) {
    return rollback([
      {
        path: "scene",
        message:
          `the Scene update could not be committed: ${(err as Error).message}. ` +
          `The previous Scene and its Reference Thumbnail are unchanged and usable.`,
      },
    ]);
  }

  return {
    ok: true,
    imported: {
      reference: {
        path: reserved.name,
        ...(opts?.source !== undefined ? { source: opts.source } : {}),
      },
      sceneFile: scenePath,
      storedPath: reserved.path,
      normalized: {
        width: REFERENCE_WIDTH,
        height: REFERENCE_HEIGHT,
        bytes: png.length,
        source: { width: outcome.sourceWidth, height: outcome.sourceHeight },
      },
    },
  };
}