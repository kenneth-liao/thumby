/**
 * Local subject segmentation — the shipped matting engine (REQ-017, ADR-0006).
 *
 * Isolation runs **on this machine**: a BiRefNet ONNX model predicts the
 * subject mask through `onnxruntime-node` (CoreML on Apple silicon, CPU
 * otherwise), and `composeMatte` applies that mask as the candidate's alpha
 * channel. No image model, no second Gateway hop, nothing billed — which is
 * why a matting attempt has no cost to lose when it fails.
 *
 * Weights are not in the repo. They live in a gitignored cache, pinned by
 * exact filename and sha-256 and verified once per process: a missing or
 * wrong-bytes model fails loudly with the file to place and where, and the
 * matting pass never silently degrades into "no isolation".
 */
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import type { InferenceSession, Tensor } from "onnxruntime-node";
import { decodePng, encodePngRgba, PngParseError } from "./png.js";
import { composeMatte, type MatteEngine } from "./matte.js";

/**
 * The pinned segmenter. BiRefNet (MIT) exported to ONNX; the fp16 build is
 * half the bytes of fp32 and is what CoreML wants on Apple silicon.
 * `preprocessor_config.json` from the same repo is the source of the input
 * geometry and normalization below — they are not free parameters.
 */
export const SUBJECT_SEGMENTER = {
  file: "birefnet-fp16.onnx",
  sha256: "3654c741eb80bd926ada8fed1713b506ccf8d30eb1f6487e87eb9f234f33df09",
  source:
    "https://huggingface.co/onnx-community/BiRefNet-ONNX/resolve/main/onnx/model_fp16.onnx",
  /** Square input the export expects. */
  size: 1024,
  /** ImageNet normalization, per the model's preprocessor config. */
  mean: [0.485, 0.456, 0.406],
  std: [0.229, 0.224, 0.225],
} as const;

/** Where weights are cached. Gitignored; `THUMBY_MODEL_DIR` overrides it. */
export function modelDir(): string {
  return process.env.THUMBY_MODEL_DIR ?? path.resolve("models");
}

export function weightsPath(): string {
  return path.join(modelDir(), SUBJECT_SEGMENTER.file);
}

/** The one message that tells a human exactly how to fix missing weights. */
export function missingWeightsMessage(why: string): string {
  return [
    `The local matting model is unusable: ${why}`,
    ``,
    `Expected: ${weightsPath()}`,
    `sha-256:  ${SUBJECT_SEGMENTER.sha256}`,
    ``,
    `Fetch it once (about 490 MB, cached and gitignored):`,
    `  mkdir -p ${modelDir()}`,
    `  curl -L -o ${weightsPath()} \\`,
    `    ${SUBJECT_SEGMENTER.source}`,
    ``,
    `Isolation is local by design (ADR-0006) — the pass never falls back to an`,
    `un-matted candidate, so a creator job stops here rather than recording`,
    `candidates that could never be adopted.`,
  ].join("\n");
}

/**
 * Read and verify the weights. The hash is checked once per process — the
 * file is large, and a mid-session swap of a file this process already opened
 * is not a threat the check could catch anyway.
 */
async function loadWeights(): Promise<Uint8Array> {
  const file = weightsPath();
  let bytes: Buffer;
  try {
    bytes = await readFile(file);
  } catch {
    throw new Error(missingWeightsMessage("the weights file is not there"));
  }
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== SUBJECT_SEGMENTER.sha256)
    throw new Error(
      missingWeightsMessage(
        `the file's sha-256 is ${actual}, not the pinned identity — re-download it, or update the pin deliberately if the model is being changed`,
      ),
    );
  return bytes;
}

/** One session per process: loading half a gigabyte per candidate is absurd. */
let sessionPromise: Promise<{ session: InferenceSession; warnings: string[] }> | undefined;

async function getSession(): Promise<{ session: InferenceSession; warnings: string[] }> {
  sessionPromise ??= (async () => {
    const [ort, weights] = await Promise.all([import("onnxruntime-node"), loadWeights()]);
    const warnings: string[] = [];
    try {
      return {
        session: await ort.InferenceSession.create(weights, {
          executionProviders: ["coreml"],
          graphOptimizationLevel: "all",
        }),
        warnings,
      };
    } catch (err) {
      // CPU still produces the same matte, just slower — worth saying out loud
      // in the run record, never worth failing the pass over.
      warnings.push(
        `matte: CoreML is unavailable (${(err as Error).message.split("\n")[0]}) — the segmenter ran on CPU`,
      );
      return {
        session: await ort.InferenceSession.create(weights, { executionProviders: ["cpu"] }),
        warnings,
      };
    }
  })().catch((err) => {
    sessionPromise = undefined; // a failed load must not poison the next attempt
    throw err;
  });
  return sessionPromise;
}

/** Bilinear sample of an RGBA plane, in source pixel coordinates. */
function sampleRgb(
  rgba: Buffer,
  width: number,
  height: number,
  fx: number,
  fy: number,
): [number, number, number] {
  const x0 = Math.min(width - 1, Math.max(0, Math.floor(fx)));
  const y0 = Math.min(height - 1, Math.max(0, Math.floor(fy)));
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const tx = Math.min(1, Math.max(0, fx - x0));
  const ty = Math.min(1, Math.max(0, fy - y0));
  const at = (x: number, y: number, c: number) => rgba[(y * width + x) * 4 + c]!;
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  return [0, 1, 2].map((c) =>
    lerp(lerp(at(x0, y0, c), at(x1, y0, c), tx), lerp(at(x0, y1, c), at(x1, y1, c), tx), ty),
  ) as [number, number, number];
}

/**
 * Candidate bytes → the model's input tensor: bilinear-resized to the square
 * the export expects, scaled to 0..1, ImageNet-normalized, laid out NCHW.
 * The aspect ratio is stretched rather than letterboxed — the mask is mapped
 * back proportionally, so the stretch cancels exactly.
 */
export function preprocess(bytes: Uint8Array): Float32Array {
  let image;
  try {
    image = decodePng(bytes);
  } catch (err) {
    if (err instanceof PngParseError)
      throw new Error(`The candidate cannot be segmented: ${err.message}`);
    throw err;
  }
  const { size, mean, std } = SUBJECT_SEGMENTER;
  const out = new Float32Array(3 * size * size);
  const plane = size * size;
  for (let y = 0; y < size; y++) {
    // Sample pixel centres, so the resize is not biased toward the top-left.
    const fy = ((y + 0.5) * image.height) / size - 0.5;
    for (let x = 0; x < size; x++) {
      const fx = ((x + 0.5) * image.width) / size - 0.5;
      const rgb = sampleRgb(image.rgba, image.width, image.height, fx, fy);
      const at = y * size + x;
      for (let c = 0; c < 3; c++) out[c * plane + at] = (rgb[c]! / 255 - mean[c]!) / std[c]!;
    }
  }
  return out;
}

const sigmoid = (v: number) => 1 / (1 + Math.exp(-v));

/**
 * The model's output plane → a grayscale mask PNG (white = subject).
 *
 * Some BiRefNet exports emit probabilities and some emit logits. The range is
 * measured rather than assumed: anything outside 0..1 is squashed through a
 * sigmoid, so both exports produce the same mask instead of one of them
 * producing a black frame.
 */
export function maskPngFrom(data: Float32Array | Uint8Array, size: number): Uint8Array {
  const values = data instanceof Float32Array ? data : Float32Array.from(data);
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const needsSigmoid = min < 0 || max > 1;
  const rgba = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const p = needsSigmoid ? sigmoid(values[i]!) : values[i]!;
    const g = Math.max(0, Math.min(255, Math.round(p * 255)));
    rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = g;
    rgba[i * 4 + 3] = 255;
  }
  return encodePngRgba(size, size, rgba);
}

/** Predict the subject mask for one candidate, as a grayscale PNG. */
export async function predictSubjectMask(
  bytes: Uint8Array,
): Promise<{ mask: Uint8Array; warnings: string[] }> {
  const { session, warnings } = await getSession();
  const ort = await import("onnxruntime-node");
  const { size } = SUBJECT_SEGMENTER;
  const input = new ort.Tensor("float32", preprocess(bytes), [1, 3, size, size]);
  const inputName = session.inputNames[0]!;
  const outputs = await session.run({ [inputName]: input });
  // BiRefNet exports emit several supervision maps; the last output is the
  // final refined one, and every export here is 1×1×size×size.
  const name = session.outputNames[session.outputNames.length - 1]!;
  const tensor = outputs[name] as Tensor | undefined;
  if (!tensor) throw new Error(`The segmenter returned no "${name}" output for the candidate`);
  const data = tensor.data as Float32Array | Uint8Array;
  if (data.length !== size * size)
    throw new Error(
      `The segmenter returned ${data.length} values, not the ${size}×${size} mask the model declares`,
    );
  return { mask: maskPngFrom(data, size), warnings };
}

/**
 * Verify the pin and build the session before any of it is needed.
 *
 * This is the engine's `preflight`: the lifecycle calls it ahead of the
 * generation call, so weights that are missing or off-pin stop a creator job
 * while it is still free. Without it the first sign of trouble would be N
 * paid candidates that can never be isolated, and the only recovery would be
 * a rerun that pays again.
 */
export async function ensureSegmenterReady(): Promise<void> {
  await getSession();
}

/**
 * The shipped matting engine: predict the subject mask locally, then apply it
 * as the candidate's alpha channel. Segmentation, never colour distance; no
 * network call at matting time once the weights are cached.
 */
export function localSegmentationMatteEngine(): MatteEngine {
  const engine = async ({ bytes, label }: { bytes: Uint8Array; label: string }) => {
    const { mask, warnings } = await predictSubjectMask(bytes);
    return {
      bytes: composeMatte(bytes, mask, label),
      engine: `local-segmentation:${SUBJECT_SEGMENTER.file}`,
      warnings,
    };
  };
  return Object.assign(engine, { preflight: ensureSegmenterReady });
}
