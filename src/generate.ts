import { generateText, generateImage } from "ai";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { resolveModel, type ModelSpec } from "./models.js";

export type TextZone = "left" | "right" | "bottom" | "none";

/**
 * The plate prompt: the agent's subject is authoritative for visual content
 * (DEC-010, ADR-0011) — UI, products, devices, and complex background elements
 * are requested content, never banned. Construction adds format, zone, and
 * cross-cutting invariant guidance only: the hard text/logo ban stays because
 * final editorial text is rendered locally (ADR-0001) and exact logos are
 * sourced Assets.
 *
 * The text layer is rendered locally in CSS, so the model must also leave
 * deliberate empty space where our headline will land.
 */
function buildPrompt(subject: string, zone: TextZone, subjectless = false): string {  // With a cutout supplying the subject, the plate must stay a clean backdrop —
  // asking for a subject here produces something that fights the cutout.
  // Legacy `thumb --cutout` mode only; Plate Jobs never set it.
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
    // The UI ban belongs to the legacy cutout backdrop contract (INT-1): a UI
    // element in the backdrop fights the local cutout like any other subject
    // would. Flexible Plate Jobs (ADR-0011) may request UI freely.
    "CRITICAL: render absolutely no text, no letters, no words, no numbers, no logos, no watermarks" +
      (subjectless ? ", and no UI elements" : "") +
      " anywhere in the image.",
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

// --- creator generation (REQ-017) --------------------------------------------

/** A creator reference as the prompt sees it: a role plus its image. */
export interface CreatorRefInput {
  role: string;
  path: string;
  /** Recorded content identity — when present, the bytes sent to the model are verified against it. */
  contentHash?: string;
}

/**
 * Per-role instructions, role-assigning every reference in the prompt —
 * unassigned references make the model average faces (the chubby-drift
 * failure mode, docs/asset-requirements.md). The likeness recipe lines are
 * the tested rules from that document.
 */
const CREATOR_ROLE_INSTRUCTIONS: Record<string, string> = {
  identity:
    "identity anchor — copy this person's face exactly: do not widen, round, age, or blend the face with any other reference",
  pose: "pose reference — body pose, gesture, and framing only; never take a face from it",
  expression: "expression reference — facial expression only; never take a face from it",
  outfit: "outfit reference — clothing and styling only",
  style: "style reference — lighting and visual style only",
  edit: "source-to-edit — the image to change; keep its person's identity exactly",
};

/**
 * The model-adapted reference order (REQ-017): identity anchors first, the
 * pose reference last, every other role in declared order between — the
 * ordering the tested likeness recipe prescribes. The prompt's role manifest
 * is built from this same order, so the recorded fullPrompt always describes
 * how the images were actually attached, whatever the model's call shape.
 */
export function creatorRefOrder(refs: CreatorRefInput[]): CreatorRefInput[] {
  const identity = refs.filter((r) => r.role === "identity");
  const pose = refs.filter((r) => r.role === "pose");
  const middle = refs.filter((r) => r.role !== "identity" && r.role !== "pose");
  return [...identity, ...middle, ...pose];
}

/**
 * The creator prompt: the subject, a numbered role manifest of the attached
 * references, the tested likeness recipe, and the isolation contract. The
 * The isolation contract is what the matting pass needs — a plain flat
 * background and crisp edges — not a request for transparency the model
 * cannot honour (ADR-0006). The role
 * manifest is what preserves each reference's declared role in the Job's
 * effective-prompt provenance — by ordinal and role label only: local paths
 * are machine details and never leave the box (they live in the Job's typed
 * request record).
 */
export function buildCreatorPrompt(subject: string, orderedRefs: CreatorRefInput[]): string {
  const manifest = orderedRefs
    .map((r, i) => {
      const what = CREATOR_ROLE_INSTRUCTIONS[r.role];
      return `image ${i + 1} — ${r.role}${what ? ` (${what})` : ""}`;
    })
    .join("\n");
  return [
    subject,
    "",
    "Reference images are attached in this exact order — role-assign every one:",
    manifest,
    "",
    "Copy the face from the identity anchors exactly — do not widen, round, or blend. Do not average the references into a different person.",
    "",
    "Format: exactly one single isolated creator figure, fully inside the frame with clear margins around it, on a plain, uniform, evenly lit background — no environment, no scene, no room, no props, no surface it stands on.",
    "Style: clean readable silhouette at small sizes, even studio-like lighting, crisp well-defined edges the matting pass can cut cleanly.",
    "Do not paint a checkerboard or any other transparency indicator: isolation is done locally after generation, so the background here must be a plain flat colour.",
    "CRITICAL: render absolutely no text, no letters, no words, no numbers, no logos, no watermarks, no UI elements, and no composite thumbnail layout — this figure will be composited into a design by local tooling.",
  ].join("\n");
}

/** AI SDK warnings are objects; flatten to one readable line. */
function describeWarning(model: string, w: unknown): string {
  const o = w as { type?: string; feature?: string; setting?: string; details?: string; message?: string };
  const what = o?.feature ?? o?.setting ?? o?.type ?? "setting";
  return `${model}: ${o?.details ?? o?.message ?? `unsupported ${what}`}`;
}

/** A generation reference: a path to read, or already-verified bytes. */
type GenRef = string | { bytes: Uint8Array };

async function refParts(refs: GenRef[]) {
  return Promise.all(
    refs.map(async (r) => ({
      type: "image" as const,
      image: typeof r === "string" ? await readFile(path.resolve(r)) : r.bytes,
    })),
  );
}

/** Image models take raw bytes in GenerateImagePrompt.images, not file parts. */
function refBytes(refs: GenRef[]) {
  return Promise.all(
    refs.map((r) => (typeof r === "string" ? readFile(path.resolve(r)) : Promise.resolve(r.bytes))),
  );
}

export interface GenerateOptions {
  subject: string;
  model: string;
  zone: TextZone;
  refs: string[];
  count: number;
  /**
   * Legacy `thumb --cutout` mode only: the cutout supplies the subject, so the
   * plate must stay a bare backdrop that does not fight it. Plate Jobs never
   * set it — the agent's subject is authoritative (DEC-010, ADR-0011).
   */
  subjectless?: boolean;
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

/** A creator-candidate generation request (REQ-017). */
export interface GenerateCreatorOptions {
  subject: string;
  model: string;
  refs: CreatorRefInput[];
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
  refs: GenRef[],
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

/** A reference whose exact bytes are already loaded — no re-read, no drift. */
export interface LoadedRef {
  path: string;
  bytes: Uint8Array;
}

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/**
 * Load creator references and verify each file's bytes against the identity
 * recorded at request time. The returned bytes are exactly what the model is
 * sent — generation never re-reads a mutable path, so the provider cannot
 * receive different content than the Job records (INT: request-to-generation
 * drift is refused, not sent).
 */
export async function loadCreatorRefs(ordered: CreatorRefInput[]): Promise<LoadedRef[]> {
  return Promise.all(
    ordered.map(async (r): Promise<LoadedRef> => {
      let bytes: Buffer;
      try {
        bytes = await readFile(path.resolve(r.path));
      } catch {
        throw new Error(
          `Creator reference "${r.path}" (role ${r.role}) is missing — cannot start the generation`,
        );
      }
      if (r.contentHash !== undefined) {
        const actual = sha256(bytes);
        if (actual !== r.contentHash)
          throw new Error(
            `Creator reference "${r.path}" (role ${r.role}) changed content identity after the request was recorded — sha-256 ${r.contentHash}, actual ${actual}. Record a new job for different references.`,
          );
      }
      return { path: r.path, bytes };
    }),
  );
}

/**
 * Creator candidate generation (REQ-017): typed references are adapted to the
 * tested ordering (identity anchors first, pose last) and role-assigned in the
 * effective prompt by ordinal, so the recorded fullPrompt preserves every
 * declared role for any model call shape — with no local path sent off-box.
 * The prompt asks for a clean, evenly lit figure on a flat background — the
 * best input for the matting pass — and never for transparency: asking for it
 * produced a painted checkerboard (ADR-0006).
 * Reference bytes are verified against the recorded identities and those exact
 * bytes are what the model receives. Isolation is requested in-prompt;
 * adoption verifies true alpha — nothing hinges on the model's compliance.
 */
export async function generateCreators(
  opts: GenerateCreatorOptions,
): Promise<GenerateResult> {
  const spec = resolveModel(opts.model);
  const ordered = creatorRefOrder(opts.refs);
  const verified = await loadCreatorRefs(ordered);
  const prompt = buildCreatorPrompt(opts.subject, ordered);
  const { plates, warnings } = await runGeneration(
    spec,
    prompt,
    verified,
    opts.count,
    opts.temperature,
  );
  return {
    plates,
    warnings: [
      ...warnings,
      "creator: isolation comes from the matting pass, not the prompt — every candidate is matted before it is recorded, and adoption verifies the matte's true alpha (REQ-017)",
    ],
    fullPrompt: prompt,
  };
}
