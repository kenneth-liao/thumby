/**
 * Typed-Reference semantics for Plate and Object effective prompts (#56,
 * US-020/021/023/024, TEST-009/010/013). A reference-capable model receives
 * every attached image role-assigned in the recorded effective prompt: the
 * `edit` role as the source-to-simplify — macrostructure kept, thumbnail-scale
 * detail dropped — and `style` as style-only, with no machine-local path in
 * any model-facing prose. Object generation permits one isolated non-text UI
 * panel; final text, exact official-logo subjects, scenes, and final
 * composites stay banned (ADR-0001, REQ-015). Reruns re-derive the same
 * role-assigned prompt from the recorded typed request.
 *
 * The AI SDK seam is mocked, so the public CLI runs its real production
 * generators and nothing is ever sent to the Gateway (no spend).
 */
import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** What the model actually received, per generateImage call. */
let imageCalls: { prompt: string; images: Uint8Array[] }[] = [];
mock.module("ai", () => ({
  generateImage: async (opts: { prompt: string | { text: string; images: Uint8Array[] } }) => {
    const text = typeof opts.prompt === "string" ? opts.prompt : opts.prompt.text;
    const images = typeof opts.prompt === "string" ? [] : (opts.prompt.images ?? []);
    imageCalls.push({ prompt: text, images });
    return {
      images: [{ base64: Buffer.from(`ref-candidate-${imageCalls.length}`).toString("base64") }],
      warnings: [],
    };
  },
  generateText: async () => {
    throw new Error("the default plate/object path calls generateImage, not generateText");
  },
}));

import { run } from "../src/job-cli.js";
import { generatePlates, generateObjects } from "../src/generate.js";
import type { MatteEngine } from "../src/matte.js";
import { encodePng } from "./png.js";

let root: string;
let jobsRoot: string;
let libraryRoot: string;
let editPath: string;
let editBytes: Buffer;
let stylePath: string;
let styleBytes: Buffer;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "thumby-ref-prompt-"));
  jobsRoot = path.join(root, "jobs");
  libraryRoot = path.join(root, "library");
  await mkdir(libraryRoot, { recursive: true });
  // A real screenshot stand-in: bytes with identities, a path that must never
  // reach model-facing prose.
  editPath = path.join(root, "vscode-screenshot.png");
  editBytes = encodePng(8, 8, () => [40, 40, 60, 255], { colorType: 2 });
  await writeFile(editPath, editBytes);
  stylePath = path.join(root, "palette.png");
  styleBytes = encodePng(8, 8, () => [200, 120, 40, 255], { colorType: 2 });
  await writeFile(stylePath, styleBytes);
  imageCalls = [];
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/**
 * Plate runs never matte and never preflight the engine — the fake engine
 * must never be called by the plate lifecycle.
 */
const unusedMatte: MatteEngine = async () => {
  throw new Error("plate runs never invoke the matting engine");
};

/** Object runs matte every candidate; a fixed fake keeps the pass local and free. */
const objectMatte: MatteEngine = async () => ({
  bytes: encodePng(8, 8, () => [10, 10, 10, 255], { colorType: 2 }),
  engine: "test/fake-matte",
});

/** The recorded run prompt, read back from the job record. */
async function runPrompt(jobId: string, runIndex = 0): Promise<string> {
  const record = JSON.parse(await readFile(path.join(jobsRoot, jobId, "job.json"), "utf8"));
  return record.runs[runIndex]!.fullPrompt as string;
}

describe("plate jobs role-assign typed references (#56)", () => {
  test("an edit reference is identified as the source-to-simplify, with no path leak and no UI ban", async () => {
    const subject = "simplified interface of a code editor, dark theme, neon accent";
    const out = await run(["plates", subject, "--job", "plate-edit-1", "--ref", `edit:${editPath}`], {
      jobsRoot,
      libraryRoot,
      matte: unusedMatte,
    });
    expect(out.exitCode).toBe(0);

    const fp = await runPrompt("plate-edit-1");
    expect(fp).toContain(subject);
    // AC1: the reference is identified by recorded role — and AC2: the edit
    // role is the source whose macrostructure is kept while thumbnail-scale
    // detail is dropped (DEC-014, DEC-016). US-020's semantics are pinned:
    // major panels, proportions, key colors, and visual language survive as
    // a few large high-contrast regions.
    expect(fp).toMatch(/image 1 — edit/);
    expect(fp).toMatch(/macrostructure/i);
    expect(fp).toMatch(/major panels/i);
    expect(fp).toMatch(/key colors/i);
    expect(fp).toMatch(/high-contrast/i);
    expect(fp).toMatch(/simplif/i);
    expect(fp).toMatch(/large/i);
    expect(fp).toMatch(/incidental|small labels|dense text/i);
    // AC1: no machine-local path in model-facing prose.
    expect(fp).not.toContain(editPath);
    expect(fp).not.toContain(path.basename(editPath));
    // What the model received is exactly the recorded prompt, with the
    // reference bytes attached (TEST-010).
    expect(imageCalls).toEqual([{ prompt: fp, images: [editBytes] }]);
    // AC3: a Plate may carry the simplified UI — no contradictory UI ban —
    // while the final-text and exact-logo boundaries stay (ADR-0001).
    expect(fp).not.toMatch(/no ui/i);
    expect(fp).toMatch(/no text/i);
    expect(fp).toMatch(/no logos?/i);

    // The typed identity travels with the job record.
    const record = JSON.parse(await readFile(path.join(jobsRoot, "plate-edit-1", "job.json"), "utf8"));
    expect(record.request.refs).toEqual([
      { role: "edit", path: editPath, contentHash: sha256(editBytes) },
    ]);
  });

  test("a style reference keeps its distinct semantics — look only, never layout", async () => {
    const out = await run(["plates", "a neon city backdrop", "--job", "plate-style-1", "--ref", `style:${stylePath}`], {
      jobsRoot,
      libraryRoot,
      matte: unusedMatte,
    });
    expect(out.exitCode).toBe(0);

    const fp = await runPrompt("plate-style-1");
    expect(fp).toMatch(/image 1 — style/);
    expect(fp).toMatch(/visual style only/i);
    expect(fp).toMatch(/never take layout/i);
    // Style carries no simplification contract — distinct semantics.
    expect(fp).not.toMatch(/macrostructure/i);
  });

  test("every supplied reference is identified, in declared order", async () => {
    const out = await run(
      ["plates", "a developer's dashboard", "--job", "plate-two-refs", "--ref", `edit:${editPath}`, "--ref", `style:${stylePath}`],
      { jobsRoot, libraryRoot, matte: unusedMatte },
    );
    expect(out.exitCode).toBe(0);

    const fp = await runPrompt("plate-two-refs");
    expect(fp).toMatch(/image 1 — edit/);
    expect(fp).toMatch(/image 2 — style/);
  });

  test("a rerun re-derives the same role-assigned prompt and preserves the typed identity", async () => {
    await run(["plates", "simplified terminal ui", "--job", "plate-edit-rerun", "--ref", `edit:${editPath}`], {
      jobsRoot,
      libraryRoot,
      matte: unusedMatte,
    });
    const out = await run(["rerun", "plate-edit-rerun"], { jobsRoot, libraryRoot, matte: unusedMatte });
    expect(out.exitCode).toBe(0);

    const record = JSON.parse(await readFile(path.join(jobsRoot, "plate-edit-rerun", "job.json"), "utf8"));
    expect(record.runs).toHaveLength(2);
    expect(record.runs[1]!.fullPrompt).toBe(record.runs[0]!.fullPrompt);
    expect(record.request.refs[0]!.role).toBe("edit");
    // Both runs actually called the model with the role-assigned prompt and
    // the same reference bytes.
    expect(imageCalls).toHaveLength(2);
    for (const call of imageCalls) expect(call.prompt).toBe(record.runs[0]!.fullPrompt);
  });
});

describe("object jobs permit one isolated non-text UI panel (#56)", () => {
  test("an edit reference identifies the panel source; the UI ban is gone, the isolation contract stays", async () => {
    const subject = "simplified music player panel";
    const out = await run(["objects", subject, "--job", "obj-edit-1", "--ref", `edit:${editPath}`], {
      jobsRoot,
      libraryRoot,
      matte: objectMatte,
    });
    expect(out.exitCode).toBe(0);

    const fp = await runPrompt("obj-edit-1");
    expect(fp).toContain(subject);
    expect(fp).toMatch(/image 1 — edit/);
    expect(fp).toMatch(/macrostructure/i);
    expect(fp).toMatch(/key colors/i);
    expect(fp).toMatch(/high-contrast/i);
    expect(fp).not.toContain(editPath);
    expect(fp).not.toContain(path.basename(editPath));
    // AC4: one isolated non-text UI panel is permitted object content.
    expect(fp).not.toMatch(/no ui/i);
    // …while final text, exact logos, scenes, and final composites stay banned.
    expect(fp).toMatch(/no text/i);
    expect(fp).toMatch(/no logos?/i);
    expect(fp).toMatch(/uniform background/i);
    expect(fp).toMatch(/no composite thumbnail layout/);
    expect(imageCalls[0]!.images).toEqual([editBytes]);

    // AC6: the rerun's recorded prompt carries the same role semantics.
    await run(["rerun", "obj-edit-1"], { jobsRoot, libraryRoot, matte: objectMatte });
    expect(await runPrompt("obj-edit-1", 1)).toBe(await runPrompt("obj-edit-1", 0));
  });

  test("a UI-panel subject survives with no references at all", async () => {
    const out = await run(["objects", "a simplified settings panel", "--job", "obj-ui-1"], {
      jobsRoot,
      libraryRoot,
      matte: objectMatte,
    });
    expect(out.exitCode).toBe(0);

    const fp = await runPrompt("obj-ui-1");
    expect(fp).not.toMatch(/no ui/i);
    expect(fp).toMatch(/no text/i);
    expect(fp).toMatch(/no logos?/i);
  });
});

describe("typed reference semantics below the job boundary", () => {
  test("an identity-typed reference renders the identity manifest line — the legacy thumb mapping", async () => {
    // The legacy `thumb --ref <path>` boundary normalizes its documented
    // likeness paths to role "identity"; the shared manifest then identifies
    // them. This pins that intended prompt change (#56) without touching the
    // legacy backdrop contract.
    const result = await generatePlates({
      subject: "a calm studio wall with soft gradient light",
      model: "gpt-image",
      zone: "left",
      refs: [{ role: "identity", path: editPath }],
      count: 1,
      subjectless: true,
    });
    expect(result.fullPrompt).toMatch(/image 1 — identity/);
    expect(result.fullPrompt).not.toContain(editPath);
    // The legacy backdrop/content contract is otherwise unchanged.
    expect(result.fullPrompt).toMatch(/backdrop only/i);
    expect(result.fullPrompt).toMatch(/no ui elements/i);
  });
});

describe("reference integrity at the generation boundary (#56 review)", () => {
  test("a stale content identity is refused before any provider call", async () => {
    // The request recorded one identity; the bytes on disk answer to another.
    // Generation must refuse — before any spend — instead of sending drifted
    // bytes under the recorded identity.
    const stale = { role: "edit", path: editPath, contentHash: "f".repeat(64) };
    const before = imageCalls.length;
    await expect(
      generatePlates({
        subject: "simplified ui", model: "gpt-image", zone: "left", refs: [stale], count: 2,
      }),
    ).rejects.toThrow(/changed content identity/);
    await expect(
      generateObjects({ subject: "simplified ui", model: "gpt-image", refs: [stale], count: 2 }),
    ).rejects.toThrow(/changed content identity/);
    expect(imageCalls.length).toBe(before);
  });

  test("role lookup is own-property-safe: constructor and unknown roles render label-only", async () => {
    const result = await generatePlates({
      subject: "a plate",
      model: "gpt-image",
      zone: "left",
      refs: [
        { role: "constructor", path: editPath, contentHash: sha256(editBytes) },
        { role: "vibe", path: stylePath, contentHash: sha256(styleBytes) },
      ],
      count: 1,
    });
    // Label-only fallback: no instruction is claimed for unlisted roles, and
    // a role named like an inherited property cannot inject its value into
    // model-facing prose.
    expect(result.fullPrompt).toMatch(/image 1 — constructor$/m);
    expect(result.fullPrompt).toMatch(/image 2 — vibe$/m);
    expect(result.fullPrompt).not.toMatch(/native code/i);
    expect(result.fullPrompt).not.toMatch(/function Object/i);
  });
});