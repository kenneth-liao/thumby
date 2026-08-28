// The identity kit: Kenneth's tagged headshot index, searchable by role
// facets (REQ-016). `index.json` inside the kit is the canonical metadata —
// the kit predates the one-dir-per-asset library layout, so scanning derives
// each source's canonical shape (facets, content hash) at call time, exactly
// like the byte-hashed library kinds. Facet semantics: values on the same
// axis are alternatives (any-of); facets on different axes must all match
// (all-of). A known combination with no source is an explicit empty result —
// never inferred or invented metadata.
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
// Circular with assets.ts by design: assets.ts calls scanIdentityKit at scan
// time, identity.ts uses contentHash at call time — no module-init-order
// dependency in either direction.
import { contentHash, type LibraryEntry } from "./assets.js";

/** The one identity kit inside the library root. */
export const IDENTITY_KIT_DIR = "identity/kenny-headshots";

/**
 * A headshot in the identity kit. Its reuse value is the role it can play —
 * pose, facing, expression, gesture, outfit, framing — because everything
 * else in the final thumbnail is applied at compose time.
 */
export interface IdentityMeta {
  kind: "identity";
  id: string;
  name: string;
  tags: string[];
  /** Canonical axis → values for this source, derived at scan time. */
  facets: Record<string, string[]>;
}

/** The declared facet vocabulary of the identity kit: axis → searchable values. */
export type IdentityVocabulary = Record<string, string[]>;

/** A scanned kit: whether it exists, its sources, and its declared vocabulary. */
export interface IdentityKit {
  /** The kit directory exists — an existing kit may still hold zero sources. */
  present: boolean;
  entries: LibraryEntry<IdentityMeta>[];
  vocabulary: IdentityVocabulary;
}

/** The canonical empty kit — for callers scanning a library with no kit. */
export const EMPTY_IDENTITY_KIT: IdentityKit = { present: false, entries: [], vocabulary: {} };

interface RawIndex {
  tag_vocabulary?: Record<string, string[]>;
  common?: Record<string, unknown>;
  images?: unknown;
}

/**
 * The index stores the outfit on `common.clothing` and the framing on
 * `common.framing`; REQ-016 names those facets `outfit` and `framing`, so the
 * rename happens once here — every downstream reader assumes canonical axes.
 */
const COMMON_AXES: Record<string, string> = { clothing: "outfit", framing: "framing" };
const COMMON_AXIS_NAMES = Object.values(COMMON_AXES);

export async function scanIdentityKit(root: string): Promise<IdentityKit> {
  const kitDir = path.join(root, IDENTITY_KIT_DIR);
  try {
    await stat(kitDir);
  } catch {
    return EMPTY_IDENTITY_KIT; // a missing kit is an empty one
  }

  let raw: RawIndex;
  try {
    raw = JSON.parse(await readFile(path.join(kitDir, "index.json"), "utf8"));
  } catch (err) {
    throw new Error(
      `identity kit ${kitDir} has no readable index.json: ${(err as Error).message}`,
    );
  }
  if (!Array.isArray(raw.images))
    throw new Error(`identity kit ${kitDir}/index.json: "images" must be an array`);

  const vocabulary = buildVocabulary(raw);
  const tagToAxis = new Map<string, string>();
  for (const [axis, values] of Object.entries(vocabulary)) {
    if (axis in COMMON_AXES) continue; // common-derived axes carry no tags
    for (const value of values) {
      const owner = tagToAxis.get(value);
      if (owner && owner !== axis)
        throw new Error(
          `identity kit ${kitDir}/index.json: tag "${value}" is declared under both "${owner}" and "${axis}"`,
        );
      tagToAxis.set(value, axis);
    }
  }

  const entries: LibraryEntry<IdentityMeta>[] = [];
  const seen = new Set<string>();
  for (const [i, rawImage] of raw.images.entries()) {
    const where = `identity kit ${kitDir}/index.json: images[${i}]`;
    if (typeof rawImage !== "object" || rawImage === null)
      throw new Error(`${where} must be an object`);
    const { file, tags } = rawImage as { file?: unknown; tags?: unknown };
    if (typeof file !== "string" || !file) throw new Error(`${where} has no "file"`);
    if (!Array.isArray(tags) || !tags.every((t) => typeof t === "string"))
      throw new Error(`${where} ("${file}"): "tags" must be an array of strings`);

    const id = path.basename(file, path.extname(file));
    if (seen.has(id)) throw new Error(`${where}: duplicate source id "${id}"`);
    seen.add(id);
    if (path.basename(file) !== file)
      throw new Error(`${where}: "file" must be a plain filename inside the kit, got "${file}"`);
    const imagePath = path.join(kitDir, file);
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await readFile(imagePath));
    } catch (err) {
      throw new Error(
        `identity kit ${kitDir}/index.json: "${file}" is indexed but missing on disk (${(err as Error).message})`,
      );
    }

    const facets: Record<string, string[]> = {};
    for (const tag of tags as string[]) {
      const axis = tagToAxis.get(tag);
      if (!axis)
        throw new Error(
          `${where} ("${file}"): tag "${tag}" is not in the index tag_vocabulary — re-index the kit or fix the tag`,
        );
      (facets[axis] ??= []).push(tag);
    }
    for (const axis of COMMON_AXIS_NAMES) {
      const declared = vocabulary[axis];
      if (declared) (facets[axis] ??= []).push(...declared);
    }

    entries.push({
      meta: { kind: "identity", id, name: file, tags: tags as string[], facets },
      imagePath,
      kind: "raster",
      hash: contentHash(bytes),
    });
  }
  return { present: true, entries, vocabulary };
}

/** Declared axes: every tag_vocabulary axis plus the common-derived outfit/framing facets. */
function buildVocabulary(raw: RawIndex): IdentityVocabulary {
  const vocabulary: IdentityVocabulary = {};
  for (const [axis, values] of Object.entries(raw.tag_vocabulary ?? {})) {
    if (!Array.isArray(values) || !values.every((v) => typeof v === "string"))
      throw new Error(`identity kit index.json: tag_vocabulary["${axis}"] must be an array of strings`);
    vocabulary[axis] = values;
  }
  const common = raw.common;
  for (const [key, axis] of Object.entries(COMMON_AXES)) {
    if (!common || !(key in common)) continue;
    const value = common[key];
    if (typeof value !== "string" || !value.trim())
      throw new Error(
        `identity kit index.json: common.${key} must be a non-empty string (it names the "${axis}" facet)`,
      );
    vocabulary[axis] = [value];
  }
  return vocabulary;
}

/**
 * Filter identity sources by facet combination. Axes/values are validated
 * against the kit's declared vocabulary — a typo fails loudly with the
 * searchable vocabulary; a known combination that no source satisfies is an
 * explicit empty result.
 */
export function searchIdentityFacets(
  entries: LibraryEntry<IdentityMeta>[],
  facets: Record<string, string[]>,
  vocabulary: IdentityVocabulary,
): LibraryEntry<IdentityMeta>[] {
  // An empty pool satisfies no combination, and there is no vocabulary to
  // validate the request against — an explicit empty result is the truthful
  // answer, not an error.
  if (entries.length === 0) return [];
  for (const [axis, wanted] of Object.entries(facets)) {
    const known = vocabulary[axis];
    if (!known)
      throw new Error(
        `unknown identity facet "${axis}" — available: ${
          Object.keys(vocabulary).sort().join(", ") || "(none — the identity kit declares no facets)"
        }`,
      );
    for (const value of wanted) {
      if (!known.includes(value))
        throw new Error(
          `unknown "${axis}" facet value "${value}" — available: ${known.join(", ")}`,
        );
    }
  }
  return entries.filter((entry) =>
    Object.entries(facets).every(([axis, wanted]) =>
      (entry.meta.facets[axis] ?? []).some((value) => wanted.includes(value)),
    ),
  );
}

/**
 * Parse CLI facet terms (`axis=value`, one per --facets flag) into the
 * canonical search shape. One term per flag keeps values with commas or
 * spaces intact — e.g. the kit's `framing=standing mid-shot, torso up`.
 */
export function parseFacets(terms: string[]): Record<string, string[]> {
  const facets: Record<string, string[]> = {};
  for (const term of terms) {
    const eq = term.indexOf("=");
    if (eq <= 0 || eq === term.length - 1)
      throw new Error(
        `invalid facet "${term}" — expected "axis=value"; repeat --facets to combine axes or alternatives`,
      );
    (facets[term.slice(0, eq).trim()] ??= []).push(term.slice(eq + 1).trim());
  }
  return facets;
}
