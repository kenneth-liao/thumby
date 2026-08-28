/**
 * Scene v1: load, validate, and resolve — the one gate before any render.
 *
 * Validation runs entirely before the browser starts, in three passes over
 * the same document:
 *   1. Schema pass (ajv over src/scene-schema.ts) — field shapes, enums,
 *      canvas, opacity/size bounds, per-type required fields, unknown
 *      properties. Field-specific paths: image/text layers are oneOf branches
 *      in the schema, and a failed layer is re-validated against the branch
 *      it claims so errors stay field-specific instead of ajv's opaque
 *      oneOf error.
 *   2. Semantic pass — everything JSON Schema can't say: duplicate layer ids
 *      and crop sums.
 *   3. Resolution pass — assets through the one contract in src/assets.ts
 *      (exact bytes, hash pins), text fonts against the bundled-face registry.
 *
 * Every failure names the offending field as `layers[2].asset`, `canvas.width`,
 * `schemaVersion`, ... so an external agent can target the fix.
 */
import Ajv from "ajv";
import type { ErrorObject as AjvError } from "ajv";
import path from "node:path";
import { SCENE_SCHEMA } from "./scene-schema.js";
import {
  EMPTY_LIBRARY,
  parseAssetRef,
  resolveAsset,
  type Library,
  type ResolvedAsset,
} from "./assets.js";
import { resolveFace } from "./fonts.js";

export { SCENE_SCHEMA };
export const SCHEMA_VERSION = 1;

export interface SceneError {
  /** The offending field, e.g. `layers[2].asset`, `canvas.width`, `schemaVersion`. */
  path: string;
  message: string;
}

/** Properties every layer carries: its stable id plus the shared transform set. */
export interface BaseLayer {
  id: string;
  visible?: boolean;
  opacity?: number;
  position: { x: number; y: number };
  size: { width: number; height: number };
  rotation?: number;
  mirror?: boolean;
}

export interface ImageLayer extends BaseLayer {
  type: "image";
  asset: string;
  fit?: "cover" | "contain" | "fill" | "none";
  crop?: { left: number; top: number; right: number; bottom: number };
}

export interface TextLayer extends BaseLayer {
  type: "text";
  text: string;
  font: string;
  fontSize: number;
  color?: string;
  align?: "left" | "center" | "right";
  lineHeight?: number;
}

export type SceneLayer = ImageLayer | TextLayer;

export interface Scene {
  schemaVersion: number;
  canvas: { width: number; height: number };
  layers: SceneLayer[];
}

export interface ResolvedScene {
  scene: Scene;
  /** Exact bytes per image layer, keyed by layer id — the asset identities a render used. */
  assets: Map<string, ResolvedAsset>;
}

export type LoadResult =
  | { ok: true; resolved: ResolvedScene }
  | { ok: false; errors: SceneError[] };

// --- schema pass ---------------------------------------------------------------

const ajv = new Ajv({ allErrors: true, verbose: true });
const validateSchema = ajv.compile(SCENE_SCHEMA);

/**
 * Per-type layer validators, derived from SCENE_SCHEMA's own oneOf branches —
 * no second home for the layer shape. When a layer fails the oneOf, ajv emits
 * both branches' errors plus an opaque oneOf error at the layer path; re-running
 * the branch the layer claims yields field-specific errors (layers[0].asset).
 */
const branchValidators = {
  image: ajv.compile({
    ...(SCENE_SCHEMA.definitions.imageLayer as unknown as Record<string, unknown>),
    definitions: SCENE_SCHEMA.definitions,
  }),
  text: ajv.compile({
    ...(SCENE_SCHEMA.definitions.textLayer as unknown as Record<string, unknown>),
    definitions: SCENE_SCHEMA.definitions,
  }),
};

/** `jsonPointerToPath` output relative to a layer, prefixed with `layers[i]`. */
const layerPath = (at: string, sub: string) => `${at}.${jsonPointerToPath(sub)}`;

/**
 * Expand a failed oneOf at `layers[i]` into that layer's field-specific schema
 * errors, dropping both branches' raw inner errors. Non-layer errors pass through.
 */
function expandLayerErrors(errors: AjvError[]): SceneError[] {
  const out: SceneError[] = [];
  for (const err of errors) {
    const m = /^\/layers\/(\d+)(\/|$)/.exec(err.instancePath);
    if (!m) {
      out.push(describeSchemaError(err));
      continue;
    }
    if (err.keyword !== "oneOf") continue; // branch-internal noise; the oneOf error owns this layer
    const at = `layers[${m[1]}]`;
    const layer = err.data as Record<string, unknown> | undefined;
    const type = layer?.type;
    if (type !== "image" && type !== "text") {
      const nonObject = typeof layer !== "object" || layer === null;
      out.push({
        path: nonObject ? at : `${at}.type`,
        message: nonObject
          ? "each layer must be an image or text object"
          : `unknown layer type ${JSON.stringify(type)} — supported types: image, text`,
      });
      continue;
    }
    const validate = branchValidators[type];
    validate(layer);
    out.push(
      ...validate.errors!.map((e): SceneError => {
        if (e.keyword === "required") {
          const prop = e.params?.missingProperty as string;
          return {
            path: `${at}.${prop}`,
            message: `"${prop}" is required on ${type} layers`,
          };
        }
        if (e.keyword === "additionalProperties") {
          const prop = e.params?.additionalProperty as string;
          return {
            path: `${at}.${prop}`,
            message: `"${prop}" is not a valid layer property`,
          };
        }
        return {
          path: e.instancePath ? layerPath(at, e.instancePath) : at,
          message: e.message ?? "is invalid",
        };
      }),
    );
  }
  return out;
}

/** JSON pointer `/layers/2/size/width` → field path `layers[2].size.width`. */
function jsonPointerToPath(pointer: string, leaf?: string): string {
  const parts: string[] = [];
  for (const seg of [...pointer.split("/").slice(1), ...(leaf ? [leaf] : [])]) {
    if (/^\d+$/.test(seg)) parts.push(`[${seg}]`);
    else parts.push(parts.length ? `.${seg}` : seg);
  }
  return parts.join("");
}

function describeSchemaError(err: AjvError): SceneError {
  const data = JSON.stringify(err.data);
  const leaf = err.params?.missingProperty as string | undefined;
  if (leaf) {
    return err.instancePath === ""
      ? { path: leaf, message: `the scene requires "${leaf}"` }
      : { path: jsonPointerToPath(err.instancePath, leaf), message: `"${leaf}" is required on every layer` };
  }
  if (err.instancePath === "/schemaVersion") {
    return {
      path: "schemaVersion",
      message: `unsupported schemaVersion ${data} — this tool supports version ${SCHEMA_VERSION} only`,
    };
  }
  if (err.instancePath.startsWith("/canvas")) {
    return {
      path: jsonPointerToPath(err.instancePath),
      message: "the canvas must be exactly 1280×720 — only the YouTube thumbnail canvas is supported",
    };
  }
  if (err.keyword === "additionalProperties") {
    const prop = err.params.additionalProperty as string;
    return {
      path: jsonPointerToPath(err.instancePath, prop),
      message: `"${prop}" is not a valid layer property`,
    };
  }
  return {
    path: jsonPointerToPath(err.instancePath),
    message: err.message ?? "is invalid",
  };
}

// --- semantic pass ---------------------------------------------------------------

/**
 * Cross-layer and cross-field rules the schema can't express: duplicate layer
 * ids and crop insets that sum past the source. Per-type required and
 * misplaced fields are the schema's oneOf branches' job (one home).
 */
function semanticErrors(scene: Scene): SceneError[] {
  const errors: SceneError[] = [];
  const firstOwner = new Map<string, number>();
  scene.layers.forEach((layer, i) => {
    const at = (field: string, message: string) =>
      errors.push({ path: `layers[${i}].${field}`, message });

    const owner = firstOwner.get(layer.id);
    if (owner !== undefined)
      at("id", `duplicate layer id "${layer.id}" — first used at layers[${owner}]`);
    else firstOwner.set(layer.id, i);

    if (layer.type === "image" && layer.crop) {
      const { left, top, right, bottom } = layer.crop;
      if (left + right >= 100)
        at(
          "crop",
          `crop insets leave no source width (left ${left}% + right ${right}% ≥ 100%)`,
        );
      if (top + bottom >= 100)
        at(
          "crop",
          `crop insets leave no source height (top ${top}% + bottom ${bottom}% ≥ 100%)`,
        );
    }
  });
  return errors;
}

// --- resolution pass -------------------------------------------------------------

async function resolutionErrors(
  projectRoot: string,
  library: () => Promise<Library>,
  scene: Scene,
  assets: Map<string, ResolvedAsset>,
): Promise<SceneError[]> {
  const errors: SceneError[] = [];
  // The library materializes at most once, and only when a scene actually
  // references a library asset — a project-only scene never scans it.
  let libPromise: Promise<Library> | undefined;
  const getLibrary = () => (libPromise ??= library());
  for (const [i, layer] of scene.layers.entries()) {
    if (layer.type === "image") {
      try {
        const lib =
          parseAssetRef(layer.asset).scope === "library"
            ? await getLibrary()
            : EMPTY_LIBRARY;
        assets.set(layer.id, await resolveAsset(projectRoot, lib, layer.asset));
      } catch (err) {
        errors.push({
          path: `layers[${i}].asset`,
          message: (err as Error).message,
        });
      }
    } else {
      try {
        resolveFace(layer.font);
      } catch (err) {
        errors.push({
          path: `layers[${i}].font`,
          message: (err as Error).message,
        });
      }
    }
  }
  return errors;
}

// --- the one gate -----------------------------------------------------------------

/**
 * Load a raw Scene document: validate shape, semantics, and resolution.
 * The single gate every consumer (validate / inspect / render) reads through —
 * all failures land here, before any browser exists.
 *
 * `library` is a provider, not a value: the repo asset library is scanned at
 * most once, and only if a layer actually references a library asset.
 *
 * Project-scope asset references resolve relative to `projectRoot` (the scene
 * file's directory), so a scene plus its local assets is a relocatable bundle.
 */
export async function loadScene(
  projectRoot: string,
  library: () => Promise<Library>,
  raw: unknown,
): Promise<LoadResult> {
  if (!validateSchema(raw)) {
    return { ok: false, errors: expandLayerErrors(validateSchema.errors!) };
  }
  const scene = raw as Scene;
  const errors = semanticErrors(scene);
  const assets = new Map<string, ResolvedAsset>();
  if (errors.length === 0)
    errors.push(...(await resolutionErrors(path.resolve(projectRoot), library, scene, assets)));
  if (errors.length) return { ok: false, errors };
  return { ok: true, resolved: { scene, assets } };
}
