import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  runCreatorJob,
  rerunCreatorJob,
  loadJob,
  listJobs,
  adoptCandidate,
  validateCreatorRequest,
  type CreatorGenerator,
  type CreatorJobRequest,
  type JobGenerator,
} from "../src/jobs.js";
import { scanLibrary, writePlateAsset } from "../src/assets.js";
import { encodePng } from "./png.js";

let root: string;
let jobRoot: string;
let libraryRoot: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "thumby-creator-jobs-"));
  jobRoot = path.join(root, "jobs");
  libraryRoot = path.join(root, "library");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** True-alpha PNG: a 4×4 opaque red subject in a 16×16 transparent frame. */
const ALPHA_PNG = encodePng(16, 16, (x, y) =>
  x < 4 && y < 4 ? [255, 0, 0, 255] : [0, 0, 0, 0],
);

/** An opaque PNG — no alpha matte, the shape the adoption gate must refuse. */
const OPAQUE_PNG = encodePng(16, 16, () => [20, 90, 200, 255]);

let genCounter = 0;
const fakeGen: JobGenerator = async (req) => ({
  candidates: Array.from({ length: req.count }, () => ({
    // Distinct bytes per candidate; the suffix after IEND is ignored by the
    // PNG parser but gives every candidate its own content identity.
    bytes: Buffer.concat([ALPHA_PNG, Buffer.from(`-${genCounter++}`)]),
    mediaType: "image/png",
  })),
  warnings: [],
  fullPrompt: `CREATOR<${req.subject}>`,
});

const baseRequest = (): CreatorJobRequest => ({
  kind: "creator",
  subject: "arms crossed, explaining to camera",
  model: "nano-2",
  count: 2,
  refs: [
    { role: "identity", path: "anchor-a.png", contentHash: "a".repeat(64) },
    { role: "identity", path: "anchor-b.png", contentHash: "b".repeat(64) },
    { role: "pose", path: "pose.png", contentHash: "c".repeat(64) },
  ],
});

describe("validateCreatorRequest", () => {
  test("accepts typed identity, pose, expression, outfit, style, and edit roles", () => {
    expect(() =>
      validateCreatorRequest({
        ...baseRequest(),
        refs: [
          { role: "identity", path: "a.png", contentHash: "a".repeat(64) },
          { role: "expression", path: "e.png", contentHash: "b".repeat(64) },
          { role: "outfit", path: "o.png", contentHash: "c".repeat(64) },
          { role: "style", path: "s.png", contentHash: "d".repeat(64) },
          { role: "edit", path: "src.png", contentHash: "e".repeat(64) },
          { role: "pose", path: "p.png", contentHash: "f".repeat(64) },
        ],
      }),
    ).not.toThrow();
  });

  test("refuses a request with no identity anchor — never generate a likeness from text alone", async () => {
    await await_no_identity({ ...baseRequest(), refs: [] });
    await await_no_identity({
      ...baseRequest(),
      refs: [{ role: "pose", path: "p.png", contentHash: "c".repeat(64) }],
    });
  });

  async function await_no_identity(req: CreatorJobRequest) {
    let calls = 0;
    const spy: CreatorGenerator = async (r) => {
      calls++;
      return fakeGen(r);
    };
    await expect(runCreatorJob(jobRoot, "no-identity", req, spy)).rejects.toThrow(
      /identity|text alone/i,
    );
    expect(calls).toBe(0); // refused before any generation call
  }

  test("rejects roles outside the creator role set", () => {
    expect(() =>
      validateCreatorRequest({
        ...baseRequest(),
        refs: [
          { role: "identity", path: "a.png", contentHash: "a".repeat(64) },
          { role: "layout", path: "l.png", contentHash: "b".repeat(64) },
        ],
      }),
    ).toThrow(/layout|role/i);
  });

  test("rejects an empty subject", () => {
    expect(() => validateCreatorRequest({ ...baseRequest(), subject: "  " })).toThrow(
      /subject/i,
    );
  });
});

describe("runCreatorJob", () => {
  test("records a schemaVersion 3 creator job with its typed references", async () => {
    const job = await runCreatorJob(jobRoot, "creator-basic", baseRequest(), fakeGen);
    expect(job.kind).toBe("creator");
    expect(job.schemaVersion).toBe(3);
    expect(job.request.refs.map((r) => r.role)).toEqual(["identity", "identity", "pose"]);
    const record = JSON.parse(await readFile(path.join(jobRoot, "creator-basic", "job.json"), "utf8"));
    expect(record.schemaVersion).toBe(3);
    expect(record.kind).toBe("creator");
  });

  test("one request produces a best-of-N candidate set", async () => {
    const job = await runCreatorJob(jobRoot, "creator-n", { ...baseRequest(), count: 3 }, fakeGen);
    expect(job.runs[0]!.candidates).toHaveLength(3);
    const hashes = job.runs[0]!.candidates.map((c) => c.contentHash);
    expect(new Set(hashes).size).toBe(3);
  });

  test("refuses to create over an existing job id — rerun is the only way to add candidates", async () => {
    await runCreatorJob(jobRoot, "creator-dup", baseRequest(), fakeGen);
    await expect(runCreatorJob(jobRoot, "creator-dup", baseRequest(), fakeGen)).rejects.toThrow(
      /rerun|already exists/i,
    );
  });
});

describe("rerunCreatorJob", () => {
  test("appends a run under the lineage without touching prior candidates", async () => {
    // Rerun re-derives every reference's content identity, so the request's
    // ref paths must exist with the recorded bytes.
    const anchorA = path.join(root, "anchor-a.png");
    const anchorB = path.join(root, "anchor-b.png");
    const pose = path.join(root, "pose.png");
    await writeFile(anchorA, "anchor-a-bytes");
    await writeFile(anchorB, "anchor-b-bytes");
    await writeFile(pose, "pose-bytes");
    const sha = (s: string) => createHash("sha256").update(s).digest("hex");
    const req: CreatorJobRequest = {
      ...baseRequest(),
      refs: [
        { role: "identity", path: anchorA, contentHash: sha("anchor-a-bytes") },
        { role: "identity", path: anchorB, contentHash: sha("anchor-b-bytes") },
        { role: "pose", path: pose, contentHash: sha("pose-bytes") },
      ],
    };
    const first = await runCreatorJob(jobRoot, "creator-lineage", req, fakeGen);
    const second = await rerunCreatorJob(jobRoot, "creator-lineage", fakeGen);
    expect(second.runs).toHaveLength(2);
    expect(second.runs[0]).toEqual(first.runs[0]);
    const hashes = second.runs.flatMap((r) => r.candidates.map((c) => c.contentHash));
    expect(new Set(hashes).size).toBe(4);
  });
});

describe("loadJob record integrity for creator jobs", () => {
  test("rejects a v2 record claiming kind creator — the rollback boundary", async () => {
    await runCreatorJob(jobRoot, "creator-forged-v2", baseRequest(), fakeGen);
    const file = path.join(jobRoot, "creator-forged-v2", "job.json");
    const rec = JSON.parse(await readFile(file, "utf8"));
    rec.schemaVersion = 2; // what a 0.16-era binary would trust
    await writeFile(file, JSON.stringify(rec, null, 2));
    // Without the refusal, a 0.16.1 binary would adopt a creator job through
    // the plate path — bypassing the alpha gate entirely.
    await expect(loadJob(jobRoot, "creator-forged-v2")).rejects.toThrow(
      /schemaVersion 2|creator/i,
    );
    await expect(
      adoptCandidate(jobRoot, "creator-forged-v2", "0", "no-gate", { libraryRoot }),
    ).rejects.toThrow(/schemaVersion 2|creator/i);
  });
});

describe("adoptCandidate for creator jobs", () => {
  test("adopts a true-alpha candidate as a trial Cutout Asset with job provenance", async () => {
    const job = await runCreatorJob(jobRoot, "creator-adopt", baseRequest(), fakeGen);
    const cand = job.runs[0]!.candidates[0]!;

    const result = await adoptCandidate(jobRoot, "creator-adopt", cand.contentHash, "kenny-crossed", {
      libraryRoot,
      name: "Arms Crossed",
      tags: ["arms-crossed", "explaining"],
    });

    expect(result.adoptedFrom).toBe(`job:creator-adopt#${cand.contentHash}`);
    const lib = await scanLibrary(libraryRoot);
    const asset = lib.cutouts.find((c) => c.meta.id === "kenny-crossed")!;
    expect(asset).toBeDefined();
    expect(asset.hash).toBe(cand.contentHash);
    expect(asset.meta.kind).toBe("cutout");
    if (asset.meta.kind === "cutout") {
      // Trial is forced: adoption is never an approval (REQ-017, DEC-004).
      expect(asset.meta.approval).toBe("trial");
      expect(asset.meta.model).toBe("google/gemini-3.1-flash-image");
      expect(asset.meta.subject).toBe("arms crossed, explaining to camera");
      expect(asset.meta.fullPrompt).toBe("CREATOR<arms crossed, explaining to camera>");
      expect(asset.meta.adoptedFrom).toBe(`job:creator-adopt#${cand.contentHash}`);
    }
    expect(result.imagePath.endsWith(path.join("kenny-crossed", "cutout.png"))).toBe(true);
  });

  test("refuses an opaque candidate — the same true-alpha gate as objects", async () => {
    const opaqueGen: CreatorGenerator = async (req) => ({
      candidates: [{ bytes: OPAQUE_PNG, mediaType: "image/png" }],
      warnings: [],
      fullPrompt: `CREATOR<${req.subject}>`,
    });
    await runCreatorJob(jobRoot, "creator-opaque", { ...baseRequest(), count: 1 }, opaqueGen);
    const job = await loadJob(jobRoot, "creator-opaque");
    const hash = job.runs[0]!.candidates[0]!.contentHash;

    await expect(
      adoptCandidate(jobRoot, "creator-opaque", hash, "opaque-creator", { libraryRoot }),
    ).rejects.toThrow(/chroma-key|alpha/i);
    const lib = await scanLibrary(libraryRoot);
    expect(lib.cutouts).toHaveLength(0);
  });

  test("never overwrites an existing asset of any kind", async () => {
    await runCreatorJob(jobRoot, "creator-overwrite", baseRequest(), fakeGen);
    const job = await loadJob(jobRoot, "creator-overwrite");
    const [a, b] = job.runs[0]!.candidates;
    await adoptCandidate(jobRoot, "creator-overwrite", a!.contentHash, "taken", { libraryRoot });
    await expect(
      adoptCandidate(jobRoot, "creator-overwrite", b!.contentHash, "taken", { libraryRoot }),
    ).rejects.toThrow(/already exists/i);
  });

  test("adoption never writes or edits a Scene", async () => {
    await writePlateAsset(libraryRoot, "plate-a", new TextEncoder().encode("PLATE"), {
      kind: "plate", id: "plate-a", name: "Plate A", tags: [],
    });
    await runCreatorJob(jobRoot, "creator-scene", baseRequest(), fakeGen);
    const job = await loadJob(jobRoot, "creator-scene");
    const scenePath = path.join(root, "scene.json");
    await writeFile(scenePath, JSON.stringify({ schemaVersion: 1, layers: [] }));
    await adoptCandidate(jobRoot, "creator-scene", job.runs[0]!.candidates[0]!.contentHash, "kenny-trial", {
      libraryRoot,
    });
    // The scene file is byte-identical: adoption enters the library only.
    expect(await readFile(scenePath, "utf8")).toBe(
      JSON.stringify({ schemaVersion: 1, layers: [] }),
    );
  });
});

describe("listJobs with creator jobs", () => {
  test("summarizes creator jobs from one jobs root", async () => {
    await runCreatorJob(jobRoot, "creator-a", { ...baseRequest(), count: 1 }, fakeGen);
    const jobs = await listJobs(jobRoot);
    const a = jobs.find((j) => j.jobId === "creator-a")!;
    expect(a.kind).toBe("creator");
    expect(a.subject).toBe("arms crossed, explaining to camera");
    expect(a.candidates).toBe(1);
  });
});

// --- CLI ----------------------------------------------------------------------

import { run as cliRun } from "../src/job-cli.js";

let cliRoot: string;
let cliJobsRoot: string;
let cliLibraryRoot: string;

async function cliSetup(): Promise<void> {
  cliRoot = await mkdtemp(path.join(tmpdir(), "thumby-creator-cli-"));
  cliJobsRoot = path.join(cliRoot, "jobs");
  cliLibraryRoot = path.join(cliRoot, "library");
}

async function cliTeardown(): Promise<void> {
  await rm(cliRoot, { recursive: true, force: true });
}

function runCli(args: string[]) {
  return cliRun(args, {
    generate: fakeGen,
    generateObject: fakeGen,
    generateCreator: fakeGen,
    jobsRoot: cliJobsRoot,
    libraryRoot: cliLibraryRoot,
  });
}

describe("jobs creators (CLI)", () => {
  beforeEach(cliSetup);
  afterEach(cliTeardown);

  test("starts a creator job from typed references, defaulting to nano-2", async () => {
    const anchor = path.join(cliRoot, "anchor.png");
    const pose = path.join(cliRoot, "pose.png");
    await writeFile(anchor, "anchor-bytes");
    await writeFile(pose, "pose-bytes");
    const res = await runCli([
      "creators", "arms crossed, explaining to camera",
      "--ref", `identity:${anchor}`,
      "--ref", `pose:${pose}`,
      "--count", "3",
      "--job", "kenny-crossed",
    ]);
    expect(res.exitCode).toBe(0);
    const out = res.output as Record<string, any>;
    expect(out.ok).toBe(true);
    expect(out.kind).toBe("creator");
    const record = JSON.parse(await readFile(path.join(cliJobsRoot, "kenny-crossed", "job.json"), "utf8"));
    expect(record.request.model).toBe("nano-2");
    expect(record.request.refs.map((r: any) => r.role)).toEqual(["identity", "pose"]);
    expect(record.request.count).toBe(3);
  });

  test("honors an explicit --model even when it equals the plate default", async () => {
    const anchor = path.join(cliRoot, "anchor.png");
    await writeFile(anchor, "anchor-bytes");
    const res = await runCli([
      "creators", "arms crossed", "--ref", `identity:${anchor}`,
      "--job", "explicit-model", "--model", "gpt-image",
    ]);
    expect(res.exitCode).toBe(0);
    const record = JSON.parse(await readFile(path.join(cliJobsRoot, "explicit-model", "job.json"), "utf8"));
    // An explicit choice is never silently rewritten — the generation call
    // will refuse it (gpt-image cannot take anchors), which is the honest
    // failure, not a silent model swap.
    expect(record.request.model).toBe("gpt-image");
  });

  test("refuses a request without an identity anchor as a structured failure", async () => {
    const pose = path.join(cliRoot, "pose.png");
    await writeFile(pose, "pose-bytes");
    const res = await runCli(["creators", "arms crossed", "--ref", `pose:${pose}`]);
    expect(res.exitCode).toBe(1);
    const out = res.output as Record<string, any>;
    expect(out.ok).toBe(false);
    expect(JSON.stringify(out.errors)).toMatch(/identity|text alone/i);
  });

  test("adopt routes a creator job to the trial-cutout path", async () => {
    const anchor = path.join(cliRoot, "anchor.png");
    await writeFile(anchor, "anchor-bytes");
    await runCli(["creators", "arms crossed", "--ref", `identity:${anchor}`, "--job", "cli-adopt"]);
    const job = await loadJob(cliJobsRoot, "cli-adopt");
    const hash = job.runs[0]!.candidates[0]!.contentHash;
    const res = await runCli(["adopt", "cli-adopt", hash, "--id", "kenny-trial", "--tags", "arms-crossed"]);
    expect(res.exitCode).toBe(0);
    const lib = await scanLibrary(cliLibraryRoot);
    const cutout = lib.cutouts.find((c) => c.meta.id === "kenny-trial")!;
    expect(cutout).toBeDefined();
    if (cutout.meta.kind === "cutout") expect(cutout.meta.approval).toBe("trial");
  });
});
