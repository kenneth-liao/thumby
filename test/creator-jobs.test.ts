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
  type TypedRef,
} from "../src/jobs.js";
import { scanLibrary, writePlateAsset } from "../src/assets.js";
import { composeMatte, type MatteEngine } from "../src/matte.js";
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

/**
 * What the tested recipe actually returns: an opaque RGB figure on a plain
 * background (measured provider behavior). The fixtures model the
 * real default path, so the suite exercises generation *and* matting.
 */
const OPAQUE_PNG = encodePng(
  16,
  16,
  (x, y) => (x < 8 && y < 8 ? [200, 30, 40, 255] : [20, 90, 200, 255]),
  { colorType: 2 },
);

/** The segmentation mask the matting engine predicts for it. */
const MASK_PNG = encodePng(
  16,
  16,
  (x, y) => (x < 8 && y < 8 ? [255, 255, 255, 255] : [0, 0, 0, 255]),
  { colorType: 2 },
);

/** A candidate that already carries a real matte — the native-alpha route. */
const ALPHA_PNG = encodePng(16, 16, (x, y) =>
  x < 8 && y < 8 ? [255, 0, 0, 255] : [0, 0, 0, 0],
);

let genCounter = 0;
const fakeGen: JobGenerator = async (req) => ({
  candidates: Array.from({ length: req.count }, () => ({
    // Distinct bytes per candidate; the suffix after IEND is ignored by the
    // PNG parser but gives every candidate its own content identity.
    bytes: Buffer.concat([OPAQUE_PNG, Buffer.from(`-${genCounter++}`)]),
    mediaType: "image/png",
  })),
  warnings: [],
  fullPrompt: `CREATOR<${req.subject}>`,
});

/** The matting seam under test: a predicted mask applied by the real composer. */
const fakeMatte: MatteEngine = async ({ bytes, label }) => ({
  bytes: composeMatte(bytes, MASK_PNG, label),
  engine: "test/segmentation",
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
    await expect(runCreatorJob(jobRoot, "no-identity", req, spy, fakeMatte)).rejects.toThrow(
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
  test("records a schemaVersion 5 creator job with its ordered typed references", async () => {
    const job = await runCreatorJob(jobRoot, "creator-basic", baseRequest(), fakeGen, fakeMatte);
    expect(job.kind).toBe("creator");
    expect(job.schemaVersion).toBe(5);
    expect(job.request.refs.map((r) => r.role)).toEqual(["identity", "identity", "pose"]);
    const record = JSON.parse(await readFile(path.join(jobRoot, "creator-basic", "job.json"), "utf8"));
    expect(record.schemaVersion).toBe(5);
    expect(record.kind).toBe("creator");
  });

  test("one request produces a best-of-N candidate set", async () => {
    const job = await runCreatorJob(jobRoot, "creator-n", { ...baseRequest(), count: 3 }, fakeGen, fakeMatte);
    expect(job.runs[0]!.candidates).toHaveLength(3);
    const hashes = job.runs[0]!.candidates.map((c) => c.contentHash);
    expect(new Set(hashes).size).toBe(3);
  });

  test("refuses to create over an existing job id — rerun is the only way to add candidates", async () => {
    await runCreatorJob(jobRoot, "creator-dup", baseRequest(), fakeGen, fakeMatte);
    await expect(runCreatorJob(jobRoot, "creator-dup", baseRequest(), fakeGen, fakeMatte)).rejects.toThrow(
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
    const first = await runCreatorJob(jobRoot, "creator-lineage", req, fakeGen, fakeMatte);
    const second = await rerunCreatorJob(jobRoot, "creator-lineage", fakeGen, fakeMatte);
    expect(second.runs).toHaveLength(2);
    expect(second.runs[0]).toEqual(first.runs[0]);
    const hashes = second.runs.flatMap((r) => r.candidates.map((c) => c.contentHash));
    expect(new Set(hashes).size).toBe(4);
  });
});

describe("loadJob record integrity for creator jobs", () => {
  test("rejects a v2 record claiming kind creator — the rollback boundary", async () => {
    await runCreatorJob(jobRoot, "creator-forged-v2", baseRequest(), fakeGen, fakeMatte);
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

  test("rejects a v4 record claiming kind creator — v4 belongs to Plate/Object Jobs", async () => {
    // v4 is the role-aware-Reference prompt contract for Plate and Object
    // Jobs (#56, PROD-1); a Creator record under it has no contract.
    await runCreatorJob(jobRoot, "creator-forged-v4", baseRequest(), fakeGen, fakeMatte);
    const file = path.join(jobRoot, "creator-forged-v4", "job.json");
    const rec = JSON.parse(await readFile(file, "utf8"));
    rec.schemaVersion = 4;
    await writeFile(file, JSON.stringify(rec, null, 2));
    await expect(loadJob(jobRoot, "creator-forged-v4")).rejects.toThrow(/schemaVersion 4|creator/i);
    await expect(
      adoptCandidate(jobRoot, "creator-forged-v4", "0", "no-gate", { libraryRoot }),
    ).rejects.toThrow(/schemaVersion 4|creator/i);
  });
  test("upgrades a v3 creator rerun without changing its legacy provider order", async () => {
    const pose = path.join(root, "legacy-pose.png");
    const style = path.join(root, "legacy-style.png");
    const anchor = path.join(root, "legacy-anchor.png");
    await writeFile(pose, "pose-bytes");
    await writeFile(style, "style-bytes");
    await writeFile(anchor, "anchor-bytes");
    const hashed = (role: string, file: string, bytes: string): TypedRef => ({
      role,
      path: file,
      contentHash: createHash("sha256").update(bytes).digest("hex"),
    });
    const req: CreatorJobRequest = {
      ...baseRequest(),
      refs: [
        hashed("pose", pose, "pose-bytes"),
        hashed("style", style, "style-bytes"),
        hashed("identity", anchor, "anchor-bytes"),
      ],
    };
    await runCreatorJob(jobRoot, "creator-rerun-v3", req, fakeGen, fakeMatte);
    const file = path.join(jobRoot, "creator-rerun-v3", "job.json");
    const legacy = JSON.parse(await readFile(file, "utf8"));
    legacy.schemaVersion = 3;
    await writeFile(file, JSON.stringify(legacy, null, 2));

    let rerunRoles: string[] = [];
    const capture: CreatorGenerator = async (request) => {
      rerunRoles = request.refs.map((ref) => ref.role);
      return fakeGen(request);
    };
    await rerunCreatorJob(jobRoot, "creator-rerun-v3", capture, fakeMatte);

    const record = JSON.parse(await readFile(file, "utf8"));
    expect(rerunRoles).toEqual(["identity", "style", "pose"]);
    expect(record.schemaVersion).toBe(5);
    expect(record.request.refs.map((ref: TypedRef) => ref.role)).toEqual(rerunRoles);
    expect(record.runs).toHaveLength(2);
  });
});

describe("the matting pass (REQ-017)", () => {
  test("mattes every candidate of a run — the model's opaque output becomes adoptable", async () => {
    const job = await runCreatorJob(jobRoot, "creator-matted", { ...baseRequest(), count: 2 }, fakeGen, fakeMatte);
    const run = job.runs[0]!;
    expect(run.candidates).toHaveLength(2);
    for (const cand of run.candidates) {
      expect(cand.matte).toBeDefined();
      expect(cand.matte!.engine).toBe("test/segmentation");
      expect(cand.matte!.file.startsWith("mattes/")).toBe(true);
      // The recorded matte is on disk under its own content identity.
      const bytes = await readFile(path.join(jobRoot, "creator-matted", cand.matte!.file));
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(cand.matte!.contentHash);
      // The raw candidate is exactly what the model returned — opaque.
      expect(cand.contentHash).not.toBe(cand.matte!.contentHash);
    }
    // Matting is local and unbilled: the run's cost is generation only.
    expect(run.costUsd).toBeCloseTo(0.067 * 2, 6);
    expect(run.costMeasured).toBe(true);
  });

  test("keeps a natively isolated candidate's own bytes — no second model call", async () => {
    const nativeGen: CreatorGenerator = async (req) => ({
      candidates: [{ bytes: ALPHA_PNG, mediaType: "image/png" }],
      warnings: [],
      fullPrompt: `CREATOR<${req.subject}>`,
    });
    let engineCalls = 0;
    const spyMatte: MatteEngine = async (input) => {
      engineCalls++;
      return fakeMatte(input);
    };
    const job = await runCreatorJob(jobRoot, "creator-native", { ...baseRequest(), count: 1 }, nativeGen, spyMatte);
    const cand = job.runs[0]!.candidates[0]!;
    expect(engineCalls).toBe(0);
    expect(cand.matte!.engine).toBe("native-alpha");
    expect(cand.matte!.contentHash).toBe(cand.contentHash);
  });

  test("records why a candidate could not be isolated instead of discarding the run", async () => {
    const brokenMatte: MatteEngine = async () => {
      throw new Error("mask model returned no image");
    };
    const job = await runCreatorJob(jobRoot, "creator-nomatte", { ...baseRequest(), count: 1 }, fakeGen, brokenMatte);
    const cand = job.runs[0]!.candidates[0]!;
    expect(cand.matte).toBeUndefined();
    expect(job.runs[0]!.warnings.join("\n")).toMatch(/matte:.*could not be isolated/i);
  });

  test("a failed matting attempt costs the run nothing — the pass is local (RE-2)", async () => {
    // Nothing about matting is billed, so there is no spend for a failure to
    // lose and no unmeasured part to hide: the whole class of bug is gone.
    const failing: MatteEngine = async () => {
      throw new Error("the local matting model is unusable: the weights file is not there");
    };
    const job = await runCreatorJob(jobRoot, "creator-local-fail", { ...baseRequest(), count: 1 }, fakeGen, failing);
    const run = job.runs[0]!;
    expect(run.candidates[0]!.matte).toBeUndefined();
    expect(run.costUsd).toBeCloseTo(0.067, 6);
    expect(run.costMeasured).toBe(true);
    // The fix-it message reaches the run record, not just a console somewhere.
    expect(run.warnings.join("\n")).toMatch(/weights file is not there/i);
  });
});

describe("the matting pass runs its preflight before anything is paid for (RE-3)", () => {
  /** An engine whose prerequisite is missing — the shipped one's weights. */
  const notReady = (): MatteEngine =>
    Object.assign(
      // A fresh function per call: attaching the hook to the shared fake
      // would leak the failure into every other test in this file.
      (input: { bytes: Uint8Array; label: string }) => fakeMatte(input),
      {
        preflight: async () => {
          throw new Error(
            "The local matting model is unusable: the weights file is not there\n\nExpected: models/birefnet-hr-fp16.onnx",
          );
        },
      },
    );

  test("a new creator job never calls the generator when the pass cannot run", async () => {
    let generated = 0;
    const spy: CreatorGenerator = async (req) => {
      generated++;
      return fakeGen(req);
    };
    await expect(
      runCreatorJob(jobRoot, "creator-preflight", baseRequest(), spy, notReady()),
    ).rejects.toThrow(/weights file is not there/i);
    // The paid call never happened, and no job record was left behind.
    expect(generated).toBe(0);
    await expect(loadJob(jobRoot, "creator-preflight")).rejects.toThrow(/No generation job/i);
  });

  test("a rerun is held to the same rule — it pays for candidates too", async () => {
    const anchor = path.join(root, "anchor-a.png");
    await writeFile(anchor, "anchor-a-bytes");
    const req: CreatorJobRequest = {
      ...baseRequest(),
      count: 1,
      refs: [
        {
          role: "identity",
          path: anchor,
          contentHash: createHash("sha256").update("anchor-a-bytes").digest("hex"),
        },
      ],
    };
    const job = await runCreatorJob(jobRoot, "creator-preflight-rerun", req, fakeGen, fakeMatte);
    expect(job.runs).toHaveLength(1);

    let generated = 0;
    const spy: CreatorGenerator = async (r) => {
      generated++;
      return fakeGen(r);
    };
    await expect(
      rerunCreatorJob(jobRoot, "creator-preflight-rerun", spy, notReady()),
    ).rejects.toThrow(/weights file is not there/i);
    expect(generated).toBe(0);
    // The lineage is untouched: no half-run appended.
    expect((await loadJob(jobRoot, "creator-preflight-rerun")).runs).toHaveLength(1);
  });

  test("an engine with nothing to check needs no preflight", async () => {
    // fakeMatte is a plain function — the seam must not require the hook.
    expect((fakeMatte as MatteEngine).preflight).toBeUndefined();
    const job = await runCreatorJob(jobRoot, "creator-no-preflight", { ...baseRequest(), count: 1 }, fakeGen, fakeMatte);
    expect(job.runs[0]!.candidates[0]!.matte).toBeDefined();
  });
});

describe("adoptCandidate for creator jobs", () => {
  test("adopts the candidate's matte as a trial Cutout Asset with job and matte provenance", async () => {
    const job = await runCreatorJob(jobRoot, "creator-adopt", baseRequest(), fakeGen, fakeMatte);
    const cand = job.runs[0]!.candidates[0]!;

    const result = await adoptCandidate(jobRoot, "creator-adopt", cand.contentHash, "creator-crossed", {
      libraryRoot,
      name: "Arms Crossed",
      tags: ["arms-crossed", "explaining"],
    });

    expect(result.adoptedFrom).toBe(`job:creator-adopt#${cand.contentHash}`);
    const lib = await scanLibrary(libraryRoot);
    const asset = lib.cutouts.find((c) => c.meta.id === "creator-crossed")!;
    expect(asset).toBeDefined();
    // The Asset's bytes are the matte — the isolated form, not the opaque
    // candidate — and the candidate it came from stays in the provenance.
    expect(asset.hash).toBe(cand.matte!.contentHash);
    expect(asset.meta.kind).toBe("cutout");
    if (asset.meta.kind === "cutout") {
      // Trial is forced: adoption is never an approval (REQ-017, DEC-004).
      expect(asset.meta.approval).toBe("trial");
      expect(asset.meta.model).toBe("google/gemini-3.1-flash-image");
      expect(asset.meta.subject).toBe("arms crossed, explaining to camera");
      expect(asset.meta.fullPrompt).toBe("CREATOR<arms crossed, explaining to camera>");
      expect(asset.meta.adoptedFrom).toBe(`job:creator-adopt#${cand.contentHash}`);
      expect(asset.meta.matting).toBe("true-alpha");
      expect(asset.meta.matteEngine).toBe("test/segmentation");
      // No content identity is stored in meta — it is derived from the bytes
      // at scan time (ADR-0002); the lineage lives in adoptedFrom alone.
      expect(JSON.stringify(asset.meta)).not.toContain(cand.matte!.contentHash);
      expect(Object.keys(asset.meta)).not.toContain("matteHash");
    }
    // The reported identity is the Asset's own — the bytes that were written,
    // which for a creator adoption are the matte's, not the candidate's (RE-1).
    expect(result.contentHash).toBe(cand.matte!.contentHash);
    expect(result.contentHash).toBe(asset.hash);
    expect(result.contentHash).not.toBe(cand.contentHash);
    expect(result.imagePath.endsWith(path.join("creator-crossed", "cutout.png"))).toBe(true);
  });

  test("refuses a candidate the matting pass could not isolate — never the opaque bytes", async () => {
    const brokenMatte: MatteEngine = async () => {
      throw new Error("mask model returned no image");
    };
    await runCreatorJob(jobRoot, "creator-opaque", { ...baseRequest(), count: 1 }, fakeGen, brokenMatte);
    const job = await loadJob(jobRoot, "creator-opaque");
    const hash = job.runs[0]!.candidates[0]!.contentHash;

    await expect(
      adoptCandidate(jobRoot, "creator-opaque", hash, "opaque-creator", { libraryRoot }),
    ).rejects.toThrow(/no matte/i);
    const lib = await scanLibrary(libraryRoot);
    expect(lib.cutouts).toHaveLength(0);
  });

  test("refuses a tampered matte — the adopted bytes must match the record", async () => {
    const job = await runCreatorJob(jobRoot, "creator-tamper", { ...baseRequest(), count: 1 }, fakeGen, fakeMatte);
    const cand = job.runs[0]!.candidates[0]!;
    await writeFile(path.join(jobRoot, "creator-tamper", cand.matte!.file), ALPHA_PNG);

    await expect(
      adoptCandidate(jobRoot, "creator-tamper", cand.contentHash, "tampered", { libraryRoot }),
    ).rejects.toThrow(/no longer matches its recorded identity/i);
    expect((await scanLibrary(libraryRoot)).cutouts).toHaveLength(0);
  });

  test("refuses a matte that does not carry true alpha — the gate holds independently", async () => {
    // A hand-edited record pointing the matte at opaque bytes: the pass's own
    // verification is bypassed, and the adoption gate must still refuse.
    const job = await runCreatorJob(jobRoot, "creator-forged-matte", { ...baseRequest(), count: 1 }, fakeGen, fakeMatte);
    const cand = job.runs[0]!.candidates[0]!;
    const file = path.join(jobRoot, "creator-forged-matte", "job.json");
    const rec = JSON.parse(await readFile(file, "utf8"));
    rec.runs[0].candidates[0].matte = {
      file: cand.file,
      contentHash: cand.contentHash,
      engine: "forged",
    };
    await writeFile(file, JSON.stringify(rec, null, 2));

    await expect(
      adoptCandidate(jobRoot, "creator-forged-matte", cand.contentHash, "forged", { libraryRoot }),
    ).rejects.toThrow(/chroma-key|alpha/i);
    expect((await scanLibrary(libraryRoot)).cutouts).toHaveLength(0);
  });

  test("never overwrites an existing asset of any kind", async () => {
    await runCreatorJob(jobRoot, "creator-overwrite", baseRequest(), fakeGen, fakeMatte);
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
    await runCreatorJob(jobRoot, "creator-scene", baseRequest(), fakeGen, fakeMatte);
    const job = await loadJob(jobRoot, "creator-scene");
    const scenePath = path.join(root, "scene.json");
    await writeFile(scenePath, JSON.stringify({ schemaVersion: 1, layers: [] }));
    await adoptCandidate(jobRoot, "creator-scene", job.runs[0]!.candidates[0]!.contentHash, "creator-trial", {
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
    await runCreatorJob(jobRoot, "creator-a", { ...baseRequest(), count: 1 }, fakeGen, fakeMatte);
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
    matte: fakeMatte,
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
      "--job", "creator-crossed",
    ]);
    expect(res.exitCode).toBe(0);
    const out = res.output as Record<string, any>;
    expect(out.ok).toBe(true);
    expect(out.kind).toBe("creator");
    const record = JSON.parse(await readFile(path.join(cliJobsRoot, "creator-crossed", "job.json"), "utf8"));
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
    // An explicit choice is never silently rewritten. gpt-image is qualified
    // for typed References (#52), so the job runs; its likeness strength is
    // not qualified, which is guidance, not a gate. A capability-incompatible
    // model is refused before any spend (see model-selection.test.ts).
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

  test("reports missing matting weights as a structured failure, before any generation", async () => {
    const anchor = path.join(cliRoot, "anchor.png");
    await writeFile(anchor, "anchor-bytes");
    let generated = 0;
    const spy: CreatorGenerator = async (req) => {
      generated++;
      return fakeGen(req);
    };
    const res = await cliRun(
      ["creators", "arms crossed", "--ref", `identity:${anchor}`, "--job", "cli-no-weights"],
      {
        generate: fakeGen,
        generateObject: fakeGen,
        generateCreator: spy,
        matte: Object.assign((input: { bytes: Uint8Array; label: string }) => fakeMatte(input), {
          preflight: async () => {
            throw new Error("The local matting model is unusable: the weights file is not there");
          },
        }),
        jobsRoot: cliJobsRoot,
        libraryRoot: cliLibraryRoot,
      },
    );
    expect(res.exitCode).toBe(1);
    const out = res.output as Record<string, any>;
    expect(out.ok).toBe(false);
    expect(JSON.stringify(out.errors)).toMatch(/weights file is not there/i);
    expect(generated).toBe(0);
  });

  test("adopt routes a creator job to the trial-cutout path", async () => {
    const anchor = path.join(cliRoot, "anchor.png");
    await writeFile(anchor, "anchor-bytes");
    await runCli(["creators", "arms crossed", "--ref", `identity:${anchor}`, "--job", "cli-adopt"]);
    const job = await loadJob(cliJobsRoot, "cli-adopt");
    const hash = job.runs[0]!.candidates[0]!.contentHash;
    const res = await runCli(["adopt", "cli-adopt", hash, "--id", "creator-trial", "--tags", "arms-crossed"]);
    expect(res.exitCode).toBe(0);
    const lib = await scanLibrary(cliLibraryRoot);
    const cutout = lib.cutouts.find((c) => c.meta.id === "creator-trial")!;
    expect(cutout).toBeDefined();
    if (cutout.meta.kind === "cutout") expect(cutout.meta.approval).toBe("trial");
  });
});
