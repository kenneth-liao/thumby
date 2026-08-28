import { inflateSync } from "node:zlib";

/**
 * Minimal PNG reader for 8-bit non-interlaced RGB/RGBA screenshots:
 * inflates the IDAT stream and unfilters scanlines so tests can assert on
 * actual composited pixels, not just header dimensions.
 */
export function decodePng(buf: Buffer): {
  width: number;
  height: number;
  px: (x: number, y: number) => number[];
} {
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const colorType = buf[25]!;
  const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : NaN;
  if (!Number.isInteger(bpp)) throw new Error(`unsupported PNG color type ${colorType}`);

  const idat: Buffer[] = [];
  let off = 8;
  while (off + 12 <= buf.length) {
    const len = buf.readUInt32BE(off);
    if (buf.toString("ascii", off + 4, off + 8) === "IDAT")
      idat.push(buf.subarray(off + 8, off + 8 + len));
    off += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));

  const stride = width * bpp;
  const out = Buffer.alloc(height * stride);
  const paeth = (a: number, b: number, c: number) => {
    const p = a + b - c;
    const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++]!;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp]! : 0;
      const b = prev ? prev[x]! : 0;
      const c = prev && x >= bpp ? prev[x - bpp]! : 0;
      let v = raw[pos + x]!;
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) v += paeth(a, b, c);
      cur[x] = v & 0xff;
    }
    pos += stride;
  }
  return {
    width,
    height,
    px: (x, y) => {
      const at = y * stride + x * bpp;
      const rgb = Array.from(out.subarray(at, at + bpp));
      return bpp === 3 ? [...rgb, 255] : rgb;
    },
  };
}
