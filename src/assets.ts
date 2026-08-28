import { readFile, readdir, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The single canonical location of the asset library: `<repo>/assets`. */
export const LIBRARY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "assets",
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
  /** Governance home when approved (e.g. a content-repo provenance record). */
  source?: string;
  /** The cutout this one was edited from — always an approved original. */
  derivedFrom?: string;
  /** The edit instruction that produced it from derivedFrom. */
  editPrompt?: string;
  model?: string;
  adoptedFrom?: string;
}

export type AssetMeta = LogoMeta | PlateMeta | CutoutMeta;

export interface LibraryEntry<M extends AssetMeta = AssetMeta> {
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
}

const KIND_DIRS = ["logos", "plates", "cutouts"] as const;
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
      if (meta.kind !== "logo" && meta.kind !== "plate" && meta.kind !== "cutout")
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
  const [logos, plates, cutouts] = await Promise.all([
    scanKindDir(root, "logos"),
    scanKindDir(root, "plates"),
    scanKindDir(root, "cutouts"),
  ]);
  // An id is the vocabulary every reader uses; it must be unambiguous library-wide.
  const seen = new Map<string, string>();
  for (const [kind, entries] of [
    ["logos", logos],
    ["plates", plates],
    ["cutouts", cutouts],
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
  };
}

function matches(entry: LibraryEntry, q: string): boolean {
  const m = entry.meta;
  const hay = [m.id, m.name, ...m.tags, ...("aliases" in m ? m.aliases ?? [] : [])]
    .join("\n")
    .toLowerCase();
  return hay.includes(q);
}

export async function searchLibrary(lib: Library, query: string): Promise<Library> {
  const q = query.trim().toLowerCase();
  if (!q) return lib;
  return {
    logos: lib.logos.filter((e) => matches(e, q)),
    plates: lib.plates.filter((e) => matches(e, q)),
    cutouts: lib.cutouts.filter((e) => matches(e, q)),
  };
}

/**
 * Resolve a logo id or alias to its entry. Throws with the available options
 * when nothing matches, so a typo'd overlay spec fails loudly before compose.
 */
export function resolveLogo(lib: Library, idOrAlias: string): LibraryEntry<LogoMeta> {
  const want = idOrAlias.toLowerCase();
  const hit = lib.logos.find(
    (l) =>
      l.meta.id === want ||
      l.meta.name.toLowerCase() === want ||
      (l.meta.aliases ?? []).some((a) => a.toLowerCase() === want),
  );
  if (hit) return hit;
  throw new Error(
    `Unknown logo "${idOrAlias}". In library: ${
      lib.logos.map((l) => l.meta.id).join(", ") || "(none — add one with bun run library add-logo)"
    }`,
  );
}

/**
 * Resolve a cutout id to its entry. Throws with the available options when
 * nothing matches, so a typo'd --cutout fails loudly before compose.
 */
export function resolveCutout(lib: Library, id: string): LibraryEntry<CutoutMeta> {
  const hit = lib.cutouts.find((c) => c.meta.id === id);
  if (hit) return hit;
  throw new Error(
    `Unknown cutout "${id}". In library: ${
      lib.cutouts.map((c) => c.meta.id).join(", ") ||
      "(none — add one with bun run library add-cutout <file> --id <name>)"
    }`,
  );
}

// --- the asset resolution contract ------------------------------------------
//
// One runtime-validated contract for both scopes: reusable-library assets
// (`<id>` / `library:<id>`) and project-local assets (a project-relative
// path). A reference may pin exact content with `@<hash>` — the sha-256 of
// the bytes, full or an unambiguous prefix. The file's bytes are the single
// source of truth: the hash is always derived, never stored in meta.json, so
// changing the bytes creates a different identity and old pinned references
// fail loudly instead of silently resolving to new content.

/** Full sha-256 hex or an unambiguous prefix of one (8–64 hex chars). */
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

/** Parse one asset reference into its scope and exact-content pin. */
export function parseAssetRef(ref: string): AssetRef {
  const raw = ref.trim();
  if (!raw) throw new Error(`empty asset reference — expected an asset id or path`);

  const isLibrary =
    raw.startsWith("library:") || (!raw.includes("/") && !raw.startsWith("."));
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
  kind?: "logo" | "plate" | "cutout";
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
 */
export async function resolveAsset(
  projectRoot: string,
  lib: Library,
  ref: string,
): Promise<ResolvedAsset> {
  const parsed = parseAssetRef(ref);

  if (parsed.scope === "library") {
    const want = parsed.id!.toLowerCase();
    const entry =
      lib.logos.find(
        (l) =>
          l.meta.id === want ||
          (l.meta.name ?? "").toLowerCase() === want ||
          (l.meta.aliases ?? []).some((a) => a.toLowerCase() === want),
      ) ?? [...lib.plates, ...lib.cutouts].find((e) => e.meta.id === want);
    if (!entry) {
      const all = [...lib.logos, ...lib.plates, ...lib.cutouts];
      throw new Error(
        `unknown library asset "${parsed.id}". In library: ${
          all.map((e) => e.meta.id).join(", ") || "(empty — add assets with bun run library)"
        }`,
      );
    }
    const bytes = new Uint8Array(await readFile(entry.imagePath));
    const hash = contentHash(bytes);
    verifyIdentity(entry.meta.id, parsed.hash, hash);
    return {
      scope: "library",
      id: entry.meta.id,
      kind: entry.meta.kind,
      bytes,
      mediaType: mediaTypeFor(entry.imagePath),
      hash,
    };
  }

  const abs = path.resolve(projectRoot, parsed.path!);
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
  const hash = contentHash(bytes);
  const rel = path.relative(projectRoot, abs).split(path.sep).join("/");
  verifyIdentity(rel, parsed.hash, hash);
  return { scope: "project", path: rel, bytes, mediaType: mediaTypeFor(abs), hash };
}
