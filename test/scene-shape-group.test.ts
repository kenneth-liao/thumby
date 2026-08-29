import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Page } from "playwright";
import { scanLibrary, type Library } from "../src/assets.js";
import { getBrowser } from "../src/browser.js";
import { loadScene, type Scene, type SceneLayer, type LoadResult } from "../src/scene.js";
import { scenePageHtml, renderScene, type ImageSize } from "../src/scene-render.js";
import { run as cliRun } from "../src/scene-cli.js";
import { decodePng } from "./png.js";

// --- fixtures -------------------------------------------------------------

/** Opaque red square — a plain image body for stacking and effects. */
const RED_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="#ff0000"/></svg>`;

/** Opaque red disc centered on transparency — alpha for drop-shadow/glow geometry. */
const DOT_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><circle cx="50" cy="50" r="30" fill="#ff0000"/></svg>`;

interface Fix {
  root: string;
  projectRoot: string;
  lib: Library;
  sceneFile: string;
}

let fix: Fix;
let page: Page;

beforeAll(async () => {
  const root = await mkdtemp(path.join(tmpdir(), "thumby-shape-group-"));
  const projectRoot = path.join(root, "project");
  const libRoot = path.join(root, "library");
  await mkdir(path.join(libRoot, "plates", "demo-plate"), { recursive: true });
  await writeFile(
    path.join(libRoot, "plates", "demo-plate", "meta.json"),
    JSON.stringify({ kind: "plate", id: "demo-plate", name: "Demo Plate", tags: [] }),
  );
  await writeFile(path.join(libRoot, "plates", "demo-plate", "demo-plate.svg"), RED_SVG);
  await mkdir(projectRoot, { recursive: true });
  await writeFile(path.join(projectRoot, "red.svg"), RED_SVG);
  await writeFile(path.join(projectRoot, "dot.svg"), DOT_SVG);
  fix = {
    root,
    projectRoot,
    lib: await scanLibrary(libRoot),
    sceneFile: path.join(projectRoot, "scene.json"),
  };
  // One route-blocked page for every pixel test: fewer browser lifecycles to
  // flake, and every render is proven offline by construction. The browser
  // comes from the shared singleton — one process, one Chromium, even across
  // isolated test files.
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
  // Close only this file's context — the shared browser outlives the file
  // (another test file may still be rendering on its own context).
  await page.context().close();
});

/** Render in the shared route-blocked page — scenes are 1280×720 like the viewport. */
const render = (resolved: Extract<LoadResult, { ok: true }>["resolved"]) =>
  renderScene(resolved, { page });

// --- helpers ----------------------------------------------------------------

const imageLayer = (over: Record<string, unknown> = {}): SceneLayer =>
  ({
    id: "bg",
    type: "image",
    asset: "demo-plate",
    position: { x: 0, y: 0 },
    size: { width: 1280, height: 720 },
    ...over,
  }) as SceneLayer;

const shapeLayer = (over: Record<string, unknown> = {}): SceneLayer =>
  ({
    id: "badge",
    type: "shape",
    shape: "rect",
    color: "#ff0000",
    position: { x: 440, y: 260 },
    size: { width: 400, height: 200 },
    ...over,
  }) as SceneLayer;

const scene = (layers: SceneLayer[]): Scene => ({
  schemaVersion: 1,
  canvas: { width: 1280, height: 720 },
  layers,
});

async function load(raw: unknown): Promise<Extract<LoadResult, { ok: true }>> {
  const result = await loadScene(fix.projectRoot, async () => fix.lib, raw);
  expect(result.ok).toBe(true);
  return result as Extract<LoadResult, { ok: true }>;
}

async function loadErrors(raw: unknown): Promise<{ path: string; message: string }[]> {
  const result = await loadScene(fix.projectRoot, async () => fix.lib, raw);
  expect(result.ok).toBe(false);
  return (result as { ok: false; errors: { path: string; message: string }[] }).errors;
}

async function htmlOf(layers: SceneLayer[], natural?: Map<string, ImageSize>): Promise<string> {
  const { resolved } = await load(scene(layers));
  return scenePageHtml(resolved, natural ?? new Map());
}

// --- shape validation ---------------------------------------------------------

describe("shape layers — validation", () => {
  it("accepts rect, ellipse, and triangle shapes", async () => {
    const { resolved } = await load(
      scene([
        shapeLayer({ shape: "rect", radius: 12 }),
        shapeLayer({ id: "oval", shape: "ellipse" }),
        shapeLayer({ id: "peak", shape: "triangle" }),
      ]),
    );
    expect(resolved.scene.layers).toHaveLength(3);
  });

  it("rejects an unknown shape kind naming the field", async () => {
    const errors = await loadErrors(scene([shapeLayer({ shape: "hexagon" })]));
    expect(errors[0]!.path).toBe("layers[0].shape");
    expect(errors[0]!.message).toMatch(/rect/);
  });

  it("rejects radius on a non-rect shape — no corners to round", async () => {
    const errors = await loadErrors(
      scene([shapeLayer({ shape: "ellipse", radius: 8 })]),
    );
    expect(errors[0]!.path).toBe("layers[0].radius");
    expect(errors[0]!.message).toMatch(/rect/);
  });

  it("rejects a negative radius", async () => {
    const errors = await loadErrors(scene([shapeLayer({ radius: -1 })]));
    expect(errors[0]!.path).toBe("layers[0].radius");
  });

  it("rejects a shape with both color and fill — one fill per shape", async () => {
    const errors = await loadErrors(
      scene([shapeLayer({ color: "#ff0000", fill: { from: "#ff0000", to: "#0000ff" } })]),
    );
    expect(errors[0]!.path).toBe("layers[0].fill");
    expect(errors[0]!.message).toMatch(/mutually exclusive/);
  });

  it("rejects shape fields on other layer types — from the schema's oneOf branches", async () => {
    const errors = await loadErrors(
      scene([
        imageLayer({ shape: "rect" }),
      ]),
    );
    expect(errors[0]!.path).toBe("layers[0].shape");
    expect(errors[0]!.message).toMatch(/not a valid/);
  });

  it("rejects border without a color and a positive width", async () => {
    const errors = await loadErrors(scene([shapeLayer({ border: { width: 0, color: "#000" } })]));
    expect(errors[0]!.path).toBe("layers[0].border.width");
  });
});

// --- shape markup -------------------------------------------------------------

describe("shape layers — markup", () => {
  it("renders a rect with radius as an SVG rect at the layer box", async () => {
    const html = await htmlOf([shapeLayer({ shape: "rect", radius: 12, color: "#ff0000" })]);
    expect(html).toContain(`<rect x="0" y="0" width="400" height="200" rx="12" ry="12" fill="#ff0000"/>`);
  });

  it("omits rx on a rect without radius", async () => {
    const html = await htmlOf([shapeLayer({ shape: "rect" })]);
    expect(html).toContain(`<rect x="0" y="0" width="400" height="200" fill="#ff0000"/>`);
  });

  it("clamps radius to half the shorter side — a pill, per CSS semantics", async () => {
    const html = await htmlOf([
      shapeLayer({ shape: "rect", size: { width: 200, height: 100 }, radius: 60 }),
    ]);
    // Emitted clamped, not delegated to the browser's per-axis SVG clamp.
    expect(html).toContain(`<rect x="0" y="0" width="200" height="100" rx="50" ry="50"`);
  });

  it("renders ellipse geometry inscribed in the layer box", async () => {
    const html = await htmlOf([shapeLayer({ id: "oval", shape: "ellipse", color: "#00aa00" })]);
    expect(html).toContain(`<ellipse cx="200" cy="100" rx="200" ry="100" fill="#00aa00"/>`);
  });

  it("renders a triangle as a polygon — apex top-center, base at the bottom", async () => {
    const html = await htmlOf([shapeLayer({ id: "peak", shape: "triangle", color: "#00aa00" })]);
    expect(html).toContain(`<polygon points="200,0 0,200 400,200" fill="#00aa00"/>`);
  });

  it("paints a gradient fill through a defs linearGradient referenced by id", async () => {
    const html = await htmlOf([
      shapeLayer({ color: undefined, fill: { from: "#ff0000", to: "#0000ff", angle: 0 } }),
    ]);
    expect(html).toContain(
      `<linearGradient id="grad-1" x1="0.5" y1="1" x2="0.5" y2="0">` +
        `<stop offset="0" stop-color="#ff0000"/><stop offset="1" stop-color="#0000ff"/>` +
        `</linearGradient>`,
    );
    expect(html).toContain(`fill="url(#grad-1)"`);
  });

  it("defaults the gradient angle to left→right", async () => {
    const html = await htmlOf([shapeLayer({ color: undefined, fill: { from: "#ff0000", to: "#0000ff" } })]);
    expect(html).toContain(`<linearGradient id="grad-1" x1="0" y1="0.5" x2="1" y2="0.5">`);
  });

  it("numbers gradient ids in layer order so ids stay unique", async () => {
    const html = await htmlOf([
      shapeLayer({ id: "a", color: undefined, fill: { from: "#ff0000", to: "#0000ff" } }),
      shapeLayer({ id: "b", color: undefined, fill: { from: "#00ff00", to: "#000000" } }),
    ]);
    expect(html).toContain(`id="grad-1"`);
    expect(html).toContain(`id="grad-2"`);
    expect(html).toContain(`fill="url(#grad-2)"`);
  });

  it("draws the border as a stroke centered on the shape outline", async () => {
    const html = await htmlOf([
      shapeLayer({ border: { width: 10, color: "#0000ff" } }),
    ]);
    expect(html).toContain(`fill="#ff0000" stroke="#0000ff" stroke-width="10"`);
  });

  it("keeps shape layers addressable like every other layer", async () => {
    const html = await htmlOf([shapeLayer({ id: "badge", rotation: 15, opacity: 0.5 })]);
    expect(html).toContain(`class="scene-layer" data-layer-id="badge"`);
    expect(html).toContain("left:440px;top:260px;width:400px;height:200px;opacity:0.5");
    expect(html).toContain("transform:rotate(15deg)");
  });
});

// --- shape pixels -------------------------------------------------------------

describe("shape layers — pixels", () => {
  it("renders a rounded rect with its border in pixels", async () => {
    const { resolved } = await load(
      scene([
        shapeLayer({
          shape: "rect",
          radius: 30,
          color: "#ff0000",
          border: { width: 10, color: "#0000ff" },
        }),
      ]),
    );
    const { png } = await render(resolved);
    const img = decodePng(png);
    expect(img.px(640, 360)).toEqual([255, 0, 0, 255]); // fill center
    expect(img.px(643, 263)).toEqual([0, 0, 255, 255]); // top border — centered stroke
    expect(img.px(640, 283)).toEqual([255, 0, 0, 255]); // inside the border
    expect(img.px(442, 262)).toEqual([255, 255, 255, 255]); // rounded corner cut away
  }, 20000);

  it("clips an ellipse to its box — center filled, corner empty", async () => {
    const { resolved } = await load(scene([shapeLayer({ id: "oval", shape: "ellipse" })]));
    const { png } = await render(resolved);
    const img = decodePng(png);
    expect(img.px(640, 360)).toEqual([255, 0, 0, 255]);
    expect(img.px(450, 270)).toEqual([255, 255, 255, 255]);
  }, 20000);

  it("renders a triangle — apex up, outside the edges stays background", async () => {
    const { resolved } = await load(scene([shapeLayer({ id: "peak", shape: "triangle", color: "#00aa00" })]));
    const { png } = await render(resolved);
    const img = decodePng(png);
    expect(img.px(640, 410)).toEqual([0, 170, 0, 255]); // centroid
    expect(img.px(450, 220)).toEqual([255, 255, 255, 255]); // outside the left edge
  }, 20000);

  it("composites shapes in z-order over images", async () => {
    const { resolved } = await load(
      scene([
        imageLayer({ asset: "./red.svg" }),
        shapeLayer({ id: "oval", shape: "ellipse", color: "#0000ff" }),
      ]),
    );
    const { png } = await render(resolved);
    const img = decodePng(png);
    expect(img.px(640, 360)).toEqual([0, 0, 255, 255]); // shape on top
    expect(img.px(100, 100)).toEqual([255, 0, 0, 255]); // image below
  }, 20000);

  it("shape edits change pixels — restyling a shape is a render change", async () => {
    const before = await load(scene([shapeLayer({ color: "#ff0000" })]));
    const after = await load(scene([shapeLayer({ color: "#00ff00" })]));
    const a = await render(before.resolved);
    const b = await render(after.resolved);
    expect(a.png.equals(b.png)).toBe(false);
  }, 20000);
});

// --- group validation ---------------------------------------------------------

/** A group wrapping one child layer; children keep group-local coordinates. */
const groupLayer = (
  layers: SceneLayer[],
  over: Record<string, unknown> = {},
): SceneLayer =>
  ({
    id: "card",
    type: "group",
    position: { x: 400, y: 300 },
    size: { width: 480, height: 270 },
    layers,
    ...over,
  }) as SceneLayer;

const child = (over: Record<string, unknown> = {}): SceneLayer => {
  // Overrides replace defaults; an explicit `undefined` override deletes the
  // default (an own-but-undefined key would still fail additionalProperties).
  const layer: Record<string, unknown> = {
    id: "m",
    type: "shape",
    shape: "rect",
    color: "#ff0000",
    position: { x: 0, y: 0 },
    size: { width: 480, height: 270 },
  };
  for (const [key, value] of Object.entries(over)) {
    if (value === undefined) delete layer[key];
    else layer[key] = value;
  }
  return layer as unknown as SceneLayer;
};

describe("group layers — validation", () => {
  it("accepts a group with nested layers", async () => {
    const { resolved } = await load(scene([groupLayer([child()])]));
    expect(resolved.scene.layers[0]).toMatchObject({ type: "group" });
  });

  it("rejects an empty group — a group wraps at least one layer", async () => {
    const errors = await loadErrors(scene([groupLayer([])]));
    expect(errors[0]!.path).toBe("layers[0].layers");
  });

  it("rejects a non-positive scale", async () => {
    const errors = await loadErrors(scene([groupLayer([child()], { scale: 0 })]));
    expect(errors[0]!.path).toBe("layers[0].scale");
  });

  it("rejects unknown properties on group children", async () => {
    const errors = await loadErrors(
      scene([groupLayer([child({ crop: { left: 0, top: 0, right: 0, bottom: 0 } })])]),
    );
    expect(errors[0]!.path).toBe("layers[0].layers[0].crop");
    expect(errors[0]!.message).toMatch(/not a valid/);
  });

  it("keeps nested required-field errors field-specific", async () => {
    const errors = await loadErrors(
      scene([groupLayer([child({ id: "img", type: "image", shape: undefined, color: undefined })])]),
    );
    expect(errors[0]!.path).toBe("layers[0].layers[0].asset");
  });

  it("rejects duplicate ids across nesting levels naming the first use", async () => {
    const errors = await loadErrors(
      scene([child({ id: "dup" }), groupLayer([child({ id: "dup" })], { id: "outer" })]),
    );
    expect(errors[0]!.path).toBe("layers[1].layers[0].id");
    expect(errors[0]!.message).toMatch(/first used at layers\[0\]/);
  });

  it("rejects a nested child's missing asset by full path", async () => {
    const errors = await loadErrors(
      scene([groupLayer([child({ id: "img", type: "image", shape: undefined, asset: "./missing.svg", color: undefined })])]),
    );
    expect(errors[0]!.path).toBe("layers[0].layers[0].asset");
  });

  it("rejects an unknown nested font by full path", async () => {
    const errors = await loadErrors(
      scene([
        groupLayer([
          child({
            id: "label",
            type: "text",
            shape: undefined,
            color: undefined,
            text: "hi",
            font: "Zapfino",
            fontSize: 40,
            size: { width: 200, height: 80 },
          }),
        ]),
      ]),
    );
    expect(errors[0]!.path).toBe("layers[0].layers[0].font");
  });

  it("rejects nested crop insets that leave no source", async () => {
    const errors = await loadErrors(
      scene([
        groupLayer([
          child({
            id: "img",
            type: "image",
            shape: undefined,
            color: undefined,
            asset: "demo-plate",
            crop: { left: 60, top: 0, right: 60, bottom: 0 },
          }),
        ]),
      ]),
    );
    expect(errors[0]!.path).toBe("layers[0].layers[0].crop");
  });

  it("rejects an inverted nested autoFit range", async () => {
    const errors = await loadErrors(
      scene([
        groupLayer([
          child({
            id: "label",
            type: "text",
            shape: undefined,
            color: undefined,
            text: "hi",
            font: "Anton",
            fontSize: undefined,
            autoFit: { min: 80, max: 40 },
            size: { width: 200, height: 80 },
          }),
        ]),
      ]),
    );
    expect(errors[0]!.path).toBe("layers[0].layers[0].autoFit");
  });

  it("rejects group-only fields on other layer types", async () => {
    const errors = await loadErrors(scene([shapeLayer({ layers: [child()] })]));
    expect(errors[0]!.path).toBe("layers[0].layers");
    expect(errors[0]!.message).toMatch(/not a valid/);
  });
});

// --- group markup -------------------------------------------------------------

describe("group layers — markup", () => {
  it("renders a group as a container with children at local coordinates", async () => {
    const html = await htmlOf([groupLayer([child({ position: { x: 20, y: 30 } })])]);
    const group = html.match(/<div class="scene-layer" data-layer-id="card"[^>]*>/)![0];
    expect(group).toContain("left:400px;top:300px;width:480px;height:270px");
    expect(html).toContain(`data-layer-id="m"`);
    expect(html).toContain("left:20px;top:30px");
    // Children render inside the group's container, not flattened after it.
    expect(html.indexOf('data-layer-id="card"')).toBeLessThan(html.indexOf('data-layer-id="m"'));
    expect(html.indexOf('data-layer-id="m"')).toBeLessThan(html.lastIndexOf("</div>"));
  });

  it("emits scale first on the group transform — mirror innermost, then rotation", async () => {
    const html = await htmlOf([groupLayer([child()], { scale: 0.5, rotation: 15, mirror: true })]);
    expect(html).toContain("transform:scale(0.5) rotate(15deg) scaleX(-1)");
  });

  it("omits scale at 1 — the default needs no transform", async () => {
    const html = await htmlOf([groupLayer([child()], { scale: 1 })]);
    expect(html).not.toContain("scale(");
  });

  it("lands group opacity and visibility on the container", async () => {
    const html = await htmlOf([groupLayer([child()], { opacity: 0.5, visible: false })]);
    const group = html.match(/<div class="scene-layer" data-layer-id="card"[^>]*>/)![0];
    expect(group).toContain("opacity:0.5");
    expect(group).toContain("display:none");
  });
});

// --- group pixels ---------------------------------------------------------------

describe("group layers — pixels", () => {
  it("composites children at group-local coordinates", async () => {
    const { resolved } = await load(scene([groupLayer([child({ color: "#ff0000" })])]));
    const { png } = await render(resolved);
    const img = decodePng(png);
    expect(img.px(500, 350)).toEqual([255, 0, 0, 255]);
    expect(img.px(100, 100)).toEqual([255, 255, 255, 255]);
  }, 20000);

  it("moves the whole group — one edit, no child edits", async () => {
    const base = await load(scene([groupLayer([child({ color: "#ff0000" })])]));
    const moved = await load(
      scene([groupLayer([child({ color: "#ff0000" })], { position: { x: 700, y: 300 } })]),
    );
    const before = decodePng((await render(base.resolved)).png);
    const after = decodePng((await render(moved.resolved)).png);
    expect(before.px(500, 350)).toEqual([255, 0, 0, 255]);
    expect(after.px(500, 350)).toEqual([255, 255, 255, 255]);
    expect(after.px(800, 350)).toEqual([255, 0, 0, 255]);
  }, 20000);

  it("scales the whole group around its center — resize without flattening", async () => {
    const { resolved } = await load(
      scene([groupLayer([child({ color: "#00aa00" })], { scale: 0.5 })]),
    );
    const { png } = await render(resolved);
    const img = decodePng(png);
    // Box center (640,435) stays fixed; the 480×270 box renders 240×135.
    expect(img.px(640, 435)).toEqual([0, 170, 0, 255]);
    expect(img.px(450, 350)).toEqual([255, 255, 255, 255]);
    expect(img.px(640, 320)).toEqual([255, 255, 255, 255]);
  }, 20000);

  it("rotates the group — children transform with it", async () => {
    const { resolved } = await load(
      scene([
        groupLayer(
          [child({ id: "m", color: "#ff0000", position: { x: 200, y: 0 }, size: { width: 100, height: 50 } })],
          { id: "outer", position: { x: 0, y: 0 }, size: { width: 400, height: 400 }, rotation: 90 },
        ),
      ]),
    );
    const { png } = await render(resolved);
    const img = decodePng(png);
    // Child center local (250,25) → 90° CW about (200,200) → (375,250).
    expect(img.px(375, 250)).toEqual([255, 0, 0, 255]);
    expect(img.px(310, 250)).toEqual([255, 255, 255, 255]);
  }, 20000);

  it("composes nested group rotations", async () => {
    const inner = groupLayer(
      [child({ id: "m", color: "#ff0000", position: { x: 200, y: 0 }, size: { width: 100, height: 50 } })],
      { id: "inner", position: { x: 0, y: 0 }, size: { width: 400, height: 400 }, rotation: 90 },
    );
    const outer = groupLayer([inner], {
      id: "outer",
      position: { x: 0, y: 0 },
      size: { width: 400, height: 400 },
      rotation: 90,
    });
    const { resolved } = await load(scene([outer]));
    const { png } = await render(resolved);
    const img = decodePng(png);
    // 90° + 90°: child center local (250,25) → inner rotation → (375,250) →
    // outer rotation → (150,375); two quarter turns put the box back upright.
    expect(img.px(150, 375)).toEqual([255, 0, 0, 255]);
    expect(img.px(250, 375)).toEqual([255, 255, 255, 255]);
  }, 20000);

  it("applies group opacity over the composed children", async () => {
    const { resolved } = await load(
      scene([
        imageLayer({ asset: "./red.svg" }),
        groupLayer([child({ id: "m", color: "#0000ff", size: { width: 400, height: 200 } })], {
          id: "card",
          position: { x: 440, y: 260 },
          size: { width: 480, height: 270 },
          opacity: 0.5,
        }),
      ]),
    );
    const { png } = await render(resolved);
    const img = decodePng(png);
    const [r, g, b] = img.px(640, 360);
    expect(r).toBeGreaterThanOrEqual(124);
    expect(r).toBeLessThanOrEqual(131);
    expect(g).toBeLessThanOrEqual(8);
    expect(b).toBeGreaterThanOrEqual(124);
    expect(b).toBeLessThanOrEqual(131);
    expect(img.px(100, 100)).toEqual([255, 0, 0, 255]);
  }, 20000);

  it("hides the whole group with one flag", async () => {
    const { resolved } = await load(scene([groupLayer([child({ color: "#ff0000" })], { visible: false })]));
    const { png } = await render(resolved);
    const img = decodePng(png);
    expect(img.px(500, 350)).toEqual([255, 255, 255, 255]);
  }, 20000);

  it("interleaves groups with other layers in array order", async () => {
    const groupRed = groupLayer(
      [child({ id: "m", color: "#ff0000", size: { width: 400, height: 200 } })],
      { id: "card", position: { x: 440, y: 260 }, size: { width: 480, height: 270 } },
    );
    const blue = shapeLayer({ id: "oval", shape: "ellipse", color: "#0000ff" });
    const onTop = await load(scene([blue, groupRed]));
    const beneath = await load(scene([groupRed, blue]));
    const top = decodePng((await render(onTop.resolved)).png);
    const under = decodePng((await render(beneath.resolved)).png);
    expect(top.px(640, 360)).toEqual([255, 0, 0, 255]);
    expect(under.px(640, 360)).toEqual([0, 0, 255, 255]);
  }, 20000);
});

// --- the logo-card fixture ------------------------------------------------------

/**
 * A grouped logo card: rounded plate, ellipse logo, label — the component an
 * agent moves, resizes, hides, and restyles without touching its children.
 */
const logoCardLayers = (over: Record<string, unknown> = {}): SceneLayer[] => [
  groupLayer(
    [
      child({ id: "card-bg", shape: "rect", radius: 24, color: "#101820" }),
      child({ id: "card-logo", shape: "ellipse", color: "#22d3ee", position: { x: 24, y: 24 }, size: { width: 120, height: 120 } }),
      child({
        id: "card-label",
        type: "text",
        shape: undefined,
        text: "LOGO",
        font: "Anton",
        fontSize: 64,
        color: "#ffffff",
        position: { x: 180, y: 90 },
        size: { width: 270, height: 90 },
      }),
    ],
    { id: "logo-card", position: { x: 400, y: 220 }, size: { width: 480, height: 270 }, ...over },
  ),
];

describe("grouped logo-card fixture — one editable component", () => {
  it("renders the card, its children staying individually addressable", async () => {
    const html = await htmlOf(logoCardLayers());
    for (const id of ["logo-card", "card-bg", "card-logo", "card-label"])
      expect(html).toContain(`data-layer-id="${id}"`);
    const { resolved } = await load(scene(logoCardLayers()));
    const { png } = await render(resolved);
    const img = decodePng(png);
    expect(img.px(640, 460)).toEqual([16, 24, 32, 255]); // card plate, below the label
    expect(img.px(484, 284)).toEqual([34, 211, 238, 255]); // logo disc
  }, 20000);

  it("moves as one component", async () => {
    const moved = await load(scene(logoCardLayers({ position: { x: 700, y: 400 } })));
    const { png } = await render(moved.resolved);
    const img = decodePng(png);
    expect(img.px(940, 640)).toEqual([16, 24, 32, 255]); // moved card plate, below the label
    expect(img.px(640, 460)).toEqual([255, 255, 255, 255]); // old spot empty
  }, 20000);

  it("resizes as one component — children scale with the group", async () => {
    const scaled = await load(scene(logoCardLayers({ scale: 0.5 })));
    const { png } = await render(scaled.resolved);
    const img = decodePng(png);
    // Half-size card centered on (640, 355): plate visible below the scaled
    // label, gone at points inside the original box but outside the scaled one.
    expect(img.px(640, 410)).toEqual([16, 24, 32, 255]);
    expect(img.px(430, 250)).toEqual([255, 255, 255, 255]);
    expect(img.px(640, 240)).toEqual([255, 255, 255, 255]);
  }, 20000);

  it("restyles as one component — group effects change without touching children", async () => {
    const base = await render((await load(scene(logoCardLayers()))).resolved);
    const restyled = await render(
      (
        await load(
          scene(
            logoCardLayers({ effects: { shadow: { x: 10, y: 14, blur: 28, color: "#ff0000" } } }),
          ),
        )
      ).resolved,
    );
    expect(base.png.equals(restyled.png)).toBe(false);
    // The card shadow below the plate turns red — over a white canvas that
    // shows as the green channel dropping; the plate itself is untouched.
    const before = decodePng(base.png);
    const after = decodePng(restyled.png);
    const [, bGreen] = before.px(660, 505);
    const [, aGreen] = after.px(660, 505);
    expect(aGreen).toBeLessThan(bGreen - 40);
    expect(after.px(640, 460)).toEqual(before.px(640, 460));
  }, 20000);

  it("hides as one component", async () => {
    const hidden = await load(scene(logoCardLayers({ visible: false })));
    const { png } = await render(hidden.resolved);
    const img = decodePng(png);
    expect(img.px(640, 355)).toEqual([255, 255, 255, 255]);
  }, 20000);

  it("restyles through a child edit without flattening the group", async () => {
    const restyled = logoCardLayers();
    (restyled[0] as { layers: SceneLayer[] }).layers[1] = child({
      id: "card-logo",
      shape: "ellipse",
      color: "#ff00ff",
      position: { x: 24, y: 24 },
      size: { width: 120, height: 120 },
    });
    const { resolved } = await load(scene(restyled));
    const { png } = await render(resolved);
    const img = decodePng(png);
    expect(img.px(484, 284)).toEqual([255, 0, 255, 255]); // restyled disc
    expect(img.px(640, 460)).toEqual([16, 24, 32, 255]); // plate untouched
  }, 20000);
});

// --- effects ------------------------------------------------------------------

/** The alpha-carrying image the effect pixel tests composite. */
const dotImage = (over: Record<string, unknown> = {}): SceneLayer =>
  imageLayer({
    id: "dot",
    asset: "./dot.svg",
    position: { x: 540, y: 260 },
    size: { width: 200, height: 200 },
    ...over,
  });

describe("effects — validation", () => {
  it("rejects an empty effects object", async () => {
    const errors = await loadErrors(scene([dotImage({ effects: {} })]));
    expect(errors[0]!.path).toBe("layers[0].effects");
  });

  it("rejects an empty colorAdjust — a no-op adjustment is not a value", async () => {
    const errors = await loadErrors(scene([dotImage({ effects: { colorAdjust: {} } })]));
    expect(errors[0]!.path).toBe("layers[0].effects.colorAdjust");
  });

  it("rejects a negative blur radius", async () => {
    const errors = await loadErrors(scene([dotImage({ effects: { blur: -1 } })]));
    expect(errors[0]!.path).toBe("layers[0].effects.blur");
  });

  it("rejects a zero-radius glow", async () => {
    const errors = await loadErrors(
      scene([dotImage({ effects: { glow: { radius: 0, color: "#00ff00" } } })]),
    );
    expect(errors[0]!.path).toBe("layers[0].effects.glow.radius");
  });

  it("rejects a glow without a color", async () => {
    const errors = await loadErrors(
      scene([dotImage({ effects: { glow: { radius: 10 } } })]),
    );
    expect(errors[0]!.path).toBe("layers[0].effects.glow.color");
  });

  it("rejects a negative colorAdjust saturate", async () => {
    const errors = await loadErrors(
      scene([dotImage({ effects: { colorAdjust: { saturate: -0.5 } } })]),
    );
    expect(errors[0]!.path).toBe("layers[0].effects.colorAdjust.saturate");
  });

  it("rejects effects on text and shape layers — image and group content only", async () => {
    const textErrors = await loadErrors(
      scene([
        child({
          id: "label",
          type: "text",
          shape: undefined,
          text: "hi",
          font: "Anton",
          fontSize: 40,
          size: { width: 200, height: 80 },
          effects: { blur: 2 },
        }),
      ]),
    );
    expect(textErrors[0]!.path).toBe("layers[0].effects");
    expect(textErrors[0]!.message).toMatch(/not a valid/);
    const shapeErrors = await loadErrors(scene([shapeLayer({ effects: { blur: 2 } })]));
    expect(shapeErrors[0]!.path).toBe("layers[0].effects");
  });
});

describe("effects — markup", () => {
  it("emits the chain as one filter in the documented order", async () => {
    const html = await htmlOf([
      dotImage({
        effects: {
          blur: 2,
          colorAdjust: { brightness: 0.8, contrast: 1.2, saturate: 0.5, hueRotate: 30 },
          glow: { radius: 12, color: "#00ff00" },
          shadow: { x: 4, y: 6, blur: 10, color: "#0000ff" },
        },
      }),
    ]);
    expect(html).toContain(
      "filter:blur(2px) brightness(0.8) contrast(1.2) saturate(0.5) hue-rotate(30deg) " +
        "drop-shadow(0px 0px 12px #00ff00) drop-shadow(4px 6px 10px #0000ff)",
    );
  });

  it("lands the filter on the group container — the whole subtree is effected", async () => {
    const html = await htmlOf([groupLayer([child()], { effects: { shadow: { x: 4, y: 6, blur: 10, color: "#0000ff" } } })]);
    const group = html.match(/<div class="scene-layer" data-layer-id="card"[^>]*>/)![0];
    expect(group).toContain("filter:drop-shadow(4px 6px 10px #0000ff)");
  });
});

describe("effects — pixels", () => {
  it("shadows follow the content's alpha, offset and crisp at blur 0", async () => {
    const { resolved } = await load(
      scene([dotImage({ effects: { shadow: { x: 24, y: 0, blur: 0, color: "#0000ff" } } })]),
    );
    const { png } = await render(resolved);
    const img = decodePng(png);
    expect(img.px(640, 360)).toEqual([255, 0, 0, 255]); // the disc itself
    expect(img.px(716, 360)).toEqual([0, 0, 255, 255]); // offset shadow — outside the disc
    expect(img.px(560, 360)).toEqual([255, 255, 255, 255]); // no shadow to the left
  }, 20000);

  it("glows around the content's alpha without touching the content", async () => {
    const { resolved } = await load(
      scene([dotImage({ effects: { glow: { radius: 12, color: "#00ff00" } } })]),
    );
    const { png } = await render(resolved);
    const img = decodePng(png);
    const [r, g, b] = img.px(704, 360); // outside the disc edge — halo, not background
    expect(g).toBeGreaterThan(200);
    expect(r).toBeLessThan(200);
    expect(b).toBeLessThan(200);
    expect(img.px(640, 360)).toEqual([255, 0, 0, 255]);
  }, 20000);

  it("blurs the content's edges", async () => {
    const { resolved } = await load(scene([dotImage({ asset: "./red.svg", effects: { blur: 6 } })]));
    const { png } = await render(resolved);
    const img = decodePng(png);
    expect(img.px(700, 360)).toEqual([255, 0, 0, 255]); // deep inside stays pure
    const [, g] = img.px(739, 360); // 1px inside the box edge — white bleeds in
    expect(g).toBeGreaterThan(30);
    expect(g).toBeLessThan(220);
  }, 20000);

  it("desaturates with colorAdjust — the unmasked whole-content adjustment", async () => {
    const { resolved } = await load(
      scene([dotImage({ effects: { colorAdjust: { saturate: 0 } } })]),
    );
    const { png } = await render(resolved);
    const img = decodePng(png);
    const [r, g, b] = img.px(640, 360);
    for (const c of [r, g, b]) {
      expect(c).toBeGreaterThan(50);
      expect(c).toBeLessThan(60);
    }
  }, 20000);

  it("effects a group's whole subtree — the shadow follows the children's union", async () => {
    const { resolved } = await load(
      scene([
        groupLayer([dotImage()], {
          id: "card",
          position: { x: 0, y: 0 },
          size: { width: 1280, height: 720 },
          effects: { shadow: { x: 24, y: 0, blur: 0, color: "#0000ff" } },
        }),
      ]),
    );
    const { png } = await render(resolved);
    const img = decodePng(png);
    expect(img.px(640, 360)).toEqual([255, 0, 0, 255]);
    expect(img.px(716, 360)).toEqual([0, 0, 255, 255]);
  }, 20000);
});

describe("effects — inspect", () => {
  it("summarizes effects on image and group layers", async () => {
    await writeFile(
      fix.sceneFile,
      JSON.stringify(
        scene([
          dotImage({ effects: { blur: 2, colorAdjust: { brightness: 1.2 } } }),
          groupLayer([child()], { effects: { glow: { radius: 10, color: "#00ff00" } } }),
        ]),
      ),
    );
    const { exitCode, output } = await cliRun(["inspect", fix.sceneFile]);
    expect(exitCode).toBe(0);
    const layers = (output as { layers: Record<string, unknown>[] }).layers;
    expect(layers[0]).toMatchObject({
      effects: { blur: 2, colorAdjust: { brightness: 1.2 } },
    });
    expect(layers[1]).toMatchObject({
      effects: { glow: { radius: 10, color: "#00ff00" } },
    });
  });
});

// --- group inspect ----------------------------------------------------------------

describe("group layers — inspect", () => {
  it("summarizes groups with nested child summaries and resolved assets", async () => {
    await writeFile(
      fix.sceneFile,
      JSON.stringify(
        scene([
          groupLayer(
            [
              child({ id: "img", type: "image", shape: undefined, color: undefined, asset: "./red.svg" }),
              child({ id: "m", color: "#ff0000" }),
            ],
            { scale: 0.8 },
          ),
        ]),
      ),
    );
    const { exitCode, output } = await cliRun(["inspect", fix.sceneFile]);
    expect(exitCode).toBe(0);
    const layers = (output as { layers: Record<string, unknown>[] }).layers;
    expect(layers[0]).toMatchObject({ id: "card", type: "group", scale: 0.8 });
    const nested = layers[0]!.layers as Record<string, unknown>[];
    expect(nested[0]).toMatchObject({ id: "img", type: "image" });
    expect(nested[0]!.resolvedAsset).toMatchObject({ hash: expect.any(String) });
    expect(nested[1]).toMatchObject({ id: "m", type: "shape", color: "#ff0000" });
  });
});

// --- committed fixture -----------------------------------------------------------

describe("committed logo-card fixture", () => {
  const FIXTURE = path.join(import.meta.dir, "fixtures", "shape-group", "logo-card.json");

  it("validates with no library references", async () => {
    const raw = JSON.parse(await readFile(FIXTURE, "utf8"));
    const result = await loadScene(
      path.dirname(FIXTURE),
      async () => {
        throw new Error("the logo-card fixture must not reference library assets");
      },
      raw,
    );
    expect(result.ok).toBe(true);
  });

  it("renders 1280×720 with the card composited over the backdrop", async () => {
    const raw = JSON.parse(await readFile(FIXTURE, "utf8"));
    const { resolved } = await loadScene(
      path.dirname(FIXTURE),
      async () => {
        throw new Error("the logo-card fixture must not reference library assets");
      },
      raw,
    ).then(
      (r) => {
        expect(r.ok).toBe(true);
        return r as Extract<LoadResult, { ok: true }>;
      },
    );
    const { png, width, height, warnings } = await render(resolved);
    expect([width, height]).toEqual([1280, 720]);
    // The fixture's full-canvas backdrop legitimately intersects both
    // protected regions — accepted overlap (ADR-0005): reported as safe-area
    // warnings, never failing the render. Every other signal must stay absent.
    expect(warnings.filter((w) => w.startsWith("safe-area:"))).toHaveLength(2);
    expect(warnings.every((w) => w.includes('layer "backdrop"'))).toBe(true);
    expect(warnings.filter((w) => !w.startsWith("safe-area:"))).toEqual([]);
    const img = decodePng(png);
    expect(img.px(100, 100)).toEqual([15, 23, 42, 255]); // gradient backdrop corner (#0f172a)
    expect(img.px(640, 460)).toEqual([16, 24, 32, 255]); // card plate, below the label
    expect(img.px(484, 284)).toEqual([34, 211, 238, 255]); // logo disc
  }, 20000);

  it("inspects as one group with addressable children", async () => {
    const { exitCode, output } = await cliRun(["inspect", FIXTURE]);
    expect(exitCode).toBe(0);
    // layerCount counts the whole tree — 2 top-level + 4 group children.
    expect(output).toMatchObject({ layerCount: 6 });
    const layers = (output as { layers: Record<string, unknown>[] }).layers;
    expect(layers[1]).toMatchObject({ id: "logo-card", type: "group" });
    const nested = layers[1]!.layers as Record<string, unknown>[];
    expect(nested.map((c) => c.id)).toEqual(["card-bg", "card-logo", "card-label", "card-tag"]);
  });
});

// --- shape inspect ----------------------------------------------------------------

describe("shape layers — inspect", () => {
  it("summarizes shape layers with geometry and style", async () => {
    await writeFile(
      fix.sceneFile,
      JSON.stringify(
        scene([
          shapeLayer({ shape: "rect", radius: 12, border: { width: 4, color: "#000000" } }),
          shapeLayer({ id: "oval", shape: "ellipse", color: undefined, fill: { from: "#ff0000", to: "#0000ff" } }),
        ]),
      ),
    );
    const { exitCode, output } = await cliRun(["inspect", fix.sceneFile]);
    expect(exitCode).toBe(0);
    const layers = (output as { layers: Record<string, unknown>[] }).layers;
    expect(layers[0]).toMatchObject({
      id: "badge",
      type: "shape",
      shape: "rect",
      radius: 12,
      color: "#ff0000",
      border: { width: 4, color: "#000000" },
    });
    expect(layers[1]).toMatchObject({
      id: "oval",
      type: "shape",
      shape: "ellipse",
      fill: { from: "#ff0000", to: "#0000ff" },
    });
    expect(layers[1]).not.toHaveProperty("color");
  });

  it("validates a shape scene through the CLI", async () => {
    await writeFile(fix.sceneFile, JSON.stringify(scene([shapeLayer({ shape: "triangle" })])));
    const { exitCode, output } = await cliRun(["validate", fix.sceneFile]);
    expect(exitCode).toBe(0);
    expect(output).toMatchObject({ ok: true, layerCount: 1 });
  });
});