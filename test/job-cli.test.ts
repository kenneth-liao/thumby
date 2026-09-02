import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readFile, mkdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PlateGenerator, ObjectGenerator } from "../src/jobs.js";
import { composeMatte, type MatteEngine } from "../src/matte.js";
import { scanLibrary } from "../src/assets.js";
import { run as cliRun, PRODUCTION_GENERATOR, generateOptionsFor } from "../src/job-cli.js";
import { encodePng } from "./png.js";

let root: string;
let jobsRoot: string;
let libraryRoot: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "thumby-job-cli-"));
  jobsRoot = path.join(root, "jobs");
  libraryRoot = path.join(root, "library");
  await mkdir(libraryRoot, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

let n = 0;
const fakeGen: PlateGenerator = async (req) => ({
  candidates: Array.from({ length: req.count }, (_, i) => ({
    bytes: Buffer.from(`cli-fake-${req.subject}-${n++}-${i}`),
    mediaType: "image/png",
  })),
  warnings: ["fake: warning one"],
  fullPrompt: `PROMPT<${req.subject}>`,
});

/** Invoke the CLI with test roots and the fake generators. */
function run(
  args: string[],
  generate: PlateGenerator = fakeGen,
  generateObject: ObjectGenerator = fakeObjectGen,
  matte: MatteEngine = tripwireMatte,
) {
  return cliRun(args, { generate, generateObject, matte, jobsRoot, libraryRoot });
}

const PLATES_ARGS = ["plates", "neon server room", "--zone", "left", "--count", "2"];

describe("jobs plates", () => {
  test("creates a job and returns the run with candidates as structured output", async () => {
    const res = await run(PLATES_ARGS);
    expect(res.exitCode).toBe(0);
    const out = res.output as Record<string, any>;
    expect(out.ok).toBe(true);
    expect(out.jobId).toMatch(/^plate-[a-z0-9-]+$/);
    expect(out.runIndex).toBe(0);
    expect(out.run.fullPrompt).toBe("PROMPT<neon server room>");
    expect(out.run.warnings).toEqual(["fake: warning one"]);
    expect(out.run.candidates).toHaveLength(2);
    for (const c of out.run.candidates) {
      await stat(path.join(out.jobDir, c.file));
    }
    // The record exists on disk under the jobs root.
    const record = JSON.parse(await readFile(path.join(out.jobDir, "job.json"), "utf8"));
    expect(record.jobId).toBe(out.jobId);
    expect(record.request.subject).toBe("neon server room");
  });

  test("accepts an explicit --job id and typed references with content identities", async () => {
    const refFile = path.join(root, "style.png");
    await writeFile(refFile, "ref-bytes");
    const res = await run([
      "plates", "subject", "--job", "hook-backdrop", "--ref", `style:${refFile}`,
    ]);
    expect(res.exitCode).toBe(0);
    const out = res.output as Record<string, any>;
    expect(out.jobId).toBe("hook-backdrop");
    const record = JSON.parse(await readFile(path.join(out.jobDir, "job.json"), "utf8"));
    expect(record.request.refs).toHaveLength(1);
    expect(record.request.refs[0].role).toBe("style");
    expect(record.request.refs[0].contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("records every occurrence of the repeatable --ref flag", async () => {
    const styleFile = path.join(root, "style.png");
    const layoutFile = path.join(root, "layout.png");
    await writeFile(styleFile, "style-bytes");
    await writeFile(layoutFile, "layout-bytes");
    const res = await run([
      "plates", "subject", "--job", "two-refs",
      "--ref", `style:${styleFile}`, "--ref", `layout:${layoutFile}`,
    ]);
    expect(res.exitCode).toBe(0);
    const record = JSON.parse(
      await readFile(path.join(jobsRoot, "two-refs", "job.json"), "utf8"),
    );
    expect(record.request.refs.map((r: any) => r.role)).toEqual(["style", "layout"]);
  });

  test("usage errors are structured with exit code 2", async () => {
    expect((await run(["plates"])).exitCode).toBe(2);
    expect((await run(["plates", "subject", "--zone", "sideways"])).exitCode).toBe(2);
    expect((await run(["plates", "subject", "--count", "0"])).exitCode).toBe(2);
    expect((await run(["plates", "subject", "--ref", "untyped.png"])).exitCode).toBe(2);
    for (const args of [["plates"], ["plates", "subject", "--zone", "sideways"]]) {
      const out = (await run(args)).output as Record<string, any>;
      expect(out.ok).toBe(false);
      expect(out.errors[0].message).toBeDefined();
    }
  });

  test("a generation failure is a structured error, exit code 1", async () => {
    const boom: PlateGenerator = async () => {
      throw new Error("gateway down");
    };
    const res = await run(["plates", "subject"], boom);
    expect(res.exitCode).toBe(1);
    const out = res.output as Record<string, any>;
    expect(out.ok).toBe(false);
    expect(out.errors[0].message).toMatch(/gateway down/);
  });
});

describe("jobs rerun", () => {
  test("appends a run under the lineage using the recorded request", async () => {
    const first = (await run(["plates", "recorded subject", "--job", "lineage-job"])).output as Record<string, any>;
    const second = await run(["rerun", "lineage-job"]);
    expect(second.exitCode).toBe(0);
    const out = second.output as Record<string, any>;
    expect(out.runIndex).toBe(1);
    expect(out.run.fullPrompt).toBe(first.run.fullPrompt);
    expect(out.job.runs).toHaveLength(2);
  });

  test("an unknown job id is a structured failure, exit code 1", async () => {
    const res = await run(["rerun", "missing-job"]);
    expect(res.exitCode).toBe(1);
    expect((res.output as Record<string, any>).ok).toBe(false);
  });

  test("extra positionals are usage errors, not silently ignored", async () => {
    await run(["plates", "subject", "--job", "one-arg-job"]);
    expect((await run(["rerun", "one-arg-job", "extra"])).exitCode).toBe(2);
    expect((await run(["show", "one-arg-job", "extra"])).exitCode).toBe(2);
    expect((await run(["rerun", "one-arg-job"])).exitCode).toBe(0);
  });
});

describe("jobs show and list", () => {
  test("show returns the full record; list summarizes", async () => {
    await run(["plates", "subject one", "--job", "job-a"]);
    await run(["plates", "subject two", "--job", "job-b"]);

    const show = await run(["show", "job-a"]);
    expect(show.exitCode).toBe(0);
    const shown = show.output as Record<string, any>;
    expect(shown.ok).toBe(true);
    expect(shown.job.jobId).toBe("job-a");
    expect(shown.job.request.subject).toBe("subject one");

    const list = await run(["list"]);
    const out = list.output as Record<string, any>;
    expect(out.ok).toBe(true);
    expect(out.jobs).toHaveLength(2);
    expect(out.jobs.map((j: any) => j.jobId).sort()).toEqual(["job-a", "job-b"]);
  });
});

describe("jobs adopt", () => {
  test("adopts a candidate into the library as an immutable Plate Asset", async () => {
    await run(["plates", "neon server room", "--job", "adopt-job", "--count", "2"]);
    const shown = ((await run(["show", "adopt-job"])).output as Record<string, any>).job;
    const hash: string = shown.runs[0].candidates[0].contentHash;

    const res = await run(["adopt", "adopt-job", hash.slice(0, 12), "--id", "neon-room", "--tags", "neon,tech"]);
    expect(res.exitCode).toBe(0);
    const out = res.output as Record<string, any>;
    expect(out.ok).toBe(true);
    expect(out.assetId).toBe("neon-room");
    expect(out.contentHash).toBe(hash);

    const lib = await scanLibrary(libraryRoot);
    const plate = lib.plates.find((p) => p.meta.id === "neon-room")!;
    expect(plate.hash).toBe(hash);
    expect(plate.meta.subject).toBe("neon server room");
    expect(plate.meta.adoptedFrom).toBe(`job:adopt-job#${hash}`);
  });

  test("refuses to overwrite an adopted asset — structured failure, exit 1", async () => {
    await run(["plates", "subject", "--job", "dup-job", "--count", "2"]);
    const shown = ((await run(["show", "dup-job"])).output as Record<string, any>).job;
    const [a, b] = shown.runs[0].candidates;

    expect((await run(["adopt", "dup-job", a.contentHash, "--id", "taken"])).exitCode).toBe(0);
    const res = await run(["adopt", "dup-job", b.contentHash, "--id", "taken"]);
    expect(res.exitCode).toBe(1);
    const out = res.output as Record<string, any>;
    expect(out.ok).toBe(false);
    expect(out.errors[0].message).toMatch(/already exists/);

    const lib = await scanLibrary(libraryRoot);
    expect(lib.plates.find((p) => p.meta.id === "taken")!.hash).toBe(a.contentHash);
  });

  test("adopt without --id is a usage error", async () => {
    await run(["plates", "subject", "--job", "need-id"]);
    const res = await run(["adopt", "need-id", "0123456789abcdef"]);
    expect(res.exitCode).toBe(2);
  });
});

/** True-alpha PNG: a 4×4 opaque red subject in a 16×16 transparent frame. */
const ALPHA_PNG = encodePng(16, 16, (x, y) =>
  x < 4 && y < 4 ? [255, 0, 0, 255] : [0, 0, 0, 0],
);

/** Opaque PNG (color type 2): a subject over a painted backdrop, no alpha. */
const OPAQUE_PNG = encodePng(
  16,
  16,
  (x, y) => (x < 8 && y < 8 ? [230, 120, 80, 255] : [20, 90, 200, 255]),
  { colorType: 2 },
);

/** The segmentation mask the working fake engine predicts for it. */
const MASK_PNG = encodePng(
  16,
  16,
  (x, y) => (x < 8 && y < 8 ? [255, 255, 255, 255] : [0, 0, 0, 255]),
  { colorType: 2 },
);

let objN = 0;
const fakeObjectGen: ObjectGenerator = async (req) => ({
  candidates: Array.from({ length: req.count }, () => ({
    bytes: Buffer.concat([ALPHA_PNG, Buffer.from(`-${objN++}`)]),
    mediaType: "image/png",
  })),
  warnings: [],
  fullPrompt: `OBJECT<${req.subject}>`,
});

/** The harness matte is a tripwire: native-alpha candidates must never reach it. */
const tripwireMatte: MatteEngine = async () => {
  throw new Error("test engine must not run — candidates are native-alpha");
};

/** The measured reality: an opaque candidate whose backdrop is painted pixels. */
const opaqueObjectGen: ObjectGenerator = async (req) => ({
  candidates: [
    { bytes: Buffer.concat([OPAQUE_PNG, Buffer.from(`-${objN++}`)]), mediaType: "image/png" },
  ],
  warnings: [],
  fullPrompt: `OBJECT<${req.subject}>`,
});

/** A working fake engine: the predicted mask composed on by the real composer. */
const workingMatte: MatteEngine = async ({ bytes, label }) => ({
  bytes: composeMatte(bytes, MASK_PNG, label),
  engine: "test/segmentation",
});

describe("jobs objects", () => {
  test("creates an object job and returns the run with kind in the output", async () => {
    const res = await run(["objects", "a retro desk lamp", "--job", "obj-cli", "--count", "2"]);
    expect(res.exitCode).toBe(0);
    const out = res.output as Record<string, any>;
    expect(out.ok).toBe(true);
    expect(out.kind).toBe("object");
    expect(out.run.candidates).toHaveLength(2);
    const record = JSON.parse(await readFile(path.join(out.jobDir, "job.json"), "utf8"));
    expect(record.kind).toBe("object");
    expect(record.request.subject).toBe("a retro desk lamp");
    expect(record.request).not.toHaveProperty("zone");
  });

  test("auto job ids are object-prefixed", async () => {
    const res = await run(["objects", "a potted monstera"]);
    const out = res.output as Record<string, any>;
    expect(out.jobId).toMatch(/^object-[a-z0-9-]+$/);
  });

  test("a logo or text subject is a structured failure before any generation call", async () => {
    let calls = 0;
    const spy: ObjectGenerator = async (req) => {
      calls++;
      return fakeObjectGen(req);
    };
    const res = await run(["objects", "the OpenAI logo", "--job", "obj-logo"], undefined, spy);
    expect(res.exitCode).toBe(1);
    const out = res.output as Record<string, any>;
    expect(out.ok).toBe(false);
    expect(out.errors[0].message).toMatch(/logo/i);
    expect(calls).toBe(0);
  });

  test("rerun dispatches by the recorded job kind", async () => {
    await run(["objects", "a floating terminal", "--job", "obj-lineage"]);
    const second = await run(["rerun", "obj-lineage"], undefined, fakeObjectGen);
    expect(second.exitCode).toBe(0);
    const out = second.output as Record<string, any>;
    expect(out.kind).toBe("object");
    expect(out.job.runs).toHaveLength(2);
  });

  test("an opaque object job is matted end-to-end through the CLI — run, rerun, adopt", async () => {
    // The measured reality through the real command path: the model returns
    // opaque candidates, the CLI hands the engine to the run and the rerun,
    // and adoption writes the matte. Reverting the CLI's object-engine wiring
    // fails this test instead of leaving CI green.
    await run(
      ["objects", "a chrome fishing hook", "--job", "obj-opaque-cli"],
      undefined,
      opaqueObjectGen,
      workingMatte,
    );
    const rerun = await run(["rerun", "obj-opaque-cli"], undefined, opaqueObjectGen, workingMatte);
    expect(rerun.exitCode).toBe(0);
    const job = ((rerun.output as Record<string, any>).job) as Record<string, any>;
    expect(job.runs).toHaveLength(2);
    for (const run_ of job.runs)
      for (const cand of run_.candidates) {
        expect(cand.matte).toBeDefined();
        expect(cand.matte.engine).toBe("test/segmentation");
      }

    // Adopt from the rerun's candidates: the matte enters the library, not
    // the opaque candidate — the asset's hash is the matte's.
    const rerunCandidates = job.runs[1].candidates as Array<Record<string, any>>;
    const res = await run([
      "adopt",
      "obj-opaque-cli",
      (rerunCandidates[0]!.contentHash as string).slice(0, 12),
      "--id",
      "hook-tile",
    ]);
    expect(res.exitCode).toBe(0);
    const lib = await scanLibrary(libraryRoot);
    const asset = lib.objects.find((o) => o.meta.id === "hook-tile")!;
    expect(asset.hash).toBe(rerunCandidates[0]!.matte.contentHash);
    expect(asset.meta.matting).toBe("true-alpha");
    expect(asset.meta.matteEngine).toBe("test/segmentation");
  });

  test("adopt dispatches to the alpha-gated object path", async () => {
    await run(["objects", "a retro desk lamp", "--job", "obj-adopt-cli"]);
    const shown = ((await run(["show", "obj-adopt-cli"])).output as Record<string, any>).job;
    const hash: string = shown.runs[0].candidates[0].contentHash;

    const res = await run(["adopt", "obj-adopt-cli", hash.slice(0, 12), "--id", "lamp"]);
    expect(res.exitCode).toBe(0);
    const lib = await scanLibrary(libraryRoot);
    const asset = lib.objects.find((o) => o.meta.id === "lamp")!;
    expect(asset.hash).toBe(hash);
    expect(asset.meta.matting).toBe("true-alpha");
  });
});

// AI-SDK tripwire for this file: every other test uses injected generators, so
// the only legitimate path to the real SDK is through PRODUCTION_GENERATOR's
// gates — which must refuse before the call. If any test reaches the SDK, the
// tripwire fails loudly instead of attempting a live provider call.
mock.module("ai", () => ({
  generateImage: () => {
    throw new Error("AI SDK must not be called — a gate must refuse before the provider call");
  },
  generateText: () => {
    throw new Error("AI SDK must not be called — a gate must refuse before the provider call");
  },
}));

describe("production generator wiring", () => {  test("maps a job request onto generatePlates options — subject-authoritative contract included", () => {
    // The ADR-0011 load-bearing fact: a Plate Job's subject is authoritative —
    // no subjectless backdrop mode is forced, and the full request (zone,
    // count, typed-ref paths, temperature) maps through.
    expect(
      generateOptionsFor({
        kind: "plate", subject: "neon room", zone: "right", model: "nano-2",
        count: 3, temperature: 0.4,
        refs: [{ role: "style", path: "refs/palette.png", contentHash: "ab".repeat(32) }],
      }),
    ).toEqual({
      subject: "neon room",
      zone: "right",
      model: "nano-2",
      refs: ["refs/palette.png"],
      count: 3,
      temperature: 0.4,
    });
    expect(generateOptionsFor({ ...requestFixture(), temperature: undefined }).temperature).toBeUndefined();
  });

  test("the production generator's last gate refuses an incompatible referenced request before any AI SDK call", async () => {
    // PRODUCTION_GENERATOR is exercised directly so the runJob request
    // boundary — which normally refuses first — cannot intercept: this is the
    // only test that reaches the generator-level gate in generate.ts
    // (defense in depth). The mocked AI SDK tripwire above proves rejection
    // happens before any provider call, and the canonical builder's
    // registry-derived message proves no compatibility list is duplicated.
    const refFile = path.join(root, "style.png");
    await writeFile(refFile, "bytes");
    await expect(
      PRODUCTION_GENERATOR({
        kind: "plate", subject: "simplified ui", zone: "left", model: "flux", count: 1,
        refs: [{ role: "style", path: refFile, contentHash: "ab".repeat(32) }],
      }),
    ).rejects.toThrow(/not qualified reference-capable/);
    await expect(
      PRODUCTION_GENERATOR({
        kind: "plate", subject: "simplified ui", zone: "left", model: "flux", count: 1,
        refs: [{ role: "style", path: refFile, contentHash: "ab".repeat(32) }],
      }),
    ).rejects.toThrow(/bfl\/flux-2-flex/);
  });
});

function requestFixture() {
  return {
    kind: "plate" as const,
    subject: "neon room",
    zone: "right" as const,
    model: "nano-2",
    count: 3,
    refs: [],
  };
}
