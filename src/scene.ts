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
 *   2b. Theme pass — verify the Scene's theme pin (content-derived revision,
 *      src/themes.ts) and apply the theme's defaults: explicit layer value >
 *      theme default > renderer built-in default (LAYER_DEFAULTS).
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
import { applyThemeToLayer, getTheme, themeRevision } from "./themes.js";

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
  /** Editable visual effects applied to the image's rendered alpha. */
  effects?: Effects;
  crop?: { left: number; top: number; right: number; bottom: number };
}

/** One styled run inside a text layer; unset fields inherit the layer's values. */
export interface TextSpan {
  text: string;
  font?: string;
  fontSize?: number;
  weight?: number;
  color?: string;
  tracking?: number;
  casing?: "upper" | "lower" | "none";
}

export interface TextLayer extends BaseLayer {
  type: "text";
  /** Plain content — mutually exclusive with `spans` (semantic pass). */
  text?: string;
  /** Styled runs — mutually exclusive with `text` (semantic pass). */
  spans?: TextSpan[];
  font: string;
  /** Fixed size — mutually exclusive with `autoFit` (semantic pass). */
  fontSize?: number;
  /** Shrink-to-fit range — mutually exclusive with `fontSize` (semantic pass). */
  autoFit?: { min: number; max: number };
  /** CSS font weight; default is the bundled face's natural weight. */
  weight?: number;
  /** Letter spacing in em. */
  tracking?: number;
  casing?: "upper" | "lower" | "none";
  /** Solid fill — mutually exclusive with `fill` (semantic pass). */
  color?: string;
  /** Linear gradient fill — mutually exclusive with `color` (semantic pass). */
  fill?: { from: string; to: string; angle?: number };
  stroke?: { width: number; color: string };
  shadows?: { x: number; y: number; blur: number; color: string }[];
  align?: "left" | "center" | "right";
  lineHeight?: number;
}

export type ShapeKind = "rect" | "ellipse" | "triangle";

/**
 * Editable visual effects for image and group content — emitted as one CSS
 * filter chain in a fixed order (blur → colorAdjust → glow → shadow); glow
 * and shadow follow the content's alpha.
 */
export interface Effects {
  blur?: number;
  colorAdjust?: {
    brightness?: number;
    contrast?: number;
    saturate?: number;
    hueRotate?: number;
  };
  glow?: { radius: number; color: string };
  shadow?: { x: number; y: number; blur: number; color: string };
}

export interface ShapeLayer extends BaseLayer {
  type: "shape";
  shape: ShapeKind;
  /** Corner radius in px — rect only (semantic pass). Clamped to half the shorter side in markup. */
  radius?: number;
  /** Solid fill — mutually exclusive with `fill`; default #000 when neither is set. */
  color?: string;
  /** Linear gradient fill — mutually exclusive with `color` (semantic pass). */
  fill?: { from: string; to: string; angle?: number };
  /** Outline centered on the shape's edge. */
  border?: { width: number; color: string };
}

export interface GroupLayer extends BaseLayer {
  type: "group";
  /**
   * Resize factor for the whole group, applied around its center. Children
   * are authored in group-local px and never flattened; 1 (default) renders
   * them at their authored sizes.
   */
  scale?: number;
  /** Editable visual effects applied to the whole composed subtree. */
  effects?: Effects;
  /** Nested layers in group-local px; array order is compositing order. */
  layers: SceneLayer[];
}

export type SceneLayer = ImageLayer | TextLayer | ShapeLayer | GroupLayer;

export interface Scene {
  schemaVersion: number;
  canvas: { width: number; height: number };
  /** Named theme defaults, pinned to an exact revision. */
  theme?: { name: string; revision: string };
  layers: SceneLayer[];
}

export interface ResolvedScene {
  scene: Scene;
  /** Exact bytes per image layer, keyed by layer id — the asset identities a render used. */
  assets: Map<string, ResolvedAsset>;
}

/**
 * The renderer's built-in per-property defaults — the one home, shared by the
 * renderer (which applies them) and the inspector (which surfaces them as the
 * effective values an agent will render). Theme defaults slot above these and
 * explicit Scene values above those: one precedence rule.
 */
export const LAYER_DEFAULTS = {
  visible: true,
  opacity: 1,
  fit: "cover",
  align: "left",
  lineHeight: 1.1,
  color: "#000",
  fillAngle: 90,
} as const;

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
  shape: ajv.compile({
    ...(SCENE_SCHEMA.definitions.shapeLayer as unknown as Record<string, unknown>),
    definitions: SCENE_SCHEMA.definitions,
  }),
  group: ajv.compile({
    ...(SCENE_SCHEMA.definitions.groupLayer as unknown as Record<string, unknown>),
    definitions: SCENE_SCHEMA.definitions,
  }),
};

type LayerType = keyof typeof branchValidators;

const claimedType = (layer: unknown): LayerType | undefined => {
  const t = (layer as Record<string, unknown> | null | undefined)?.type;
  return t === "image" || t === "text" || t === "shape" || t === "group" ? t : undefined;
};

/**
 * The text contract — exactly one of text/spans, exactly one of
 * fontSize/autoFit, at most one of color/fill — with its one set of friendly
 * messages. The schema document enforces the rules itself (the textLayer
 * `allOf` block), so this is only where a violation's opaque oneOf/not
 * failure gets its message. Paths are layer-relative.
 */
function textContractErrors(layer: TextLayer): SceneError[] {
  const errors: SceneError[] = [];
  if (layer.text !== undefined && layer.spans !== undefined)
    errors.push({
      path: "spans",
      message: `"spans" and "text" are mutually exclusive — content lives in one place`,
    });
  else if (layer.text === undefined && layer.spans === undefined)
    errors.push({ path: "text", message: `text layers need "text" or "spans"` });
  if (layer.fontSize !== undefined && layer.autoFit !== undefined)
    errors.push({
      path: "autoFit",
      message: `"autoFit" and "fontSize" are mutually exclusive — one sizing mode per layer`,
    });
  else if (layer.fontSize === undefined && layer.autoFit === undefined)
    errors.push({
      path: "fontSize",
      message: `text layers need "fontSize" or "autoFit"`,
    });
  if (layer.color !== undefined && layer.fill !== undefined)
    errors.push({
      path: "fill",
      message: `"fill" and "color" are mutually exclusive — one fill per layer`,
    });
  return errors;
}

/**
 * The shape fill contract — at most one of color/fill — with its friendly
 * message, mirroring the shapeLayer `allOf` block the way textContractErrors
 * mirrors the text one. Paths are layer-relative.
 */
function shapeContractErrors(layer: ShapeLayer): SceneError[] {
  if (layer.color !== undefined && layer.fill !== undefined)
    return [
      {
        path: "fill",
        message: `"fill" and "color" are mutually exclusive — one fill per shape`,
      },
    ];
  return [];
}

/** `jsonPointerToPath` output relative to a layer, prefixed with `layers[i]`. */
const layerPath = (at: string, sub: string) => `${at}.${jsonPointerToPath(sub)}`;

/** A JSON pointer chain of layer indices: a layer node at some nesting depth. */
const LAYER_POINTER = /^(?:\/layers\/\d+)+$/;

/**
 * Expand a failed layer oneOf into field-specific schema errors, recursing
 * into nested group children so a failure three groups deep still names
 * `layers[1].layers[0].layers[2].asset`. Scene-level errors pass through.
 */
function expandLayerErrors(errors: AjvError[]): SceneError[] {
  return expandBranch(errors, undefined, "");
}

/**
 * Map one claimed layer node's branch errors. `at` is the node's field path
 * ("" for the scene root); branch errors and nested failed-child oneOf errors
 * are relative to it. `allOf` contract violations expand to the per-type
 * friendly message home.
 */
function expandBranch(errors: AjvError[], root: unknown, at: string): SceneError[] {
  const out: SceneError[] = [];
  const type = root === undefined ? undefined : claimedType(root);
  const inContract = (e: AjvError) => e.schemaPath.includes("/allOf/");
  const contractHit = type !== undefined && errors.some(inContract);
  const fieldErrors = errors.filter((e) => !inContract(e));

  const failedChild = new Set<string>();
  for (const e of fieldErrors)
    if (e.keyword === "oneOf" && LAYER_POINTER.test(e.instancePath))
      failedChild.add(e.instancePath);
  const ownedByFailedChild = (p: string) =>
    [...failedChild].some((f) => p.startsWith(f) && (p.length === f.length || p[f.length] === "/"));

  for (const e of fieldErrors) {
    if (e.keyword === "oneOf" && failedChild.has(e.instancePath)) {
      const data = e.data;
      const childType = claimedType(data);
      const childAt = at === "" ? jsonPointerToPath(e.instancePath) : layerPath(at, e.instancePath);
      if (!childType) {
        const nonObject = typeof data !== "object" || data === null;
        out.push({
          path: nonObject ? childAt : `${childAt}.type`,
          message: nonObject
            ? "each layer must be an image, text, shape, or group object"
            : `unknown layer type ${JSON.stringify(
                (data as Record<string, unknown> | null)?.type,
              )} — supported types: image, text, shape, group`,
        });
        continue;
      }
      const validate = branchValidators[childType];
      validate(data);
      out.push(...expandBranch(validate.errors!, data, childAt));
      continue;
    }
    if (ownedByFailedChild(e.instancePath)) continue; // noise under a failed child; its own expansion owns it
    if (root === undefined) {
      out.push(describeSchemaError(e));
      continue;
    }
    // Branch-internal errors of the claimed node at `at`.
    const host = e.instancePath ? layerPath(at, e.instancePath) : at;
    const inSpans = /^\/spans(\/|$)/.test(e.instancePath);
    if (e.keyword === "required") {
      const prop = e.params?.missingProperty as string;
      out.push({
        path: `${host}.${prop}`,
        message: `"${prop}" is required on ${inSpans ? "spans" : `${type} layers`}`,
      });
      continue;
    }
    if (e.keyword === "additionalProperties") {
      const prop = e.params?.additionalProperty as string;
      out.push({
        path: `${host}.${prop}`,
        message: `"${prop}" is not a valid ${inSpans ? "span" : "layer"} property`,
      });
      continue;
    }
    if (e.keyword === "enum" && e.params?.allowedValues) {
      const allowed = (e.params.allowedValues as unknown[]).join(", ");
      out.push({
        path: host,
        message: `${JSON.stringify(e.data)} is not one of: ${allowed}`,
      });
      continue;
    }
    out.push({ path: host, message: e.message ?? "is invalid" });
  }

  if (contractHit && type) {
    const contract =
      type === "text"
        ? textContractErrors(root as unknown as TextLayer)
        : type === "shape"
          ? shapeContractErrors(root as unknown as ShapeLayer)
          : [];
    out.push(...contract.map((e) => ({ ...e, path: at === "" ? e.path : `${at}.${e.path}` })));
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
 * Every layer in the tree with its field path — the one walk both post-schema
 * passes share, so the path format (`layers[1].layers[0]`) has a single home.
 */
function* layerEntries(
  layers: SceneLayer[],
  at: (i: number) => string,
): Generator<{ layer: SceneLayer; at: string }> {
  for (const [i, layer] of layers.entries()) {
    const here = at(i);
    yield { layer, at: here };
    if (layer.type === "group") yield* layerEntries(layer.layers, (j) => `${here}.layers[${j}]`);
  }
}

/**
 * Cross-layer and cross-field rules the schema can't express: duplicate layer
 * ids (across the whole layer tree — nested children are stable ids too),
 * crop insets that sum past the source, rect-only radius, and inverted
 * autoFit ranges. Per-type required and misplaced fields are the schema's
 * oneOf branches' job (one home).
 */
function semanticErrors(scene: Scene): SceneError[] {
  const errors: SceneError[] = [];
  const firstOwner = new Map<string, string>();
  for (const { layer, at: here } of layerEntries(scene.layers, (i) => `layers[${i}]`)) {
    const field = (name: string, message: string) =>
      errors.push({ path: `${here}.${name}`, message });

    const owner = firstOwner.get(layer.id);
    if (owner !== undefined)
      field("id", `duplicate layer id "${layer.id}" — first used at ${owner}`);
    else firstOwner.set(layer.id, here);

    if (layer.type === "image" && layer.crop) {
      const { left, top, right, bottom } = layer.crop;
      if (left + right >= 100)
        field(
          "crop",
          `crop insets leave no source width (left ${left}% + right ${right}% ≥ 100%)`,
        );
      if (top + bottom >= 100)
        field(
          "crop",
          `crop insets leave no source height (top ${top}% + bottom ${bottom}% ≥ 100%)`,
        );
    }

    if (layer.type === "shape" && layer.radius !== undefined && layer.shape !== "rect")
      field(
        "radius",
        `"radius" applies to rect shapes only — a ${layer.shape} has no corners to round`,
      );

    if (layer.type === "text") {
      // The content/sizing/fill contract is the schema's (textContractErrors
      // owns its messages); an inverted autoFit range is this pass's — no
      // JSON Schema keyword compares two sibling values.
      if (layer.autoFit && layer.autoFit.min > layer.autoFit.max)
        field(
          "autoFit",
          `autoFit min (${layer.autoFit.min}px) exceeds max (${layer.autoFit.max}px)`,
        );
    }
  }
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
  for (const { layer, at } of layerEntries(scene.layers, (i) => `layers[${i}]`)) {
    if (layer.type === "image") {
      // Ids are globally unique (the semantic pass owns that), so resolved
      // assets key by layer id at any depth.
      try {
        const lib =
          parseAssetRef(layer.asset).scope === "library"
            ? await getLibrary()
            : EMPTY_LIBRARY;
        assets.set(layer.id, await resolveAsset(projectRoot, lib, layer.asset));
      } catch (err) {
        errors.push({
          path: `${at}.asset`,
          message: (err as Error).message,
        });
      }
    } else if (layer.type === "text") {
      const checkFont = (at: string, family: string) => {
        try {
          resolveFace(family);
        } catch (err) {
          errors.push({ path: at, message: (err as Error).message });
        }
      };
      checkFont(`${at}.font`, layer.font);
      (layer.spans ?? []).forEach((span, j) => {
        if (span.font) checkFont(`${at}.spans[${j}].font`, span.font);
      });
    }
  }
  return errors;
}

// --- theme resolution -----------------------------------------------------------

/**
 * Verify the Scene's theme pin and apply the theme's defaults through the
 * whole layer tree, in place. This is the one precedence boundary: explicit
 * layer values win, then theme defaults, then the renderer's built-in
 * defaults. Defaults never fight the fill contracts — a theme color applies
 * only where the layer sets neither color nor fill, and shape radius only
 * to rects.
 */
function themeErrorsAndApply(scene: Scene): SceneError[] {
  if (!scene.theme) return [];
  const { name, revision } = scene.theme;
  let theme: ReturnType<typeof getTheme>;
  try {
    theme = getTheme(name);
  } catch (err) {
    return [{ path: "theme.name", message: (err as Error).message }];
  }
  const actual = themeRevision(theme);
  if (!actual.startsWith(revision))
    return [
      {
        path: "theme.revision",
        message:
          `theme "${name}" is pinned to revision "${revision}" but now hashes to "${actual}".\n` +
          `The theme changed; re-pin it to "${actual}" or drop the pin to accept the new content.`,
      },
    ];
  for (const { layer } of layerEntries(scene.layers, (i) => `layers[${i}]`))
    applyThemeToLayer(layer, theme);
  return [];
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
  if (errors.length === 0) errors.push(...themeErrorsAndApply(scene));
  const assets = new Map<string, ResolvedAsset>();
  if (errors.length === 0)
    errors.push(...(await resolutionErrors(path.resolve(projectRoot), library, scene, assets)));
  if (errors.length) return { ok: false, errors };
  return { ok: true, resolved: { scene, assets } };
}
