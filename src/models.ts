/**
 * Model registry. Everything routes through Vercel AI Gateway, so switching
 * models is a string change — no new SDK, no new key.
 *
 * Two call shapes exist upstream:
 *   'multimodal' — Nano Banana family. generateText() -> result.files (uint8Array)
 *   'image'      — Flux / Imagen / Recraft / GPT Image. generateImage() -> result.images[].base64
 */
export type ModelKind = "multimodal" | "image";

export interface ModelSpec {
  id: string;
  kind: ModelKind;
  /** Per-image cost at 1K, for the run summary. */
  approxCost: number;
  /**
   * true  — taken from real AI Gateway billing records
   * false — from the Gateway's published pricing table, not yet observed
   */
  costMeasured: boolean;
  /** Accepts reference images for likeness / style transfer. */
  supportsRef: boolean;
  /**
   * How the model wants its dimensions. OpenAI's image models reject
   * `aspectRatio` and require an explicit `size`.
   */
  sizing?: "aspectRatio" | "size";
  note: string;
}

export const MODELS: Record<string, ModelSpec> = {
  "gpt-image": {
    id: "openai/gpt-image-2",
    kind: "image",
    sizing: "size",
    approxCost: 0.0045,
    costMeasured: true,
    // Qualified through a real Gateway request with a typed Reference on the
    // exact production call shape (#52, TEST-012): SUPPORTED.
    supportsRef: true,
    note:
      "GPT Image 2 — cheapest and best at following the zone brief; qualified for typed References (#52). " +
      "The rate is the measured text-only plate cost — a reference call bills the image as extra input tokens " +
      "(measured once: $0.016 account-window delta with a ~1 MB reference; the per-generation billing lookup " +
      "was unavailable), not a per-image rate. Slower (~15s)",
  },

  // The Gemini models cost 8-30x more per plate. gpt-image also takes typed
  // References now (qualified through the Gateway, #52), but likeness work
  // remains Nano Banana territory until separately qualified (TEST-012).
  "nano-lite": {
    id: "google/gemini-3.1-flash-lite-image",
    kind: "multimodal",
    approxCost: 0.034,
    costMeasured: true,
    supportsRef: true,
    note: "Nano Banana 2 Lite — fastest (~3s) and the cheapest way to use a face ref",
  },
  "nano-2": {
    id: "google/gemini-3.1-flash-image",
    kind: "multimodal",
    approxCost: 0.067,
    costMeasured: true,
    supportsRef: true,
    note: "Nano Banana 2 — better plates than lite, same reference-image support",
  },
  "nano-pro": {
    id: "google/gemini-3-pro-image",
    kind: "multimodal",
    approxCost: 0.134,
    costMeasured: false,
    supportsRef: true,
    note: "Nano Banana Pro — native 2K/4K and the strongest likeness; priciest by far",
  },

  // Stylistic alternates.
  flux: {
    id: "bfl/flux-2-flex",
    kind: "image",
    approxCost: 0.03,
    costMeasured: false,
    supportsRef: false,
    note: "FLUX.2 Flex — the most stylistic control",
  },
  seedream: {
    id: "bytedance/seedream-5.0-pro",
    kind: "image",
    approxCost: 0.035,
    costMeasured: false,
    supportsRef: true,
    note: "Seedream 5.0 Pro — flat per-image rate (no 4K penalty), takes reference images; identity strength unproven here",
  },
  recraft: {
    id: "recraft/recraft-v4.1",
    kind: "image",
    approxCost: 0.035,
    costMeasured: false,
    supportsRef: false,
    note: "Recraft V4.1 — clean vector/graphic looks",
  },
};

export const DEFAULT_MODEL = "gpt-image";

/**
 * The creator-job default — a kind-specific likeness preference, not a
 * capability derivation: the measured likeness workhorse
 * (docs/asset-requirements.md). It flows through the same
 * reference-capability gate as every other selection, so a drift in its
 * qualification fails loudly instead of spending on a refused call.
 */
export const CREATOR_DEFAULT_MODEL = "nano-2";

/**
 * The canonical qualified reference-capable list (DEC-018): every registry
 * model the recorded evidence marks as accepting typed References. Default
 * selection, explicit validation, help, and recovery messages all read this
 * one reader — there is no second compatibility list.
 */
export function referenceCapableModels(): { key: string; spec: ModelSpec }[] {
  return Object.entries(MODELS)
    .filter(([, spec]) => spec.supportsRef)
    .map(([key, spec]) => ({ key, spec }));
}

/**
 * The one reference-incompatibility refusal (DEC-020): names the rejected
 * model, states that nothing was sent, and lists every qualified compatible
 * choice derived from the registry — recovery never requires registry
 * knowledge (US-032).
 */
export function referenceIncompatibilityError(spec: ModelSpec): string {
  const qualified = referenceCapableModels()
    .map(({ key, spec: s }) => `${key} (${s.id})`)
    .join(", ");
  return (
    `Model "${spec.id}" is not qualified reference-capable — the registry records no Gateway-proven ` +
    `typed-Reference support for it, so the Job was refused before any provider call and nothing was spent. ` +
    `Qualified reference-capable models: ${qualified}. ` +
    `Raw gateway ids carry no capability claim until they are qualified through a real Gateway request and registered (TEST-012).`
  );
}

/**
 * The reference-capability gate (TEST-011): a model selection for a Job that
 * carries typed References must be qualified reference-capable, or it is
 * refused here — before any generator call, and therefore before any spend
 * (US-031, DEC-020). A selection without References needs no capability
 * claim: the existing default and raw-id pass-through behavior is preserved.
 */
export function validateReferenceCapability(model: string, hasReferences: boolean): void {
  if (!hasReferences) return;
  const spec = resolveModel(model);
  if (!spec.supportsRef) throw new Error(referenceIncompatibilityError(spec));
}

export function resolveModel(name: string): ModelSpec {
  const spec = MODELS[name];
  if (spec) return spec;
  // Allow passing a raw gateway id through; assume image-only call shape
  // unless it looks like a Gemini multimodal model.
  if (name.includes("/")) {
    return {
      id: name,
      kind: name.includes("gemini") ? "multimodal" : "image",
      sizing: name.startsWith("openai/") ? "size" : "aspectRatio",
      approxCost: 0,
      costMeasured: false,
      // No capability claim: a raw id is unqualified until a real Gateway
      // request proves it and it is registered (DEC-019, TEST-012) —
      // capability is never inferred from the model-name substring. The
      // call-shape guess stays: it is SDK routing, not a capability fact.
      supportsRef: false,
      note: "raw gateway id",
    };
  }
  throw new Error(
    `Unknown model "${name}". Options: ${Object.keys(MODELS).join(", ")} (or a raw gateway id like bytedance/seedream-5.0-lite)`,
  );
}
