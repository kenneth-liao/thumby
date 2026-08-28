/**
 * The Render manifest — the portable record of one render invocation (REQ-010).
 *
 * One manifest is written beside a render's outputs. Every path inside it is
 * relative to the manifest file's own directory in portable `/` form, so
 * moving the project directory never invalidates a manifest-backed rerender:
 * the manifest, the scene, and the assets all move together, and identity is
 * content (sha-256), never location.
 *
 * The manifest is an identity record, not a provenance copy: asset entries
 * carry exactly what resolved (scope, id/kind/path, hash, mediaType) — the
 * canonical provenance stays on the Asset (or its Generation Job), and the
 * sha-256 pins the exact bytes a rerender must see (drift fails, never
 * silently resolves newer content — src/assets.ts owns the resolution
 * contract; this module verifies against it).
 */
import { readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { ResolvedAsset } from "./assets.js";
import type { ResolvedScene, SceneError } from "./scene.js";

export const MANIFEST_VERSION = 1;

/** sha-256 hex of the exact bytes — the identity a rerender verifies. */
const SHA256 = /^[0-9a-f]{64}$/;

/** sha-256 of the exact bytes. */
export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * A path as the manifest stores it: relative to the manifest file's own
 * directory, `/`-separated, so it survives relocation unchanged.
 */
export function relPath(fromDir: string, target: string): string {
  return path.relative(fromDir, target).split(path.sep).join("/");
}

/** The manifest path paired with a render output: `out/foo.png` → `out/foo.manifest.json`. */
export function manifestPathFor(outputPath: string): string {
  return outputPath.replace(/\.png$/i, "") + ".manifest.json";
}

/**
 * The tool version — read once from the one canonical home (package.json),
 * so the manifest and the CLI never disagree about what produced a render.
 */
export function toolVersion(): string {
  const pkg = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version: string };
  return pkg.version;
}

/** One resolved asset's identity — identity fields only, never provenance. */
export interface ManifestAsset {
  /** The image layer id the asset resolved for. */
  layer: string;
  scope: "library" | "project";
  /** Library scope: the resolved asset id (post-alias). */
  id?: string;
  /** Library scope: the asset kind. */
  kind?: "logo" | "plate" | "cutout";
  /** Project scope: the path relative to the scene's directory, as resolved. */
  path?: string;
  hash: string;
  mediaType: string;
}

/** The manifest's identity record of one resolved asset, keyed by its layer. */
export function assetEntry(layer: string, a: ResolvedAsset): ManifestAsset {
  return {
    layer,
    scope: a.scope,
    ...(a.id !== undefined ? { id: a.id } : {}),
    ...(a.kind !== undefined ? { kind: a.kind } : {}),
    ...(a.path !== undefined ? { path: a.path } : {}),
    hash: a.hash,
    mediaType: a.mediaType,
  };
}

/** One rendered output: its file, geometry, content hash, warnings, and the exact asset identities it used. */
export interface ManifestOutput {
  /** The output file, relative to the manifest file's directory. */
  output: string;
  width: number;
  height: number;
  sha256: string;
  warnings: string[];
  assets: ManifestAsset[];
}

/** The batch contact sheet, when the render wrote one. */
export interface ManifestContact {
  output: string;
  width: number;
  height: number;
  sha256: string;
}

/** The portable record of one render invocation. */
export interface RenderManifest {
  manifestVersion: typeof MANIFEST_VERSION;
  tool: { name: string; version: string };
  schemaVersion: number;
  /** Scene identity: manifest-relative path plus the scene file's exact bytes. */
  scene: { path: string; sha256: string };
  /** The selected Variants — `[]` renders the base Scene. */
  variant: string[];
  outputs: ManifestOutput[];
  contact?: ManifestContact;
}

export interface ManifestRenderInput {
  /** Absolute path of the rendered output file. */
  output: string;
  width: number;
  height: number;
  warnings: string[];
  png: Buffer;
  /** The resolved scene this output rendered — the source of its asset identities. */
  resolved: ResolvedScene;
}

/**
 * Build the manifest for one render invocation. `manifestDir` is where the
 * manifest will be written; every recorded path is computed relative to it.
 * `sceneSha256` must be the hash of the same scene bytes the caller parsed.
 */
export function buildManifest(opts: {
  manifestDir: string;
  sceneFile: string;
  sceneSha256: string;
  variant: string[];
  outputs: ManifestRenderInput[];
  contact?: { output: string; width: number; height: number; png: Buffer };
}): RenderManifest {
  return {
    manifestVersion: MANIFEST_VERSION,
    tool: { name: "thumby", version: toolVersion() },
    schemaVersion: opts.outputs[0]!.resolved.scene.schemaVersion,
    scene: {
      path: relPath(opts.manifestDir, opts.sceneFile),
      sha256: opts.sceneSha256,
    },
    variant: opts.variant,
    outputs: opts.outputs.map((o) => ({
      output: relPath(opts.manifestDir, o.output),
      width: o.width,
      height: o.height,
      sha256: sha256(o.png),
      warnings: o.warnings,
      assets: [...o.resolved.assets.entries()].map(([layer, a]) => assetEntry(layer, a)),
    })),
    ...(opts.contact
      ? {
          contact: {
            output: relPath(opts.manifestDir, opts.contact.output),
            width: opts.contact.width,
            height: opts.contact.height,
            sha256: sha256(opts.contact.png),
          },
        }
      : {}),
  };
}

export async function writeManifest(file: string, manifest: RenderManifest): Promise<void> {
  await writeFile(file, JSON.stringify(manifest, null, 2) + "\n");
}

// --- strict reading ------------------------------------------------------------
//
// The manifest is a machine contract: a rerender must fail on any shape it
// does not understand rather than guess. Errors carry field paths
// (`outputs[0].sha256`) like every other structured failure in this tool.

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const isHex64 = (v: unknown): v is string => typeof v === "string" && SHA256.test(v);
const isPosInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;
/** A portable relative path: `/`-separated, never absolute, no Windows separators. */
const isRelPath = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0 && !path.isAbsolute(v) && !v.includes("\\");

class ManifestErrors {
  readonly errors: SceneError[] = [];
  at(path: string, message: string): void {
    this.errors.push({ path, message });
  }
}

/** Known keys per object — unknown keys are rejected, never silently ignored. */
const OUTPUT_KEYS = new Set(["output", "width", "height", "sha256", "warnings", "assets"]);
const ASSET_KEYS = new Set(["layer", "scope", "id", "kind", "path", "hash", "mediaType"]);

function checkAsset(at: string, v: unknown, errs: ManifestErrors): void {
  if (!isObject(v)) return errs.at(at, "must be an asset identity object");
  for (const k of Object.keys(v)) if (!ASSET_KEYS.has(k)) errs.at(`${at}.${k}`, `"${k}" is not a valid asset identity field`);
  if (typeof v.layer !== "string" || !v.layer) errs.at(`${at}.layer`, `"layer" must be a layer id`);
  if (v.scope !== "library" && v.scope !== "project")
    errs.at(`${at}.scope`, `"scope" must be "library" or "project"`);
  if (!isHex64(v.hash)) errs.at(`${at}.hash`, `"hash" must be a full sha-256 hex digest`);
  if (typeof v.mediaType !== "string" || !v.mediaType) errs.at(`${at}.mediaType`, `"mediaType" must be a string`);
  if (v.id !== undefined && (typeof v.id !== "string" || !v.id)) errs.at(`${at}.id`, `"id" must be a string`);
  if (v.kind !== undefined && v.kind !== "logo" && v.kind !== "plate" && v.kind !== "cutout")
    errs.at(`${at}.kind`, `"kind" must be "logo", "plate", or "cutout"`);
  if (v.path !== undefined && !isRelPath(v.path)) errs.at(`${at}.path`, `"path" must be a relative path`);
  if (v.scope === "library" && typeof v.id !== "string")
    errs.at(`${at}.id`, `a library asset identity needs the resolved asset "id"`);
  if (v.scope === "project" && typeof v.path !== "string")
    errs.at(`${at}.path`, `a project asset identity needs the resolved "path"`);
}

function checkOutput(at: string, v: unknown, errs: ManifestErrors): void {
  if (!isObject(v)) return errs.at(at, "must be an output object");
  for (const k of Object.keys(v)) if (!OUTPUT_KEYS.has(k)) errs.at(`${at}.${k}`, `"${k}" is not a valid output field`);
  if (!isRelPath(v.output)) errs.at(`${at}.output`, `"output" must be a path relative to the manifest file`);
  if (!isPosInt(v.width)) errs.at(`${at}.width`, `"width" must be a positive integer`);
  if (!isPosInt(v.height)) errs.at(`${at}.height`, `"height" must be a positive integer`);
  if (!isHex64(v.sha256)) errs.at(`${at}.sha256`, `"sha256" must be a full sha-256 hex digest`);
  if (!Array.isArray(v.warnings) || !v.warnings.every((w) => typeof w === "string"))
    errs.at(`${at}.warnings`, `"warnings" must be an array of strings`);
  if (!Array.isArray(v.assets)) errs.at(`${at}.assets`, `"assets" must be an array`);
  else v.assets.forEach((a, i) => checkAsset(`${at}.assets[${i}]`, a, errs));
}

/**
 * Strictly read and validate a manifest from its bytes. Every structural
 * problem is reported with its field path; a rerender never proceeds on a
 * partial guess of what a render recorded.
 */
export async function readManifest(
  file: string,
  bytes?: Buffer,
): Promise<{ ok: true; manifest: RenderManifest } | { ok: false; errors: SceneError[] }> {
  let text: string;
  try {
    text = (bytes ?? await readFile(file, "utf8")).toString("utf8");
  } catch (err) {
    return {
      ok: false,
      errors: [{ path: path.basename(file), message: `cannot read manifest: ${(err as Error).message}` }],
    };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { ok: false, errors: [{ path: path.basename(file), message: `invalid JSON: ${(err as Error).message}` }] };
  }
  const errs = new ManifestErrors();
  if (!isObject(raw)) return { ok: false, errors: [{ path: "manifest", message: "the manifest must be a JSON object" }] };
  for (const k of Object.keys(raw))
    if (
      !["manifestVersion", "tool", "schemaVersion", "scene", "variant", "outputs", "contact"].includes(k)
    )
      errs.at(k, `"${k}" is not a valid manifest field`);

  if (raw.manifestVersion !== MANIFEST_VERSION)
    errs.at(
      "manifestVersion",
      `unsupported manifestVersion ${JSON.stringify(raw.manifestVersion)} — this tool supports version ${MANIFEST_VERSION} only`,
    );
  if (!isObject(raw.tool)) errs.at("tool", `"tool" must be an object with "name" and "version"`);
  else {
    if (typeof raw.tool.name !== "string" || !raw.tool.name) errs.at("tool.name", `"name" must be a string`);
    if (typeof raw.tool.version !== "string" || !raw.tool.version) errs.at("tool.version", `"version" must be a string`);
  }
  if (typeof raw.schemaVersion !== "number") errs.at("schemaVersion", `"schemaVersion" must be a number`);
  if (!isObject(raw.scene)) errs.at("scene", `"scene" must be an object with "path" and "sha256"`);
  else {
    if (!isRelPath(raw.scene.path)) errs.at("scene.path", `"path" must be a path relative to the manifest file`);
    if (!isHex64(raw.scene.sha256)) errs.at("scene.sha256", `"sha256" must be a full sha-256 hex digest`);
  }
  if (!Array.isArray(raw.variant) || !raw.variant.every((v) => typeof v === "string"))
    errs.at("variant", `"variant" must be an array of variant names (empty for the base Scene)`);
  if (!Array.isArray(raw.outputs) || raw.outputs.length === 0)
    errs.at("outputs", `"outputs" must be a non-empty array of rendered outputs`);
  else raw.outputs.forEach((o, i) => checkOutput(`outputs[${i}]`, o, errs));
  if (raw.contact !== undefined) {
    const at = "contact";
    if (!isObject(raw.contact)) errs.at(at, `"contact" must be an object with "output", "width", "height", "sha256"`);
    else {
      for (const k of Object.keys(raw.contact))
        if (!["output", "width", "height", "sha256"].includes(k))
          errs.at(`${at}.${k}`, `"${k}" is not a valid contact field`);
      if (!isRelPath(raw.contact.output)) errs.at(`${at}.output`, `"output" must be a path relative to the manifest file`);
      if (!isPosInt(raw.contact.width)) errs.at(`${at}.width`, `"width" must be a positive integer`);
      if (!isPosInt(raw.contact.height)) errs.at(`${at}.height`, `"height" must be a positive integer`);
      if (!isHex64(raw.contact.sha256)) errs.at(`${at}.sha256`, `"sha256" must be a full sha-256 hex digest`);
    }
  }
  if (errs.errors.length) return { ok: false, errors: errs.errors };
  return { ok: true, manifest: raw as unknown as RenderManifest };
}
