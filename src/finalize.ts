/**
 * Render finalization — the YouTube 2 MB output limit (REQ-011), enforced
 * locally and deterministically (DEC-002: scope is YouTube 1280×720).
 *
 * One concern: take a rendered PNG and return the bytes a Scene render is
 * allowed to publish, or a structured failure with the observed size and an
 * actionable explanation. Three stages, in order, each only when needed:
 *
 *   0. At or below the limit: the bytes pass through untouched — a compliant
 *      render is never recompressed.
 *   1. Lossless: the alpha plane is dropped when every pixel is opaque, rows
 *      are re-filtered with a per-row minimum-sum heuristic, and the scanlines
 *      are re-deflated at maximum level. Same pixels, exact dimensions.
 *   2. Palette: a deterministic median-cut quantization to ≤256 colors with
 *      Floyd–Steinberg dithering, written as an indexed PNG. Visually
 *      lossless-grade at thumbnail scale; requires no alpha (semi-transparent
 *      input fails with the fix instead). Real renders qualify: Scene pages
 *      composite on an opaque body, and Chromium screenshots them as RGB.
 *
 * Every stage is pure and deterministic: identical input bytes produce
 * identical output bytes (fixed zlib settings, fixed tie-breaking), so a
 * rerender reproduces the same compliant file. Dimensions are never touched —
 * the IHDR carries the decoded width/height verbatim through every stage.
 *
 * A quantized 1280×720 frame is bounded under the limit by construction
 * (indexed scanlines ≤ 921,600 bytes plus chunk overhead), so the
 * compliance-impossible failure is only reachable through injected test
 * limits or transparency — the failure path still exists, with the size that
 * was actually observed.
 *
 * This module owns a minimal PNG codec (decode 8-bit non-interlaced
 * truecolor, encode truecolor and indexed). Anything it cannot decode fails
 * loudly naming the defect — never silently passes oversized bytes through.
 */
import { deflateSync, inflateSync } from "node:zlib";
import type { SceneError } from "./scene.js";

/**
 * The byte limit a final Render must satisfy: 2,000,000 bytes — safe under
 * both the decimal and the binary reading of YouTube's "2 MB".
 */
export const OUTPUT_LIMIT = 2_000_000;

/** How an oversized render was brought into compliance. */
export interface Optimization {
  stage: "lossless" | "quantized";
  bytesBefore: number;
  bytesAfter: number;
}

export interface FinalizeOpts {
  /** The hard limit in bytes. Defaults to OUTPUT_LIMIT; tests inject smaller ones. */
  limit?: number;
  /** The error path reported on failure (the CLI passes the output path). */
  at?: string;
}

export type FinalizeResult =
  | { ok: true; png: Buffer; optimization?: Optimization }
  | { ok: false; errors: SceneError[] };

const fail = (at: string, message: string): FinalizeResult => ({
  ok: false,
  errors: [{ path: at, message }],
});

// --- PNG codec -----------------------------------------------------------------

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([head, body, crc]);
}

/** Decoded truecolor pixels: `channels` samples per pixel, 8-bit, row-major. */
interface Decoded {
  width: number;
  height: number;
  channels: 3 | 4;
  pixels: Buffer;
}

/**
 * Decode an 8-bit, non-interlaced, truecolor (RGB or RGBA) PNG. Any other
 * shape fails naming the defect — finalization never guesses.
 */
function decodePng(bytes: Buffer): Decoded | SceneError {
  const err = (message: string): SceneError => ({ path: "png", message });
  if (bytes.length < SIG.length || !bytes.subarray(0, SIG.length).equals(SIG))
    return err("the render output is not a PNG file — finalization cannot inspect it");
  let ihdr: Buffer | undefined;
  const idat: Buffer[] = [];
  let pos = SIG.length;
  while (pos + 12 <= bytes.length) {
    const len = bytes.readUInt32BE(pos);
    const type = bytes.toString("latin1", pos + 4, pos + 8);
    if (pos + 12 + len > bytes.length) return err(`truncated PNG: "${type}" chunk is cut off`);
    const data = bytes.subarray(pos + 8, pos + 8 + len);
    if (bytes.readUInt32BE(pos + 8 + len) !== crc32(bytes.subarray(pos + 4, pos + 8 + len)))
      return err(`corrupt PNG: the "${type}" chunk fails its CRC check`);
    if (type === "IHDR") ihdr = Buffer.from(data);
    else if (type === "IDAT") idat.push(Buffer.from(data));
    else if (type === "IEND") break;
    pos += 12 + len;
  }
  if (!ihdr) return err("malformed PNG: no IHDR header chunk");
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const depth = ihdr[8]!;
  const colorType = ihdr[9]!;
  if (width < 1 || height < 1) return err(`malformed PNG: invalid dimensions ${width}×${height}`);
  if (depth !== 8) return err(`unsupported PNG bit depth ${depth} — expected 8`);
  if (colorType !== 2 && colorType !== 6)
    return err(`unsupported PNG color type ${colorType} — expected 2 (RGB) or 6 (RGBA)`);
  if (ihdr[10] !== 0) return err(`unsupported PNG compression method ${ihdr[10]} — expected 0`);
  if (ihdr[11] !== 0) return err(`unsupported PNG filter method ${ihdr[11]} — expected 0`);
  if (ihdr[12] !== 0) return err("unsupported PNG: interlaced scans are not supported");
  const channels = colorType === 6 ? 4 : 3;
  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(idat));
  } catch {
    return err("corrupt PNG: the image data does not inflate");
  }
  const stride = width * channels;
  if (raw.length !== height * (stride + 1))
    return err(
      `corrupt PNG: image data is ${raw.length} bytes but ${height * (stride + 1)} are needed`,
    );
  const pixels = Buffer.alloc(height * stride);
  const bpp = channels;
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    const prev = dst - stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? pixels[dst + x - bpp]! : 0;
      const b = y > 0 ? pixels[prev + x]! : 0;
      const c = x >= bpp && y > 0 ? pixels[prev + x - bpp]! : 0;
      let v = raw[src + x]!;
      switch (filter) {
        case 0:
          break;
        case 1:
          v += a;
          break;
        case 2:
          v += b;
          break;
        case 3:
          v += (a + b) >> 1;
          break;
        case 4:
          v += paeth(a, b, c);
          break;
        default:
          return err(`corrupt PNG: unknown row filter ${filter}`);
      }
      pixels[dst + x] = v & 0xff;
    }
  }
  return { width, height, channels, pixels };
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Encode truecolor pixels with per-row minimum-sum-of-absolute-values filtering. */
function encodeTruecolor(width: number, height: number, channels: 3 | 4, pixels: Buffer): Buffer {
  const stride = width * channels;
  const out = Buffer.alloc(height * (stride + 1));
  const rows = [Buffer.alloc(stride), Buffer.alloc(stride), Buffer.alloc(stride), Buffer.alloc(stride), Buffer.alloc(stride)];
  for (let y = 0; y < height; y++) {
    const src = y * stride;
    const prev = src - stride;
    let bestCost = Infinity;
    let best = 0;
    for (let f = 0; f < 5; f++) {
      const row = rows[f]!;
      let cost = 0;
      for (let x = 0; x < stride; x++) {
        const orig = pixels[src + x]!;
        const a = x >= channels ? pixels[src + x - channels]! : 0;
        const b = y > 0 ? pixels[prev + x]! : 0;
        const c = x >= channels && y > 0 ? pixels[prev + x - channels]! : 0;
        let v: number;
        switch (f) {
          case 0:
            v = orig;
            break;
          case 1:
            v = orig - a;
            break;
          case 2:
            v = orig - b;
            break;
          case 3:
            v = orig - ((a + b) >> 1);
            break;
          default:
            v = orig - paeth(a, b, c);
        }
        row[x] = v & 0xff;
        // Cost = |signed value of the stored byte| — the same quantity the
        // decoder recovers, so negative residuals cost their magnitude too.
        const sb = v & 0xff;
        cost += Math.abs(sb < 128 ? sb : sb - 256);
      }
      if (cost < bestCost) {
        bestCost = cost;
        best = f;
      }
    }
    out[y * (stride + 1)] = best;
    rows[best].copy(out, y * (stride + 1) + 1);
  }
  return assemble(width, height, channels === 4 ? 6 : 2, deflateSync(out, { level: 9 }), undefined);
}

/** Encode indexed pixels (one palette index per pixel) with filter-0 rows. */
function encodeIndexed(
  width: number,
  height: number,
  palette: number[],
  indices: Uint8Array,
): Buffer {
  const out = Buffer.alloc(height * (width + 1));
  for (let y = 0; y < height; y++) {
    out[y * (width + 1)] = 0;
    Buffer.from(indices.buffer, indices.byteOffset + y * width, width).copy(
      out,
      y * (width + 1) + 1,
    );
  }
  const plte = Buffer.alloc(palette.length * 3);
  palette.forEach((packed, i) => {
    plte[i * 3] = (packed >> 16) & 0xff;
    plte[i * 3 + 1] = (packed >> 8) & 0xff;
    plte[i * 3 + 2] = packed & 0xff;
  });
  return assemble(width, height, 3, deflateSync(out, { level: 9 }), plte);
}

function assemble(
  width: number,
  height: number,
  colorType: number,
  idat: Buffer,
  plte: Buffer | undefined,
): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  const parts = [SIG, chunk("IHDR", ihdr)];
  if (plte) parts.push(chunk("PLTE", plte));
  parts.push(chunk("IDAT", idat), chunk("IEND", new Uint8Array(0)));
  return Buffer.concat(parts);
}

// --- stage 2: deterministic median-cut quantization -----------------------------

/**
 * Median-cut palette over the exact-color histogram. Deterministic:
 * deterministic sorts, deterministic split rule (widest channel range first,
 * count-weighted median), weighted-mean palette entries.
 */
function medianCut(hist: Map<number, number>, maxColors: number): number[] {
  if (hist.size <= maxColors) return [...hist.keys()].sort((a, b) => a - b);
  const boxes: number[][] = [[...hist.keys()].sort((a, b) => a - b)];
  while (boxes.length < maxColors) {
    let bestBox = -1;
    let bestRange = 0;
    let bestChannel = 16;
    for (const [i, box] of boxes.entries()) {
      if (box.length < 2) continue;
      for (const shift of [16, 8, 0]) {
        let min = 255;
        let max = 0;
        for (const packed of box) {
          const v = (packed >> shift) & 0xff;
          if (v < min) min = v;
          if (v > max) max = v;
        }
        if (max - min > bestRange) {
          bestRange = max - min;
          bestBox = i;
          bestChannel = shift;
        }
      }
    }
    if (bestBox < 0) break;
    const box = boxes[bestBox]!;
    const sorted = [...box].sort(
      (a, b) => ((a >> bestChannel) & 0xff) - ((b >> bestChannel) & 0xff) || a - b,
    );
    const total = sorted.reduce((s, packed) => s + hist.get(packed)!, 0);
    let acc = 0;
    let cut = sorted.length - 1;
    for (let i = 0; i < sorted.length - 1; i++) {
      acc += hist.get(sorted[i]!)!;
      if (acc * 2 >= total) {
        cut = i + 1;
        break;
      }
    }
    boxes.splice(bestBox, 1, sorted.slice(0, cut), sorted.slice(cut));
  }
  return boxes.map((box) => {
    let r = 0;
    let g = 0;
    let b = 0;
    let w = 0;
    for (const packed of box) {
      const cw = hist.get(packed)!;
      r += ((packed >> 16) & 0xff) * cw;
      g += ((packed >> 8) & 0xff) * cw;
      b += (packed & 0xff) * cw;
      w += cw;
    }
    return (Math.round(r / w) << 16) | (Math.round(g / w) << 8) | Math.round(b / w);
  });
}

/** Nearest-palette lookup with an exact-color cache (capped; a clear only costs speed, never results). */
function nearestOf(palette: number[]): (packed: number) => number {
  const cache = new Map<number, number>();
  return (packed: number): number => {
    const hit = cache.get(packed);
    if (hit !== undefined) return hit;
    let bestI = 0;
    let bestD = Infinity;
    for (let i = 0; i < palette.length; i++) {
      const p = palette[i]!;
      const dr = ((packed >> 16) & 0xff) - ((p >> 16) & 0xff);
      const dg = ((packed >> 8) & 0xff) - ((p >> 8) & 0xff);
      const db = (packed & 0xff) - (p & 0xff);
      const d = dr * dr + dg * dg + db * db;
      if (d < bestD) {
        bestD = d;
        bestI = i;
      }
    }
    if (cache.size > 1_000_000) cache.clear();
    cache.set(packed, bestI);
    return bestI;
  };
}

/**
 * Quantize RGB pixels to the palette with Floyd–Steinberg dithering — error
 * diffuses right, below-left, below, and below-right in 7/3/5/1 sixteenths.
 * Deterministic: fixed coefficients, fixed scan order. The in-row right-carry
 * is separate from the next-row error buffer, so the 7/16 right term can
 * never leak into the next row's diffusion.
 */
function mapWithDithering(
  pixels: Buffer,
  width: number,
  height: number,
  palette: number[],
): Uint8Array {
  const nearest = nearestOf(palette);
  const indices = new Uint8Array(width * height);
  // errCur: what the previous row diffused into this row. errNext: what this
  // row accumulates for the next one. carry: this row's right-propagated error.
  const errCur = new Float32Array(width * 3);
  const errNext = new Float32Array(width * 3);
  const carry = new Float32Array(3);
  for (let y = 0; y < height; y++) {
    errNext.fill(0);
    carry.fill(0);
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 3;
      const r = Math.min(255, Math.max(0, pixels[at]! + errCur[x * 3]! + carry[0]!));
      const g = Math.min(255, Math.max(0, pixels[at + 1]! + errCur[x * 3 + 1]! + carry[1]!));
      const b = Math.min(255, Math.max(0, pixels[at + 2]! + errCur[x * 3 + 2]! + carry[2]!));
      const idx = nearest((r << 16) | (g << 8) | b);
      indices[y * width + x] = idx;
      const p = palette[idx]!;
      const er = r - ((p >> 16) & 0xff);
      const eg = g - ((p >> 8) & 0xff);
      const eb = b - (p & 0xff);
      carry[0] = er * (7 / 16);
      carry[1] = eg * (7 / 16);
      carry[2] = eb * (7 / 16);
      const push = (dx: number, f: number): void => {
        const nx = x + dx;
        if (nx < 0 || nx >= width) return;
        errNext[nx * 3] += er * f;
        errNext[nx * 3 + 1] += eg * f;
        errNext[nx * 3 + 2] += eb * f;
      };
      push(-1, 3 / 16);
      push(0, 5 / 16);
      push(1, 1 / 16);
    }
    errCur.set(errNext);
  }
  return indices;
}

function quantizeTo256(
  pixels: Buffer,
  width: number,
  height: number,
): { png: Buffer } {
  const hist = new Map<number, number>();
  for (let i = 0; i < pixels.length; i += 3) {
    const packed = (pixels[i]! << 16) | (pixels[i + 1]! << 8) | pixels[i + 2]!;
    hist.set(packed, (hist.get(packed) ?? 0) + 1);
  }
  const palette = medianCut(hist, 256);
  const indices = mapWithDithering(pixels, width, height, palette);
  return { png: encodeIndexed(width, height, palette, indices) };
}

// --- the one entry point ---------------------------------------------------------

/**
 * Finalize one rendered PNG against the limit. Compliant bytes pass through
 * untouched; oversized bytes go through stage 1 (lossless) then stage 2
 * (palette), stopping at the first compliant result. Dimensions are carried
 * through verbatim — optimization never resamples.
 */
export function finalizeRender(png: Buffer, opts: FinalizeOpts = {}): FinalizeResult {
  const limit = opts.limit ?? OUTPUT_LIMIT;
  const at = opts.at ?? "render output";
  if (png.length <= limit) return { ok: true, png };

  const decoded = decodePng(png);
  if ("message" in decoded) return fail(at, decoded.message);
  const { width, height, channels, pixels } = decoded;

  // Stage 1 — lossless. Drop the alpha plane when every pixel is opaque
  // (Chromium screenshots of opaque Scene pages are often already RGB), then
  // re-filter and re-deflate at maximum level.
  let rgb: Buffer;
  let hasAlpha = false;
  if (channels === 4) {
    rgb = Buffer.alloc(width * height * 3);
    for (let i = 0, j = 0; i < pixels.length; i += 4) {
      if (pixels[i + 3]! !== 0xff) {
        hasAlpha = true;
        break;
      }
      rgb[j++] = pixels[i]!;
      rgb[j++] = pixels[i + 1]!;
      rgb[j++] = pixels[i + 2]!;
    }
  } else {
    rgb = pixels;
  }
  const stage1 =
    channels === 4 && !hasAlpha
      ? encodeTruecolor(width, height, 3, rgb)
      : encodeTruecolor(width, height, channels, pixels);
  if (stage1.length <= limit)
    return {
      ok: true,
      png: stage1,
      optimization: { stage: "lossless", bytesBefore: png.length, bytesAfter: stage1.length },
    };

  // Stage 2 — palette quantization. It operates on RGB, so alpha cannot take
  // this stage: fail with what was observed and the fix.
  if (hasAlpha)
    return fail(
      at,
      `the render is ${Math.min(stage1.length, png.length).toLocaleString("en-US")} bytes ` +
        `(the limit is ${limit.toLocaleString("en-US")} bytes) and its alpha transparency cannot ` +
        `survive palette optimization — flatten the scene's semi-transparent layers, then render again`,
    );

  const quantized = quantizeTo256(rgb, width, height);
  if (quantized.png.length <= limit)
    return {
      ok: true,
      png: quantized.png,
      optimization: { stage: "quantized", bytesBefore: png.length, bytesAfter: quantized.png.length },
    };

  return fail(
    at,
    `finalization optimized the render to ${quantized.png.length.toLocaleString("en-US")} bytes ` +
      `but the limit is ${limit.toLocaleString("en-US")} bytes — no further local optimization ` +
      `preserves this render; reduce the scene's visual complexity (simpler or smaller photographic ` +
      `assets), then render again`,
  );
}
