import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Page } from "playwright";
import { getBrowser } from "../src/browser.js";
import { type Scene, type SceneLayer, type ResolvedScene } from "../src/scene.js";
import { scenePageHtml, guidelinePageHtml, renderScene, renderGuidelines } from "../src/scene-render.js";
import { PROTECTED_REGIONS, findSafeAreaViolations, safeAreaWarnings } from "../src/safe-area.js";
import type { Box } from "../src/scene-geometry.js";
import { run as cliRun } from "../src/scene-cli.js";
import { renderOutputConflict } from "../src/manifest.js";
import { decodePng } from "./png.js";

// --- fixtures -------------------------------------------------------------

interface Fix {
  root: string;
  projectRoot: string;
  sceneFile: string;
}

let fix: Fix;
let page: Page;

beforeAll(async () => {
  const root = await mkdtemp(path.join(tmpdir(), "thumby-safe-area-"));
  const projectRoot = path.join(root, "project");
  await mkdir(projectRoot, { recursive: true });
  fix = { root, projectRoot, sceneFile: path.join(projectRoot, "scene.json") };
  // One route-blocked page for every pixel test: fewer browser lifecycles to
  // flake, and every render is proven offline by construction.
  const browser = await getBrowser();
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
  });
  await ctx.route("**/*", (route) => route.abort());
  page = await ctx.newPage();
});

afterAll(async () => {
  await rm(fix.root, { recursive: true, force: true });
  await page.context().close();
});

/** A shape-only scene loads through the gate with no assets or fonts involved. */
const shape = (over: Record<string, unknown> = {}): SceneLayer => ({
  id: "box",
  type: "shape",
  shape: "rect",
  color: "#ff0000",
  position: { x: 100, y: 100 },
  size: { width: 200, height: 100 },
  ...over,
});

const scene = (layers: SceneLayer[]): Scene => ({
  schemaVersion: 1,
  canvas: { width: 1280, height: 720 },
  layers,
});

/**
 * A synchronous ResolvedScene for the pure-geometry tests — the scene documents
 * are shape-only and valid by construction, and the load gate itself is
 * exercised by the CLI tests below.
 */
const resolved = (layers: SceneLayer[]): ResolvedScene => ({ scene: scene(layers), assets: new Map(), masks: new Map() });

// --- the one definition ------------------------------------------------------

describe("PROTECTED_REGIONS", () => {
  it("defines the duration badge and progress bar once, anchored to the 1280×720 edges", () => {
    expect(PROTECTED_REGIONS.map((r) => r.id)).toEqual(["duration-badge", "progress-bar"]);
    const badge = PROTECTED_REGIONS.find((r) => r.id === "duration-badge")!;
    expect(badge.box.x + badge.box.width).toBe(1280);
    expect(badge.box.y + badge.box.height).toBe(720);
    const progress = PROTECTED_REGIONS.find((r) => r.id === "progress-bar")!;
    expect(progress.box.x).toBe(0);
    expect(progress.box.width).toBe(1280);
    expect(progress.box.y + progress.box.height).toBe(720);
    for (const r of PROTECTED_REGIONS) {
      expect(r.box.width).toBeGreaterThan(0);
      expect(r.box.height).toBeGreaterThan(0);
      expect(r.box.x).toBeGreaterThanOrEqual(0);
      expect(r.box.y).toBeGreaterThanOrEqual(0);
      expect(r.box.x + r.box.width).toBeLessThanOrEqual(1280);
      expect(r.box.y + r.box.height).toBeLessThanOrEqual(720);
    }
  });
});

// --- violation geometry -------------------------------------------------------

describe("findSafeAreaViolations", () => {
  it("flags a visible layer inside the duration-badge region, naming layer and region", () => {
    const v = findSafeAreaViolations(resolved([shape({ id: "sticker", position: { x: 1150, y: 660 }, size: { width: 100, height: 40 } })]));
    expect(v).toHaveLength(1);
    expect(v[0]!.layer).toBe("sticker");
    expect(v[0]!.region).toBe("duration-badge");
  });

  it("flags a visible layer inside the progress-bar region", () => {
    const v = findSafeAreaViolations(resolved([shape({ id: "strip", position: { x: 500, y: 710 }, size: { width: 100, height: 8 } })]));
    expect(v).toHaveLength(1);
    expect(v[0]!.layer).toBe("strip");
    expect(v[0]!.region).toBe("progress-bar");
  });

  it("reports no violations for layers outside the protected regions", () => {
    const v = findSafeAreaViolations(resolved([shape({ position: { x: 100, y: 100 } })]));
    expect(v).toEqual([]);
  });

  it("does not violate on exact edge contact — overlap must be strict", () => {
    // Box corner exactly touching both region corners (1088, 656).
    const v = findSafeAreaViolations(resolved([shape({ position: { x: 1000, y: 600 }, size: { width: 88, height: 56 } })]));
    expect(v).toEqual([]);
  });

  it("ignores hidden layers", () => {
    const v = findSafeAreaViolations(resolved([shape({ position: { x: 1150, y: 660 }, size: { width: 100, height: 40 }, visible: false })]));
    expect(v).toEqual([]);
  });

  it("ignores fully transparent layers", () => {
    const v = findSafeAreaViolations(resolved([shape({ position: { x: 1150, y: 660 }, size: { width: 100, height: 40 }, opacity: 0 })]));
    expect(v).toEqual([]);
  });

  it("names the group child that lands in a region, not the group", () => {
    const v = findSafeAreaViolations(
      resolved([
        {
          id: "card",
          type: "group",
          position: { x: 0, y: 0 },
          size: { width: 600, height: 600 },
          layers: [shape({ id: "kid", position: { x: 1100, y: 660 }, size: { width: 100, height: 30 } })],
        },
      ]),
    );
    expect(v).toHaveLength(1);
    expect(v[0]!.layer).toBe("kid");
    expect(v[0]!.region).toBe("duration-badge");
  });

  it("applies group scale before testing the child's frame position", () => {
    // Scale 3 around the group center pushes the child into the badge region;
    // at scale 1 the same child stays outside.
    const group = (scale: number) => ({
      id: "card",
      type: "group" as const,
      position: { x: 0, y: 0 },
      size: { width: 400, height: 400 },
      scale,
      layers: [shape({ id: "kid", position: { x: 500, y: 360 }, size: { width: 40, height: 20 } })],
    });
    expect(findSafeAreaViolations(resolved([group(1)])).map((v) => v.layer)).toEqual([]);
    const v = findSafeAreaViolations(resolved([group(3)]));
    expect(v.some((x) => x.layer === "kid" && x.region === "duration-badge")).toBe(true);
  });

  it("uses the rotated bounding box — a 45° turn reaches a region the authored box misses", () => {
    const base = { id: "tag", position: { x: 980, y: 540 }, size: { width: 100, height: 100 } };
    expect(findSafeAreaViolations(resolved([shape(base)])).map((v) => v.layer)).toEqual([]);
    const v = findSafeAreaViolations(resolved([shape({ ...base, rotation: 45 })]));
    expect(v.some((x) => x.layer === "tag" && x.region === "duration-badge")).toBe(true);
  });

  it("checks connector paths, including the bow's extent", () => {
    const targets = [
      shape({ id: "a", position: { x: 100, y: 600 }, size: { width: 100, height: 40 } }),
      shape({ id: "b", position: { x: 500, y: 600 }, size: { width: 100, height: 40 } }),
    ];
    const connector = { id: "wire", type: "connector" as const, from: "a", to: "b" };
    expect(findSafeAreaViolations(resolved([...targets, connector])).map((v) => v.layer)).toEqual([]);
    // A downward bow pushes the curve's midpoint to y 720 — into the progress strip.
    const v = findSafeAreaViolations(resolved([...targets, { ...connector, bow: 100 }]));
    expect(v.some((x) => x.layer === "wire" && x.region === "progress-bar")).toBe(true);
  });

  // --- paint extents beyond the nominal box (the renderer paints there) ---

  it("counts a shape border's outside half", () => {
    // The box sits 6px short of the badge region; a 14px border paints 7px out.
    const base = { id: "framed", position: { x: 1000, y: 600 }, size: { width: 88, height: 55 } };
    expect(findSafeAreaViolations(resolved([shape(base)])).map((v) => v.layer)).toEqual([]);
    const v = findSafeAreaViolations(resolved([shape({ ...base, border: { width: 14, color: "#000" } })]));
    expect(v.some((x) => x.layer === "framed" && x.region === "duration-badge")).toBe(true);
  });

  it("counts text stroke and shadows", () => {
    const text = (over: Record<string, unknown>) => ({
      id: "word",
      type: "text" as const,
      text: "Hi",
      font: "Anton",
      fontSize: 40,
      position: { x: 1000, y: 600 },
      size: { width: 88, height: 55 },
      ...over,
    });
    expect(findSafeAreaViolations(resolved([text({})])).map((v) => v.layer)).toEqual([]);
    const stroked = findSafeAreaViolations(resolved([text({ stroke: { width: 20, color: "#000" } })]));
    expect(stroked.some((x) => x.layer === "word" && x.region === "duration-badge")).toBe(true);
    const shadowed = findSafeAreaViolations(
      resolved([text({ shadows: [{ x: 0, y: 0, blur: 30, color: "#000000" }] })]),
    );
    expect(shadowed.some((x) => x.layer === "word" && x.region === "duration-badge")).toBe(true);
  });

  it("counts image effect blur and directional drop-shadow offsets", () => {
    // Base box touches x 1088 exactly (no strict overlap) but reaches into
    // the badge's y band, so any x-direction pad tips it into the region.
    const image = (over: Record<string, unknown>) => ({
      id: "pic",
      type: "image" as const,
      asset: "./pic.png",
      position: { x: 1000, y: 600 },
      size: { width: 88, height: 60 },
      ...over,
    });
    expect(findSafeAreaViolations(resolved([image({})])).map((v) => v.layer)).toEqual([]);
    const shadowed = findSafeAreaViolations(
      resolved([image({ effects: { shadow: { x: 40, y: 0, blur: 0, color: "#000000" } } })]),
    );
    expect(shadowed).toHaveLength(1);
    expect(shadowed[0]!.region).toBe("duration-badge");
    const blurred = findSafeAreaViolations(resolved([image({ effects: { blur: 30 } })]));
    expect(blurred.some((x) => x.layer === "pic" && x.region === "duration-badge")).toBe(true);
  });

  it("counts the connector's stroke and auto-oriented arrowhead", () => {
    // The path runs along y 690; a 5px stroke stays 2.5px clear of the
    // progress strip, but the arrowhead paints arrowPad(5) = 15px past its
    // anchor — across the 704 boundary.
    const targets = [
      shape({ id: "a", position: { x: 100, y: 680 }, size: { width: 100, height: 20 } }),
      shape({ id: "b", position: { x: 500, y: 680 }, size: { width: 100, height: 20 } }),
    ];
    const connector = { id: "wire", type: "connector" as const, from: "a", to: "b", width: 5 };
    expect(findSafeAreaViolations(resolved([...targets, connector])).map((v) => v.layer)).toEqual([]);
    const v = findSafeAreaViolations(resolved([...targets, { ...connector, arrow: true }]));
    expect(v.some((x) => x.layer === "wire" && x.region === "progress-bar")).toBe(true);
  });

  it("inherits a group's effects pad down to its children", () => {
    // The child's frame box is clear of every region; the group's 80px blur
    // pushes its shadow 80px beyond it — across the badge's y boundary.
    const group = (effects?: Record<string, unknown>) => ({
      id: "card",
      type: "group" as const,
      position: { x: 0, y: 0 },
      size: { width: 600, height: 600 },
      ...(effects ? { effects } : {}),
      layers: [shape({ id: "kid", position: { x: 1100, y: 560 }, size: { width: 40, height: 20 } })],
    });
    expect(findSafeAreaViolations(resolved([group()])).map((v) => v.layer)).toEqual([]);
    const v = findSafeAreaViolations(resolved([group({ shadow: { x: 0, y: 0, blur: 80, color: "#000000" } })]));
    expect(v.some((x) => x.layer === "kid" && x.region === "duration-badge")).toBe(true);
  });

  it("carries directional pads through rotation — a local shadow offset rotates into frame axes", () => {
    // The 88×55 box rotated 90° spans x 1016.5–1071.5, y 543.5–631.5: clear
    // of every region. A shadow offset (x: 40, y: −40) in the layer's local
    // frame rotates into frame +y and +x, truly painting into the badge
    // region — the pads must rotate with the layer.
    const image = {
      id: "pic",
      type: "image" as const,
      asset: "./pic.png",
      position: { x: 1000, y: 560 },
      size: { width: 88, height: 55 },
      rotation: 90,
    };
    expect(findSafeAreaViolations(resolved([image])).map((v) => v.layer)).toEqual([]);
    const v = findSafeAreaViolations(
      resolved([{ ...image, effects: { shadow: { x: 40, y: -40, blur: 0, color: "#000000" } } }]),
    );
    expect(v.some((x) => x.layer === "pic" && x.region === "duration-badge")).toBe(true);
  });

  it("scales a group's effects pad with the group's scale", () => {
    // The child's frame box sits clear of the badge region; scale 0.5 halves
    // the group's 80px blur to a 40px frame pad, which reaches it.
    const group = (scale: number) => ({
      id: "card",
      type: "group" as const,
      position: { x: 0, y: 0 },
      size: { width: 800, height: 800 },
      scale,
      effects: { shadow: { x: 0, y: 0, blur: 80, color: "#000000" } },
      layers: [shape({ id: "kid", position: { x: 1700, y: 880 }, size: { width: 40, height: 30 } })],
    });
    // scale 1: frame box (1700,880) is off-canvas; scale 0.5 puts it at
    // (1050,640)-(1070,655) — clear of every region before the pad.
    const v = findSafeAreaViolations(resolved([group(0.5)]));
    expect(v.some((x) => x.layer === "kid" && x.region === "duration-badge")).toBe(true);
  });

  // --- chained and nested paint composes additively, not by maximum -------

  it("accumulates a layer's own filter chain — blur then shadow compose, not max", () => {
    // The 60×60 box ends 70px short of the badge's x edge. A 20px blur paints
    // 60px out (3σ) and a 20px rightward shadow 20px — either alone stays
    // clear. The renderer emits one CSS filter chain, so chained the shadow
    // paints from the blurred output and reaches 80px, across the 1088 edge.
    const image = (effects: Record<string, unknown>) => ({
      id: "pic",
      type: "image" as const,
      asset: "./pic.png",
      position: { x: 958, y: 580 },
      size: { width: 60, height: 60 },
      effects,
    });
    expect(findSafeAreaViolations(resolved([image({ blur: 20 })])).map((v) => v.layer)).toEqual([]);
    expect(
      findSafeAreaViolations(resolved([image({ shadow: { x: 20, y: 0, blur: 0, color: "#000" } })])).map((v) => v.layer),
    ).toEqual([]);
    const v = findSafeAreaViolations(
      resolved([image({ blur: 20, shadow: { x: 20, y: 0, blur: 0, color: "#000" } })]),
    );
    expect(v.some((x) => x.layer === "pic" && x.region === "duration-badge")).toBe(true);
  });

  it("accumulates chained child and group effects — a group's filter paints on its children's output", () => {
    // A 20px rightward image shadow inside a group with its own 20px
    // rightward shadow paints to x 1100 from a nominal box ending at 1060 —
    // across the badge's 1088 edge — though either alone stays at 1080.
    const shadow = { shadow: { x: 20, y: 0, blur: 0, color: "#000" } };
    const image = (effects?: Record<string, unknown>) => ({
      id: "pic",
      type: "image" as const,
      asset: "./pic.png",
      position: { x: 1000, y: 620 },
      size: { width: 60, height: 60 },
      ...(effects ? { effects } : {}),
    });
    const group = (effects?: Record<string, unknown>, childEffects?: Record<string, unknown>) => ({
      id: "card",
      type: "group" as const,
      position: { x: 0, y: 0 },
      size: { width: 600, height: 600 },
      ...(effects ? { effects } : {}),
      layers: [image(childEffects)],
    });
    expect(findSafeAreaViolations(resolved([group(undefined, shadow)])).map((v) => v.layer)).toEqual([]);
    expect(findSafeAreaViolations(resolved([group(shadow)])).map((v) => v.layer)).toEqual([]);
    const v = findSafeAreaViolations(resolved([group(shadow, shadow)]));
    expect(v.some((x) => x.layer === "pic" && x.region === "duration-badge")).toBe(true);
  });

  it("accumulates nested group effects down the tree", () => {
    // Two nested groups each add a 20px rightward shadow: 40px of paint past
    // the box — across the badge's edge — though one level alone stays at 1080.
    const leaf = {
      id: "pic",
      type: "image" as const,
      asset: "./pic.png",
      position: { x: 1000, y: 620 },
      size: { width: 60, height: 60 },
    };
    const shadow = { shadow: { x: 20, y: 0, blur: 0, color: "#000" } };
    const wrap = (id: string, effects: Record<string, unknown> | undefined, layers: SceneLayer[]) => ({
      id,
      type: "group" as const,
      position: { x: 0, y: 0 },
      size: { width: 600, height: 600 },
      ...(effects ? { effects } : {}),
      layers,
    });
    expect(findSafeAreaViolations(resolved([wrap("outer", shadow, [leaf])])).map((v) => v.layer)).toEqual([]);
    const v = findSafeAreaViolations(resolved([wrap("outer", shadow, [wrap("inner", shadow, [leaf])])]));
    expect(v.some((x) => x.layer === "pic" && x.region === "duration-badge")).toBe(true);
  });

  it("collapses a directional group pad that crosses an ancestor's rotation", () => {
    // The leaf's frame box is clear of every region. The inner group's 40px
    // rightward shadow points along the rotating outer group's local x — which
    // maps to frame +y — so its painted extent reaches frame y 730, across the
    // progress strip's 704 edge. Uncollapsed, the pad would pad frame x only
    // and the violation would be missed.
    const outer = {
      id: "tilt",
      type: "group" as const,
      position: { x: 400, y: 400 },
      size: { width: 400, height: 200 },
      rotation: 90,
      layers: [{
        id: "card",
        type: "group" as const,
        position: { x: 0, y: 0 },
        size: { width: 400, height: 200 },
        effects: { shadow: { x: 40, y: 0, blur: 0, color: "#000" } },
        layers: [shape({ id: "kid", position: { x: 370, y: 90 }, size: { width: 20, height: 10 } })],
      }],
    };
    expect(
      findSafeAreaViolations(
        resolved([{ ...outer, layers: [{ ...outer.layers[0]!, effects: undefined }] }]),
      ).map((v) => v.layer),
    ).toEqual([]);
    const v = findSafeAreaViolations(resolved([outer]));
    expect(v.some((x) => x.layer === "kid" && x.region === "progress-bar")).toBe(true);
  });
});

// --- the strings renders surface -----------------------------------------------

describe("safeAreaWarnings", () => {
  it("turns violations into actionable warnings naming the layer and the region", () => {
    const w = safeAreaWarnings(resolved([shape({ id: "sticker", position: { x: 1150, y: 660 }, size: { width: 100, height: 40 } })]));
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('safe-area: visible layer "sticker"');
    expect(w[0]).toContain("duration-badge");
  });

  it("is empty when nothing intersects", () => {
    expect(safeAreaWarnings(resolved([shape({ position: { x: 100, y: 100 } })]))).toEqual([]);
  });
});

// --- the guideline view ---------------------------------------------------------

describe("guideline page html", () => {
  it("adds one overlay per protected region, and the plain page has none", () => {
    const html = scenePageHtml(resolved([shape({ position: { x: 100, y: 100 } })]));
    expect(html).not.toContain("safe-guide");
    expect(html).not.toContain("duration-badge");
    const guided = guidelinePageHtml(resolved([shape({ position: { x: 100, y: 100 } })]), new Map());
    expect(guided).toContain("safe-guide");
    expect(guided).toContain('data-region-id="duration-badge"');
    expect(guided).toContain('data-region-id="progress-bar"');
  });
});

// --- the CLI surface -------------------------------------------------------------

describe("scene CLI", () => {
  const writeScene = async (name: string, layers: SceneLayer[]) => {
    const file = path.join(fix.projectRoot, name);
    await writeFile(file, JSON.stringify(scene(layers), null, 2));
    return file;
  };

  it("validate reports structured safeAreaViolations", async () => {
    const file = await writeScene("violating.json", [
      shape({ id: "sticker", position: { x: 1150, y: 660 }, size: { width: 100, height: 40 } }),
    ]);
    const { exitCode, output } = await cliRun(["validate", file]);
    expect(exitCode).toBe(0);
    const o = output as {
      ok: boolean;
      safeAreaViolations: {
        layer: string;
        region: string;
        box: { x: number; y: number; width: number; height: number };
        regionBox: { x: number; y: number; width: number; height: number };
      }[];
    };
    expect(o.ok).toBe(true);
    expect(o.safeAreaViolations).toEqual([
      {
        layer: "sticker",
        region: "duration-badge",
        box: { x: 1150, y: 660, width: 100, height: 40 },
        regionBox: PROTECTED_REGIONS.find((r) => r.id === "duration-badge")!.box,
      },
    ]);
  });

  it("validate reports an empty array when nothing intersects", async () => {
    const file = await writeScene("clean.json", [shape({ position: { x: 100, y: 100 } })]);
    const { exitCode, output } = await cliRun(["validate", file]);
    expect(exitCode).toBe(0);
    expect((output as { safeAreaViolations: unknown[] }).safeAreaViolations).toEqual([]);
  });

  it("render surfaces safe-area violations as warnings in the output and manifest", async () => {
    const file = await writeScene("render-warn.json", [
      shape({ id: "sticker", position: { x: 1150, y: 660 }, size: { width: 100, height: 40 } }),
    ]);
    const { exitCode, output } = await cliRun(["render", file]);
    expect(exitCode).toBe(0);
    const o = output as { ok: boolean; warnings: string[]; manifest: string };
    expect(o.warnings.some((w) => w.includes('safe-area: visible layer "sticker"'))).toBe(true);
    const manifest = JSON.parse(await readFile(o.manifest, "utf8")) as { outputs: { warnings: string[] }[] };
    expect(manifest.outputs[0]!.warnings.some((w) => w.includes('safe-area: visible layer "sticker"'))).toBe(true);
  });

  it("render output carries no safe-area warnings when nothing intersects", async () => {
    const file = await writeScene("render-clean.json", [shape({ position: { x: 100, y: 100 } })]);
    const { output } = await cliRun(["render", file]);
    expect((output as { warnings: string[] }).warnings).toEqual([]);
  });

  it("variant renders surface safe-area warnings too (renderScene owns the merge)", async () => {
    const file = path.join(fix.projectRoot, "variant-warn.json");
    await writeFile(
      file,
      JSON.stringify(
        {
          ...scene([shape({ id: "sticker", position: { x: 1150, y: 660 }, size: { width: 100, height: 40 } })]),
          variants: { alt: { changes: [{ layer: "sticker", set: { opacity: 1 } }] } },
        },
        null,
        2,
      ),
    );
    const { exitCode, output } = await cliRun(["render", file, "--variant", "alt"]);
    expect(exitCode).toBe(0);
    const o = output as { ok: boolean; outputs: { warnings: string[] }[]; manifest: string };
    expect(o.outputs[0]!.warnings.some((w) => w.includes('safe-area: visible layer "sticker"'))).toBe(true);
    const manifest = JSON.parse(await readFile(o.manifest, "utf8")) as { outputs: { warnings: string[] }[] };
    expect(manifest.outputs[0]!.warnings.some((w) => w.includes('safe-area: visible layer "sticker"'))).toBe(true);
  });

  it("rerender surfaces safe-area warnings from a fresh render, not the manifest's stale copy", async () => {
    const file = await writeScene("rerender-warn.json", [
      shape({ id: "sticker", position: { x: 1150, y: 660 }, size: { width: 100, height: 40 } }),
    ]);
    const rendered = await cliRun(["render", file]);
    expect(rendered.exitCode).toBe(0);
    const manifest = (rendered.output as { manifest: string }).manifest;
    const rerun = await cliRun(["rerender", manifest]);
    expect(rerun.exitCode).toBe(0);
    const o = rerun.output as { ok: boolean; outputs: { warnings: string[] }[] };
    expect(o.outputs[0]!.warnings.some((w) => w.includes('safe-area: visible layer "sticker"'))).toBe(true);
  });

  it("guidelines writes the overlay view to its own file, never the final output", async () => {
    const file = await writeScene("guide.json", [shape({ position: { x: 100, y: 100 } })]);
    const rendered = await cliRun(["render", file]);
    expect(rendered.exitCode).toBe(0);
    const finalOut = (rendered.output as { output: string }).output;
    const guided = await cliRun(["guidelines", file]);
    expect(guided.exitCode).toBe(0);
    const o = guided.output as { ok: boolean; output: string; regions: { id: string }[] };
    expect(o.ok).toBe(true);
    expect(o.output).not.toBe(finalOut);
    expect(o.output.endsWith("guide.guidelines.png")).toBe(true);
    expect(o.regions.map((r) => r.id)).toEqual(["duration-badge", "progress-bar"]);

    // The guideline view shows the overlay; the final output does not.
    const guidedPx = decodePng(await readFile(o.output));
    const finalPx = decodePng(await readFile(finalOut));
    // Inside the progress-bar region: the overlay tints the white background magenta.
    const inRegion = guidedPx.px(640, 712);
    expect(inRegion[0]).toBe(255);
    expect(inRegion[1]).toBeLessThan(250);
    expect(inRegion[2]).toBe(255);
    expect(finalPx.px(640, 712)).toEqual([255, 255, 255, 255]);
  });

  it("guidelines supports --out with the same containment rule as render", async () => {
    const file = await writeScene("guide-out.json", [shape({ position: { x: 100, y: 100 } })]);
    const bad = await cliRun(["guidelines", file, "--out", path.join(fix.root, "escaped.png")]);
    expect(bad.exitCode).toBe(2);
    const good = await cliRun(["guidelines", file, "--out", path.join(fix.projectRoot, "out", "custom.png")]);
    expect(good.exitCode).toBe(0);
    expect((good.output as { output: string }).output.endsWith("custom.png")).toBe(true);
  });

  it("guidelines without a scene file is a usage error", async () => {
    const { exitCode } = await cliRun(["guidelines"]);
    expect(exitCode).toBe(2);
  });

  it("guidelines refuses to overwrite a final Render output, bytes untouched", async () => {
    const file = await writeScene("collision.json", [shape({ position: { x: 100, y: 100 } })]);
    const rendered = await cliRun(["render", file]);
    expect(rendered.exitCode).toBe(0);
    const finalOut = (rendered.output as { output: string }).output;
    const before = await readFile(finalOut);
    const guided = await cliRun(["guidelines", file, "--out", finalOut]);
    expect(guided.exitCode).toBe(1);
    const o = guided.output as { ok: boolean; errors: { path: string; message: string }[] };
    expect(o.ok).toBe(false);
    expect(o.errors[0]!.message).toContain("Render output");
    expect(await readFile(finalOut)).toEqual(before);
  });

  it("guidelines refuses its default name when a render has claimed it via --out", async () => {
    const file = await writeScene("claimed.json", [shape({ position: { x: 100, y: 100 } })]);
    const claimed = path.join(fix.projectRoot, "out", "claimed.guidelines.png");
    const rendered = await cliRun(["render", file, "--out", claimed]);
    expect(rendered.exitCode).toBe(0);
    const guided = await cliRun(["guidelines", file]);
    expect(guided.exitCode).toBe(1);
    expect((guided.output as { errors: { message: string }[] }).errors[0]!.message).toContain("Render output");
    const before = await readFile(claimed);
    const guidedAgain = await cliRun(["guidelines", file, "--out", claimed]);
    expect(guidedAgain.exitCode).toBe(1);
    expect(await readFile(claimed)).toEqual(before);
  });

  it("guidelines refuses a multi-Variant batch output recorded in the shared variants manifest, bytes untouched", async () => {
    // A batch records every output in one <scene>.variants.manifest.json —
    // no manifest sits beside out/scene.alt.png — so the guard must consult
    // every manifest in the directory, not just the adjacent name.
    const file = path.join(fix.projectRoot, "batch-collision.json");
    await writeFile(
      file,
      JSON.stringify(
        {
          ...scene([shape({ position: { x: 100, y: 100 } })]),
          variants: {
            alt: { changes: [{ layer: "box", set: { opacity: 1 } }] },
            zoom: { changes: [{ layer: "box", set: { color: "#0000ff" } }] },
          },
        },
        null,
        2,
      ),
    );
    const rendered = await cliRun(["render", file, "--variant", "alt,zoom"]);
    expect(rendered.exitCode).toBe(0);
    const o = rendered.output as { ok: boolean; outputs: { output: string }[]; manifest: string };
    expect(o.outputs).toHaveLength(2);
    expect(o.manifest.endsWith("batch-collision.variants.manifest.json")).toBe(true);
    const batchOut = o.outputs[0]!.output;
    const before = await readFile(batchOut);
    const guided = await cliRun(["guidelines", file, "--out", batchOut]);
    expect(guided.exitCode).toBe(1);
    const g = guided.output as { ok: boolean; errors: { message: string }[] };
    expect(g.ok).toBe(false);
    expect(g.errors[0]!.message).toContain("Render output");
    expect(await readFile(batchOut)).toEqual(before);
    // The batch contact sheet is manifest-recorded too — equally untouchable.
    const contact = path.join(fix.projectRoot, "out", "batch-collision.contact.png");
    const beforeContact = await readFile(contact);
    const guidedContact = await cliRun(["guidelines", file, "--out", contact]);
    expect(guidedContact.exitCode).toBe(1);
    expect(await readFile(contact)).toEqual(beforeContact);
  });

  it("guidelines refuses a symlink aliasing a final Render output, bytes untouched", async () => {
    // writeFile follows symlinks, so a lexical path comparison guards a name,
    // not the file the write lands on: out/alias.png -> out/symlinked.png
    // reaches the Render's bytes under a name no manifest records.
    const file = await writeScene("symlinked.json", [shape({ position: { x: 100, y: 100 } })]);
    const rendered = await cliRun(["render", file]);
    expect(rendered.exitCode).toBe(0);
    const finalOut = (rendered.output as { output: string }).output;
    const alias = path.join(path.dirname(finalOut), "alias.png");
    await symlink(path.basename(finalOut), alias);
    const before = await readFile(finalOut);
    const guided = await cliRun(["guidelines", file, "--out", alias]);
    expect(guided.exitCode).toBe(1);
    const o = guided.output as { ok: boolean; errors: { message: string }[] };
    expect(o.ok).toBe(false);
    expect(o.errors[0]!.message).toContain("Render output");
    expect(await readFile(finalOut)).toEqual(before);
  });

});

describe("renderOutputConflict", () => {
  it("reports no conflict for a directory that does not exist", async () => {
    const missing = path.join(fix.root, "no-such-dir", "g.png");
    expect(await renderOutputConflict(missing)).toBeUndefined();
  });

  it("fails closed when the directory cannot be read — only absence means nothing is recorded", async () => {
    // A permission or I/O failure answers nothing about what is recorded
    // there. Returning "no conflict" would let a guideline write proceed on
    // an unanswered question; the read must propagate instead.
    const locked = path.join(fix.root, "locked");
    await mkdir(locked, { recursive: true });
    await chmod(locked, 0o000);
    try {
      await expect(renderOutputConflict(path.join(locked, "g.png"))).rejects.toThrow();
    } finally {
      await chmod(locked, 0o755);
    }
  });
});

// --- the geometry against Chromium's real paint -----------------------------------

/**
 * The axis-aligned box covering every pixel the render actually painted (the
 * canvas is white where nothing paints). The ground truth a footprint must
 * contain — measuring it is the only way to catch a bound that assumes the
 * wrong blur convention, which no pure-geometry test can see.
 */
function paintedBox(png: Buffer): Box {
  const img = decodePng(png);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let y = 0; y < img.height; y++)
    for (let x = 0; x < img.width; x++) {
      const [r, g, b] = img.px(x, y);
      if (r === 255 && g === 255 && b === 255) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

const overlaps = (a: Box, b: Box): boolean =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

describe("blur-bearing paint extents match Chromium", () => {
  // A 100×60 box whose right edge sits at x 1058 — 30px clear of the duration
  // badge — inside a group carrying the effect. The authored box violates
  // nothing; only the blur's real paint reaches the region, so each case
  // proves the bound, not the box. Chromium takes `filter: blur(N)` and
  // `filter: drop-shadow(x y N)` lengths as σ, and `text-shadow`'s as 2σ, and
  // paints out to ~2.45σ — a bound of the authored length alone under-counts.
  const clearOfBadge = { position: { x: 958, y: 610 }, size: { width: 100, height: 60 } };
  const badge = PROTECTED_REGIONS.find((r) => r.id === "duration-badge")!;

  const grouped = (effects: Record<string, unknown>): SceneLayer =>
    ({
      id: "card",
      type: "group",
      position: { x: 0, y: 0 },
      size: { width: 1280, height: 720 },
      effects,
      layers: [shape({ id: "hero", ...clearOfBadge })],
    }) as SceneLayer;

  const cases: { name: string; layer: SceneLayer; painter: string }[] = [
    { name: "filter blur", layer: grouped({ blur: 20 }), painter: "hero" },
    { name: "glow radius", layer: grouped({ glow: { radius: 20, color: "#0000ff" } }), painter: "hero" },
    {
      name: "drop-shadow blur",
      layer: grouped({ shadow: { x: 0, y: 0, blur: 20, color: "#0000ff" } }),
      painter: "hero",
    },
    {
      name: "text shadow blur",
      layer: {
        id: "word",
        type: "text",
        font: "Anton",
        fontSize: 96,
        color: "#ff0000",
        spans: [{ text: "HELLO" }],
        shadows: [{ x: 0, y: 0, blur: 60, color: "#0000ff" }],
        ...clearOfBadge,
      } as unknown as SceneLayer,
      painter: "word",
    },
  ];

  it("the authored boxes are clear of the badge — only paint can reach it", () => {
    expect(overlaps({ ...clearOfBadge.position, ...clearOfBadge.size }, badge.box)).toBe(false);
  });

  for (const { name, layer, painter } of cases)
    it(`${name}: every pixel painted inside a protected region is reported`, async () => {
      const r = resolved([layer]);
      const { png } = await renderScene(r, { page });
      const paint = paintedBox(png);
      const violations = findSafeAreaViolations(r);
      for (const region of PROTECTED_REGIONS) {
        if (!overlaps(paint, region.box)) continue;
        expect(
          violations.some((v) => v.layer === painter && v.region === region.id),
        ).toBe(true);
      }
      // The case is only meaningful if the blur really did carry paint into
      // the badge — a bound derived from the authored length would miss it.
      expect(overlaps(paint, badge.box)).toBe(true);
    });
});

// --- the rendered pixels ----------------------------------------------------------

describe("rendered guideline pixels", () => {
  it("renderGuidelines draws the overlay over the scene content", async () => {
    const r = resolved([shape({ id: "hero", position: { x: 1100, y: 600 }, size: { width: 150, height: 100 } })]);
    const plain = await renderScene(r, { page });
    const guided = await renderGuidelines(r, { page });
    const plainPx = decodePng(plain.png);
    const guidedPx = decodePng(guided.png);
    // Hero fills (1100,600)-(1250,700): red in both renders where no overlay sits…
    expect(plainPx.px(1110, 610)).toEqual([255, 0, 0, 255]);
    // …but the badge-region part of the hero is tinted in the guideline view only.
    const tinted = guidedPx.px(1150, 670);
    expect(tinted[0]).toBe(255);
    expect(tinted[1]).toBeLessThan(250);
    expect(plainPx.px(1150, 670)).toEqual([255, 0, 0, 255]);
    expect(guidedPx.width).toBe(1280);
    expect(guidedPx.height).toBe(720);
  });
});
