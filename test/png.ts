import { deflateSync, inflateSync } from "node:zlib";

// CRC-32 (PNG polynomial), bit-reflected table form.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([head, body, crc]);
}

/**
 * Minimal PNG writer for test fixtures: filter-0 scanlines, zlib compression —
 * the exact shape the true-alpha gate and the pixel reader parse. Default is
 * RGBA (color type 6); `colorType: 2` writes opaque RGB, first three channels.
 */
export function encodePng(
  width: number,
  height: number,
  rgba: (x: number, y: number) => [number, number, number, number],
  opts?: { colorType?: 2 | 6 },
): Buffer {
  const colorType = opts?.colorType ?? 6;
  const bpp = colorType === 6 ? 4 : 3;
  const raw = Buffer.alloc(height * (width * bpp + 1));
  for (let y = 0; y < height; y++) {
    const row = y * (width * bpp + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = rgba(x, y);
      const at = row + 1 + x * bpp;
      raw[at] = r;
      raw[at + 1] = g;
      raw[at + 2] = b;
      if (bpp === 4) raw[at + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = colorType;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}


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
