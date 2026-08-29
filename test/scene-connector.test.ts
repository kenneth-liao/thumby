import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Page } from "playwright";
import { getBrowser } from "../src/browser.js";
import { loadScene, type Scene, type SceneLayer, type LoadResult } from "../src/scene.js";
import { scenePageHtml, renderScene, connectorGeometry, type ImageSize } from "../src/scene-render.js";
import { run as cliRun } from "../src/scene-cli.js";
import { decodePng } from "./png.js";

// --- fixtures -------------------------------------------------------------

/** Opaque red square — a plain image body for z-order and target boxes. */
const RED_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="#ff0000"/></svg>`;

interface Fix {
  root: string;
  projectRoot: string;
  sceneFile: string;
}

let fix: Fix;
let page: Page;

beforeAll(async () => {
  const root = await mkdtemp(path.join(tmpdir(), "thumby-connector-"));
  const projectRoot = path.join(root, "project");
  await mkdir(projectRoot, { recursive: true });
  await writeFile(path.join(projectRoot, "red.svg"), RED_SVG);
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

/** Render in the shared route-blocked page — scenes are 1280×720 like the viewport. */
const render = (resolved: Extract<LoadResult, { ok: true }>["resolved"]) =>
  renderScene(resolved, { page });

// --- helpers ----------------------------------------------------------------

const shapeLayer = (over: Record<string, unknown> = {}): SceneLayer =>
  ({
    id: "badge",
    type: "shape",
    shape: "rect",
    color: "#ff0000",
    position: { x: 100, y: 275 },
    size: { width: 200, height: 170 },
    ...over,
  }) as SceneLayer;

const connectorLayer = (over: Record<string, unknown> = {}): SceneLayer =>
  ({
    id: "line",
    type: "connector",
    from: "badge",
    to: "target",
    ...over,
  }) as SceneLayer;

const scene = (layers: SceneLayer[]): Scene => ({
  schemaVersion: 1,
  canvas: { width: 1280, height: 720 },
  layers,
});

async function load(raw: unknown): Promise<Extract<LoadResult, { ok: true }>> {
  const result = await loadScene(fix.projectRoot, async () => {
    throw new Error("connector tests must not reference library assets");
  }, raw);
  expect(result.ok).toBe(true);
  return result as Extract<LoadResult, { ok: true }>;
}

async function loadErrors(raw: unknown): Promise<{ path: string; message: string }[]> {
  const result = await loadScene(fix.projectRoot, async () => {
    throw new Error("connector tests must not reference library assets");
  }, raw);
  expect(result.ok).toBe(false);
  return (result as { ok: false; errors: { path: string; message: string }[] }).errors;
}

async function htmlOf(layers: SceneLayer[], natural?: Map<string, ImageSize>): Promise<string> {
  const { resolved } = await load(scene(layers));
  return scenePageHtml(resolved, natural ?? new Map());
}

// --- connector validation ------------------------------------------------------

describe("connector layers — validation", () => {
  it("accepts a connector between two top-level layers", async () => {
    const { resolved } = await load(
      scene([shapeLayer(), shapeLayer({ id: "target", position: { x: 600, y: 260 } }), connectorLayer()]),
    );
    expect(resolved.scene.layers[2]).toMatchObject({ type: "connector", from: "badge", to: "target" });
  });

  it("rejects a dangling from target naming the field", async () => {
    const errors = await loadErrors(scene([connectorLayer({ from: "ghost" }), shapeLayer(), shapeLayer({ id: "target" })]));
    expect(errors[0]!.path).toBe("layers[0].from");
    expect(errors[0]!.message).toMatch(/ghost/);
  });

  it("rejects a dangling to target naming the field", async () => {
    const errors = await loadErrors(scene([connectorLayer({ to: "ghost" }), shapeLayer(), shapeLayer({ id: "target" })]));
    expect(errors[0]!.path).toBe("layers[0].to");
    expect(errors[0]!.message).toMatch(/ghost/);
  });

  it("rejects a group-child id as a target — targets are top-level only", async () => {
    const errors = await loadErrors(
      scene([
        connectorLayer({ from: "target", to: "inner" }),
        shapeLayer({ id: "target" }),
        {
          id: "card",
          type: "group",
          position: { x: 0, y: 0 },
          size: { width: 100, height: 100 },
          layers: [shapeLayer({ id: "inner", position: { x: 0, y: 0 }, size: { width: 10, height: 10 } })],
        } as SceneLayer,
      ]),
    );
    expect(errors[0]!.path).toBe("layers[0].to");
    expect(errors[0]!.message).toMatch(/inner/);
  });

  it("rejects a self-targeted connector", async () => {
    const errors = await loadErrors(
      scene([connectorLayer({ from: "line" }), shapeLayer(), shapeLayer({ id: "target" })]),
    );
    expect(errors[0]!.path).toBe("layers[0].from");
    expect(errors[0]!.message).toMatch(/itself/);
  });

  it("rejects a connector targeting another connector — no box to anchor to", async () => {
    const errors = await loadErrors(
      scene([connectorLayer(), connectorLayer({ id: "chain", to: "line" }), shapeLayer(), shapeLayer({ id: "target" })]),
    );
    expect(errors[0]!.path).toBe("layers[1].to");
    expect(errors[0]!.message).toMatch(/targets connector/);
  });

  it("rejects a connector nested inside a group — geometry resolves in frame coordinates", async () => {
    const errors = await loadErrors(
      scene([
        shapeLayer({ id: "target" }),
        {
          id: "card",
          type: "group",
          position: { x: 0, y: 0 },
          size: { width: 100, height: 100 },
          layers: [connectorLayer({ from: "card" })],
        } as SceneLayer,
      ]),
    );
    expect(errors[0]!.path).toBe("layers[1].layers[0].type");
    expect(errors[0]!.message).toMatch(/top level|frame/);
  });

  it("rejects connector fields on other layer types — from the schema's oneOf branches", async () => {
    const errors = await loadErrors(scene([shapeLayer({ from: "x", to: "y" })]));
    expect(errors[0]!.path).toBe("layers[0].from");
    expect(errors[0]!.message).toMatch(/not a valid/);
  });

  it("rejects an empty dash array", async () => {
    const errors = await loadErrors(scene([connectorLayer({ dash: [] }), shapeLayer(), shapeLayer({ id: "target" })]));
    expect(errors[0]!.path).toBe("layers[0].dash");
  });

  it("rejects a non-positive width", async () => {
    const errors = await loadErrors(scene([connectorLayer({ width: 0 }), shapeLayer(), shapeLayer({ id: "target" })]));
    expect(errors[0]!.path).toBe("layers[0].width");
  });

  it("rejects position/size on a connector — geometry derives from targets", async () => {
    const errors = await loadErrors(
      scene([connectorLayer({ position: { x: 0, y: 0 } }), shapeLayer(), shapeLayer({ id: "target" })]),
    );
    expect(errors[0]!.path).toBe("layers[0].position");
    expect(errors[0]!.message).toMatch(/not a valid/);
  });

  it("rejects an unknown layer type naming connector as supported", async () => {
    const errors = await loadErrors(scene([{ id: "x", type: "arrow", from: "a", to: "b" } as unknown as SceneLayer]));
    expect(errors[0]!.message).toMatch(/connector/);
  });
});

// --- connector geometry ---------------------------------------------------------

/**
 * Two boxes with a clean horizontal axis: A (100,275)–(300,445) centered at
 * (200,360), B (600,260)–(800,460) centered at (700,360).
 */
const A = { x: 100, y: 275, width: 200, height: 170 };
const B = { x: 600, y: 260, width: 200, height: 200 };

describe("connector geometry", () => {
  it("trims the path to where it exits the source box and enters the target box", () => {
    expect(connectorGeometry(A, B)).toEqual({ x1: 300, y1: 360, cx: 450, cy: 360, x2: 600, y2: 360 });
  });

  it("trims vertical runs the same way — exits the bottom, enters the top", () => {
    const a = { x: 200, y: 100, width: 200, height: 100 };
    const b = { x: 200, y: 400, width: 200, height: 100 };
    expect(connectorGeometry(a, b)).toEqual({ x1: 300, y1: 200, cx: 300, cy: 300, x2: 300, y2: 400 });
  });

  it("bows perpendicular to the run — positive curves clockwise (down for left→right)", () => {
    const g = connectorGeometry(A, B, 50);
    expect(g.cx).toBeCloseTo(450);
    expect(g.cy).toBeCloseTo(410);
  });

  it("flips the bow with the run direction — right→left curves up", () => {
    const g = connectorGeometry(B, A, 50);
    expect(g.cy).toBeCloseTo(310);
  });

  it("falls back to the centers when the boxes overlap along the run", () => {
    const g = connectorGeometry({ x: 0, y: 0, width: 200, height: 100 }, { x: 50, y: 25, width: 200, height: 100 });
    expect(g).toEqual({ x1: 100, y1: 50, cx: 125, cy: 62.5, x2: 150, y2: 75 });
  });
});

// --- connector markup ------------------------------------------------------------

describe("connector layers — markup", () => {
  it("draws a pixel-space full-canvas SVG path trimmed to the target boxes", async () => {
    const html = await htmlOf([
      shapeLayer(),
      shapeLayer({ id: "target", position: { x: 600, y: 260 }, size: { width: 200, height: 200 } }),
      connectorLayer({ color: "#ff0000", width: 4 }),
    ]);
    expect(html).toContain(`M 300 360 Q 450 360 600 360`);
    expect(html).toContain(`stroke="#ff0000" stroke-width="4"`);
  });

  it("keeps connectors addressable and canvas-sized like every other layer", async () => {
    const html = await htmlOf([
      shapeLayer(),
      shapeLayer({ id: "target", position: { x: 600, y: 260 }, size: { width: 200, height: 200 } }),
      connectorLayer({ opacity: 0.5, visible: false }),
    ]);
    expect(html).toContain(`class="scene-layer" data-layer-id="line"`);
    expect(html).toContain("left:0px;top:0px;width:1280px;height:720px;opacity:0.5;display:none");
  });

  it("emits the dash pattern as SVG stroke-dasharray in frame px", async () => {
    const html = await htmlOf([
      shapeLayer(),
      shapeLayer({ id: "target", position: { x: 600, y: 260 }, size: { width: 200, height: 200 } }),
      connectorLayer({ dash: [10, 9] }),
    ]);
    expect(html).toContain(`stroke-dasharray="10 9"`);
  });

  it("omits stroke-dasharray on a solid connector", async () => {
    const html = await htmlOf([
      shapeLayer(),
      shapeLayer({ id: "target", position: { x: 600, y: 260 }, size: { width: 200, height: 200 } }),
      connectorLayer(),
    ]);
    expect(html).not.toContain("stroke-dasharray");
  });

  it("adds an auto-oriented arrowhead marker at the to end, colored with the line", async () => {
    const html = await htmlOf([
      shapeLayer(),
      shapeLayer({ id: "target", position: { x: 600, y: 260 }, size: { width: 200, height: 200 } }),
      connectorLayer({ color: "#ff0000", arrow: true }),
    ]);
    expect(html).toContain(`marker-end="url(#arrow-1)"`);
    expect(html).toContain(
      `<marker id="arrow-1" viewBox="0 0 12 12" refX="10" refY="6" markerWidth="4" markerHeight="4" orient="auto" markerUnits="strokeWidth"><path d="M 1 1 L 11 6 L 1 11 Z" fill="#ff0000"/></marker>`,
    );
  });

  it("numbers arrow markers in layer order so ids stay unique", async () => {
    const html = await htmlOf([
      shapeLayer(),
      shapeLayer({ id: "target", position: { x: 600, y: 260 }, size: { width: 200, height: 200 } }),
      connectorLayer({ id: "line1", arrow: true }),
      connectorLayer({ id: "line2", from: "target", to: "badge", arrow: true }),
    ]);
    expect(html).toContain(`marker-end="url(#arrow-1)"`);
    expect(html).toContain(`marker-end="url(#arrow-2)"`);
  });

  it("composites connectors at their array position like any layer", async () => {
    const layers = [
      shapeLayer(),
      shapeLayer({ id: "target", position: { x: 600, y: 260 }, size: { width: 200, height: 200 } }),
      connectorLayer(),
    ];
    const html = await htmlOf(layers);
    expect(html.indexOf('data-layer-id="badge"')).toBeLessThan(html.indexOf('data-layer-id="line"'));
  });
});

// --- connector pixels -------------------------------------------------------------

/** The horizontal scene the pixel tests composite: line from (300,360) to (600,360). */
const horizontalScene = (connectorOver: Record<string, unknown> = {}): SceneLayer[] => [
  connectorLayer({ color: "#ff0000", ...connectorOver }),
  shapeLayer(),
  shapeLayer({ id: "target", position: { x: 600, y: 260 }, size: { width: 200, height: 200 } }),
];

describe("connector layers — pixels", () => {
  it("draws the line between the box edges, not beyond them", async () => {
    const { resolved } = await load(scene(horizontalScene({ width: 4 })));
    const { png } = await render(resolved);
    const img = decodePng(png);
    expect(img.px(450, 360)).toEqual([255, 0, 0, 255]); // mid-line
    expect(img.px(302, 360)).toEqual([255, 0, 0, 255]); // just inside the source edge
    expect(img.px(598, 360)).toEqual([255, 0, 0, 255]); // just inside the target edge
    expect(img.px(450, 340)).toEqual([255, 255, 255, 255]); // above the line
    expect(img.px(90, 360)).toEqual([255, 255, 255, 255]); // left of the source box
  }, 20000);

  it("renders the dash pattern — on in the dash, off in the gap", async () => {
    const { resolved } = await load(scene(horizontalScene({ width: 2, dash: [6, 6] })));
    const { png } = await render(resolved);
    const img = decodePng(png);
    expect(img.px(303, 360)).toEqual([255, 0, 0, 255]); // mid-dash (path starts at 300)
    expect(img.px(309, 360)).toEqual([255, 255, 255, 255]); // mid-gap
    expect(img.px(315, 360)).toEqual([255, 0, 0, 255]); // next dash
  }, 20000);

  it("bows the path — the curve passes below the straight run", async () => {
    const { resolved } = await load(scene(horizontalScene({ width: 4, bow: 100 })));
    const { png } = await render(resolved);
    const img = decodePng(png);
    expect(img.px(450, 410)).toEqual([255, 0, 0, 255]); // curve midpoint (bow 100 → y 360+100)
    expect(img.px(450, 360)).toEqual([255, 255, 255, 255]); // the straight run is empty
  }, 20000);

  it("lands the arrowhead at the target edge, oriented along the path", async () => {
    const { resolved } = await load(scene(horizontalScene({ width: 4, arrow: true })));
    const { png } = await render(resolved);
    const img = decodePng(png);
    expect(img.px(595, 360)).toEqual([255, 0, 0, 255]); // inside the arrowhead
    expect(img.px(560, 360)).toEqual([255, 0, 0, 255]); // the line
    expect(img.px(595, 350)).toEqual([255, 255, 255, 255]); // above the arrowhead
  }, 20000);

  it("composites in z-order — the connector can pass behind or in front of a layer", async () => {
    const conn = connectorLayer({ color: "#ff0000", width: 4 });
    const blocker = shapeLayer({
      id: "creator",
      color: "#0000ff",
      position: { x: 430, y: 330 },
      size: { width: 100, height: 60 },
    });
    const behind = await render((await load(scene([conn, ...horizontalScene().slice(1), blocker]))).resolved);
    const front = await render((await load(scene([...horizontalScene().slice(1), blocker, conn]))).resolved);
    expect(decodePng(behind.png).px(480, 360)).toEqual([0, 0, 255, 255]); // connector behind
    expect(decodePng(front.png).px(480, 360)).toEqual([255, 0, 0, 255]); // connector in front
  }, 20000);

  it("hides with visible:false and fades with opacity", async () => {
    const hidden = await render((await load(scene(horizontalScene({ visible: false })))).resolved);
    expect(decodePng(hidden.png).px(450, 360)).toEqual([255, 255, 255, 255]);
    const faded = await render((await load(scene(horizontalScene({ opacity: 0.5 })))).resolved);
    const [r, g, b] = decodePng(faded.png).px(450, 360);
    expect(r).toBeGreaterThanOrEqual(250); // 50% red over white keeps the red channel
    for (const c of [g, b]) {
      expect(c).toBeGreaterThanOrEqual(120);
      expect(c).toBeLessThanOrEqual(135);
    }
  }, 20000);
});

// --- the constellation fixture -----------------------------------------------------

/**
 * The committed constellation fixture: glass-tile card groups, a creator image,
 * and Connectors — the overlay constellation rebuilt from generic layers only.
 * The Claude card and its connector sit before the creator image, so the
 * creator overlaps both; the rest composite in front.
 */
describe("constellation fixture — generic layers only", () => {
  const FIXTURE = path.join(import.meta.dir, "fixtures", "constellation", "constellation.json");

  const loadFixture = async () => {
    const raw = JSON.parse(await readFile(FIXTURE, "utf8"));
    const result = await loadScene(
      path.dirname(FIXTURE),
      async () => {
        throw new Error("the constellation fixture must not reference library assets");
      },
      raw,
    );
    expect(result.ok).toBe(true);
    return result as Extract<LoadResult, { ok: true }>;
  };

  it("validates with no library references", async () => {
    const { resolved } = await loadFixture();
    const types = resolved.scene.layers.map((l) => l.type);
    expect(new Set(types)).toEqual(
      new Set(["shape", "group", "connector", "image"]),
    );
  });

  it("renders with the creator in front of the behind card and its connector", async () => {
    const { resolved } = await loadFixture();
    const { png, width, height, warnings } = await render(resolved);
    expect([width, height]).toEqual([1280, 720]);
    // The fixture's full-canvas backdrop legitimately intersects both
    // protected regions and the codex tile's corner enters the badge —
    // accepted overlap (ADR-0005): reported as safe-area warnings, never
    // failing the render. Every other render signal must stay absent.
    const pairs = warnings
      .filter((w) => w.startsWith("safe-area:"))
      .map((w) => /visible layer "([^"]+)".*intersects the (.+) region /.exec(w))
      .map((m) => `${m![1]}→${m![2]}`)
      .sort();
    expect(pairs).toEqual(
      ["backdrop→duration-badge", "backdrop→progress-bar", "codex-tile→duration-badge"].sort(),
    );
    expect(warnings.filter((w) => !w.startsWith("safe-area:"))).toEqual([]);
    const img = decodePng(png);
    expect(img.px(135, 135)).toEqual([20, 24, 31, 255]); // claude tile, above the creator
    expect(img.px(300, 300)).toEqual([34, 211, 238, 255]); // creator over the behind card
    expect(img.px(390, 311)).toEqual([34, 211, 238, 255]); // behind connector hidden under the creator
    expect(img.px(420, 327)).toEqual([242, 242, 242, 255]); // behind connector visible past the creator
    expect(img.px(838, 335)).toEqual([242, 242, 242, 255]); // front dashed connector, mid-dash
    expect(img.px(995, 536)).toEqual([242, 242, 242, 255]); // bowed connector's arrowhead at the codex card
  }, 20000);

  it("inspects as generic layers with connector summaries", async () => {
    const { exitCode, output } = await cliRun(["inspect", FIXTURE]);
    expect(exitCode).toBe(0);
    const data = output as { layerCount: number; layers: Record<string, unknown>[] };
    // 9 top-level layers + 12 group children.
    expect(data.layerCount).toBe(21);
    const conn = data.layers.find((l) => l.id === "conn-codex");
    expect(conn).toMatchObject({
      type: "connector",
      from: "choice-card",
      to: "codex-card",
      bow: 60,
      dash: [10, 9],
      color: "#F2F2F2",
      width: 3.2,
      arrow: true,
    });
    const choice = data.layers.find((l) => l.id === "choice-card");
    expect(choice).toMatchObject({ effects: { glow: { radius: 20 } } });
  });
});

// --- connector inspect ------------------------------------------------------------

describe("connector layers — inspect", () => {
  it("summarizes targets and effective styling — and has no position/size", async () => {
    await writeFile(
      fix.sceneFile,
      JSON.stringify(scene(horizontalScene({ bow: 40, dash: [10, 9], arrow: true }))),
    );
    const { exitCode, output } = await cliRun(["inspect", fix.sceneFile]);
    expect(exitCode).toBe(0);
    const layers = (output as { layers: Record<string, unknown>[] }).layers;
    expect(layers[0]).toEqual({
      id: "line",
      type: "connector",
      visible: true,
      opacity: 1,
      from: "badge",
      to: "target",
      bow: 40,
      dash: [10, 9],
      color: "#ff0000",
      width: 3,
      arrow: true,
    });
  });

  it("surfaces connector defaults on a bare connector", async () => {
    await writeFile(
      fix.sceneFile,
      JSON.stringify(scene([connectorLayer(), shapeLayer(), shapeLayer({ id: "target", position: { x: 600, y: 260 }, size: { width: 200, height: 200 } })])),
    );
    const { exitCode, output } = await cliRun(["inspect", fix.sceneFile]);
    expect(exitCode).toBe(0);
    const layers = (output as { layers: Record<string, unknown>[] }).layers;
    expect(layers[0]).toEqual({
      id: "line",
      type: "connector",
      visible: true,
      opacity: 1,
      from: "badge",
      to: "target",
      color: "#000",
      width: 3,
      arrow: false,
    });
  });

  it("validates a connector scene through the CLI", async () => {
    await writeFile(fix.sceneFile, JSON.stringify(scene(horizontalScene())));
    const { exitCode, output } = await cliRun(["validate", fix.sceneFile]);
    expect(exitCode).toBe(0);
    expect(output).toMatchObject({ ok: true, layerCount: 3 });
  });
});
