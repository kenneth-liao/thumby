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
function buildPrompt(subject: string, zone: TextZone, subjectless: boolean): string {  // With a cutout supplying the subject, the plate must stay a clean backdrop —
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

/**
 * An object request (REQ-015) is one isolated non-text object: a standalone
 * asset for local compositing, never a scene or a composite (OOS-009).
 * Transparency is requested in the prompt; whether the model actually returns
 * a true-alpha PNG is verified at adoption — an opaque candidate is refused
 * there, so nothing hinges on the model's compliance.
 */
function buildObjectPrompt(subject: string): string {
  return [
    subject,
    "",
    "Format: exactly one single isolated object, centered, with the entire object fully inside the frame and clear margins around it on all sides.",
    "The object must be a standalone asset on a plain uniform background: no environment, no scene, no room, no surface it stands on, no hands or people holding or touching it.",
    "Style: clean readable silhouette at small sizes, even studio-like lighting, crisp well-defined edges suitable for cutout isolation, true transparency around the object.",
    "CRITICAL: render absolutely no text, no letters, no words, no numbers, no logos, no watermarks, no UI elements, and no composite thumbnail layout — this object will be composited into a design by local tooling.",
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

/** An isolated-object generation request (REQ-015). */
export interface GenerateObjectOptions {
  subject: string;
  model: string;
  refs: string[];
  count: number;
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

/**
 * The one AI-SDK call core, shared by every generation workflow: call the
 * resolved model `count` times with the given prompt, collect the images and
 * warnings. Workflow differences live entirely in the caller's prompt.
 */
async function runGeneration(
  spec: ModelSpec,
  prompt: string,
  refs: string[],
  count: number,
  temperature?: number,
): Promise<{ plates: GeneratedPlate[]; warnings: string[] }> {
  const warnings: string[] = [];

  if (refs.length && !spec.supportsRef) {
    throw new Error(
      `Model "${spec.id}" does not accept reference images. Use nano-pro or nano-2 for likeness.`,
    );
  }

  if (temperature != null && spec.kind !== "multimodal") {
    throw new Error(
      `--temperature only applies to multimodal models (Gemini); "${spec.id}" is an image model.`,
    );
  }

  const runs = Array.from({ length: count }, (_, i) => i);

  const plates = await Promise.all(
    runs.map(async (): Promise<GeneratedPlate> => {
      if (spec.kind === "multimodal") {
        const result = await generateText({
          model: spec.id,
          ...(temperature != null ? { temperature } : {}),
          ...(refs.length
            ? {
                messages: [
                  {
                    role: "user" as const,
                    content: [
                      { type: "text" as const, text: prompt },
                      ...(await refParts(refs)),
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
        // The multimodal branch must record warnings too — a Generation Job
        // that certifies an empty warnings array is a false record.
        warnings.push(...(result.warnings ?? []).map((w) => describeWarning(spec.id, w)));
        return {
          bytes: file.uint8Array,
          mediaType: file.mediaType ?? "image/png",
          spec,
        };
      }

      const result = await generateImage({
        model: spec.id,
        ...(refs.length
          ? { prompt: { text: prompt, images: await refBytes(refs) } }
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

  return { plates, warnings: [...new Set(warnings)] };
}

export async function generatePlates(
  opts: GenerateOptions,
): Promise<GenerateResult> {
  const prompt = buildPrompt(opts.subject, opts.zone, opts.subjectless);
  const { plates, warnings } = await runGeneration(
    resolveModel(opts.model),
    prompt,
    opts.refs,
    opts.count,
    opts.temperature,
  );
  return { plates, warnings, fullPrompt: prompt };
}

/**
 * Isolated non-text object generation (REQ-015): the prompt asks for a
 * standalone cutout-ready object; adoption verifies true alpha. This function
 * adds one warning to the run record when the resolved model cannot be asked
 * for transparency — the record stays honest about what the gate will accept.
 */
export async function generateObjects(
  opts: GenerateObjectOptions,
): Promise<GenerateResult> {
  const spec = resolveModel(opts.model);
  const prompt = buildObjectPrompt(opts.subject);
  const { plates, warnings } = await runGeneration(
    spec,
    prompt,
    opts.refs,
    opts.count,
    opts.temperature,
  );
  return {
    plates,
    warnings: [
      ...warnings,
      "object: transparency is requested in-prompt — adoption verifies true alpha and refuses opaque candidates (REQ-015)",
    ],
    fullPrompt: prompt,
  };
}
