/**
 * The matting pass (REQ-017) — the stage that turns a generated creator
 * candidate into an adoptable isolated asset.
 *
 * Why it exists: image providers return opaque RGB for this workflow, and
 * the adoption gate refuses opaque bytes by design. Isolation therefore cannot be a prompt
 * instruction and cannot be RGB chroma-key distance; it is a segmentation
 * pass that predicts a subject matte and applies it as a real alpha channel.
 *
 * Two things live here, deliberately separated:
 *   - `composeMatte` — offline, deterministic pixel work: a predicted mask
 *     becomes the candidate's alpha channel. No network, no model.
 *   - `matteCandidate` — the policy: a candidate that already carries a real
 *     matte is kept as-is (the native-alpha route, no inference at all);
 *     anything else goes through the injected engine, and the result is
 *     verified against the adoption gate *here*, at the boundary, so a
 *     degenerate matte can never be recorded as one.
 *
 * The engine is a seam. The shipped one runs a BiRefNet ONNX segmenter
 * **locally** (`src/segment.ts`) — no model call leaves the machine at
 * matting time, so a matting attempt spends nothing and a failed one has no
 * cost to lose (ADR-0006). Tests inject their own engine.
 */
import { decodePng, encodePngRgba, PngParseError } from "./png.js";
import { verifyTrueAlpha } from "./alpha.js";

/** Engine name recorded when the candidate's own alpha channel is the matte. */
export const NATIVE_ALPHA = "native-alpha" as const;

/** What an engine returns: the matted bytes and how they were produced. */
export interface MatteEngineResult {
  bytes: Uint8Array;
  /** The engine that produced the matte — recorded on the candidate and the adopted Asset. */
  engine: string;
  /** Anything worth recording on the run (e.g. the segmenter fell back to CPU). */
  warnings?: string[];
}

/**
 * The matting seam. Input is one candidate; output is its true-alpha matte.
 *
 * `preflight` is how an engine says "I cannot run" *before* anything is paid
 * for. The lifecycle calls it once, ahead of the generation call, so an
 * engine with a missing prerequisite (the local segmenter's weights) stops
 * the job while it is still free — rather than after N billed candidates
 * exist with no way to isolate them. An engine with nothing to check omits
 * it; a fake engine in a test is just a function.
 */
export interface MatteEngine {
  (input: { bytes: Uint8Array; label: string }): Promise<MatteEngineResult>;
  readonly preflight?: () => Promise<void>;
}

export interface MatteOutcome {
  bytes: Uint8Array;
  engine: string;
  warnings: string[];
}

/** Rec. 709 luminance — a predicted mask is read as brightness, white = subject. */
const luminance = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/**
 * Bilinear sample of a mask at source pixel coordinates, matching the
 * candidate's geometry. The mask's luminance × its own alpha is interpolated
 * as one quantity, so soft edges stay soft and detail that lives *between*
 * mask pixels survives the rescale instead of aliasing.
 */
function sampleCoverage(
  mask: { rgba: Buffer; width: number; height: number },
  fx: number,
  fy: number,
): number {
  const x0 = Math.min(mask.width - 1, Math.max(0, Math.floor(fx)));
  const y0 = Math.min(mask.height - 1, Math.max(0, Math.floor(fy)));
  const x1 = Math.min(mask.width - 1, x0 + 1);
  const y1 = Math.min(mask.height - 1, y0 + 1);
  const tx = Math.min(1, Math.max(0, fx - x0));
  const ty = Math.min(1, Math.max(0, fy - y0));
  const at = (x: number, y: number) => {
    const m = (y * mask.width + x) * 4;
    return luminance(mask.rgba[m]!, mask.rgba[m + 1]!, mask.rgba[m + 2]!) * (mask.rgba[m + 3]! / 255);
  };
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  return lerp(lerp(at(x0, y0), at(x1, y0), tx), lerp(at(x0, y1), at(x1, y1), tx), ty);
}

/**
 * Apply a predicted segmentation mask to a candidate as its alpha channel.
 *
 * The mask is read as brightness (white = subject, black = background), so a
 * grayscale, RGB, or RGBA mask all work; a mask that carries its own alpha
 * has it multiplied in, so a model that returns the mask already cut out is
 * read correctly rather than as a black frame. A mask at different dimensions
 * is sampled bilinearly across the candidate's geometry — models do not
 * reliably honour "same dimensions" (BiRefNet HR predicts 2048×2048, the
 * candidate is smaller), and bilinear interpolation is what keeps hair-level
 * detail alive across that rescale instead of aliasing it away.
 *
 * The candidate's colour is never modified: only alpha is written. There is
 * no colour-distance step anywhere in this function — that is what makes it a
 * matte rather than a chroma key.
 */
export function composeMatte(
  imageBytes: Uint8Array,
  maskBytes: Uint8Array,
  label: string,
): Uint8Array {
  const image = read(imageBytes, `Candidate "${label}"`);
  const mask = read(maskBytes, `Matte mask for "${label}"`);

  const rgba = Buffer.from(image.rgba);
  for (let y = 0; y < image.height; y++) {
    const fy = ((y + 0.5) * mask.height) / image.height - 0.5;
    for (let x = 0; x < image.width; x++) {
      const fx = ((x + 0.5) * mask.width) / image.width - 0.5;
      const cover = sampleCoverage(mask, fx, fy);
      rgba[(y * image.width + x) * 4 + 3] = Math.max(0, Math.min(255, Math.round(cover)));
    }
  }
  return encodePngRgba(image.width, image.height, rgba);
}

function read(bytes: Uint8Array, what: string) {
  try {
    return decodePng(bytes);
  } catch (err) {
    if (err instanceof PngParseError)
      throw new Error(`${what} cannot be matted: ${err.message}`);
    throw err;
  }
}

/**
 * Produce the adoptable matte for one candidate.
 *
 * Native alpha first: when a model does return a real matte, that matte is
 * the candidate's own bytes — no inference at all, and the exact bytes the
 * human reviewed. Otherwise the engine runs, and its output must
 * pass the same true-alpha gate adoption applies. Verifying here means a
 * matte that cuts away everything (or nothing) fails at the pass that
 * produced it, naming the engine, instead of surfacing later as a confusing
 * adoption refusal.
 */
export async function matteCandidate(
  bytes: Uint8Array,
  label: string,
  engine: MatteEngine,
): Promise<MatteOutcome> {
  try {
    verifyTrueAlpha(bytes, label);
    return { bytes, engine: NATIVE_ALPHA, warnings: [] };
  } catch {
    // Not natively isolated — the ordinary case, and exactly why this pass exists.
  }

  const result = await engine({ bytes, label });
  try {
    verifyTrueAlpha(result.bytes, label);
  } catch (err) {
    throw new Error(
      `The matting pass ("${result.engine}") did not produce a usable matte for "${label}": ${(err as Error).message}`,
      { cause: err },
    );
  }
  return { bytes: result.bytes, engine: result.engine, warnings: result.warnings ?? [] };
}
