import { describe, test, expect } from "bun:test";
import { verifyTrueAlpha } from "../src/alpha.js";
import { encodePng } from "./png.js";

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
