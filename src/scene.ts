/**
 * Scene v1: load, validate, and resolve — the one gate before any render.
 *
 * Validation runs entirely before the browser starts, in two passes over the
 * same document:
 *   1. Schema pass (ajv over src/scene-schema.ts) — field shapes, enums,
 *      canvas, opacity/size bounds, unknown properties. Field-specific paths.
 *   2. Semantic pass — everything JSON Schema can't say: duplicate layer ids,
 *      type-specific required fields and misplaced fields, crop sums.
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
  if (err.keyword === "enum" && err.instancePath.endsWith("/type")) {
    return {
      path: jsonPointerToPath(err.instancePath),
      message: `unknown layer type ${data} — supported types: image, text`,
    };
  }
  return {
    path: jsonPointerToPath(err.instancePath),
    message: err.message ?? "is invalid",
  };
}

// --- semantic pass ---------------------------------------------------------------

const IMAGE_ONLY_FIELDS = ["asset", "fit", "crop"] as const;
const TEXT_ONLY_FIELDS = ["text", "font", "fontSize", "color", "align", "lineHeight"] as const;

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

    const raw = layer as unknown as Record<string, unknown>;
    if (layer.type === "image") {
      if (typeof raw.asset !== "string")
        at("asset", "an image layer requires an asset reference");
      for (const f of TEXT_ONLY_FIELDS)
        if (raw[f] !== undefined) at(f, `"${f}" applies only to text layers`);
      if (layer.crop) {
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
    } else {
      for (const f of IMAGE_ONLY_FIELDS)
        if (raw[f] !== undefined) at(f, `"${f}" applies only to image layers`);
      if (typeof raw.text !== "string")
        at("text", "a text layer requires text content");
      if (typeof raw.font !== "string")
        at("font", "a text layer requires a font family");
      if (typeof raw.fontSize !== "number")
        at("fontSize", "a text layer requires a fontSize");
    }
  });
  return errors;
}

// --- resolution pass -------------------------------------------------------------

async function resolutionErrors(
  projectRoot: string,
  lib: Library,
  scene: Scene,
  assets: Map<string, ResolvedAsset>,
): Promise<SceneError[]> {
  const errors: SceneError[] = [];
  for (const [i, layer] of scene.layers.entries()) {
    if (layer.type === "image") {
      try {
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
 * Project-scope asset references resolve relative to `projectRoot` (the scene
 * file's directory), so a scene plus its local assets is a relocatable bundle.
 */
export async function loadScene(
  projectRoot: string,
  lib: Library,
  raw: unknown,
): Promise<LoadResult> {
  if (!validateSchema(raw)) {
    return { ok: false, errors: validateSchema.errors!.map(describeSchemaError) };
  }
  const scene = raw as Scene;
  const errors = semanticErrors(scene);
  const assets = new Map<string, ResolvedAsset>();
  if (errors.length === 0)
    errors.push(...(await resolutionErrors(path.resolve(projectRoot), lib, scene, assets)));
  if (errors.length) return { ok: false, errors };
  return { ok: true, resolved: { scene, assets } };
}
