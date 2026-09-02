import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, readFile, mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  runPlateJob,
  runObjectJob,
  loadJob,
  adoptCandidate,
  type JobGenerator,
  type PlateJobRequest,
  type ObjectJobRequest,
  type PlateGenerator,
} from "../src/jobs.js";
import { reviewJob } from "../src/review.js";
import { run as cliRun } from "../src/job-cli.js";
import { composeMatte, type MatteEngine } from "../src/matte.js";
import { encodePng } from "./png.js";

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

let root: string;
let jobRoot: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "thumby-job-review-"));
  jobRoot = path.join(root, "jobs");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** True-alpha PNG: a 4×4 opaque red subject in a 16×16 transparent frame. */
const ALPHA_PNG = encodePng(16, 16, (x, y) =>
  x < 4 && y < 4 ? [255, 0, 0, 255] : [0, 0, 0, 0],
);

/** The measured reality: an opaque candidate whose backdrop is painted pixels. */
const OPAQUE_PNG = encodePng(
  16,
  16,
  (x, y) => (x < 8 && y < 8 ? [230, 120, 80, 255] : [20, 90, 200, 255]),
  { colorType: 2 },
);

/** The segmentation mask the matting engine predicts for it. */
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

const brokenMatte: MatteEngine = async () => {
  throw new Error("mask model returned no image");
};

let genCounter = 0;
/** Two distinct opaque candidates per call — every hash is genuine evidence. */
const distinctOpaqueGen: JobGenerator = async (req) => ({
  candidates: Array.from({ length: req.count }, () => ({
    bytes: Buffer.concat([OPAQUE_PNG, Buffer.from(`-${genCounter++}`)]),
    mediaType: "image/png",
  })),
  warnings: [],
  fullPrompt: `GEN<${req.subject}>`,
});

const plateGen: PlateGenerator = distinctOpaqueGen as PlateGenerator;

const plateRequest = (count = 2): PlateJobRequest => ({
  kind: "plate",
  subject: "neon server room",
  zone: "left",
  model: "gpt-image",
  count,
  refs: [],
});

const objectRequest = (count = 1): Parameters<typeof runObjectJob>[2] => ({
  kind: "object",
  subject: "a retro desk lamp",
  model: "gpt-image",
  count,
  refs: [],
});

/** sha-256 of every base64 image embedded in an HTML string. */
const embeddedHashes = (html: string): string[] =>
  [...html.matchAll(/data:[^;"]+;base64,([A-Za-z0-9+/=]+)/g)].map((m) =>
    sha256(Buffer.from(m[1]!, "base64")),
  );

describe("reviewJob — plate", () => {
  test("shows every distinct candidate at full size and 168px, with nothing creator-specific", async () => {
    await runPlateJob(jobRoot, "plate-rev", plateRequest(), plateGen);
    const result = await reviewJob(jobRoot, "plate-rev");

    expect(result.kind).toBe("plate");
    expect(result.candidates).toHaveLength(2);
    expect(result.anchors).toEqual([]);

    const html = await readFile(result.reviewPath, "utf8");
    for (const cand of result.candidates) expect(html).toContain(cand.contentHash.slice(0, 12));
    // Full size: one natural-width figure per candidate in a scrollable
    // container — true 1:1, never downscaled to fit.
    expect(html.match(/class="fullwrap"/g)).toHaveLength(2);
    // Thumbnail size: exactly one 168px figure per distinct candidate.
    expect(html.match(/class="thumb"/g)).toHaveLength(2);
    expect(html).toContain("168px");
    // The displayed bytes are the verified bytes: every embedded image decodes
    // to a recorded candidate identity.
    const embedded = embeddedHashes(html);
    for (const cand of result.candidates) expect(embedded).toContain(cand.contentHash);
    // Nothing creator-specific: plates have no anchors, mattes, or face views.
    expect(html).not.toMatch(/face detail/i);
    expect(html).not.toMatch(/isolation/i);
  });

  test("the artifact stays static and offline: embedded evidence only, and no Scene, Asset, or job record is touched", async () => {
    await runPlateJob(jobRoot, "plate-static", plateRequest(), plateGen);
    const recordBefore = await readFile(path.join(jobRoot, "plate-static", "job.json"));

    const result = await reviewJob(jobRoot, "plate-static");
    const html = await readFile(result.reviewPath, "utf8");
    // The CSP allows embedded evidence only — no file:, no remote.
    expect(html).toContain("img-src data:");
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toContain("file:");
    expect(html).not.toContain("<script");
    // Review writes one file — the sheet beside the record — and nothing else.
    expect(await readFile(path.join(jobRoot, "plate-static", "job.json"))).toEqual(recordBefore);
  });

  test("the saved sheet is self-contained: later mutation or deletion of source files cannot alter or break it", async () => {
    await runPlateJob(jobRoot, "plate-frozen", plateRequest(1), plateGen);
    const result = await reviewJob(jobRoot, "plate-frozen");
    const sheetBefore = await readFile(result.reviewPath);

    const cand = result.candidates[0]!;
    await rm(path.join(jobRoot, "plate-frozen", cand.file));

    const sheetAfter = await readFile(result.reviewPath);
    expect(Buffer.compare(sheetBefore, sheetAfter)).toBe(0);
    // The evidence it displays is still the verified bytes, decodable from the
    // sheet alone.
    expect(embeddedHashes(sheetAfter.toString("utf8"))).toContain(cand.contentHash);
  });

  test("a failed later review produces no new output — the prior sheet stands as its point-in-time evidence", async () => {
    await runPlateJob(jobRoot, "plate-stale", plateRequest(1), plateGen);
    const result = await reviewJob(jobRoot, "plate-stale");
    const sheetBefore = await readFile(result.reviewPath);
    // The sheet stamps when its evidence was verified.
    expect(sheetBefore.toString("utf8")).toMatch(/reviewed \d{4}-\d{2}-\d{2}/);

    const cand = result.candidates[0]!;
    await writeFile(path.join(jobRoot, "plate-stale", cand.file), "tampered-after-review");
    await expect(reviewJob(jobRoot, "plate-stale")).rejects.toThrow(/identity|matches/i);
    // Nothing new was written; the earlier verified sheet is left untouched.
    expect(Buffer.compare(sheetBefore, await readFile(result.reviewPath))).toBe(0);
  });

  test("a failed sheet replacement leaves the prior sheet intact and no temp files behind", async () => {
    await runPlateJob(jobRoot, "plate-atomic", plateRequest(1), plateGen);
    const first = await reviewJob(jobRoot, "plate-atomic");
    const sheetBefore = await readFile(first.reviewPath);

    // The fault-injection seam (the reference-import writeScene precedent):
    // production always performs the real atomic replace; a rejecting seam is
    // the deterministic way to prove the failure branch.
    await expect(
      reviewJob(jobRoot, "plate-atomic", {
        replaceArtifact: () => Promise.reject(new Error("injected replacement failure")),
      }),
    ).rejects.toThrow(/injected replacement failure/);
    // The prior sheet is byte-identical — never truncated or partially replaced.
    expect(Buffer.compare(sheetBefore, await readFile(first.reviewPath))).toBe(0);
    // The replacement left no temp files in the job directory.
    const entries = await readdir(path.join(jobRoot, "plate-atomic"));
    expect(entries.some((e) => e.includes(".tmp-"))).toBe(false);
    expect(entries).toContain("review.html");
  });

  test("fails loudly on a tampered candidate and writes no partial review", async () => {
    await runPlateJob(jobRoot, "plate-tampered", plateRequest(1), plateGen);
    const job = await loadJob(jobRoot, "plate-tampered");
    const cand = job.runs[0]!.candidates[0]!;
    await writeFile(path.join(jobRoot, "plate-tampered", cand.file), "tampered-candidate-bytes");

    await expect(reviewJob(jobRoot, "plate-tampered")).rejects.toThrow(
      /candidate.*(identity|matches)/i,
    );
    expect(existsSync(path.join(jobRoot, "plate-tampered", "review.html"))).toBe(false);
  });

  test("fails loudly on a missing candidate file", async () => {
    await runPlateJob(jobRoot, "plate-missing", plateRequest(1), plateGen);
    const job = await loadJob(jobRoot, "plate-missing");
    await rm(path.join(jobRoot, "plate-missing", job.runs[0]!.candidates[0]!.file));

    await expect(reviewJob(jobRoot, "plate-missing")).rejects.toThrow(/missing/i);
    expect(existsSync(path.join(jobRoot, "plate-missing", "review.html"))).toBe(false);
  });
});

describe("reviewJob — object", () => {
  test("shows the matte adoption would use, per candidate, and names the engine", async () => {
    await runObjectJob(jobRoot, "obj-matted", objectRequest(1), distinctOpaqueGen, fakeMatte);
    const job = await loadJob(jobRoot, "obj-matted");
    const cand = job.runs[0]!.candidates[0]!;

    const result = await reviewJob(jobRoot, "obj-matted");
    expect(result.kind).toBe("object");
    const adoption = result.candidates[0]!.adoption;
    if (adoption.from !== "matte") throw new Error("expected the matte adoption would use");
    expect(adoption.file).toBe(cand.matte!.file);
    expect(adoption.engine).toBe("test/segmentation");

    const html = await readFile(result.reviewPath, "utf8");
    expect(html).toMatch(/isolation/i);
    // The displayed matte is the verified matte: its embedded bytes decode to
    // the recorded content identity — not merely some file reference.
    expect(embeddedHashes(html)).toContain(cand.matte!.contentHash);
    expect(html).toContain("matte via test/segmentation");
    // Candidates appear in both evidence sizes as well.
    expect(html.match(/class="thumb"/g)).toHaveLength(1);
  });

  test("clearly marks an object candidate without an adoptable matte", async () => {
    await runObjectJob(jobRoot, "obj-opaque-rev", objectRequest(1), distinctOpaqueGen, brokenMatte);
    const result = await reviewJob(jobRoot, "obj-opaque-rev");
    const adoption = result.candidates[0]!.adoption;
    expect(adoption.from).toBe("none");
    if (adoption.from !== "none") throw new Error("unreachable");
    expect(adoption.cause).toBe("no-matte");

    const html = await readFile(result.reviewPath, "utf8");
    expect(html).toContain("no matte — not adoptable");
  });

  test("labels a matching-hash recorded matte that fails the true-alpha gate as invalid — with its refusal reason — never as missing", async () => {
    await runObjectJob(jobRoot, "obj-invalid-matte", objectRequest(1), distinctOpaqueGen, fakeMatte);
    const cand = (await loadJob(jobRoot, "obj-invalid-matte")).runs[0]!.candidates[0]!;
    // Point the recorded matte at the candidate's own opaque bytes: the hash
    // matches the record, so this is not tampering — the matte is present but
    // invalid, and the sheet must say precisely that.
    const file = path.join(jobRoot, "obj-invalid-matte", "job.json");
    const rec = JSON.parse(await readFile(file, "utf8"));
    rec.runs[0].candidates[0].matte = { file: cand.file, contentHash: cand.contentHash, engine: "forged" };
    await writeFile(file, JSON.stringify(rec, null, 2));

    const result = await reviewJob(jobRoot, "obj-invalid-matte");
    const adoption = result.candidates[0]!.adoption;
    expect(adoption.from).toBe("none");
    if (adoption.from !== "none") throw new Error("unreachable");
    expect(adoption.cause).toBe("invalid-matte");
    expect(adoption.reason).toMatch(/cannot qualify/);

    const html = await readFile(result.reviewPath, "utf8");
    expect(html).toContain("invalid matte — not adoptable");
    expect(html).not.toContain("no matte — not adoptable");
    expect(html).toContain("cannot qualify");

    // No drift: adoption of the same record refuses with the same recorded
    // gate reason.
    await expect(
      adoptCandidate(jobRoot, "obj-invalid-matte", cand.contentHash, "forged-lamp", {
        libraryRoot: path.join(root, "library"),
      }),
    ).rejects.toThrow(/chroma-key|alpha/i);
  });

  test("a hostile matte path inside the invalid-matte refusal renders as inert escaped HTML", async () => {
    await runObjectJob(jobRoot, "obj-hostile-matte", objectRequest(1), distinctOpaqueGen, fakeMatte);
    const cand = (await loadJob(jobRoot, "obj-hostile-matte")).runs[0]!.candidates[0]!;
    const evil = `mattes/evil"\u003cimg src=x onerror=alert(1)\u003e.png`;
    await writeFile(path.join(jobRoot, "obj-hostile-matte", evil), OPAQUE_PNG);
    const file = path.join(jobRoot, "obj-hostile-matte", "job.json");
    const rec = JSON.parse(await readFile(file, "utf8"));
    rec.runs[0].candidates[0].matte = { file: evil, contentHash: sha256(OPAQUE_PNG), engine: "forged" };
    await writeFile(file, JSON.stringify(rec, null, 2));

    const result = await reviewJob(jobRoot, "obj-hostile-matte");
    const adoption = result.candidates[0]!.adoption;
    expect(adoption.from).toBe("none");
    if (adoption.from !== "none") throw new Error("unreachable");
    expect(adoption.cause).toBe("invalid-matte");

    const html = await readFile(result.reviewPath, "utf8");
    // The refusal reason (which names the hostile path) is text, not markup:
    // nothing executable survives, and the escaped form is what renders.
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("onerror=alert(1)>");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("invalid matte — not adoptable");
  });

  test("marks a natively isolated object candidate as adoptable as-is — the same bytes adoption writes", async () => {
    // The defensive native route through a hand-built record: one object
    // candidate, no recorded matte, true-alpha bytes on disk. Review and
    // adoption must agree through the same resolver — no drift.
    const bytes = ALPHA_PNG;
    const hash = sha256(bytes);
    const file = path.join("candidates", `${hash}.png`);
    const dir = path.join(jobRoot, "obj-native-rev");
    await mkdir(path.join(dir, "candidates"), { recursive: true });
    await writeFile(path.join(dir, file), bytes);
    const record = {
      schemaVersion: 4,
      jobId: "obj-native-rev",
      kind: "object",
      createdAt: "2026-09-02T00:00:00.000Z",
      request: { kind: "object", subject: "a retro desk lamp", model: "gpt-image", count: 1, refs: [] },
      runs: [
        {
          ranAt: "2026-09-02T00:00:00.000Z",
          model: "openai/gpt-image-2",
          fullPrompt: "p",
          costUsd: null,
          costMeasured: false,
          warnings: [],
          candidates: [{ contentHash: hash, file, mediaType: "image/png" }],
        },
      ],
    };
    await writeFile(path.join(dir, "job.json"), JSON.stringify(record, null, 2) + "\n");

    const result = await reviewJob(jobRoot, "obj-native-rev");
    const adoption = result.candidates[0]!.adoption;
    if (adoption.from !== "candidate") throw new Error("expected the native-alpha route");
    expect(adoption.file).toBe(file);

    const html = await readFile(result.reviewPath, "utf8");
    expect(html).toContain("natively isolated — adoption writes these bytes as-is");
    // The displayed adoptable bytes are the candidate's own verified bytes.
    expect(embeddedHashes(html)).toContain(hash);

    // No drift: adoption of the same record writes exactly these bytes under
    // the candidate's identity.
    const adopted = await adoptCandidate(jobRoot, "obj-native-rev", hash, "native-lamp", {
      libraryRoot: path.join(root, "library"),
    });
    expect(adopted.contentHash).toBe(hash);
  });

  test("fails loudly when a recorded matte file no longer matches its identity", async () => {
    await runObjectJob(jobRoot, "obj-matte-tampered", objectRequest(1), distinctOpaqueGen, fakeMatte);
    const cand = (await loadJob(jobRoot, "obj-matte-tampered")).runs[0]!.candidates[0]!;
    await writeFile(path.join(jobRoot, "obj-matte-tampered", cand.matte!.file), ALPHA_PNG);

    await expect(reviewJob(jobRoot, "obj-matte-tampered")).rejects.toThrow(
      /matte.*(identity|matches)/i,
    );
    expect(existsSync(path.join(jobRoot, "obj-matte-tampered", "review.html"))).toBe(false);
  });
});

describe("jobs review — CLI", () => {
  const deps = {
    generate: plateGen,
    generateObject: distinctOpaqueGen,
    generateCreator: distinctOpaqueGen,
    matte: fakeMatte,
    jobsRoot: "",
  };

  test("reviews a plate job: kind, review path, and adoptable candidates", async () => {
    deps.jobsRoot = jobRoot;
    await runPlateJob(jobRoot, "plate-cli", plateRequest(1), plateGen);
    const res = await cliRun(["review", "plate-cli"], deps);
    expect(res.exitCode).toBe(0);
    const out = res.output as Record<string, any>;
    expect(out.ok).toBe(true);
    expect(out.kind).toBe("plate");
    expect(out.review).toBe(path.join(jobRoot, "plate-cli", "review.html"));
    expect(out.candidates[0]!.adoptable).toBe(true);
    expect(out.anchors).toEqual([]);
  });

  test("reports an object candidate without an adoptable matte as not adoptable", async () => {
    deps.jobsRoot = jobRoot;
    await runObjectJob(jobRoot, "obj-cli-opaque", objectRequest(1), distinctOpaqueGen, brokenMatte);
    const res = await cliRun(["review", "obj-cli-opaque"], deps);
    expect(res.exitCode).toBe(0);
    const out = res.output as Record<string, any>;
    expect(out.kind).toBe("object");
    expect(out.candidates[0]!.adoptable).toBe(false);
  });
});