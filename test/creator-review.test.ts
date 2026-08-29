import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runCreatorJob, loadJob, type CreatorGenerator, type CreatorJobRequest, type JobGenerator } from "../src/jobs.js";
import { reviewCreatorJob } from "../src/review.js";
import { run as cliRun } from "../src/job-cli.js";
import { encodePng } from "./png.js";

let root: string;
let jobRoot: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "thumby-creator-review-"));
  jobRoot = path.join(root, "jobs");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const ALPHA_PNG = encodePng(16, 16, (x, y) =>
  x < 4 && y < 4 ? [255, 0, 0, 255] : [0, 0, 0, 0],
);

let genCounter = 0;
const fakeGen: JobGenerator = async (req) => ({
  candidates: Array.from({ length: req.count }, () => ({
    bytes: Buffer.concat([ALPHA_PNG, Buffer.from(`-${genCounter++}`)]),
    mediaType: "image/png",
  })),
  warnings: [],
  fullPrompt: `CREATOR<${req.subject}>`,
});

async function seedAnchors(names: string[]): Promise<void> {
  for (const name of names) {
    await writeFile(path.join(root, name), `anchor-bytes-${name}`);
  }
}

const baseRequest = (anchors: string[]): CreatorJobRequest => ({
  kind: "creator",
  subject: "arms crossed, explaining to camera",
  model: "nano-2",
  count: 2,
  refs: anchors.map((a) => ({
    role: "identity",
    path: path.join(root, a),
    contentHash: "0".repeat(64),
  })),
});

describe("reviewCreatorJob", () => {
  test("writes a review sheet listing every distinct candidate against the identity anchors", async () => {
    await seedAnchors(["anchor-a.png", "anchor-b.png"]);
    const job = await runCreatorJob(jobRoot, "creator-review", baseRequest(["anchor-a.png", "anchor-b.png"]), fakeGen);
    // A second run adds candidates the sheet must also show — best-of-N across reruns.
    const reran = await runCreatorJob(jobRoot, "creator-review-2", baseRequest(["anchor-a.png"]), fakeGen);
    void reran;

    const result = await reviewCreatorJob(jobRoot, "creator-review");
    expect(result.reviewPath).toBe(path.join(jobRoot, "creator-review", "review.html"));

    const html = await readFile(result.reviewPath, "utf8");
    // Every candidate image from every run is referenced.
    for (const cand of job.runs[0]!.candidates) {
      expect(html).toContain(cand.contentHash.slice(0, 12));
    }
    // Anchors are referenced with their ids for the face-detail comparison.
    expect(html).toContain("anchor-a.png");
    expect(html).toContain("anchor-b.png");
    // The face-detail section exists and the subject/model provenance is shown.
    expect(html).toMatch(/face detail/i);
    expect(html).toContain("arms crossed, explaining to camera");
    expect(result.candidates).toHaveLength(2);
    expect(result.anchors.map((a) => a.id)).toEqual(["anchor-a", "anchor-b"]);
  });

  test("deduplicates recurring candidate hashes to their first run", async () => {
    await seedAnchors(["anchor-a.png"]);
    const same: CreatorGenerator = async (req) => ({
      candidates: [{ bytes: ALPHA_PNG, mediaType: "image/png" }],
      warnings: [],
      fullPrompt: `CREATOR<${req.subject}>`,
    });
    await runCreatorJob(jobRoot, "creator-dup", baseRequest(["anchor-a.png"]), same);
    await runCreatorJob(jobRoot, "creator-dup-2", baseRequest(["anchor-a.png"]), same);
    const result = await reviewCreatorJob(jobRoot, "creator-dup");
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.runIndex).toBe(0);
  });

  test("fails loudly when an identity anchor file is missing", async () => {
    await seedAnchors(["anchor-a.png", "gone.png"]);
    await runCreatorJob(jobRoot, "creator-missing", baseRequest(["anchor-a.png", "gone.png"]), fakeGen);
    await rm(path.join(root, "gone.png"));
    await expect(reviewCreatorJob(jobRoot, "creator-missing")).rejects.toThrow(/gone\.png/);
  });

  test("refuses non-creator jobs — anchors only exist on creator requests", async () => {
    // A plate job shares the lifecycle but has no identity anchors.
    const { runPlateJob } = await import("../src/jobs.js");
    await runPlateJob(jobRoot, "plate-review", {
      kind: "plate",
      subject: "neon server room",
      zone: "left",
      model: "gpt-image",
      count: 1,
      refs: [],
    }, async () => ({ candidates: [{ bytes: ALPHA_PNG, mediaType: "image/png" }], warnings: [], fullPrompt: "p" }));
    await expect(reviewCreatorJob(jobRoot, "plate-review")).rejects.toThrow(/creator/i);
  });

  test("the CLI review command prints structured JSON with the review path", async () => {
    await seedAnchors(["anchor-a.png"]);
    await runCreatorJob(jobRoot, "creator-cli", baseRequest(["anchor-a.png"]), fakeGen);
    const res = await cliRun(["review", "creator-cli"], {
      generate: fakeGen,
      generateObject: fakeGen,
      jobsRoot: jobRoot,
    });
    expect(res.exitCode).toBe(0);
    const out = res.output as Record<string, any>;
    expect(out.ok).toBe(true);
    expect(out.review).toBe(path.join(jobRoot, "creator-cli", "review.html"));
    expect(out.candidates).toHaveLength(2);
    const job = await loadJob(jobRoot, "creator-cli");
    expect(job.runs[0]!.candidates).toHaveLength(2);
  });
});
