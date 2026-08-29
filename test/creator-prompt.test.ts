import { describe, test, expect } from "bun:test";
import { buildCreatorPrompt, creatorRefOrder } from "../src/generate.js";
import type { TypedRef } from "../src/jobs.js";

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

  test("role-assigns every reference in the effective prompt — provenance preserves the declared role", () => {
    const prompt = buildCreatorPrompt("arms crossed, explaining to camera", ordered);
    // Each reference is numbered and role-labeled in the prompt text itself.
    expect(prompt).toContain("1. identity");
    expect(prompt).toContain("2. identity");
    expect(prompt).toContain("3. style");
    expect(prompt).toContain("4. pose");
    expect(prompt).toContain("anchor-a.png");
    expect(prompt).toContain("pose.png");
  });

  test("carries the tested likeness recipe: copy the face exactly, never blend anchors", () => {
    const prompt = buildCreatorPrompt("deadpan stare", ordered);
    expect(prompt).toMatch(/copy.*face exactly/i);
    expect(prompt).toMatch(/do not (widen|blend)|never.*blend|average/i);
  });

  test("demands one isolated figure on a plain uniform background with true transparency", () => {
    const prompt = buildCreatorPrompt("arms crossed", ordered);
    expect(prompt).toMatch(/isolated/i);
    expect(prompt).toMatch(/uniform background/i);
    expect(prompt).toMatch(/transparen/i);
    expect(prompt).toMatch(/no text|no letters/i);
  });

  test("includes the subject verbatim", () => {
    const prompt = buildCreatorPrompt("unseen pose: presenting at a whiteboard", ordered);
    expect(prompt).toContain("unseen pose: presenting at a whiteboard");
  });
});
