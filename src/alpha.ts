/**
 * True-alpha verification for object candidates (REQ-015).
 *
 * The gate at adoption: an object candidate qualifies only when it carries a
 * real alpha channel with a real matte — meaningful transparent area and a
 * meaningful opaque subject. RGB chroma-key color distance cannot qualify an
 * output because no keying path exists here: the bytes are only ever parsed
 * and measured, never recolored.
 *
 * Parses 8-bit non-interlaced PNG directly (IHDR + inflate + unfilter) so the
 * job lifecycle stays offline and browser-free. Anything that cannot be
 * measured — JPEG, palette, grayscale, interlaced, 16-bit — is refused with
 * an actionable error, never guessed.
 */
import { inflateSync } from "node:zlib";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** An object matte must be at least 1% transparent (real cutout) and 1% opaque (a subject exists). */
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
    `Object candidate "${label}" cannot qualify: ${why}\n` +
      `Object adoption requires true alpha (a transparent-background PNG with a real matte) — ` +
      `RGB chroma-key color distance alone cannot qualify an output (REQ-015). ` +
      `Regenerate the object with transparency, or matte it through a segmentation pass and re-record the job.`,
  );
}

export function verifyTrueAlpha(bytes: Uint8Array, label: string): AlphaReport {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIGNATURE))
    refuse(label, "the bytes are not a PNG (bad signature)");
  if (buf.toString("ascii", 12, 16) !== "IHDR")
    refuse(label, "the PNG has no IHDR header where one is required");

  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const bitDepth = buf[24]!;
  const colorType = buf[25]!;
  const interlace = buf[28]!;
  if (bitDepth !== 8) refuse(label, `bit depth ${bitDepth} is not supported — 8-bit PNG only`);
  if (colorType === 0 || colorType === 2 || colorType === 3)
    refuse(
      label,
      `the PNG has no alpha channel (color type ${colorType}) — an opaque image is exactly the chroma-key shape this gate exists to reject`,
    );
  if (colorType !== 6) refuse(label, `color type ${colorType} is not supported — RGBA PNG only`);
  if (interlace !== 0) refuse(label, "interlaced PNG is not supported");

  let idat: Buffer[] = [];
  let off = 8;
  while (off + 12 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    if (type === "IDAT") idat.push(buf.subarray(off + 8, off + 8 + len));
    if (type === "IEND") break;
    off += 12 + len;
  }
  if (idat.length === 0) refuse(label, "the PNG has no IDAT image data");

  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(idat));
  } catch {
    refuse(label, "the IDAT stream does not decompress (corrupt PNG)");
  }
  const stride = width * 4;
  if (raw.length < height * (stride + 1))
    refuse(label, "the IDAT stream is shorter than the declared pixel data (corrupt PNG)");

  const paeth = (a: number, b: number, c: number) => {
    const p = a + b - c;
    const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };

  // Reconstruct the scanlines (same unfilter as the test pixel reader, RGBA
  // only) and measure the alpha channel.
  const out = Buffer.alloc(height * stride);
  let transparentPx = 0;
  let opaquePx = 0;
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++]!;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? cur[x - 4]! : 0;
      const b = prev ? prev[x]! : 0;
      const c = prev && x >= 4 ? prev[x - 4]! : 0;
      let v = raw[pos + x]!;
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) v += paeth(a, b, c);
      cur[x] = v & 0xff;
    }
    pos += stride;
    for (let x = 3; x < stride; x += 4) {
      const alpha = cur[x]!;
      if (alpha <= TRANSPARENT_MAX) transparentPx++;
      else if (alpha >= OPAQUE_MIN) opaquePx++;
    }
  }

  const total = width * height;
  if (transparentPx < total * MIN_SHARE)
    refuse(
      label,
      `only ${transparentPx} of ${total} pixels are transparent (<1%) — the image is effectively opaque`,
    );
  if (opaquePx < total * MIN_SHARE)
    refuse(
      label,
      `only ${opaquePx} of ${total} pixels are opaque (<1%) — the matte is empty`,
    );
  return { width, height, transparentPx, opaquePx };
}
