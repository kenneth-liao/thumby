import { generateText, generateImage } from "ai";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { resolveModel, type ModelSpec } from "./models.js";

export type TextZone = "left" | "right" | "bottom" | "none";

/**
 * The text layer is rendered locally in CSS, so the model must produce a clean
 * plate: no lettering of its own, and deliberate empty space where our headline
 * will land.
 */
function buildPrompt(subject: string, zone: TextZone, subjectless: boolean): string {
  // With a cutout supplying the subject, the plate must stay a clean backdrop —
  // asking for a subject here produces something that fights the cutout.
  const backdrop: Record<TextZone, string> = {
    left: "Keep the entire left half AND the centre of the frame completely empty and unobstructed. Confine every visual element to the far right edge.",
    right: "Keep the entire right half AND the centre of the frame completely empty and unobstructed. Confine every visual element to the far left edge.",
    bottom: "Keep the bottom half and the centre completely empty. Confine every visual element to the top edge.",
    none: "Keep the composition even and uncluttered across the whole frame.",
  };
  const composition: Record<TextZone, string> = {
    left: "Compose with the subject pushed to the RIGHT third of the frame. Keep the left half visually calm and uncluttered.",
    right:
      "Compose with the subject pushed to the LEFT third of the frame. Keep the right half visually calm and uncluttered.",
    bottom:
      "Compose with the subject in the upper two thirds. Keep the bottom third visually calm and uncluttered.",
    none: "Fill the frame edge to edge.",
  };

  return [
    subject,
    "",
    "Format: a 16:9 YouTube thumbnail background plate.",
    subjectless ? backdrop[zone] : composition[zone],
    ...(subjectless
      ? [
          "This is a backdrop only. Do NOT include any person, character, figure, hands, product, device, or prominent foreground object.",
        ]
      : []),
    "Style: high contrast, saturated, punchy lighting, strong focal subject, clean readable silhouette at small sizes.",
    "CRITICAL: render absolutely no text, no letters, no words, no numbers, no logos, no watermarks, and no UI elements anywhere in the image.",
  ].join("\n");
}

/** AI SDK warnings are objects; flatten to one readable line. */
function describeWarning(model: string, w: unknown): string {
  const o = w as { type?: string; feature?: string; setting?: string; details?: string; message?: string };
  const what = o?.feature ?? o?.setting ?? o?.type ?? "setting";
  return `${model}: ${o?.details ?? o?.message ?? `unsupported ${what}`}`;
}

async function refParts(refs: string[]) {
  return Promise.all(
    refs.map(async (p) => ({
      type: "image" as const,
      image: await readFile(path.resolve(p)),
    })),
  );
}

/** Image models take raw bytes in GenerateImagePrompt.images, not file parts. */
async function refBytes(refs: string[]) {
  return Promise.all(refs.map((p) => readFile(path.resolve(p))));
}

export interface GenerateOptions {
  subject: string;
  model: string;
  zone: TextZone;
  refs: string[];
  count: number;
  /** A cutout supplies the subject, so the plate must stay a bare backdrop. */
  subjectless: boolean;
  /**
   * Multimodal models only — lowers creative drift for likeness work.
   * Image-kind models have no such knob; a value here is rejected loudly.
   */
  temperature?: number;
}

/**
 * Exact 16:9 for models that want an explicit size, so nothing gets cropped.
 * OpenAI requires both dimensions divisible by 16 — 1536x864 satisfies both.
 */
const LANDSCAPE_SIZE = "1536x864" as const;

export interface GenerateResult {
  plates: GeneratedPlate[];
  warnings: string[];
  /** The full text sent to the model, composition suffix included. */
  fullPrompt: string;
}

export interface GeneratedPlate {
  bytes: Uint8Array;
  mediaType: string;
  spec: ModelSpec;
}

export async function generatePlates(
  opts: GenerateOptions,
): Promise<GenerateResult> {
  const spec = resolveModel(opts.model);
  const warnings: string[] = [];
  const prompt = buildPrompt(opts.subject, opts.zone, opts.subjectless);

  if (opts.refs.length && !spec.supportsRef) {
    throw new Error(
      `Model "${opts.model}" does not accept reference images. Use nano-pro or nano-2 for likeness.`,
    );
  }

  if (opts.temperature != null && spec.kind !== "multimodal") {
    throw new Error(
      `--temperature only applies to multimodal models (Gemini); "${opts.model}" is an image model.`,
    );
  }

  const runs = Array.from({ length: opts.count }, (_, i) => i);

  const plates = await Promise.all(
    runs.map(async (): Promise<GeneratedPlate> => {
      if (spec.kind === "multimodal") {
        const result = await generateText({
          model: spec.id,
          ...(opts.temperature != null ? { temperature: opts.temperature } : {}),
          ...(opts.refs.length
            ? {
                messages: [
                  {
                    role: "user" as const,
                    content: [
                      { type: "text" as const, text: prompt },
                      ...(await refParts(opts.refs)),
                    ],
                  },
                ],
              }
            : { prompt }),
        });

        const file = result.files.find((f) => f.mediaType?.startsWith("image/"));
        if (!file) {
          throw new Error(
            `${spec.id} returned no image. Text response: ${result.text.slice(0, 300)}`,
          );
        }
        return {
          bytes: file.uint8Array,
          mediaType: file.mediaType ?? "image/png",
          spec,
        };
      }

      const result = await generateImage({
        model: spec.id,
        ...(opts.refs.length
          ? { prompt: { text: prompt, images: await refBytes(opts.refs) } }
          : { prompt }),
        ...(spec.sizing === "size"
          ? { size: LANDSCAPE_SIZE }
          : { aspectRatio: "16:9" as const }),
      });
      warnings.push(...result.warnings.map((w) => describeWarning(spec.id, w)));
      const image = result.images[0];
      if (!image) throw new Error(`${spec.id} returned no image.`);
      return {
        bytes: Buffer.from(image.base64, "base64"),
        mediaType: "image/png",
        spec,
      };
    }),
  );

  return { plates, warnings: [...new Set(warnings)], fullPrompt: prompt };
}
