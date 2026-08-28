import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, readFile, readdir, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  runPlateJob,
  rerunPlateJob,
  loadJob,
  listJobs,
  adoptCandidate,
  parseTypedRef,
  type PlateGenerator,
  type PlateJobRequest,
} from "../src/jobs.js";
import { scanLibrary } from "../src/assets.js";

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

let root: string;
let jobRoot: string;
let libraryRoot: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "thumby-jobs-"));
  jobRoot = path.join(root, "jobs");
  libraryRoot = path.join(root, "library");
  await mkdir(libraryRoot, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Distinct bytes per call so every candidate has a unique content identity. */
let genCounter = 0;
const fakeGen: PlateGenerator = async (req) => ({
  plates: Array.from({ length: req.count }, (_, i) => ({
    bytes: Buffer.from(`fake-${req.subject}-${req.zone}-${genCounter++}-${i}`),
    mediaType: "image/png",
  })),
  warnings: ["gpt-image: unsupported setting"],
  fullPrompt: `PROMPT<${req.subject} zone=${req.zone}>`,
});

const baseRequest = (): PlateJobRequest => ({
  kind: "plate",
  subject: "neon server room",
  zone: "left",
  model: "gpt-image",
  count: 2,
  refs: [],
});

describe("parseTypedRef", () => {
  test("parses role:path and derives the content identity from the bytes", async () => {
    const bytes = Buffer.from("reference-image-bytes");
    const file = path.join(root, "style-ref.png");
    await writeFile(file, bytes);
    const ref = await parseTypedRef(`style:${file}`);
    expect(ref.role).toBe("style");
    expect(ref.path).toBe(file);
    expect(ref.contentHash).toBe(sha256(bytes));
  });

  test("rejects untyped or malformed refs", () => {
    expect(parseTypedRef("just-a-path.png")).rejects.toThrow(/role.*path/);
    expect(parseTypedRef(":path.png")).rejects.toThrow(/role/);
    expect(parseTypedRef("Bad Role:path.png")).rejects.toThrow(/role/);
  });
});

describe("runPlateJob", () => {
  test("creates a job record with model, full effective prompt, typed refs, cost, warnings, and candidates", async () => {
    const bytes = Buffer.from("style-ref-bytes");
    const refFile = path.join(root, "style.png");
    await writeFile(refFile, bytes);
    const ref = await parseTypedRef(`style:${refFile}`);

    const request = { ...baseRequest(), refs: [ref] };
    const job = await runPlateJob(jobRoot, "plate-test-1", request, fakeGen);

    expect(job.schemaVersion).toBe(1);
    expect(job.jobId).toBe("plate-test-1");
    expect(job.kind).toBe("plate");
    expect(job.request).toEqual(request);
    expect(job.runs).toHaveLength(1);

    const run = job.runs[0]!;
    expect(run.fullPrompt).toBe("PROMPT<neon server room zone=left>");
    expect(run.model).toBe("openai/gpt-image-2");
    // gpt-image: approxCost 0.0045, measured — 2 plates.
    expect(run.costUsd).toBeCloseTo(0.009, 6);
    expect(run.costMeasured).toBe(true);
    expect(run.warnings).toEqual(["gpt-image: unsupported setting"]);
    expect(run.candidates).toHaveLength(2);

    // Candidates are content-addressed on disk with matching identities.
    for (const cand of run.candidates) {
      const stored = await readFile(path.join(jobRoot, "plate-test-1", cand.file));
      expect(sha256(stored)).toBe(cand.contentHash);
      expect(cand.file).toMatch(/^candidates\//);
    }
    // The recorded job round-trips from disk.
    const loaded = await loadJob(jobRoot, "plate-test-1");
    expect(loaded).toEqual(job);
  });

  test("rejects an invalid job id", () => {
    expect(runPlateJob(jobRoot, "Bad_Id", baseRequest(), fakeGen)).rejects.toThrow(/job id/i);
  });

  test("refuses to create over an existing job — rerun is the only append path", async () => {
    await runPlateJob(jobRoot, "plate-dup", baseRequest(), fakeGen);
    expect(runPlateJob(jobRoot, "plate-dup", baseRequest(), fakeGen)).rejects.toThrow(/rerun/i);
  });

  test("a failed generation records no run and leaves the job absent", async () => {
    const boom: PlateGenerator = async () => {
      throw new Error("gateway down");
    };
    await expect(runPlateJob(jobRoot, "plate-fail", baseRequest(), boom)).rejects.toThrow(
      /gateway down/,
    );
    await expect(loadJob(jobRoot, "plate-fail")).rejects.toThrow();
  });
});

describe("rerunPlateJob", () => {
  test("appends a new run under the job lineage, preserving prior candidates", async () => {
    const request = baseRequest();
    const first = await runPlateJob(jobRoot, "plate-lineage", request, fakeGen);

    const seen: PlateJobRequest[] = [];
    const spyGen: PlateGenerator = async (req) => {
      seen.push(structuredClone(req));
      return fakeGen(req);
    };
    const second = await rerunPlateJob(jobRoot, "plate-lineage", spyGen);

    expect(second.runs).toHaveLength(2);
    expect(second.runs[0]).toEqual(first.runs[0]);
    // The rerun reuses the recorded request — the generator sees the same facts.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual(request);
    // New candidates, all still addressable on disk.
    const hashes = new Set(second.runs.flatMap((r) => r.candidates.map((c) => c.contentHash)));
    expect(hashes.size).toBe(4);
    for (const run of second.runs)
      for (const cand of run.candidates) {
        const stored = await readFile(path.join(jobRoot, "plate-lineage", cand.file));
        expect(sha256(stored)).toBe(cand.contentHash);
      }
    expect(await loadJob(jobRoot, "plate-lineage")).toEqual(second);
  });

  test("fails loudly when a recorded reference's content has drifted", async () => {
    const refFile = path.join(root, "style.png");
    await writeFile(refFile, "original-bytes");
    const request = {
      ...baseRequest(),
      refs: [await parseTypedRef(`style:${refFile}`)],
    };
    await runPlateJob(jobRoot, "plate-drift", request, fakeGen);

    await writeFile(refFile, "changed-bytes");
    await expect(rerunPlateJob(jobRoot, "plate-drift", fakeGen)).rejects.toThrow(
      /content identity/i,
    );
    // The failed rerun left the lineage untouched.
    expect((await loadJob(jobRoot, "plate-drift")).runs).toHaveLength(1);
  });

  test("fails loudly when a recorded reference file is missing", async () => {
    const refFile = path.join(root, "gone.png");
    await writeFile(refFile, "bytes");
    await runPlateJob(jobRoot, "plate-gone", { ...baseRequest(), refs: [await parseTypedRef(`style:${refFile}`)] }, fakeGen);
    await rm(refFile);
    await expect(rerunPlateJob(jobRoot, "plate-gone", fakeGen)).rejects.toThrow(/gone\.png/);
  });
});

describe("adoptCandidate", () => {
  test("adopts a candidate as a new immutable Plate Asset with job provenance", async () => {
    const job = await runPlateJob(jobRoot, "plate-adopt", baseRequest(), fakeGen);
    const cand = job.runs[0]!.candidates[0]!;

    const result = await adoptCandidate(jobRoot, "plate-adopt", cand.contentHash, "neon-room", {
      libraryRoot,
      name: "Neon Room",
      tags: ["neon", "tech"],
    });

    const lib = await scanLibrary(libraryRoot);
    const plate = lib.plates.find((p) => p.meta.id === "neon-room")!;
    expect(plate).toBeDefined();
    expect(plate.hash).toBe(cand.contentHash);
    expect(plate.meta.kind).toBe("plate");
    expect(plate.meta.subject).toBe("neon server room");
    expect(plate.meta.fullPrompt).toBe(job.runs[0]!.fullPrompt);
    expect(plate.meta.model).toBe(job.runs[0]!.model);
    expect(plate.meta.adoptedFrom).toBe(`job:plate-adopt#${cand.contentHash}`);
    expect(result.imagePath).toBe(plate.imagePath);
  });

  test("never overwrites an existing adopted asset", async () => {
    const job = await runPlateJob(jobRoot, "plate-overwrite", baseRequest(), fakeGen);
    const cand = job.runs[0]!.candidates[0]!;
    await adoptCandidate(jobRoot, "plate-overwrite", cand.contentHash, "taken-id", { libraryRoot });

    const other = job.runs[0]!.candidates[1]!;
    await expect(
      adoptCandidate(jobRoot, "plate-overwrite", other.contentHash, "taken-id", { libraryRoot }),
    ).rejects.toThrow(/already exists/i);

    // The first adoption's bytes are unchanged — the refused adoption wrote nothing.
    const lib = await scanLibrary(libraryRoot);
    const plate = lib.plates.find((p) => p.meta.id === "taken-id")!;
    expect(plate.hash).toBe(cand.contentHash);
  });

  test("resolves a unique hash prefix and rejects ambiguous or unknown ones", async () => {
    const job = await runPlateJob(jobRoot, "plate-prefix", baseRequest(), fakeGen);
    const [a, b] = job.runs[0]!.candidates;
    const common = longestCommonPrefix(a!.contentHash, b!.contentHash);

    await adoptCandidate(jobRoot, "plate-prefix", a!.contentHash.slice(0, 12), "prefix-ok", { libraryRoot });
    const lib = await scanLibrary(libraryRoot);
    expect(lib.plates.find((p) => p.meta.id === "prefix-ok")!.hash).toBe(a!.contentHash);

    // A shared prefix matching two candidates is ambiguous.
    expect(common.length).toBeLessThan(12);
    await expect(
      adoptCandidate(jobRoot, "plate-prefix", common, "prefix-bad", { libraryRoot }),
    ).rejects.toThrow(/ambiguous|match/i);
    await expect(
      adoptCandidate(jobRoot, "plate-prefix", "ffffffff", "prefix-bad", { libraryRoot }),
    ).rejects.toThrow(/no candidate/i);
  });

  test("adopts a content identity that recurs across runs — ambiguity is about distinct hashes", async () => {
    const dupGen: PlateGenerator = async () => ({
      plates: [{ bytes: Buffer.from("same-bytes-every-run"), mediaType: "image/png" }],
      warnings: [],
      fullPrompt: "identical output",
    });
    await runPlateJob(jobRoot, "plate-recur", { ...baseRequest(), count: 1 }, dupGen);
    const second = await rerunPlateJob(jobRoot, "plate-recur", dupGen);
    expect(second.runs).toHaveLength(2);
    expect(second.runs[1]!.candidates[0]!.contentHash).toBe(second.runs[0]!.candidates[0]!.contentHash);

    // The recurring identity is adoptable — even by a short prefix — and its
    // provenance resolves to the earliest run that produced it.
    const hash = second.runs[1]!.candidates[0]!.contentHash;
    const result = await adoptCandidate(jobRoot, "plate-recur", hash.slice(0, 10), "recur-id", { libraryRoot });
    expect(result.contentHash).toBe(hash);
    const lib = await scanLibrary(libraryRoot);
    expect(lib.plates.find((p) => p.meta.id === "recur-id")!.meta.fullPrompt).toBe("identical output");
  });

  test("fails loudly when the candidate file no longer matches its recorded identity", async () => {
    const job = await runPlateJob(jobRoot, "plate-tamper", baseRequest(), fakeGen);
    const cand = job.runs[0]!.candidates[0]!;
    await writeFile(path.join(jobRoot, "plate-tamper", cand.file), "tampered");
    await expect(
      adoptCandidate(jobRoot, "plate-tamper", cand.contentHash, "tamper-id", { libraryRoot }),
    ).rejects.toThrow(/identity/i);
  });

  test("adopts a non-PNG candidate under its real media type", async () => {
    const jpegGen: PlateGenerator = async () => ({
      plates: [{ bytes: Buffer.from("jpeg-candidate-bytes"), mediaType: "image/jpeg" }],
      warnings: [],
      fullPrompt: "p",
    });
    const job = await runPlateJob(jobRoot, "plate-jpeg", { ...baseRequest(), count: 1 }, jpegGen);
    const hash = job.runs[0]!.candidates[0]!.contentHash;

    await adoptCandidate(jobRoot, "plate-jpeg", hash, "jpeg-id", { libraryRoot });
    const stored = await readFile(path.join(libraryRoot, "plates", "jpeg-id", "plate.jpg"));
    expect(sha256(stored)).toBe(hash);
    // A duplicate-id adoption of the other media type still cannot overwrite.
    const pngJob = await runPlateJob(jobRoot, "plate-png", baseRequest(), fakeGen);
    await expect(
      adoptCandidate(jobRoot, "plate-png", pngJob.runs[0]!.candidates[0]!.contentHash, "jpeg-id", { libraryRoot }),
    ).rejects.toThrow(/already exists/i);
  });
});

describe("loadJob and listJobs", () => {
  test("loadJob fails loudly on a missing or corrupt record", async () => {
    await expect(loadJob(jobRoot, "nope")).rejects.toThrow(/nope/);
    await mkdir(path.join(jobRoot, "bad-job"), { recursive: true });
    await writeFile(path.join(jobRoot, "bad-job", "job.json"), "{not json");
    await expect(loadJob(jobRoot, "bad-job")).rejects.toThrow(/bad-job/);
  });

  test("listJobs summarizes every recorded job", async () => {
    await runPlateJob(jobRoot, "plate-a", baseRequest(), fakeGen);
    await rerunPlateJob(jobRoot, "plate-a", fakeGen);
    await runPlateJob(jobRoot, "plate-b", { ...baseRequest(), count: 1 }, fakeGen);

    const jobs = await listJobs(jobRoot);
    expect(jobs).toHaveLength(2);
    const a = jobs.find((j) => j.jobId === "plate-a")!;
    expect(a).toMatchObject({ kind: "plate", subject: "neon server room", runs: 2, candidates: 4 });
    const b = jobs.find((j) => j.jobId === "plate-b")!;
    expect(b).toMatchObject({ runs: 1, candidates: 1 });
  });
});

function longestCommonPrefix(a: string, b: string): string {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return a.slice(0, i);
}
