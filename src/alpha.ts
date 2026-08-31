/**
 * True-alpha verification for generated candidates (REQ-015, REQ-017).
 *
 * The gate at adoption: a candidate qualifies only when it carries a real
 * alpha channel with a real matte — meaningful transparent area and a
 * meaningful opaque subject. RGB chroma-key color distance cannot qualify an
 * output because no keying path exists here: the bytes are only ever parsed
 * and measured, never recolored. What a model returns opaque must go through
 * the segmentation matting pass (`matte.ts`) before it can reach this gate.
 *
 * The bytes cross an external-provider trust boundary; every parse bound
 * lives in the shared reader (`png.ts`), so this file holds only the gate's
 * policy: which layouts qualify, and what counts as a real matte.
 */
import { decodePng, readPngHeader, PngParseError } from "./png.js";

/** A matte must be at least 1% transparent (real cutout) and 1% opaque (a subject exists). */
const MIN_SHARE = 0.01;

/** Transparent = alpha ≤ 8; opaque = alpha ≥ 248. Semi-transparent edge pixels are neither. */
const TRANSPARENT_MAX = 8;
const OPAQUE_MIN = 248;

export interface AlphaReport {
  width: number;
  height: number;
  /** Pixels with alpha ≤ 8 — the cut-out area. */
  transparentPx: number;
  /** Pixels with alpha ≥ 248 — the subject body. */
  opaquePx: number;
}

function refuse(label: string, why: string): never {
  throw new Error(
    `Candidate "${label}" cannot qualify: ${why}\n` +
      `Adoption requires true alpha (a transparent-background PNG with a real matte) — ` +
      `RGB chroma-key color distance alone cannot qualify an output (REQ-015, REQ-017). ` +
      `Rerun the job ("jobs rerun <jobId>") so the matting pass mattes fresh candidates, or adopt a candidate that has one.`,
  );
}

/** Run a parser call, converting its refusal reason into this gate's contract error. */
function parsed<T>(label: string, read: () => T): T {
  try {
    return read();
  } catch (err) {
    if (err instanceof PngParseError) refuse(label, err.message);
    throw err;
  }
}

export function verifyTrueAlpha(bytes: Uint8Array, label: string): AlphaReport {
  // The color-type policy is the gate's, not the parser's: an opaque layout
  // is exactly the chroma-key shape this gate exists to reject, and it gets
  // that message rather than a generic "unsupported layout".
  const header = parsed(label, () => readPngHeader(bytes));
  if (header.colorType === 0 || header.colorType === 2 || header.colorType === 3)
    refuse(
      label,
      `the PNG has no alpha channel (color type ${header.colorType}) — an opaque image is exactly the chroma-key shape this gate exists to reject`,
    );
  if (header.colorType !== 6)
    refuse(label, `color type ${header.colorType} is not supported — RGBA PNG only`);

  const { width, height, rgba } = parsed(label, () => decodePng(bytes));

  let transparentPx = 0;
  let opaquePx = 0;
  for (let i = 3; i < rgba.length; i += 4) {
    const alpha = rgba[i]!;
    if (alpha <= TRANSPARENT_MAX) transparentPx++;
    else if (alpha >= OPAQUE_MIN) opaquePx++;
  }

  const total = width * height;
  if (transparentPx < total * MIN_SHARE)
    refuse(
      label,
      `only ${transparentPx} of ${total} pixels are transparent (<1%) — the image is effectively opaque`,
    );
  if (opaquePx < total * MIN_SHARE)
    refuse(label, `only ${opaquePx} of ${total} pixels are opaque (<1%) — the matte is empty`);
  return { width, height, transparentPx, opaquePx };
}
