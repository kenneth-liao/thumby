import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The single canonical location of the asset library: `<repo>/assets`.
 * THUMBY_LIBRARY_ROOT relocates it — test fixtures and portable checkouts
 * point the one resolution contract at their own root.
 */
export const LIBRARY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  process.env.THUMBY_LIBRARY_ROOT ?? "assets",
);

/**
 * The asset library: one directory per asset under `<root>/logos/<id>/` and
 * `<root>/plates/<id>/`, each holding its image file plus a `meta.json`.
 *
 * The filesystem is the registry — there is no index file to drift out of
 * sync. Everything here is derived by scanning at call time.
 */

export interface LogoMeta {
  kind: "logo";
  id: string;
  name: string;
  tags: string[];
  /** Preferred mark colour when recolourable; the renderer still overrides per card. */
  defaultColor?: string;
  /** Other ids this logo answers to, e.g. "chatgpt" → "openai". */
  aliases?: string[];
  source?: string;
}

export interface PlateMeta {
  kind: "plate";
  id: string;
  name: string;
  tags: string[];
  /** Provenance inherited from the run.json that generated the plate. */
  subject?: string;
  fullPrompt?: string;
  model?: string;
  adoptedFrom?: string;
}

/**
 * A transparent-PNG subject for compositing. Its identity is the *role* it can
 * play — pose, expression, outfit, framing — because everything else in the
 * final thumbnail (background, text, colour) is applied at compose time.
 */
export interface CutoutMeta {
  kind: "cutout";
  id: string;
  name: string;
  /** Role facets: pose, expression, outfit, framing. The reuse search space. */
  tags: string[];
  /** trials are working assets; approved ones are human-gated. */
  approval: "trial" | "approved";
  /** Recorded approver decision (REQ-018) — the promotion through approveCutout. */
  approvedBy?: string;
  approvedAt?: string;
  approvalNote?: string;
  /** Governance home when approved (e.g. a content-repo provenance record). */
  source?: string;
  /** The cutout this one was edited from — always an approved original. */
  derivedFrom?: string;
  /** The edit instruction that produced it from derivedFrom. */
  editPrompt?: string;
  model?: string;
  adoptedFrom?: string;
  /** Provenance carried from the generating job (creator adoption). */
  subject?: string;
  fullPrompt?: string;
  /**
   * Named semantic masks (REQ-019): mask name → asset reference through the
   * one resolution contract (a library mask id is the portable form). The
   * scene gate resolves and dimension-checks each referenced mask before a
   * render may use it.
   */
  masks?: Record<string, string>;
  /** How the cutout was isolated — job adoption only accepts a verified true-alpha matte. */
  matting?: "true-alpha";
  /** The matting engine that produced it ("native-alpha" when the model returned one). */
  matteEngine?: string;
}

/**
 * An isolated non-text object (REQ-015) — a lamp, terminal, device — with a
 * verified true-alpha matte, positioned independently as an Image layer.
 */
export interface ObjectMeta {
  kind: "object";
  id: string;
  name: string;
  tags: string[];
  /** The object subject the generating job recorded. */
  subject?: string;
  fullPrompt?: string;
  model?: string;
  adoptedFrom?: string;
  /** How the object was isolated — adoption only accepts verified true alpha. */
  matting: "true-alpha";
  /** The matting engine that produced it ("native-alpha" when the model returned one). */
  matteEngine?: string;
}

/**
 * A named semantic mask (REQ-019) — a PNG whose alpha selects pixels of the
 * Creator Asset that references it. It carries no subject of its own; its
 * reuse value is the selection it draws.
 */
export interface MaskMeta {
  kind: "mask";
  id: string;
  name: string;
  tags: string[];
}

export type AssetMeta = LogoMeta | PlateMeta | CutoutMeta | ObjectMeta | MaskMeta;

/** Structural base every library meta satisfies — lets `matches` be generic. */
interface BaseMeta {
  id: string;
  name?: string;
  tags: string[];
  aliases?: string[];
}

export interface LibraryEntry<M extends BaseMeta = AssetMeta> {
  meta: M;
  imagePath: string;
  /** "svg" images are recolourable in-card; rasters are shown as-is. */
  kind: "svg" | "raster";
  /** sha-256 of the image bytes — the exact-content identity, derived at scan time. */
  hash: string;
}

export interface Library {
  logos: LibraryEntry<LogoMeta>[];
  plates: LibraryEntry<PlateMeta>[];
  cutouts: LibraryEntry<CutoutMeta>[];
  objects: LibraryEntry<ObjectMeta>[];
  masks: LibraryEntry<MaskMeta>[];
}

/** The canonical empty library — for callers resolving project-scope refs only. */
export const EMPTY_LIBRARY: Library = {
  logos: [],
  plates: [],
  cutouts: [],
  objects: [],
  masks: [],
};

const KIND_DIRS = ["logos", "plates", "cutouts", "objects", "masks"] as const;
type KindDir = (typeof KIND_DIRS)[number];

const IMAGE_EXTENSIONS = new Set([".svg", ".png", ".jpg", ".jpeg", ".webp"]);

async function readMeta(dir: string): Promise<{ meta: AssetMeta } | { error: string }> {
  try {
    return { meta: JSON.parse(await readFile(path.join(dir, "meta.json"), "utf8")) };
  } catch (err) {
    const entry = path.basename(dir);
    return {
      error:
        err instanceof Error && /^ENOENT/.test((err as any).code ?? "")
          ? `asset "${entry}" has no meta.json`
          : `asset "${entry}" has unreadable meta.json: ${(err as Error).message}`,
    };
  }
}

/** Exactly one image per asset directory; SVG or raster decides its kind. */
async function findImage(dir: string): Promise<string | { error: string }> {
  const files: string[] = [];
  for (const f of await readdir(dir)) {
    if (!IMAGE_EXTENSIONS.has(path.extname(f).toLowerCase())) continue;
    if ((await stat(path.join(dir, f))).isFile()) files.push(f);
  }
  if (files.length === 0) return { error: `${dir}: no image file` };
  if (files.length > 1)
    return { error: `${dir}: multiple image files (${files.join(", ")}) — keep exactly one` };
  return path.resolve(dir, files[0]!);
}

function scanKindDir(root: string, subdir: KindDir): Promise<LibraryEntry[]> {
  const base = path.join(root, subdir);
  return (async () => {
    let names: string[];
    try {
      names = await readdir(base); // a missing library root is an empty one
    } catch {
      return [];
    }
    const entries: LibraryEntry[] = [];
    for (const d of names.sort()) {
      const dir = path.join(base, d);
      if (!(await stat(dir)).isDirectory()) continue;
      const metaResult = await readMeta(dir);
      if ("error" in metaResult) throw new Error(metaResult.error);
      const imgResult = await findImage(dir);
      if (typeof imgResult !== "string") throw new Error(imgResult.error);
      const meta = metaResult.meta as AssetMeta;
      if (
        meta.kind !== "logo" &&
        meta.kind !== "plate" &&
        meta.kind !== "cutout" &&
        meta.kind !== "object" &&
        meta.kind !== "mask"
      )
        throw new Error(`${dir}/meta.json: unknown kind "${(meta as any).kind}"`);
      if (meta.id !== d)
        throw new Error(
          `${dir}/meta.json: id "${meta.id}" does not match directory name "${d}"`,
        );
      if (meta.tags !== undefined &&
        (!Array.isArray(meta.tags) || !meta.tags.every((t) => typeof t === "string")))
        throw new Error(`${dir}/meta.json: tags must be an array of strings`);
      if (meta.name !== undefined && typeof meta.name !== "string")
        throw new Error(`${dir}/meta.json: name must be a string`);
      entries.push({
        meta,
        imagePath: imgResult,
        kind: imgResult.toLowerCase().endsWith(".svg") ? "svg" : "raster",
        hash: contentHash(new Uint8Array(await readFile(imgResult))),
      });
    }
    return entries;
  })();
}

export async function scanLibrary(root: string): Promise<Library> {
  const [logos, plates, cutouts, objects, masks] = await Promise.all([
    scanKindDir(root, "logos"),
    scanKindDir(root, "plates"),
    scanKindDir(root, "cutouts"),
    scanKindDir(root, "objects"),
    scanKindDir(root, "masks"),
  ]);
  // An id is the vocabulary every reader uses; it must be unambiguous library-wide.
  const seen = new Map<string, string>();
  for (const [kind, entries] of [
    ["logos", logos],
    ["plates", plates],
    ["cutouts", cutouts],
    ["objects", objects],
    ["masks", masks],
  ] as const) {
    for (const e of entries) {
      const owner = seen.get(e.meta.id);
      if (owner)
        throw new Error(
          `duplicate asset id "${e.meta.id}" (${kind}/${e.meta.id} and ${owner})`,
        );
      seen.set(e.meta.id, `${kind}/${e.meta.id}`);
    }
  }
  return {
    logos: logos as LibraryEntry<LogoMeta>[],
    plates: plates as LibraryEntry<PlateMeta>[],
    cutouts: cutouts as LibraryEntry<CutoutMeta>[],
    objects: objects as LibraryEntry<ObjectMeta>[],
    masks: masks as LibraryEntry<MaskMeta>[],
  };
}

const ASSET_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/** File extension for an image media type; unknown subtypes land as .png. */
export function extensionFor(mediaType: string): string {
  const subtype = mediaType.replace(/^image\//, "");
  return { png: "png", jpeg: "jpg", webp: "webp", "svg+xml": "svg" }[subtype] ?? "png";
}

/**
 * Atomically reserve an asset id library-wide. The exclusive mkdir is the
 * claim: either this process owns the id for the duration of its write or the
 * id is taken. Held across the collision check and the kind-directory create
 * (which are themselves check-then-act), so concurrent adoptions of the same
 * id — across kinds — have exactly one winner.
 */
async function reserveAssetId(root: string, id: string): Promise<string> {
  const lockDir = path.join(root, ".reservations", id);
  await mkdir(path.dirname(lockDir), { recursive: true });
  try {
    await mkdir(lockDir);
  } catch {
    throw new Error(
      `"${id}" is reserved right now — another adoption holds it, or a crashed adoption left a stale reservation at ${lockDir} (remove it if no adoption is running)`,
    );
  }
  return lockDir;
}

/**
 * The one canonical adoption write path, shared by every generated-asset kind:
 * the id must be valid, the id is reserved atomically library-wide, and the
 * asset directory is created exclusively (mkdir fails on an existing id), so
 * overwriting an adopted asset is unrepresentable — not merely detected.
 * Returns the image path.
 */
async function writeKindAsset(
  root: string,
  kindDir: "plates" | "objects" | "cutouts" | "masks",
  fileBase: string,
  id: string,
  bytes: Uint8Array,
  meta: AssetMeta,
  mediaType: string,
): Promise<string> {
  if (!ASSET_ID_PATTERN.test(id))
    throw new Error(`Invalid asset id "${id}" — use lowercase letters/digits/hyphens`);
  const reservation = await reserveAssetId(root, id);
  try {
    // An id is library-wide vocabulary: no asset of any kind may share it.
    // Re-checked under the reservation — the reservation is what makes this
    // check-then-act pair atomic against concurrent adoptions.
    for (const kind of KIND_DIRS) {
      if (existsSync(path.join(root, kind, id)))
        throw new Error(`"${id}" already exists in the library — adoption never overwrites an asset`);
    }
    const kindRoot = path.join(root, kindDir);
    await mkdir(kindRoot, { recursive: true });
    // Exclusive create: a second adoption of the same id throws here instead of
    // clobbering the first asset's bytes.
    const dir = path.join(kindRoot, id);
    await mkdir(dir);
    const imagePath = path.join(dir, `${fileBase}.${extensionFor(mediaType)}`);
    await writeFile(imagePath, bytes);
    await writeFile(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2) + "\n");
    return imagePath;
  } finally {
    await rm(reservation, { recursive: true, force: true });
  }
}

/** Write a new plate asset into the library (the plate-kind write path). */
export async function writePlateAsset(
  root: string,
  id: string,
  bytes: Uint8Array,
  meta: PlateMeta,
  mediaType = "image/png",
): Promise<string> {
  return writeKindAsset(root, "plates", "plate", id, bytes, meta, mediaType);
}

/**
 * Write a new mask asset into the library (the mask-kind write path, REQ-019).
 * The media type is not a parameter: masks must be PNG so the scene gate can
 * compare pixel dimensions against the Creator Asset that references them —
 * the contract's `mask.png` is hardcoded here, and a mislabeled candidate
 * cannot produce a differently-named asset.
 */
export async function writeMaskAsset(
  root: string,
  id: string,
  bytes: Uint8Array,
  meta: MaskMeta,
): Promise<string> {
  return writeKindAsset(root, "masks", "mask", id, bytes, meta, "image/png");
}

/**
 * Write a new object asset into the library (the object-kind write path).
 * Callers must have verified true alpha first — this function records the
 * matting claim, it does not re-check the pixels. The media type is not a
 * parameter: adoption verifies the bytes are PNG, so the contract's
 * `object.png` is hardcoded here and a mislabeled candidate cannot produce a
 * differently-named asset.
 */
export async function writeObjectAsset(
  root: string,
  id: string,
  bytes: Uint8Array,
  meta: ObjectMeta,
): Promise<string> {
  return writeKindAsset(root, "objects", "object", id, bytes, meta, "image/png");
}

/**
 * Write a generated creator candidate into the library as a Cutout Asset
 * (REQ-017). Callers must have verified true alpha first and must force
 * `approval: "trial"` — this function records the claims it is given, it does
 * not re-check pixels or approval. The media type is not a parameter:
 * adoption verifies the bytes are PNG, so the contract's `cutout.png` is
 * hardcoded here and a mislabeled candidate cannot produce a .jpg asset.
 */
export async function writeCreatorAsset(
  root: string,
  id: string,
  bytes: Uint8Array,
  meta: CutoutMeta,
): Promise<string> {
  return writeKindAsset(root, "cutouts", "cutout", id, bytes, meta, "image/png");
}

// --- the Creator approval operation (REQ-018) --------------------------------
//
// The one promotion path from trial to approved. Adoption (src/jobs.ts) and
// `library add-cutout` only ever write the state a source claims — adoption
// forces "trial", and `--approval approved` imports an externally approved
// source rather than promoting a trial. Promotion happens here and nowhere else:
// it requires a recorded approver decision and refuses to re-decide an
// already-approved asset.

/** The recorded human decision that promotes a trial Creator Asset. */
export interface ApprovalDecision {
  /** Who approved — an explicit, non-empty decision record. */
  approvedBy: string;
  /** When, as an ISO 8601 instant. */
  approvedAt: string;
  /** Optional free-text rationale. */
  approvalNote?: string;
}

/**
 * Promote one trial Creator Asset to approved, recording the approver
 * decision on its meta. The image bytes are never touched — approval selects
 * the asset's immutable content identity, and no hash is stored in meta.json
 * (ADR-0002: the hash is always derived from the bytes).
 */
export async function approveCutout(
  root: string,
  id: string,
  decision: ApprovalDecision,
): Promise<CutoutMeta> {
  // The id names a path segment below the cutouts directory — the same shape
  // adoption enforces, so a crafted id cannot reach outside the library.
  if (!ASSET_ID_PATTERN.test(id))
    throw new Error(`Invalid asset id "${id}" — use lowercase letters/digits/hyphens`);
  if (!decision.approvedBy.trim())
    throw new Error(`an approval decision needs an approver — record who approved "${id}"`);
  if (Number.isNaN(Date.parse(decision.approvedAt)))
    throw new Error(`approvedAt must be an ISO 8601 instant (got "${decision.approvedAt}")`);
  const metaFile = path.join(root, "cutouts", id, "meta.json");
  let meta: CutoutMeta;
  try {
    meta = JSON.parse(await readFile(metaFile, "utf8")) as CutoutMeta;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT")
      throw new Error(`no cutout "${id}" in the library at ${root} — nothing to approve`);
    throw err;
  }
  if (meta.kind !== "cutout")
    throw new Error(`"${id}" is a ${meta.kind}, not a Creator Asset — approval applies to cutouts only`);
  if (meta.approval === "approved")
    throw new Error(
      `"${id}" is already approved` +
        (meta.approvedBy
          ? ` by ${meta.approvedBy} at ${meta.approvedAt}`
          : "") +
        ` — approval is a decision, not a toggle`,
    );
  const updated: CutoutMeta = {
    ...meta,
    approval: "approved",
    approvedBy: decision.approvedBy.trim(),
    approvedAt: decision.approvedAt,
    ...(decision.approvalNote !== undefined ? { approvalNote: decision.approvalNote } : {}),
  };
  await writeFile(metaFile, JSON.stringify(updated, null, 2) + "\n");
  return updated;
}

// --- the Creator approval gate (REQ-018) -------------------------------------
//
// One home for the gate's language: every Scene render path states the same
// refusal and marks the same non-final outputs, so they cannot drift apart in
// wording or remedies.

/**
 * The refusal for a trial Creator Asset reference (REQ-018): names the asset,
 * the approval state, and both remedies — the explicit approval operation, or
 * the render-time experimental override.
 */
export function trialCreatorError(id: string | undefined): string {
  return (
    `library cutout "${id ?? "?"}" is a trial Creator Asset (approval: "trial") — normal and final rendering reject it.\n` +
    `Approve it explicitly with "bun run library approve ${id ?? "<id>"}", or render with --experimental for a clearly-marked non-final render.`
  );
}

/**
 * The non-final marker (REQ-018): every output of an experimental render
 * carries this warning, naming the trial Creator Asset(s) it used. Derived
 * from actual trial usage — the override on an all-approved render must not
 * mint a standing non-final marker.
 */
export function trialOverrideWarning(trialIds: string[]): string | undefined {
  if (trialIds.length === 0) return undefined;
  return (
    `NON-FINAL render — produced under the experimental trial-Creator override; ` +
    `not approved for publication. Trial Creator Asset(s) used: ${trialIds.join(", ")}.`
  );
}

/** Default output name under the experimental override: a .trial suffix marks the file non-final. */
export const trialOutputName = (file: string): string =>
  file.replace(/\.png$/, ".trial.png");

function matches(entry: LibraryEntry<BaseMeta>, q: string): boolean {
  const m = entry.meta;
  const hay = [m.id, m.name, ...m.tags, ...("aliases" in m ? m.aliases ?? [] : [])]
    .join("\n")
    .toLowerCase();
  return hay.includes(q);
}

export async function searchLibrary(
  lib: Library,
  query: string,
): Promise<Library> {
  const q = query.trim().toLowerCase();
  const text = <M extends BaseMeta>(entries: LibraryEntry<M>[]) =>
    q ? entries.filter((e) => matches(e, q)) : entries;
  return {
    logos: text(lib.logos),
    plates: text(lib.plates),
    cutouts: text(lib.cutouts),
    objects: text(lib.objects),
    masks: text(lib.masks),
  };
}

// --- the asset resolution contract ------------------------------------------
//
// One runtime-validated contract for both scopes: reusable-library assets
// (`<id>` / `library:<id>`) and project-local assets (a project-relative
// path, contained inside the project root — symlinks included). A reference
// may pin exact content with `@<hash>` — the sha-256 of
// the bytes, full or an unambiguous prefix. The file's bytes are the single
// source of truth: the hash is always derived, never stored in meta.json, so
// changing the bytes creates a different identity and old pinned references
// fail loudly instead of silently resolving to new content.

/** Full sha-256 hex, or a prefix of one (8–64 hex chars) matched against the single already-resolved asset. */
const HASH_PATTERN = /^[0-9a-f]{8,64}$/i;

/** sha-256 of the exact bytes — an Asset's content identity. */
export function contentHash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export interface AssetRef {
  scope: "library" | "project";
  /** Library scope: the asset id (an untyped ref as written, before aliasing). */
  id?: string;
  /** Project scope: the referenced path as written (relative or absolute). */
  path?: string;
  /** Exact-content pin: sha-256 hex or its prefix, if the ref carried one. */
  hash?: string;
}

/** Restricts library-scope resolution to one asset kind. */
export type AssetKind = "logo" | "plate" | "cutout" | "object" | "mask";

/** Match a logo by id, display name, or alias against a lowercased `want`. */
function matchesLogo(entry: LibraryEntry<LogoMeta>, want: string): boolean {
  return (
    entry.meta.id === want ||
    (entry.meta.name ?? "").toLowerCase() === want ||
    (entry.meta.aliases ?? []).some((a) => a.toLowerCase() === want)
  );
}

const byId = (want: string) => (e: LibraryEntry) => e.meta.id === want;

/** Parse one asset reference into its scope and exact-content pin. */
export function parseAssetRef(ref: string): AssetRef {
  const raw = ref.trim();
  if (!raw) throw new Error(`empty asset reference — expected an asset id or path`);

  const isLibrary =
    raw.startsWith("library:") ||
    (!raw.includes("/") && !raw.includes("\\") && !raw.startsWith("."));
  const body = isLibrary ? raw.replace(/^library:/, "") : raw;
  if (isLibrary && !body) throw new Error(`asset reference "${ref}" names no library asset`);

  // A trailing @<hash> pins exact content. A `@` never appears in an asset
  // id, so any tail after @ on a library ref must be a hash; on a project
  // path a hex tail is a pin, and any other `@` is simply part of the filename.
  const at = body.lastIndexOf("@");
  if (at >= 0) {
    const tail = body.slice(at + 1);
    if (HASH_PATTERN.test(tail)) {
      const head = body.slice(0, at);
      const hash = tail.toLowerCase();
      return isLibrary
        ? { scope: "library", id: head, hash }
        : { scope: "project", path: head, hash };
    }
    if (isLibrary)
      throw new Error(
        `invalid content hash "@${tail}" in asset reference "${ref}" — expected 8–64 hex chars (a sha-256 or its prefix)`,
      );
  }

  return isLibrary
    ? { scope: "library", id: body }
    : { scope: "project", path: body };
}

const MEDIA_TYPES: Record<string, string> = {
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

function mediaTypeFor(file: string): string {
  const mt = MEDIA_TYPES[path.extname(file).toLowerCase()];
  if (!mt)
    throw new Error(
      `unsupported asset image type "${path.extname(file)}" (${file}) — use svg, png, jpg, or webp`,
    );
  return mt;
}

/** A validated resolution: exact bytes plus the identity they hash to. */
export interface ResolvedAsset {
  scope: "library" | "project";
  /** Library scope: the resolved asset id (post-alias). */
  id?: string;
  /** Library scope: the asset kind. */
  kind?: AssetKind;
  /** Library scope, cutouts only: the Creator Asset approval state (REQ-018). */
  approval?: CutoutMeta["approval"];
  /** Library scope, cutouts only: named mask refs from the asset's meta (REQ-019). */
  masks?: Record<string, string>;
  /** Project scope: the path relative to the project root, in portable `/` form. */
  path?: string;
  bytes: Uint8Array;
  mediaType: string;
  /** sha-256 of the resolved bytes. */
  hash: string;
}

function verifyIdentity(label: string, pinned: string | undefined, actual: string): void {
  if (!pinned || actual.startsWith(pinned)) return;
  throw new Error(
    `asset content mismatch for ${label}: reference pins "@${pinned}" but the content now hashes to "@${actual}".\n` +
      `The bytes changed; re-pin the reference to ${label}@${actual} or accept the new content.`,
  );
}

/**
 * Resolve an asset reference to its exact content through the one contract
 * shared by library and project-local scopes. Fails with actionable errors on
 * missing content, identity mismatches, and unsupported types.
 *
 * `opts.kind` constrains library-scope resolution to one asset kind — callers
 * whose slot has a kind invariant (e.g. `--cutout` must be a transparent-PNG
 * subject) must pass it so a logo or plate id fails loudly instead of
 * compositing the wrong content.
 */
export async function resolveAsset(
  projectRoot: string,
  lib: Library,
  ref: string,
  opts?: { kind?: AssetKind },
): Promise<ResolvedAsset> {
  const parsed = parseAssetRef(ref);

  if (parsed.scope === "library") {
    const want = parsed.id!.toLowerCase();
    let entry: LibraryEntry | undefined;
    let pool: LibraryEntry[];
    if (opts?.kind === "logo") {
      entry = lib.logos.find((l) => matchesLogo(l, want));
      pool = lib.logos;
    } else if (opts?.kind === "plate") {
      entry = lib.plates.find(byId(want));
      pool = lib.plates;
    } else if (opts?.kind === "cutout") {
      entry = lib.cutouts.find(byId(want));
      pool = lib.cutouts;
    } else if (opts?.kind === "object") {
      entry = lib.objects.find(byId(want));
      pool = lib.objects;
    } else if (opts?.kind === "mask") {
      entry = lib.masks.find(byId(want));
      pool = lib.masks;
    } else {
      entry =
        lib.logos.find((l) => matchesLogo(l, want)) ??
        lib.plates.find(byId(want)) ??
        lib.cutouts.find(byId(want)) ??
        lib.objects.find(byId(want)) ??
        lib.masks.find(byId(want));
      pool = [...lib.logos, ...lib.plates, ...lib.cutouts, ...lib.objects, ...lib.masks];
    }
    if (!entry) {
      throw new Error(
        `unknown library ${opts?.kind ?? "asset"} "${parsed.id}". In library: ${
          pool.map((e) => e.meta.id).join(", ") ||
          "(empty — add assets with bun run library)"
        } — for a project-local file, use a project-relative path like ./<file>`,
      );
    }
    const bytes = new Uint8Array(await readFile(entry.imagePath));
    const hash = contentHash(bytes);
    verifyIdentity(entry.meta.id, parsed.hash, hash);
    return {
      scope: "library",
      id: entry.meta.id,
      kind: entry.meta.kind,
      // Library metadata a scene needs rides on the resolution — the one
      // boundary where the library is read — so no downstream reader re-scans
      // to learn it.
      ...(entry.meta.kind === "cutout"
        ? { approval: entry.meta.approval, ...(entry.meta.masks ? { masks: entry.meta.masks } : {}) }
        : {}),
      bytes,
      mediaType: mediaTypeFor(entry.imagePath),
      hash,
    };
  }

  const root = path.resolve(projectRoot);
  const abs = path.resolve(root, parsed.path!);
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFile(abs));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR")
      throw new Error(
        `missing project asset "${parsed.path}" — no file at ${abs}`,
      );
    throw err;
  }
  // Containment: the file actually read (symlinks resolved) must live inside
  // the project root — a scene is an externally authored document, and its
  // project scope must never reach past the scene directory it ships with.
  const rel = path.relative(root, abs).split(path.sep).join("/");
  const realRoot = await realpath(root);
  const realFile = await realpath(abs);
  const relReal = path.relative(realRoot, realFile);
  if (relReal === "" || relReal.startsWith("..") || path.isAbsolute(relReal))
    throw new Error(
      `project asset "${parsed.path}" escapes the project directory (${root}) — ` +
        `scene assets must live inside the scene file's directory`,
    );
  const hash = contentHash(bytes);
  verifyIdentity(rel, parsed.hash, hash);
  return { scope: "project", path: rel, bytes, mediaType: mediaTypeFor(abs), hash };
}
