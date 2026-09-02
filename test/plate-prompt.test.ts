/**
 * The Plate effective-prompt contract at the public Generation Job boundary
 * (#51, US-025–US-027, TEST-009). The agent's subject is authoritative for
 * visual content (DEC-010): a requested UI surface, product, or device
 * survives in the recorded effective prompt with no contradictory blanket
 * prohibition, while the final-text and exact-logo boundaries stay hard-banned
 * (ADR-0001). A rerun re-derives the same effective prompt from the recorded
 * request, so every run's provenance carries the contract, and adoption
 * forwards it into the Asset's provenance.
 *
 * The AI SDK seam is mocked, so the public CLI runs its real production
 * generator and nothing is ever sent to the Gateway (no spend).
 */
import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdtemp, rm, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

let prompts: string[] = [];
mock.module("ai", () => ({
  generateImage: async (opts: { prompt: string }) => {
    prompts.push(opts.prompt);
    return {
      images: [{ base64: Buffer.from(`plate-bytes-${prompts.length}`).toString("base64") }],
      warnings: [],
    };
  },
  generateText: async () => {
    throw new Error("the default plate path calls generateImage, not generateText");
  },
}));

import { run } from "../src/job-cli.js";
import type { MatteEngine } from "../src/matte.js";

let root: string;
let jobsRoot: string;
let libraryRoot: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "thumby-plate-prompt-"));
  jobsRoot = path.join(root, "jobs");
  libraryRoot = path.join(root, "library");
  await mkdir(libraryRoot, { recursive: true });
  prompts = [];
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/**
 * Plate runs never matte and never preflight the engine (only creator/object
 * runs do), so the fake engine must never be called — the plate lifecycle
 * ignores it entirely.
 */
const unusedMatte: MatteEngine = async () => {
  throw new Error("plate runs never invoke the matting engine");
};

/** A subject requesting exactly what the old plate prompt banned. */
const SUBJECT = "a developer's desk with a terminal window and a laptop, neon rim light";

/** The recorded effective prompt carries the request and no contradictory bans. */
function expectFlexiblePlateContract(fullPrompt: string): void {
  expect(fullPrompt).toContain(SUBJECT);
  // DEC-010: no blanket bans on UI, products, devices, or foreground objects.
  expect(fullPrompt).not.toMatch(/no ui/i);
  expect(fullPrompt).not.toMatch(/no products?/i);
  expect(fullPrompt).not.toMatch(/no devices?/i);
  expect(fullPrompt).not.toMatch(/no (?:person|foreground)/i);
  expect(fullPrompt).not.toMatch(/backdrop only/i);
  // ADR-0001: the local final-text and exact-logo boundaries stay.
  expect(fullPrompt).toMatch(/no text/i);
  expect(fullPrompt).toMatch(/no logos?/i);
}

describe("plate job effective-prompt contract (#51)", () => {
  test("a requested UI, product, or device subject survives in the recorded effective prompt", async () => {
    const out = await run(["plates", SUBJECT, "--job", "plate-flex-1"], { jobsRoot, libraryRoot, matte: unusedMatte });
    expect(out.exitCode).toBe(0);

    const record = JSON.parse(await readFile(path.join(jobsRoot, "plate-flex-1", "job.json"), "utf8"));
    expect(record.kind).toBe("plate");
    expect(record.runs).toHaveLength(1);
    expectFlexiblePlateContract(record.runs[0]!.fullPrompt);
    // What the model received is exactly what the run recorded.
    expect(prompts).toEqual([record.runs[0]!.fullPrompt]);
  });

  test("a rerun re-derives the same effective prompt and appends its provenance", async () => {
    await run(["plates", SUBJECT, "--job", "plate-flex-2"], { jobsRoot, libraryRoot, matte: unusedMatte });
    const out = await run(["rerun", "plate-flex-2"], { jobsRoot, libraryRoot, matte: unusedMatte });
    expect(out.exitCode).toBe(0);

    const record = JSON.parse(await readFile(path.join(jobsRoot, "plate-flex-2", "job.json"), "utf8"));
    expect(record.runs).toHaveLength(2);
    for (const runRecord of record.runs) expectFlexiblePlateContract(runRecord.fullPrompt);
    expect(record.runs[1]!.fullPrompt).toBe(record.runs[0]!.fullPrompt);
    // The rerun actually called the model with the recorded request's prompt.
    expect(prompts).toEqual([record.runs[0]!.fullPrompt, record.runs[1]!.fullPrompt]);
  });

  test("an adopted plate's provenance records the effective prompt", async () => {
    await run(["plates", SUBJECT, "--job", "plate-flex-3"], { jobsRoot, libraryRoot, matte: unusedMatte });
    const record = JSON.parse(await readFile(path.join(jobsRoot, "plate-flex-3", "job.json"), "utf8"));
    const hash = record.runs[0]!.candidates[0]!.contentHash;

    const out = await run(["adopt", "plate-flex-3", hash, "--id", "flex-plate"], { jobsRoot, libraryRoot, matte: unusedMatte });
    expect(out.exitCode).toBe(0);

    const meta = JSON.parse(
      await readFile(path.join(libraryRoot, "plates", "flex-plate", "meta.json"), "utf8"),
    );
    expectFlexiblePlateContract(meta.fullPrompt);
  });
});