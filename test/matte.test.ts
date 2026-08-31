import { describe, test, expect } from "bun:test";
import { composeMatte, matteCandidate, NATIVE_ALPHA, type MatteEngine } from "../src/matte.js";
import { verifyTrueAlpha } from "../src/alpha.js";
import { encodePng, decodePng } from "./png.js";

/** An opaque RGB candidate — what the tested nano recipe actually returns. */
const OPAQUE_SUBJECT = encodePng(
  16,
  16,
  (x, y) => (x >= 4 && x < 12 && y >= 4 && y < 12 ? [200, 30, 40, 255] : [10, 20, 30, 255]),
  { colorType: 2 },
);

/** The segmentation mask for it: white subject, black background. */
const MASK = encodePng(
  16,
  16,
  (x, y) => (x >= 4 && x < 12 && y >= 4 && y < 12 ? [255, 255, 255, 255] : [0, 0, 0, 255]),
  { colorType: 2 },
);

/** A half-scale mask — models do not honour "same dimensions" reliably. */
const HALF_MASK = encodePng(
  8,
  8,
  (x, y) => (x >= 2 && x < 6 && y >= 2 && y < 6 ? [255, 255, 255, 255] : [0, 0, 0, 255]),
  { colorType: 2 },
);

const ALL_BLACK = encodePng(16, 16, () => [0, 0, 0, 255], { colorType: 2 });
const ALL_WHITE = encodePng(16, 16, () => [255, 255, 255, 255], { colorType: 2 });

/** A candidate that already carries a real matte — the native-alpha route. */
const NATIVE_ALPHA_PNG = encodePng(16, 16, (x, y) =>
  x < 8 && y < 8 ? [255, 0, 0, 255] : [0, 0, 0, 0],
);

const engineOf = (mask: Uint8Array, engine = "test/segmenter"): MatteEngine =>
  async ({ bytes, label }) => ({ bytes: composeMatte(bytes, mask, label), engine });

describe("composeMatte", () => {
  test("carries the candidate's colour with alpha taken from the mask", () => {
    const matted = composeMatte(OPAQUE_SUBJECT, MASK, "cand.png");
    const png = decodePng(Buffer.from(matted));
    expect(png.width).toBe(16);
    expect(png.height).toBe(16);
    // Subject: original colour, fully opaque.
    expect(png.px(6, 6)).toEqual([200, 30, 40, 255]);
    // Background: cut out, and the source colour is irrelevant once alpha is 0.
    expect(png.px(0, 0)[3]).toBe(0);
    // The result satisfies the adoption gate — that is the whole point.
    const report = verifyTrueAlpha(matted, "cand.png");
    expect(report.opaquePx).toBe(64);
    expect(report.transparentPx).toBe(16 * 16 - 64);
  });

  test("keeps soft edges soft — a grey mask pixel becomes partial alpha", () => {
    const soft = encodePng(16, 16, (x, y) => (y === 0 ? [128, 128, 128, 255] : x >= 4 && x < 12 && y >= 4 && y < 12 ? [255, 255, 255, 255] : [0, 0, 0, 255]), {
      colorType: 2,
    });
    const png = decodePng(Buffer.from(composeMatte(OPAQUE_SUBJECT, soft, "cand.png")));
    expect(png.px(3, 0)[3]).toBe(128);
  });

  test("rescales a mask that does not match the candidate's dimensions", () => {
    const png = decodePng(Buffer.from(composeMatte(OPAQUE_SUBJECT, HALF_MASK, "cand.png")));
    expect(png.width).toBe(16);
    expect(png.px(6, 6)).toEqual([200, 30, 40, 255]);
    expect(png.px(0, 0)[3]).toBe(0);
  });

  test("refuses bytes it cannot parse rather than guessing a matte", () => {
    expect(() => composeMatte(Buffer.from("not a png"), MASK, "junk.png")).toThrow(/PNG|signature/i);
    expect(() => composeMatte(OPAQUE_SUBJECT, Buffer.from("nope"), "cand.png")).toThrow(
      /mask|PNG|signature/i,
    );
  });
});

describe("matteCandidate", () => {
  test("uses a candidate's own alpha when it already carries a real matte — no model call", async () => {
    let calls = 0;
    const engine: MatteEngine = async (input) => {
      calls++;
      return { bytes: input.bytes, engine: "should-not-run" };
    };
    const result = await matteCandidate(NATIVE_ALPHA_PNG, "native.png", engine);
    expect(calls).toBe(0);
    expect(result.engine).toBe(NATIVE_ALPHA);
    expect(Buffer.from(result.bytes)).toEqual(Buffer.from(NATIVE_ALPHA_PNG));
  });

  test("mattes an opaque candidate through the engine and names it", async () => {
    const result = await matteCandidate(OPAQUE_SUBJECT, "cand.png", engineOf(MASK));
    expect(result.engine).toBe("test/segmenter");
    expect(verifyTrueAlpha(result.bytes, "cand.png").opaquePx).toBe(64);
  });

  test("carries an engine's warnings onto the run — e.g. a CoreML fallback", async () => {
    const noisy: MatteEngine = async ({ bytes, label }) => ({
      bytes: composeMatte(bytes, MASK, label),
      engine: "test/segmenter",
      warnings: ["matte: CoreML is unavailable — the segmenter ran on CPU"],
    });
    const result = await matteCandidate(OPAQUE_SUBJECT, "cand.png", noisy);
    expect(result.warnings).toEqual(["matte: CoreML is unavailable — the segmenter ran on CPU"]);
  });

  test("refuses a degenerate matte at the matting boundary, never downstream", async () => {
    // An all-black mask cuts everything away; an all-white one cuts nothing.
    await expect(matteCandidate(OPAQUE_SUBJECT, "empty.png", engineOf(ALL_BLACK))).rejects.toThrow(
      /matte is empty|opaque pixels/i,
    );
    await expect(matteCandidate(OPAQUE_SUBJECT, "full.png", engineOf(ALL_WHITE))).rejects.toThrow(
      /effectively opaque|transparent/i,
    );
  });

  test("refuses an engine that returns bytes without a real alpha channel", async () => {
    const passthrough: MatteEngine = async ({ bytes }) => ({ bytes, engine: "bad-engine" });
    await expect(matteCandidate(OPAQUE_SUBJECT, "cand.png", passthrough)).rejects.toThrow(
      /alpha channel|chroma-key/i,
    );
  });
});
