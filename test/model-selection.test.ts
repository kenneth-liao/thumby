/**
 * Model selection from one capability source (TEST-010/TEST-011, #53):
 * a Job with typed References selects the project-approved compatible
 * default; an explicit incompatible selection — registry key or raw gateway
 * id — is refused before any generator (and therefore any provider) call,
 * listing every qualified compatible model derived from the canonical
 * registry reader. Raw ids carry no capability claim. No test here spends
 * money: every generator is injected.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readFile, mkdir, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import type { PlateGenerator, ObjectGenerator, CreatorGenerator } from "../src/jobs.js";
import type { MatteEngine } from "../src/matte.js";
import {
  MODELS,
  DEFAULT_MODEL,
  CREATOR_DEFAULT_MODEL,
  referenceCapableModels,
  referenceIncompatibilityError,
} from "../src/models.js";
import { run as cliRun } from "../src/job-cli.js";
import { encodePng } from "./png.js";

let root: string;
let jobsRoot: string;
let libraryRoot: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "thumby-model-selection-"));
  jobsRoot = path.join(root, "jobs");
  libraryRoot = path.join(root, "library");
  await mkdir(libraryRoot, { recursive: true });
  reached.plate = reached.object = reached.creator = false;
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Generator that records it was reached — a tripwire proves pre-spend refusal. */
const reached = { plate: false, object: false, creator: false };
const fakeGen: PlateGenerator = async (req) => {
  reached.plate = true;
  return {
    candidates: Array.from({ length: req.count }, (_, i) => ({
      bytes: Buffer.from(`fake-${req.subject}-${i}`),
      mediaType: "image/png",
    })),
    warnings: [],
    fullPrompt: `PROMPT<${req.subject}>`,
  };
};
const fakeObjectGen: ObjectGenerator = async (req) => {
  reached.object = true;
  return {
    candidates: [{ bytes: ALPHA_PNG, mediaType: "image/png" }],
    warnings: [],
    fullPrompt: `OBJECT<${req.subject}>`,
  };
};
const fakeCreatorGen: CreatorGenerator = async (req) => {
  reached.creator = true;
  return {
    candidates: [{ bytes: ALPHA_PNG, mediaType: "image/png" }],
    warnings: [],
    fullPrompt: `CREATOR<${req.subject}>`,
  };
};

/** Native-alpha candidate: the tripwire matte below must never be reached. */
const ALPHA_PNG = encodePng(16, 16, (x, y) => (x === 0 || y === 0 ? [0, 0, 0, 0] : [255, 0, 0, 255]));
const tripwireMatte: MatteEngine = async () => {
  throw new Error("test engine must not run — candidates are native-alpha");
};

function run(args: string[]) {
  return cliRun(args, {
    generate: fakeGen,
    generateObject: fakeObjectGen,
    generateCreator: fakeCreatorGen,
    matte: tripwireMatte,
    jobsRoot,
    libraryRoot,
  });
}

const refusalOf = (res: { exitCode: number; output: unknown }): string =>
  ((res.output as Record<string, any>).errors[0] as { message: string }).message;

/** The refusal shape: pre-spend, and listing every qualified compatible model. */
async function expectQualifiedRefusal(res: { exitCode: number; output: unknown }) {
  expect(res.exitCode).toBe(1);
  const message = refusalOf(res);
  expect(message).toMatch(/not qualified reference-capable/);
  // Every qualified compatible choice is listed, derived from the registry.
  for (const { key, spec } of referenceCapableModels()) {
    expect(message).toContain(`${key} (${spec.id})`);
  }
  // The refusal happened before the generators — nothing ran.
  expect(reached).toEqual({ plate: false, object: false, creator: false });
  return message;
}

describe("the registry is the one capability source", () => {
  test("GPT Image 2 capability and measured-cost facts reflect the #52 evidence", () => {
    const gpt = MODELS["gpt-image"];
    expect(gpt.supportsRef).toBe(true);
    // The run-summary rate stays the measured text-only plate figure.
    expect(gpt.approxCost).toBe(0.0045);
    expect(gpt.costMeasured).toBe(true);
    // The reference-call evidence is recorded as an account-window delta with
    // its basis stated — never presented as a per-image rate or run cost.
    expect(gpt.note).toMatch(/account-window delta/);
    expect(gpt.note).toMatch(/not a per-image rate/);
  });
});

describe("jobs with typed References select a compatible default", () => {
  test("a plate job with a typed Reference and no explicit model uses the qualified default", async () => {
    const refFile = path.join(root, "style.png");
    await writeFile(refFile, "ref-bytes");
    const res = await run(["plates", "simplified ui", "--ref", `edit:${refFile}`]);
    expect(res.exitCode).toBe(0);
    const out = res.output as Record<string, any>;
    expect(out.ok).toBe(true);
    expect(reached.plate).toBe(true);
    const record = JSON.parse(await readFile(path.join(out.jobDir, "job.json"), "utf8"));
    expect(record.request.model).toBe(DEFAULT_MODEL);
    expect(MODELS[record.request.model].supportsRef).toBe(true);
  });

  test("an object job with a typed Reference and no explicit model uses the qualified default", async () => {
    const refFile = path.join(root, "style.png");
    await writeFile(refFile, "ref-bytes");
    const res = await run(["objects", "brass lamp", "--ref", `edit:${refFile}`]);
    expect(res.exitCode).toBe(0);
    const out = res.output as Record<string, any>;
    expect(reached.object).toBe(true);
    const record = JSON.parse(await readFile(path.join(out.jobDir, "job.json"), "utf8"));
    expect(record.request.model).toBe(DEFAULT_MODEL);
  });
});

describe("jobs without References keep the existing default selection", () => {
  test("a plate job without references defaults to the plate default and runs", async () => {
    const res = await run(["plates", "neon room"]);
    expect(res.exitCode).toBe(0);
    const out = res.output as Record<string, any>;
    expect(reached.plate).toBe(true);
    const record = JSON.parse(await readFile(path.join(out.jobDir, "job.json"), "utf8"));
    expect(record.request.model).toBe(DEFAULT_MODEL);
  });

  test("an explicit incompatible model without references is honored — no capability claim needed", async () => {
    const res = await run(["plates", "neon room", "--model", "flux"]);
    expect(res.exitCode).toBe(0);
    const out = res.output as Record<string, any>;
    expect(reached.plate).toBe(true);
    const record = JSON.parse(await readFile(path.join(out.jobDir, "job.json"), "utf8"));
    expect(record.request.model).toBe("flux");
  });

  test("a raw gateway id without references passes through unchanged", async () => {
    const raw = "bytedance/seedream-5.0-lite";
    const res = await run(["plates", "neon room", "--model", raw]);
    expect(res.exitCode).toBe(0);
    const out = res.output as Record<string, any>;
    expect(reached.plate).toBe(true);
    const record = JSON.parse(await readFile(path.join(out.jobDir, "job.json"), "utf8"));
    expect(record.request.model).toBe(raw);
  });

  test("the creator default is the separate likeness workhorse, not derived here", () => {
    expect(CREATOR_DEFAULT_MODEL).toBe("nano-2");
    expect(CREATOR_DEFAULT_MODEL).not.toBe(DEFAULT_MODEL);
  });
});

describe("explicit incompatible selections are refused before spend", () => {
  test("a plate job with a reference-incompatible registry model is refused", async () => {
    const refFile = path.join(root, "style.png");
    await writeFile(refFile, "ref-bytes");
    const res = await run(["plates", "simplified ui", "--model", "flux", "--ref", `edit:${refFile}`]);
    await expectQualifiedRefusal(res);
    // No job record was written — the refusal is pre-creation.
    expect(await readdir(jobsRoot)).toEqual([]);
  });

  test("an object job with an incompatible model is refused the same way", async () => {
    const refFile = path.join(root, "style.png");
    await writeFile(refFile, "ref-bytes");
    const res = await run(["objects", "brass lamp", "--model", "recraft", "--ref", `edit:${refFile}`]);
    await expectQualifiedRefusal(res);
    expect(await readdir(jobsRoot)).toEqual([]);
  });

  test("a creator job with an incompatible model is refused before the generator", async () => {
    const anchor = path.join(root, "anchor.png");
    await writeFile(anchor, "anchor-bytes");
    const res = await run([
      "creators", "arms crossed", "--model", "flux", "--ref", `identity:${anchor}`,
    ]);
    await expectQualifiedRefusal(res);
    expect(await readdir(jobsRoot)).toEqual([]);
  });

  test("the refusal message has one home — the canonical builder", () => {
    const built = referenceIncompatibilityError(MODELS["flux"]);
    expect(built).toMatch(/not qualified reference-capable/);
    for (const { key, spec } of referenceCapableModels()) {
      expect(built).toContain(`${key} (${spec.id})`);
    }
  });
});

describe("raw model identifiers carry no capability claim", () => {
  test("a raw id that looks reference-capable by name is refused for reference jobs", async () => {
    const refFile = path.join(root, "style.png");
    await writeFile(refFile, "ref-bytes");
    const res = await run([
      "plates", "simplified ui", "--model", "google/gemini-3.1-flash-image", "--ref", `edit:${refFile}`,
    ]);
    await expectQualifiedRefusal(res);
  });

  test("a raw id with no gemini substring is refused the same way", async () => {
    const refFile = path.join(root, "style.png");
    await writeFile(refFile, "ref-bytes");
    const res = await run([
      "plates", "simplified ui", "--model", "acme/unknown-image-model", "--ref", `edit:${refFile}`,
    ]);
    await expectQualifiedRefusal(res);
  });

  test("capability is only asked once the request can exist — a missing reference fails as usage first", async () => {
    const res = await run(["plates", "x", "--model", "acme/unknown", "--ref", `edit:${path.join(root, "missing.png")}`]);
    expect(res.exitCode).toBe(2);
  });
});

describe("rerun re-validates the recorded model against the current registry", () => {
  test("a recorded incompatible model with references is refused on rerun", async () => {
    const refFile = path.join(root, "style.png");
    await writeFile(refFile, "ref-bytes");
    const contentHash = createHash("sha256").update("ref-bytes").digest("hex");
    // A record that predates the gate (or drifted): incompatible model + refs.
    await mkdir(path.join(jobsRoot, "stale-job"), { recursive: true });
    await writeFile(
      path.join(jobsRoot, "stale-job", "job.json"),
      JSON.stringify({
        schemaVersion: 1,
        jobId: "stale-job",
        kind: "plate",
        createdAt: new Date().toISOString(),
        request: {
          kind: "plate", subject: "old", zone: "left", model: "flux", count: 1,
          refs: [{ role: "style", path: refFile, contentHash }],
        },
        runs: [],
      }, null, 2) + "\n",
    );
    const res = await run(["rerun", "stale-job"]);
    await expectQualifiedRefusal(res);
    // The stale record is untouched — no run was appended, nothing spent.
    const record = JSON.parse(await readFile(path.join(jobsRoot, "stale-job", "job.json"), "utf8"));
    expect(record.runs).toEqual([]);
  });
});