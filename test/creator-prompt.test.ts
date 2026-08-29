import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { buildCreatorPrompt, creatorRefOrder, loadCreatorRefs } from "../src/generate.js";
import type { TypedRef } from "../src/jobs.js";

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

const ref = (role: string, p: string): TypedRef => ({
  role,
  path: p,
  contentHash: "0".repeat(64),
});

describe("creatorRefOrder", () => {
  test("orders identity anchors first and the pose reference last — the tested recipe", () => {
    const ordered = creatorRefOrder([
      ref("pose", "pose.png"),
      ref("identity", "anchor-a.png"),
      ref("style", "style.png"),
      ref("identity", "anchor-b.png"),
      ref("expression", "expr.png"),
    ]);
    expect(ordered.map((r) => r.role)).toEqual([
      "identity",
      "identity",
      "style",
      "expression",
      "pose",
    ]);
    // Anchors keep their declared order among themselves.
    expect(ordered.map((r) => r.path)).toEqual([
      "anchor-a.png",
      "anchor-b.png",
      "style.png",
      "expr.png",
      "pose.png",
    ]);
  });

  test("keeps middle roles (including edit) in declared order between anchors and pose", () => {
    const ordered = creatorRefOrder([
      ref("edit", "src.png"),
      ref("identity", "a.png"),
      ref("outfit", "o.png"),
      ref("pose", "p.png"),
    ]);
    expect(ordered.map((r) => r.path)).toEqual(["a.png", "src.png", "o.png", "p.png"]);
  });

  test("handles anchors-only and pose-only-middle edge orders", () => {
    expect(creatorRefOrder([ref("pose", "p.png"), ref("identity", "a.png")]).map((r) => r.path)).toEqual([
      "a.png",
      "p.png",
    ]);
    expect(creatorRefOrder([ref("identity", "a.png")]).map((r) => r.path)).toEqual(["a.png"]);
  });
});

describe("buildCreatorPrompt", () => {
  const ordered = creatorRefOrder([
    ref("pose", "pose.png"),
    ref("identity", "anchor-a.png"),
    ref("identity", "anchor-b.png"),
    ref("style", "style.png"),
  ]);

  test("role-assigns every reference without sending local paths off-box", () => {
    const prompt = buildCreatorPrompt("arms crossed, explaining to camera", ordered);
    // Each reference is numbered and role-labeled so the model can assign roles
    // by ordinal alone — no local path leaves the machine.
    expect(prompt).toContain("image 1 — identity");
    expect(prompt).toContain("image 2 — identity");
    expect(prompt).toContain("image 3 — style");
    expect(prompt).toContain("image 4 — pose");
    for (const ref of ordered) {
      expect(prompt).not.toContain(ref.path);
      expect(prompt).not.toContain(path.basename(ref.path));
    }
  });

  test("carries the tested likeness recipe: copy the face exactly, never blend anchors", () => {
    const prompt = buildCreatorPrompt("deadpan stare", ordered);
    expect(prompt).toMatch(/copy.*face exactly/i);
    expect(prompt).toMatch(/do not (widen|blend)|never.*blend|average/i);
  });

  test("demands one isolated figure on a plain flat background the matting pass can cut", () => {
    const prompt = buildCreatorPrompt("arms crossed", ordered);
    expect(prompt).toMatch(/isolated/i);
    expect(prompt).toMatch(/uniform, evenly lit background/i);
    expect(prompt).toMatch(/matting pass/i);
    expect(prompt).toMatch(/no text|no letters/i);
  });

  test("never asks the model for transparency — that produced a painted checkerboard", () => {
    const prompt = buildCreatorPrompt("arms crossed", ordered);
    // Transparency is only ever mentioned to forbid faking it.
    expect(prompt).not.toMatch(/true transparency/i);
    expect(prompt).toMatch(/do not paint a checkerboard/i);
  });

  test("includes the subject verbatim", () => {
    const prompt = buildCreatorPrompt("unseen pose: presenting at a whiteboard", ordered);
    expect(prompt).toContain("unseen pose: presenting at a whiteboard");
  });
});

describe("loadCreatorRefs", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "thumby-creator-refs-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("returns the exact bytes a recorded identity was derived from", async () => {
    const file = path.join(root, "anchor.png");
    const bytes = Buffer.from("anchor-bytes");
    await writeFile(file, bytes);
    const loaded = await loadCreatorRefs([{ role: "identity", path: file, contentHash: sha256(bytes) }]);
    expect(loaded).toHaveLength(1);
    expect(Buffer.from(loaded[0]!.bytes).equals(bytes)).toBe(true);
    expect(loaded[0]!.path).toBe(file);
  });

  test("refuses a reference whose bytes drifted from the recorded identity", async () => {
    const file = path.join(root, "anchor.png");
    await writeFile(file, "new-bytes");
    await expect(
      loadCreatorRefs([{ role: "identity", path: file, contentHash: "a".repeat(64) }]),
    ).rejects.toThrow(/changed content identity/);
  });

  test("refuses a missing reference before any generation call", async () => {
    await expect(
      loadCreatorRefs([{ role: "pose", path: path.join(root, "gone.png") }]),
    ).rejects.toThrow(/gone\.png.*missing/i);
  });
});
