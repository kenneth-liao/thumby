/**
 * Focused renderer inspection (#59): renderSceneInspection is the canonical
 * inspection render — the exact same render pass as the PNG, measured after
 * crop sizing, fonts, and auto-fit. It returns one RenderedLayer per resolved
 * Layer, in resolved-tree order, each id exactly once, with bounds taken only
 * from the browser DOM: the wrapper element for non-connectors (post-
 * transform, so nested/scaled/rotated/mirrored boxes are Chromium's own
 * measurement) and the connector's rendered path for connectors. Hidden
 * layers — own or ancestor — report visible:false and bounds:null, and the
 * PNG is byte-equal to an ordinary renderScene of the same Scene.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Page } from "playwright";
import { getBrowser } from "../src/browser.js";
import { loadScene, type Scene, type SceneLayer, type LoadResult } from "../src/scene.js";
import { renderScene, renderSceneInspection, layerTree } from "../src/scene-render.js";

// --- fixtures -------------------------------------------------------------

const BG_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720"><rect width="1280" height="720" fill="#10233f"/></svg>`;
/** Intrinsic 200×200 source for the cropped layer (needs declared dimensions). */
const PHOTO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="#3366aa"/><circle cx="100" cy="100" r="80" fill="#ffcc00"/></svg>`;

const layers: SceneLayer[] = [
  { id: "plate", type: "image", asset: "./bg.svg", position: { x: 0, y: 0 }, size: { width: 1280, height: 720 } },
  {
    id: "headline",
    type: "text",
    text: "Inspect every layer",
    font: "Source Sans 3",
    position: { x: 80, y: 60 },
    size: { width: 500, height: 120 },
    autoFit: { min: 24, max: 96 },
    align: "center",
  },
  { id: "badge", type: "shape", shape: "rect", color: "#ff0000", position: { x: 120, y: 300 }, size: { width: 220, height: 140 } },
  { id: "tilt", type: "shape", shape: "rect", color: "#00aa00", position: { x: 400, y: 300 }, size: { width: 200, height: 120 }, rotation: 30 },
  { id: "flip", type: "shape", shape: "rect", color: "#0000ff", position: { x: 700, y: 300 }, size: { width: 180, height: 120 }, mirror: true },
  {
    id: "portrait",
    type: "image",
    asset: "./photo.svg",
    position: { x: 950, y: 120 },
    size: { width: 240, height: 160 },
    crop: { left: 10, top: 20, right: 10, bottom: 20 },
    fit: "cover",
  },
  {
    id: "cluster",
    type: "group",
    position: { x: 300, y: 470 },
    size: { width: 300, height: 180 },
    scale: 1.5,
    layers: [
      { id: "cluster-dot", type: "shape", shape: "ellipse", color: "#ff00ff", position: { x: 20, y: 20 }, size: { width: 80, height: 80 } },
      { id: "cluster-label", type: "text", text: "nested", font: "Source Sans 3", position: { x: 20, y: 110 }, size: { width: 260, height: 50 }, fontSize: 28 },
    ],
  },
  { id: "line", type: "connector", from: "badge", to: "flip", arrow: true, width: 4 },
  { id: "ghost", type: "shape", shape: "rect", color: "#333333", position: { x: 600, y: 500 }, size: { width: 120, height: 80 }, visible: false },
  {
    id: "veil",
    type: "group",
    position: { x: 0, y: 0 },
    size: { width: 400, height: 200 },
    visible: false,
    layers: [
      { id: "veil-inner", type: "shape", shape: "rect", color: "#888888", position: { x: 10, y: 10 }, size: { width: 100, height: 60 } },
    ],
  },
];

const scene = (): Scene => ({ schemaVersion: 1, canvas: { width: 1280, height: 720 }, layers });

let root: string;
let page: Page;
let resolved: Extract<LoadResult, { ok: true }>["resolved"];

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "thumby-inspect-"));
  await writeFile(path.join(root, "bg.svg"), BG_SVG);
  await writeFile(path.join(root, "photo.svg"), PHOTO_SVG);
  const result = await loadScene(root, async () => {
    throw new Error("inspection tests must not reference library assets");
  }, scene());
  if (!result.ok) throw new Error(`fixture scene failed to load: ${JSON.stringify(result.errors)}`);
  resolved = result.resolved;
  const browser = await getBrowser();
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
  });
  await ctx.route("**/*", (route) => route.abort());
  page = await ctx.newPage();
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  await page.context().close();
});

const inspect = () => renderSceneInspection(resolved, { page });

const near = (got: number, want: number, tol = 0.5) => Math.abs(got - want) <= tol;
const nearBox = (
  got: { x: number; y: number; width: number; height: number },
  want: { x: number; y: number; width: number; height: number },
  tol = 0.5,
) =>
  near(got.x, want.x, tol) && near(got.y, want.y, tol) &&
  near(got.width, want.width, tol) && near(got.height, want.height, tol);

// --- the canonical inspection result ----------------------------------------

describe("renderSceneInspection — canonical renderer inspection (#59)", () => {
  it("returns one RenderedLayer per resolved Layer, each id exactly once, in tree order", async () => {
    const { layers: got } = await inspect();
    const expected = [...layerTree(resolved.scene.layers)];
    expect(got).toHaveLength(expected.length);
    expect(got.map((l) => l.id)).toEqual(expected.map((l) => l.id));
    // Every id exactly once — no double report for nested children or targets.
    expect(new Set(got.map((l) => l.id)).size).toBe(got.length);
    expect(got.map((l) => l.type)).toEqual(expected.map((l) => l.type));
    // Spot-check the interesting order facts: group children stay in place,
    // the connector follows its tree position, hidden layers stay listed.
    expect(got.map((l) => l.id)).toEqual([
      "plate", "headline", "badge", "tilt", "flip", "portrait",
      "cluster", "cluster-dot", "cluster-label", "line", "ghost", "veil", "veil-inner",
    ]);
  });

  it("reports visibility through ancestors: own-hidden and ancestor-hidden are false, bounds absent", async () => {
    const { layers: got } = await inspect();
    const byId = new Map(got.map((l) => [l.id, l]));
    expect(byId.get("ghost")!.visible).toBe(false);
    expect(byId.get("veil")!.visible).toBe(false);
    expect(byId.get("veil-inner")!.visible).toBe(false);
    expect(byId.get("ghost")!.bounds).toBeNull();
    expect(byId.get("veil")!.bounds).toBeNull();
    expect(byId.get("veil-inner")!.bounds).toBeNull();
    for (const l of got) {
      if (l.id === "ghost" || l.id === "veil" || l.id === "veil-inner") continue;
      expect(l.visible).toBe(true);
      expect(l.bounds).not.toBeNull();
    }
  });

  it("measures image, text/auto-fit, and shape wrappers exactly", async () => {
    const { layers: got } = await inspect();
    const byId = new Map(got.map((l) => [l.id, l]));
    expect(nearBox(byId.get("plate")!.bounds!, { x: 0, y: 0, width: 1280, height: 720 })).toBe(true);
    // Text/auto-fit: the wrapper box is the layer box — auto-fit shrinks the
    // type inside it, and the measurement runs after that pass.
    expect(nearBox(byId.get("headline")!.bounds!, { x: 80, y: 60, width: 500, height: 120 })).toBe(true);
    expect(nearBox(byId.get("badge")!.bounds!, { x: 120, y: 300, width: 220, height: 140 })).toBe(true);
    // Cropped image: the wrapper is the layer box (the clip window lives inside).
    expect(nearBox(byId.get("portrait")!.bounds!, { x: 950, y: 120, width: 240, height: 160 })).toBe(true);
  });

  it("measures rotated, mirrored, scaled, and nested geometry from the browser transforms", async () => {
    const { layers: got } = await inspect();
    const byId = new Map(got.map((l) => [l.id, l]));
    // 30° rotation about the box center (500,360): the transformed AABB.
    expect(nearBox(byId.get("tilt")!.bounds!, { x: 383.397, y: 258.038, width: 233.205, height: 203.923 })).toBe(true);
    // Mirror changes handedness, not the axis-aligned box.
    expect(nearBox(byId.get("flip")!.bounds!, { x: 700, y: 300, width: 180, height: 120 })).toBe(true);
    // The scaled group wrapper: 300×180 scaled 1.5 about its center (450,560).
    expect(nearBox(byId.get("cluster")!.bounds!, { x: 225, y: 425, width: 450, height: 270 })).toBe(true);
    // A nested child's bounds go through the group's transform, not a
    // second geometry model: group-local (20,20,80,80) under scale 1.5.
    expect(nearBox(byId.get("cluster-dot")!.bounds!, { x: 255, y: 455, width: 120, height: 120 })).toBe(true);
    expect(nearBox(byId.get("cluster-label")!.bounds!, { x: 255, y: 590, width: 390, height: 75 })).toBe(true);
  });

  it("measures a connector by its rendered path, with the arrow's paint represented", async () => {
    const { layers: got } = await inspect();
    const byId = new Map(got.map((l) => [l.id, l]));
    const b = byId.get("line")!.bounds!;
    // The path runs from badge's right edge (~340,368) to flip's left edge
    // (~700,361.6) — never the full-canvas wrapper (0,0,1280,720).
    expect(near(b.x, 340, 10)).toBe(true);
    expect(near(b.width, 360, 20)).toBe(true);
    expect(b.width).toBeLessThan(1280);
    expect(b.y).toBeGreaterThanOrEqual(300);
    expect(b.y).toBeLessThanOrEqual(375);
    // Arrow paint is represented: the bounds reach past the path's known end
    // anchor (x = 700) and past the stroke's own perpendicular extent (the
    // 6.43px fill rise + 4px stroke ≈ 10.4) — the arrowhead's ≈±6.7px
    // perpendicular extent must show up in the measured box.
    expect(b.x + b.width).toBeGreaterThan(700.5);
    expect(b.height).toBeGreaterThanOrEqual(13);
    expect(b.height).toBeLessThanOrEqual(40);
  });

  it("is the same render pass as the PNG: byte-equal to an ordinary renderScene", async () => {
    const inspection = await inspect();
    const plain = await renderScene(resolved, { page });
    expect(inspection.width).toBe(1280);
    expect(inspection.height).toBe(720);
    expect(Buffer.compare(inspection.png, plain.png)).toBe(0);
    expect(inspection.warnings).toEqual(plain.warnings);
  });
});