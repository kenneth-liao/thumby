import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readFile, mkdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PlateGenerator } from "../src/jobs.js";
import { scanLibrary } from "../src/assets.js";
import { run as cliRun, PRODUCTION_GENERATOR } from "../src/job-cli.js";

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
  plates: Array.from({ length: req.count }, (_, i) => ({
    bytes: Buffer.from(`cli-fake-${req.subject}-${n++}-${i}`),
    mediaType: "image/png",
  })),
  warnings: ["fake: warning one"],
  fullPrompt: `PROMPT<${req.subject}>`,
});

/** Invoke the CLI with test roots and the fake generator. */
function run(args: string[], generate: PlateGenerator = fakeGen) {
  return cliRun(args, { generate, jobsRoot, libraryRoot });
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

describe("production generator wiring", () => {
  test("maps a job request onto generatePlates options", async () => {
    // Offline contract check only: the production generator rejects a model
    // that cannot take references, proving the request is forwarded.
    const refFile = path.join(root, "style.png");
    await writeFile(refFile, "bytes");
    const res = await cliRun(
      ["plates", "subject", "--model", "gpt-image", "--ref", `style:${refFile}`],
      { generate: PRODUCTION_GENERATOR, jobsRoot, libraryRoot },
    );
    expect(res.exitCode).toBe(1);
    expect(((res.output as Record<string, any>).errors[0].message as string)).toMatch(/does not accept reference images/);
  });
});
