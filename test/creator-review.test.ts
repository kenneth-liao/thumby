import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { runCreatorJob, loadJob, rerunCreatorJob, type CreatorGenerator, type CreatorJobRequest, type JobGenerator } from "../src/jobs.js";
import { reviewCreatorJob } from "../src/review.js";
import { run as cliRun } from "../src/job-cli.js";
import { composeMatte, type MatteEngine } from "../src/matte.js";
import { encodePng } from "./png.js";

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

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

/** What the model actually returns: opaque RGB. The matting pass isolates it. */
const OPAQUE_PNG = encodePng(
  16,
  16,
  (x, y) => (x < 8 && y < 8 ? [200, 30, 40, 255] : [20, 90, 200, 255]),
  { colorType: 2 },
);
const MASK_PNG = encodePng(
  16,
  16,
  (x, y) => (x < 8 && y < 8 ? [255, 255, 255, 255] : [0, 0, 0, 255]),
  { colorType: 2 },
);

const fakeMatte: MatteEngine = async ({ bytes, label }) => ({
  bytes: composeMatte(bytes, MASK_PNG, label),
  engine: "test/segmentation",
});

let genCounter = 0;
const distinctGen: JobGenerator = async (req) => ({
  candidates: Array.from({ length: req.count }, () => ({
    bytes: Buffer.concat([OPAQUE_PNG, Buffer.from(`-${genCounter++}`)]),
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

const anchorRef = async (name: string): Promise<{ role: "identity"; path: string; contentHash: string }> => ({
  role: "identity",
  path: path.join(root, name),
  contentHash: sha256(Buffer.from(`anchor-bytes-${name}`)),
});

const baseRequest = (anchors: string[]): CreatorJobRequest => ({
  kind: "creator",
  subject: "arms crossed, explaining to camera",
  model: "nano-2",
  count: 2,
  refs: anchors.map((a) => ({
    role: "identity" as const,
    path: path.join(root, a),
    contentHash: sha256(Buffer.from(`anchor-bytes-${a}`)),
  })),
});

describe("reviewCreatorJob", () => {
  test("writes a review sheet listing every distinct candidate across runs, against the identity anchors", async () => {
    await seedAnchors(["anchor-a.png", "anchor-b.png"]);
    await runCreatorJob(jobRoot, "creator-review", baseRequest(["anchor-a.png", "anchor-b.png"]), distinctGen, fakeMatte);
    // A rerun of the SAME job adds candidates the sheet must also show — the
    // advertised all-runs behavior is exercised through the real lineage.
    const second = await rerunCreatorJob(jobRoot, "creator-review", distinctGen, fakeMatte);
    expect(second.runs).toHaveLength(2);

    const result = await reviewCreatorJob(jobRoot, "creator-review");
    expect(result.reviewPath).toBe(path.join(jobRoot, "creator-review", "review.html"));

    const html = await readFile(result.reviewPath, "utf8");
    // Every candidate from every run is referenced. The rerun produced distinct
    // candidates (distinctGen emits unique bytes), so its hashes are genuine
    // second-run evidence — assert them directly, not as re-read first-run hashes.
    const firstRunHashes = new Set(second.runs[0]!.candidates.map((c) => c.contentHash.slice(0, 12)));
    const secondRunHashes = second.runs[1]!.candidates.map((c) => c.contentHash.slice(0, 12));
    expect(secondRunHashes.some((h) => !firstRunHashes.has(h))).toBe(true);
    for (const hash of [...firstRunHashes, ...secondRunHashes]) {
      expect(html).toContain(hash);
    }
    // Anchors are referenced with their ids for the face-detail comparison.
    expect(html).toContain("anchor-a.png");
    expect(html).toContain("anchor-b.png");
    // The face-detail section exists and the subject/model provenance is shown.
    expect(html).toMatch(/face detail/i);
    expect(html).toContain("arms crossed, explaining to camera");
    // Candidates from both runs are present (run 0 and run 1 captions).
    expect(result.candidates).toHaveLength(4);
    expect(result.candidates.some((c) => c.runIndex === 1)).toBe(true);
    expect(result.anchors.map((a) => a.id)).toEqual(["anchor-a", "anchor-b"]);
  });

  test("deduplicates a candidate hash recurring across runs to its first run", async () => {
    await seedAnchors(["anchor-a.png"]);
    const same: CreatorGenerator = async (req) => ({
      candidates: [{ bytes: OPAQUE_PNG, mediaType: "image/png" }],
      warnings: [],
      fullPrompt: `CREATOR<${req.subject}>`,
    });
    const job = await runCreatorJob(jobRoot, "creator-dup", baseRequest(["anchor-a.png"]), same, fakeMatte);
    const reran = await rerunCreatorJob(jobRoot, "creator-dup", same, fakeMatte);
    expect(reran.runs[0]!.candidates[0]!.contentHash).toBe(reran.runs[1]!.candidates[0]!.contentHash);
    const result = await reviewCreatorJob(jobRoot, "creator-dup");
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.runIndex).toBe(0);
    const html = await readFile(result.reviewPath, "utf8");
    expect(html).toContain(`run ${result.candidates[0]!.runIndex}`);
  });

  test("shows the matte adoption would write, per candidate, and names the engine", async () => {
    await seedAnchors(["anchor-a.png"]);
    const job = await runCreatorJob(jobRoot, "creator-matte-view", { ...baseRequest(["anchor-a.png"]), count: 1 }, distinctGen, fakeMatte);
    const cand = job.runs[0]!.candidates[0]!;
    const result = await reviewCreatorJob(jobRoot, "creator-matte-view");
    expect(result.candidates[0]!.matte!.contentHash).toBe(cand.matte!.contentHash);
    const html = await readFile(result.reviewPath, "utf8");
    expect(html).toMatch(/isolation/i);
    expect(html).toContain(path.basename(cand.matte!.file));
    expect(html).toContain("matte via test/segmentation");
  });

  test("says plainly when a candidate has no matte — it is evidence, not an adoptable asset", async () => {
    await seedAnchors(["anchor-a.png"]);
    const brokenMatte: MatteEngine = async () => {
      throw new Error("mask model returned no image");
    };
    await runCreatorJob(jobRoot, "creator-no-matte", { ...baseRequest(["anchor-a.png"]), count: 1 }, distinctGen, brokenMatte);
    const result = await reviewCreatorJob(jobRoot, "creator-no-matte");
    expect(result.candidates[0]!.matte).toBeUndefined();
    const html = await readFile(result.reviewPath, "utf8");
    expect(html).toContain("no matte — not adoptable");
  });

  test("fails loudly when a matte file no longer matches its recorded identity", async () => {
    await seedAnchors(["anchor-a.png"]);
    const job = await runCreatorJob(jobRoot, "creator-matte-tampered", { ...baseRequest(["anchor-a.png"]), count: 1 }, distinctGen, fakeMatte);
    const cand = job.runs[0]!.candidates[0]!;
    await writeFile(path.join(jobRoot, "creator-matte-tampered", cand.matte!.file), ALPHA_PNG);
    await expect(reviewCreatorJob(jobRoot, "creator-matte-tampered")).rejects.toThrow(
      /matte.*(changed|identity)/i,
    );
  });

  test("fails loudly when an identity anchor file is missing", async () => {
    await seedAnchors(["anchor-a.png", "gone.png"]);
    await runCreatorJob(jobRoot, "creator-missing", baseRequest(["anchor-a.png", "gone.png"]), distinctGen, fakeMatte);
    await rm(path.join(root, "gone.png"));
    await expect(reviewCreatorJob(jobRoot, "creator-missing")).rejects.toThrow(/gone\.png/);
  });

  test("fails loudly when an identity anchor's bytes no longer match the recorded identity", async () => {
    await seedAnchors(["anchor-a.png"]);
    await runCreatorJob(jobRoot, "creator-drift", baseRequest(["anchor-a.png"]), distinctGen, fakeMatte);
    await writeFile(path.join(root, "anchor-a.png"), "tampered-anchor-bytes");
    await expect(reviewCreatorJob(jobRoot, "creator-drift")).rejects.toThrow(
      /anchor-a\.png.*(changed|identity|drift)/i,
    );
  });

  test("fails loudly when a candidate file no longer matches its recorded identity", async () => {
    await seedAnchors(["anchor-a.png"]);
    await runCreatorJob(jobRoot, "creator-tampered", baseRequest(["anchor-a.png"]), distinctGen, fakeMatte);
    const job = await loadJob(jobRoot, "creator-tampered");
    const cand = job.runs[0]!.candidates[0]!;
    await writeFile(path.join(jobRoot, "creator-tampered", cand.file), "tampered-candidate-bytes");
    await expect(reviewCreatorJob(jobRoot, "creator-tampered")).rejects.toThrow(
      /candidate.*(changed|identity)/i,
    );
  });

  test("renders hostile subjects and quote-bearing anchor paths as inert escaped HTML", async () => {
    const evilSubject = `nice pose</p><script>alert(\"pwned\")</script><img src=x onerror=alert(1)>`;
    const evilName = `an\"chor<img>.png`;
    await seedAnchors([evilName]);
    await runCreatorJob(jobRoot, "creator-hostile", {
      kind: "creator",
      subject: evilSubject,
      model: "nano-2",
      count: 1,
      refs: [await anchorRef(evilName)],
    }, distinctGen, fakeMatte);
    const review = await reviewCreatorJob(jobRoot, "creator-hostile");
    const html = await readFile(review.reviewPath, "utf8");
    // No executable markup survives: the raw payload never appears verbatim.
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("onerror=alert(1)>");
    expect(html).toContain("&lt;script&gt;");
    // The subject renders as text, escaped.
    expect(html).toContain(escapeHtml(evilSubject));
    // A restrictive CSP ships with the sheet.
    expect(html).toContain("Content-Security-Policy");
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
    await runCreatorJob(jobRoot, "creator-cli", baseRequest(["anchor-a.png"]), distinctGen, fakeMatte);
    const res = await cliRun(["review", "creator-cli"], {
      generate: distinctGen,
      generateObject: distinctGen,
      generateCreator: distinctGen,
      matte: fakeMatte,
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

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
