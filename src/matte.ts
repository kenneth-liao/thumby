/**
 * The matting pass (REQ-017) — the stage that turns a generated creator
 * candidate into an adoptable isolated asset.
 *
 * Why it exists: the tested likeness recipe returns opaque RGB (measured —
 * see "Isolation" in docs/asset-requirements.md), and the adoption gate
 * refuses opaque bytes by design. Isolation therefore cannot be a prompt
 * instruction and cannot be RGB chroma-key distance; it is a segmentation
 * pass that predicts a subject matte and applies it as a real alpha channel.
 *
 * Two things live here, deliberately separated:
 *   - `composeMatte` — offline, deterministic pixel work: a predicted mask
 *     becomes the candidate's alpha channel. No network, no model.
 *   - `matteCandidate` — the policy: a candidate that already carries a real
 *     matte is kept as-is (the native-alpha route, no model call and no
 *     cost); anything else goes through the injected engine, and the result
 *     is verified against the adoption gate *here*, at the boundary, so a
 *     degenerate matte can never be recorded as one.
 *
 * The engine is a seam: the shipped one predicts the mask through the
 * Gateway (`segmentationMatteEngine` in generate.ts), and a local
 * BiRefNet/BEN2/RMBG-class runner can replace it without touching the
 * lifecycle, the gate, or the Job record.
 */
import { decodePng, encodePngRgba, PngParseError } from "./png.js";
import { verifyTrueAlpha } from "./alpha.js";

/**
 * What a matting attempt spent, whether or not it produced a usable matte.
 * A model call that has already returned is billed even when composition or
 * verification then fails, so this travels with the failure as well as with
 * the success — a run that dropped it would understate its own cost and could
 * claim the cost was measured when the unmeasured part simply vanished.
 */
export interface MatteBilling {
  costUsd: number;
  costMeasured: boolean;
  warnings: string[];
}

/** No call was made (or none had returned): nothing was spent. */
export const UNBILLED: MatteBilling = { costUsd: 0, costMeasured: true, warnings: [] };

/**
 * Every matting failure is this error, so a caller reads billing from one
 * shape instead of guessing which failures cost money.
 */
export class MattingFailure extends Error {
  constructor(
    message: string,
    readonly billing: MatteBilling,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "MattingFailure";
  }
}

/** Engine name recorded when the candidate's own alpha channel is the matte. */
export const NATIVE_ALPHA = "native-alpha" as const;

/** What an engine returns: the matted bytes plus what it cost to produce them. */
export interface MatteEngineResult {
  bytes: Uint8Array;
  /** The engine that produced the matte — recorded on the candidate and the adopted Asset. */
  engine: string;
  costUsd?: number;
  costMeasured?: boolean;
  /** Anything the engine's own model call reported — recorded on the run. */
  warnings?: string[];
}

/** The matting seam. Input is one candidate; output is its true-alpha matte. */
export type MatteEngine = (input: {
  bytes: Uint8Array;
  label: string;
}) => Promise<MatteEngineResult>;

export interface MatteOutcome extends MatteBilling {
  bytes: Uint8Array;
  engine: string;
}

/** Rec. 709 luminance — a predicted mask is read as brightness, white = subject. */
const luminance = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/**
 * Apply a predicted segmentation mask to a candidate as its alpha channel.
 *
 * The mask is read as brightness (white = subject, black = background), so a
 * grayscale, RGB, or RGBA mask all work; a mask that carries its own alpha
 * has it multiplied in, so a model that returns the mask already cut out is
 * read correctly rather than as a black frame. A mask at different dimensions
 * is sampled nearest-neighbour across the candidate's geometry — models do
 * not reliably honour "same dimensions", and refusing the candidate over the
 * mask's resolution would throw away a paid generation for no gain.
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
    const my = mask.height === image.height ? y : Math.min(mask.height - 1, Math.floor((y * mask.height) / image.height));
    for (let x = 0; x < image.width; x++) {
      const mx = mask.width === image.width ? x : Math.min(mask.width - 1, Math.floor((x * mask.width) / image.width));
      const m = (my * mask.width + mx) * 4;
      const cover = luminance(mask.rgba[m]!, mask.rgba[m + 1]!, mask.rgba[m + 2]!) * (mask.rgba[m + 3]! / 255);
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
 * the candidate's own bytes — no second model call, no cost, and the exact
 * bytes the human reviewed. Otherwise the engine runs, and its output must
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
    return { bytes, engine: NATIVE_ALPHA, ...UNBILLED };
  } catch {
    // Not natively isolated — the ordinary case, and exactly why this pass exists.
  }

  let result: MatteEngineResult;
  try {
    result = await engine({ bytes, label });
  } catch (err) {
    // An engine that got far enough to be billed says so by throwing a
    // MattingFailure; anything else (a connection error, a bad model id)
    // never reached a billable call.
    throw err instanceof MattingFailure
      ? err
      : new MattingFailure(`The matting pass failed for "${label}": ${(err as Error).message}`, UNBILLED, {
          cause: err,
        });
  }

  const billing: MatteBilling = {
    costUsd: result.costUsd ?? 0,
    costMeasured: result.costMeasured ?? false,
    warnings: result.warnings ?? [],
  };
  try {
    verifyTrueAlpha(result.bytes, label);
  } catch (err) {
    // The call already happened, so its cost and warnings survive the refusal.
    throw new MattingFailure(
      `The matting pass ("${result.engine}") did not produce a usable matte for "${label}": ${(err as Error).message}`,
      billing,
      { cause: err },
    );
  }
  return { bytes: result.bytes, engine: result.engine, ...billing };
}
