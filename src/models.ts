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
    supportsRef: false,
    note: "GPT Image 2 — cheapest and best at following the zone brief. Slower (~15s)",
  },

  // The Gemini models cost 8-30x more per plate. Reach for them when you need
  // a reference image for likeness, which gpt-image cannot take.
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
    supportsRef: false,
    note: "Seedream 5.0 Pro — photoreal, strong composition",
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
      supportsRef: name.includes("gemini"),
      note: "raw gateway id",
    };
  }
  throw new Error(
    `Unknown model "${name}". Options: ${Object.keys(MODELS).join(", ")} (or a raw gateway id like bytedance/seedream-5.0-lite)`,
  );
}
