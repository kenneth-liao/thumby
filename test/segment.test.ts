import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, readdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  SUBJECT_SEGMENTER,
  ensureSegmenterReady,
  localSegmentationMatteEngine,
  maskPngFrom,
  missingWeightsMessage,
  preprocess,
  weightsPath,
} from "../src/segment.js";
import { verifyTrueAlpha } from "../src/alpha.js";
import { encodePng, decodePng } from "./png.js";

const originalModelDir = process.env.THUMBY_MODEL_DIR;

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "thumby-segment-"));
});
afterEach(async () => {
  if (originalModelDir === undefined) delete process.env.THUMBY_MODEL_DIR;
  else process.env.THUMBY_MODEL_DIR = originalModelDir;
  await rm(root, { recursive: true, force: true });
});

describe("preprocess", () => {
  test("resizes to the model's square and ImageNet-normalizes, NCHW", () => {
    const { size, mean, std } = SUBJECT_SEGMENTER;
    const flat = encodePng(8, 4, () => [255, 0, 0, 255], { colorType: 2 });
    const tensor = preprocess(flat);
    expect(tensor.length).toBe(3 * size * size);
    // Channel planes, not interleaved pixels: red is plane 0.
    expect(tensor[0]).toBeCloseTo((1 - mean[0]) / std[0], 5);
    expect(tensor[size * size]).toBeCloseTo((0 - mean[1]) / std[1], 5);
    expect(tensor[2 * size * size]).toBeCloseTo((0 - mean[2]) / std[2], 5);
  });

  test("refuses bytes it cannot parse instead of segmenting garbage", () => {
    expect(() => preprocess(Buffer.from("not a png"))).toThrow(/cannot be segmented|PNG|signature/i);
  });
});

describe("maskPngFrom", () => {
  const size = 4;

  test("passes probabilities through as grayscale coverage", () => {
    const probs = Float32Array.from([
      1, 1, 0, 0,
      1, 1, 0, 0,
      0, 0, 0, 0,
      0, 0, 0, 0,
    ]);
    const png = decodePng(Buffer.from(maskPngFrom(probs, size)));
    expect(png.width).toBe(size);
    expect(png.px(0, 0)).toEqual([255, 255, 255, 255]);
    expect(png.px(3, 3)).toEqual([0, 0, 0, 255]);
  });

  test("squashes logits through a sigmoid — an export that emits them is not a black frame", () => {
    // Same mask, expressed as logits: without the sigmoid every value would
    // clamp to 0 or 255 by luck, and a negative-only export would go black.
    const logits = Float32Array.from([
      8, 8, -8, -8,
      8, 8, -8, -8,
      -8, -8, -8, -8,
      -8, -8, -8, -8,
    ]);
    const png = decodePng(Buffer.from(maskPngFrom(logits, size)));
    expect(png.px(0, 0)[0]).toBeGreaterThan(250);
    expect(png.px(3, 3)[0]).toBeLessThan(5);
  });
});

/**
 * These run before the live check on purpose: a successful session is cached
 * for the process, so the failure paths must be exercised while no session
 * has been built.
 */
describe("weights are pinned and failures are loud", () => {
  const OPAQUE = encodePng(16, 16, (x, y) => (x < 8 ? [200, 30, 40, 255] : [20, 90, 200, 255]), {
    colorType: 2,
  });

  test("missing weights name the file, the pin, and the fetch command", async () => {
    process.env.THUMBY_MODEL_DIR = root;
    const err = await localSegmentationMatteEngine()({ bytes: OPAQUE, label: "cand.png" }).catch(
      (e) => e as Error,
    );
    const message = (err as Error).message;
    expect(message).toContain(path.join(root, SUBJECT_SEGMENTER.file));
    expect(message).toContain(SUBJECT_SEGMENTER.sha256);
    expect(message).toContain(SUBJECT_SEGMENTER.source);
    // Never a silent skip: the pass refuses rather than recording no matte.
    expect(message).toMatch(/never falls back|fails|unusable/i);
  });

  test("weights whose bytes do not match the pin are refused, with the actual hash", async () => {
    process.env.THUMBY_MODEL_DIR = root;
    await writeFile(path.join(root, SUBJECT_SEGMENTER.file), "not the model");
    const err = await localSegmentationMatteEngine()({ bytes: OPAQUE, label: "cand.png" }).catch(
      (e) => e as Error,
    );
    expect((err as Error).message).toMatch(/sha-256 is [0-9a-f]{64}/);
  });

  test("preflight refuses before any candidate is generated, with the same message", async () => {
    // This is what stops a creator job while it is still free (RE-3): the
    // lifecycle calls it ahead of the paid generation call.
    process.env.THUMBY_MODEL_DIR = root;
    const engine = localSegmentationMatteEngine();
    expect(engine.preflight).toBe(ensureSegmenterReady);
    const err = await engine.preflight!().catch((e) => e as Error);
    expect((err as Error).message).toContain(path.join(root, SUBJECT_SEGMENTER.file));
    expect((err as Error).message).toContain(SUBJECT_SEGMENTER.sha256);
    expect((err as Error).message).toContain(SUBJECT_SEGMENTER.source);
  });

  test("the fix-it message is one text, whatever raised it", () => {
    process.env.THUMBY_MODEL_DIR = root;
    expect(missingWeightsMessage("because")).toContain(weightsPath());
  });
});

/**
 * The live check. It exercises the real weights against a real recorded
 * candidate and is skipped whenever either is absent — unit tests never load
 * half a gigabyte of model, and CI without the cache stays green.
 */
describe("local segmentation (live)", () => {
  const demoCandidates = path.resolve("out", "jobs", "int1-alpha-demo", "candidates");
  const present = async (p: string) => !!(await stat(p).catch(() => null));

  test("mattes a real opaque creator candidate to a true-alpha PNG", async () => {
    if (!(await present(weightsPath())) || !(await present(demoCandidates))) {
      console.log("skipped: local weights or the recorded demo candidates are not on this machine");
      return;
    }
    const file = (await readdir(demoCandidates)).find((f) => f.endsWith(".png"));
    if (!file) return;
    const bytes = await readFile(path.join(demoCandidates, file));
    // The candidate is opaque RGB — the measured shape the pass exists for.
    expect(() => verifyTrueAlpha(bytes, file)).toThrow(/alpha channel/i);

    const result = await localSegmentationMatteEngine()({ bytes, label: file });
    const report = verifyTrueAlpha(result.bytes, file);
    expect(result.engine).toBe(`local-segmentation:${SUBJECT_SEGMENTER.file}`);
    // A real subject matte: most of the frame cut away, a substantial subject left.
    const total = report.width * report.height;
    expect(report.transparentPx / total).toBeGreaterThan(0.4);
    expect(report.opaquePx / total).toBeGreaterThan(0.05);
  }, 120_000);
});
