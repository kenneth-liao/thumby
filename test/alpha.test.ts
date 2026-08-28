import { describe, test, expect } from "bun:test";
import { deflateSync } from "node:zlib";
import { verifyTrueAlpha } from "../src/alpha.js";
import { encodePng, chunk, ihdr, PNG_SIGNATURE } from "./png.js";

/** A 10×10 frame: a 4×4 opaque red subject at the top-left, the rest transparent. */
const WITH_SUBJECT = encodePng(10, 10, (x, y) =>
  x < 4 && y < 4 ? [255, 0, 0, 255] : [0, 0, 0, 0],
);

const OPAQUE = encodePng(10, 10, () => [0, 128, 255, 255]);
const ALL_TRANSPARENT = encodePng(10, 10, () => [0, 0, 0, 0]);

/** 20×20 with a single fully-transparent pixel in an otherwise opaque frame. */
const ONE_STRAY_PIXEL = encodePng(20, 20, (x, y) =>
  x === 0 && y === 0 ? [1, 2, 3, 0] : [9, 9, 9, 255],
);

describe("verifyTrueAlpha", () => {
  test("accepts an RGBA candidate with a real subject and real transparency", () => {
    const report = verifyTrueAlpha(WITH_SUBJECT, "candidate.png");
    expect(report.width).toBe(10);
    expect(report.height).toBe(10);
    expect(report.transparentPx).toBe(84);
    expect(report.opaquePx).toBe(16);
  });

  test("refuses an opaque RGB(A) image — color-distance keying cannot qualify", () => {
    expect(() => verifyTrueAlpha(OPAQUE, "opaque.png")).toThrow(
      /no transparent pixels|opaque/i,
    );
  });

  test("refuses an entirely transparent image — an empty matte is no object", () => {
    expect(() => verifyTrueAlpha(ALL_TRANSPARENT, "empty.png")).toThrow(
      /no opaque pixels|empty/i,
    );
  });

  test("refuses transparency below 1% of the frame — a stray pixel is not a matte", () => {
    expect(() => verifyTrueAlpha(ONE_STRAY_PIXEL, "stray.png")).toThrow(
      /1%|transparent/i,
    );
  });

  test("refuses a non-PNG payload", () => {
    expect(() => verifyTrueAlpha(Buffer.from("not a png"), "junk.png")).toThrow(
      /not a PNG|signature/i,
    );
  });

  test("refuses an RGB (no-alpha-channel) PNG by color type", () => {
    const rgb = encodePng(4, 4, () => [200, 10, 10, 255], { colorType: 2 });
    expect(() => verifyTrueAlpha(rgb, "rgb.png")).toThrow(/alpha channel/i);
  });

  test("refuses interlaced or non-8-bit PNGs with an actionable message", () => {
    const odd = Buffer.from(encodePng(4, 4, () => [1, 2, 3, 255]));
    odd[24] = 16; // IHDR bit depth byte → 16
    expect(() => verifyTrueAlpha(odd, "odd.png")).toThrow(/bit depth/i);
  });
});

describe("verifyTrueAlpha — bounded parsing of external bytes (PROD-1)", () => {
  /** A well-formed signature + IHDR + stub IDAT: geometry is refused from the header alone. */
  const headerOnly = (width: number, height: number) =>
    Buffer.concat([
      PNG_SIGNATURE,
      chunk("IHDR", ihdr(width, height)),
      chunk("IDAT", deflateSync(Buffer.alloc(1))),
      chunk("IEND", Buffer.alloc(0)),
    ]);

  test("refuses an encoded payload over the parse-size cap", () => {
    const big = Buffer.alloc(65 * 1024 * 1024);
    big.set(PNG_SIGNATURE);
    expect(() => verifyTrueAlpha(big, "huge.png")).toThrow(/parse limit/i);
  });

  test("refuses zero or over-cap dimensions from the IHDR before any allocation", () => {
    expect(() => verifyTrueAlpha(headerOnly(0, 10), "zero.png")).toThrow(/zero dimension/i);
    expect(() => verifyTrueAlpha(headerOnly(9000, 10), "wide.png")).toThrow(/per-axis parse limit/i);
    expect(() => verifyTrueAlpha(headerOnly(10, 9000), "tall.png")).toThrow(/per-axis parse limit/i);
    expect(() => verifyTrueAlpha(headerOnly(8192, 3000), "many.png")).toThrow(/-pixel parse limit/i);
  });

  test("refuses a decompression bomb — inflate is capped at the declared geometry", () => {
    const declared = 16 * (16 * 4 + 1);
    const bomb = Buffer.concat([
      PNG_SIGNATURE,
      chunk("IHDR", ihdr(16, 16)),
      chunk("IDAT", deflateSync(Buffer.alloc(declared * 64))),
      chunk("IEND", Buffer.alloc(0)),
    ]);
    expect(() => verifyTrueAlpha(bomb, "bomb.png")).toThrow(/does not decompress|corrupt/i);
  });

  test("refuses a chunk whose length runs past the end of the file", () => {
    const png = Buffer.from(WITH_SUBJECT);
    png.writeUInt32BE(0xffffff, 8 + 25); // IHDR chunk is 25 bytes — this is the IDAT length field
    expect(() => verifyTrueAlpha(png, "truncated.png")).toThrow(/past the end/i);
  });

  test("refuses a chunk that fails its CRC-32 check", () => {
    const png = Buffer.from(WITH_SUBJECT);
    png[8 + 12 + 13 - 1] ^= 0xff; // flip the last IHDR CRC byte
    expect(() => verifyTrueAlpha(png, "badcrc.png")).toThrow(/CRC/i);
  });

  test("refuses non-standard IHDR compression and filter methods", () => {
    const comp = Buffer.from(WITH_SUBJECT);
    comp[26] = 1;
    expect(() => verifyTrueAlpha(comp, "comp.png")).toThrow(/compression method/i);
    const filt = Buffer.from(WITH_SUBJECT);
    filt[27] = 1;
    expect(() => verifyTrueAlpha(filt, "filt.png")).toThrow(/filter method/i);
  });

  test("refuses a scanline length mismatch — the IDAT must match the declared geometry exactly", () => {
    // Rebuild the IHDR with a shrunken declared width (CRC still valid) — the
    // real scanlines no longer fit the geometry, which must be refused.
    const shrunk = Buffer.concat([
      PNG_SIGNATURE,
      chunk("IHDR", ihdr(9, 10)),
      Buffer.from(WITH_SUBJECT).subarray(8 + 25),
    ]);
    expect(() => verifyTrueAlpha(shrunk, "mismatch.png")).toThrow(/declared pixel data|decompress/i);
  });
});

describe("verifyTrueAlpha — scanline filters (INT-4)", () => {
  /**
   * A 16×1 RGBA PNG whose single scanline is forward-filtered with the given
   * code (up=0 on the first row, so only the left neighbour matters), so the
   * gate's unfilter reconstructs the true pixels for every valid code.
   */
  function filteredRowPng(filter: number): Buffer {
    const w = 16, bpp = 4;
    const px = (x: number): [number, number, number, number] =>
      x < 4 ? [255, 0, 0, 255] : [0, 0, 0, 0];
    const paeth = (a: number, b: number, c: number) => {
      const p = a + b - c;
      const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
    };
    const orig: number[] = [];
    for (let x = 0; x < w; x++) orig.push(...px(x));
    const raw = Buffer.alloc(1 + w * bpp);
    raw[0] = filter;
    for (let x = 0; x < w; x++)
      for (let i = 0; i < bpp; i++) {
        const left = x >= 1 ? orig[(x - 1) * bpp + i]! : 0;
        const v = orig[x * bpp + i]!;
        raw[1 + x * bpp + i] =
          filter === 0 ? v
          : filter === 1 ? v - left
          : filter === 2 ? v
          : filter === 3 ? v - (left >> 1)
          : v - left; // filter 4: paeth(left, 0, 0) === left
      }
    return Buffer.concat([
      PNG_SIGNATURE,
      chunk("IHDR", ihdr(w, 1)),
      chunk("IDAT", deflateSync(raw)),
      chunk("IEND", Buffer.alloc(0)),
    ]);
  }

  test("refuses an unknown filter code instead of silently decoding it as filter 0", () => {
    const weird = encodePng(8, 8, () => [1, 2, 3, 255], { filterByte: 7 });
    expect(() => verifyTrueAlpha(weird, "filter7.png")).toThrow(/unknown filter code/i);
  });

  test("still decodes all four valid filter codes", () => {
    for (const filter of [0, 1, 2, 3, 4]) {
      const report = verifyTrueAlpha(filteredRowPng(filter), `filter${filter}.png`);
      expect(report.width).toBe(16);
      expect(report.transparentPx).toBe(12);
      expect(report.opaquePx).toBe(4);
    }
  });
});
