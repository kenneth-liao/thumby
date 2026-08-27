import { readFile, readdir, stat } from "node:fs/promises";
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

export type AssetMeta = LogoMeta | PlateMeta;

export interface LibraryEntry<M extends AssetMeta = AssetMeta> {
  meta: M;
  imagePath: string;
  /** "svg" images are recolourable in-card; rasters are shown as-is. */
  kind: "svg" | "raster";
}

export interface Library {
  logos: LibraryEntry<LogoMeta>[];
  plates: LibraryEntry<PlateMeta>[];
}

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

function scanKindDir(root: string, subdir: "logos" | "plates"): Promise<LibraryEntry[]> {
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
      if (meta.kind !== "logo" && meta.kind !== "plate")
        throw new Error(`${dir}/meta.json: unknown kind "${(meta as any).kind}"`);
      if (meta.id !== d)
        throw new Error(
          `${dir}/meta.json: id "${meta.id}" does not match directory name "${d}"`,
        );
      entries.push({
        meta,
        imagePath: imgResult,
        kind: imgResult.toLowerCase().endsWith(".svg") ? "svg" : "raster",
      });
    }
    return entries;
  })();
}

export async function scanLibrary(root: string): Promise<Library> {
  const [logos, plates] = await Promise.all([
    scanKindDir(root, "logos"),
    scanKindDir(root, "plates"),
  ]);
  // An id is the vocabulary every reader uses; it must be unambiguous library-wide.
  const seen = new Map<string, string>();
  for (const [kind, entries] of [
    ["logos", logos],
    ["plates", plates],
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
