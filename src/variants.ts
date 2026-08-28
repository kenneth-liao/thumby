/**
 * Sparse Scene Variants — named patches over the canonical base Scene.
 *
 * The base Scene stays the single source of truth: a Variant stores only the
 * fields it changes (`set` overrides whole fields), addressed to stable layer
 * ids anywhere in the tree. Two boundaries live here:
 *
 *   1. `variantErrors` — the gate pass. Every Variant in the document is
 *      validated against the target layer's own schema branch (property
 *      shapes derived from SCENE_SCHEMA — no second home), so unknown targets
 *      and invalid patched values fail loadScene with field-specific paths
 *      like `variants["alt"].changes[0].set.opacity` before any render.
 *
 *   2. `resolveVariant` — pure patch application: clone the raw document,
 *      assign each change's `set` onto its target, return the merged raw.
 *      The merged document still goes through the full loadScene gate, so a
 *      patch that breaks a Scene contract (or references a missing Asset)
 *      fails at resolution, never at render time.
 *
 * `id` and `type` are a layer's identity and are not patchable.
 */
import Ajv from "ajv";
import type { ErrorObject as AjvError } from "ajv";
import { SCENE_SCHEMA } from "./scene-schema.js";
import type { Scene, SceneError, SceneLayer } from "./scene.js";

/** One sparse patch: a target layer id plus whole-field overrides. */
export interface VariantChange {
  layer: string;
  set: Record<string, unknown>;
}

/** A named Variant: what it changes, and nothing else. */
export interface SceneVariant {
  description?: string;
  changes: VariantChange[];
}

const LAYER_TYPES = (
  SCENE_SCHEMA.definitions.layer.oneOf as readonly { $ref: string }[]
).map((branch) => branch.$ref.replace("#/definitions/", "").replace(/Layer$/, ""));

/**
 * Fields a patch may never carry: the layer's identity (`id`, `type` — a
 * Variant addresses a layer, it cannot rename or retarget it) and a group's
 * `layers` (whole-subtree replacement is not a sparse change and would
 * rewrite child ids — edit children by their own ids instead).
 */
const UNPATCHABLE = new Set(["id", "type", "layers"]);

/**
 * Per-type patch validators, derived from SCENE_SCHEMA's own layer branches —
 * the same properties a layer may carry, minus the unpatchable fields.
 * `required` and cross-field contracts stay out: a patch is partial, and
 * merged-document contracts are the full gate's job.
 */
const ajv = new Ajv({ allErrors: true, verbose: true });
const layerBranches = SCENE_SCHEMA.definitions as unknown as Record<
  string,
  { properties: Record<string, unknown> }
>;
const patchValidators: Record<string, ReturnType<typeof ajv.compile>> = Object.fromEntries(
  LAYER_TYPES.map((type) => {
    const properties = Object.fromEntries(
      Object.entries(layerBranches[`${type}Layer`].properties).filter(
        ([k]) => !UNPATCHABLE.has(k),
      ),
    );
    return [
      type,
      ajv.compile({
        type: "object",
        additionalProperties: false,
        properties,
        definitions: SCENE_SCHEMA.definitions,
      }),
    ];
  }),
);

/** `variants["<name>"]` field path, the quote form every variant error uses. */
const vpath = (name: string, ...rest: (string | number)[]) =>
  `variants["${name}"]${rest.map((r) => (typeof r === "number" ? `[${r}]` : `.${r}`)).join("")}`;

/** JSON pointer `/effects/glow` → `.effects.glow`, relative to a field path. */
const subPath = (pointer: string, leaf?: string): string => {
  let out = "";
  for (const seg of [...pointer.split("/").slice(1), ...(leaf ? [leaf] : [])]) {
    out += /^\d+$/.test(seg) ? `[${seg}]` : `.${seg}`;
  }
  return out;
};

/** Every layer in the tree keyed by id — ids are unique (the semantic pass owns that). */
function layersById(layers: SceneLayer[], into = new Map<string, SceneLayer>()) {
  for (const layer of layers) {
    if (!into.has(layer.id)) into.set(layer.id, layer);
    if (layer.type === "group") layersById(layer.layers, into);
  }
  return into;
}

/**
 * Validate every Variant in the document: known targets, patchable fields,
 * schema-valid values. Runs inside loadScene after the semantic pass, so all
 * commands (validate / inspect / render) reject broken Variants at the gate.
 */
export function variantErrors(scene: Scene): SceneError[] {
  const variants = scene.variants;
  if (!variants) return [];
  const byId = layersById(scene.layers);
  const errors: SceneError[] = [];
  for (const [name, variant] of Object.entries(variants)) {
    const seen = new Set<string>();
    variant.changes.forEach((change, i) => {
      if (seen.has(change.layer))
        errors.push({
          path: vpath(name, "changes", i, "layer"),
          message: `duplicate change target "${change.layer}" — a variant applies one change per layer; merge the fields into one set`,
        });
      seen.add(change.layer);
      const target = byId.get(change.layer);
      if (!target) {
        errors.push({
          path: vpath(name, "changes", i, "layer"),
          message: `"${change.layer}" is not a layer in this scene — variant changes must name a stable layer id`,
        });
        return;
      }
      // A missing validator would mean a layer type the schema knows but this
      // module does not — fail fast, never validate patches silently away.
      const validate = patchValidators[target.type];
      if (!validate)
        throw new Error(`no patch validator for layer type "${target.type}" — src/variants.ts is out of sync with the schema`);
      const ok = validate(change.set);
      if (ok) return;
      for (const e of validate.errors as AjvError[]) {
        const at = `${vpath(name, "changes", i, "set")}${subPath(e.instancePath)}`;
        if (e.keyword === "additionalProperties") {
          errors.push({
            path: `${at}.${e.params.additionalProperty}`,
            message: `"${e.params.additionalProperty}" is not a patchable property of ${target.type} layers`,
          });
        } else if (e.keyword === "required") {
          errors.push({
            path: `${at}${subPath(e.instancePath, e.params.missingProperty)}`,
            message: `"${e.params.missingProperty}" is required in this patched value`,
          });
        } else {
          errors.push({ path: at, message: e.message ?? "is invalid" });
        }
      }
    });
  }
  return errors;
}

/**
 * Apply one named Variant to a raw Scene document: clone, assign each
 * change's `set` onto its target layer, return the merged raw document for
 * the caller's loadScene pass. Structural errors cannot occur for a document
 * that passed the gate — they fail fast here anyway rather than render.
 */
export function resolveVariant(
  raw: unknown,
  name: string,
): { ok: true; raw: unknown } | { ok: false; errors: SceneError[] } {
  const variants = (raw as { variants?: Record<string, SceneVariant> } | null)?.variants;
  const variant = variants?.[name];
  if (!variant)
    return {
      ok: false,
      errors: [
        {
          path: `variants["${name}"]`,
          message: `unknown variant "${name}" — this scene defines: ${
            Object.keys(variants ?? {}).join(", ") || "none"
          }`,
        },
      ],
    };
  const merged = structuredClone(raw) as Scene;
  const byId = layersById(merged.layers);
  for (const [i, change] of variant.changes.entries()) {
    const target = byId.get(change.layer);
    if (!target)
      return {
        ok: false,
        errors: [
          {
            path: vpath(name, "changes", i, "layer"),
            message: `"${change.layer}" is not a layer in this scene`,
          },
        ],
      };
    Object.assign(target, change.set);
  }
  return { ok: true, raw: merged };
}
