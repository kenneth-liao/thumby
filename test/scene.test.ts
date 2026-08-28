import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { contentHash, scanLibrary, type Library } from "../src/assets.js";
import { BUNDLED_FACES, resolveFace } from "../src/fonts.js";
import {
  loadScene,
  SCENE_SCHEMA,
  type Scene,
  type SceneLayer,
  type LoadResult,
} from "../src/scene.js";
import { scenePageHtml, renderScene } from "../src/scene-render.js";
import { run as cliRun } from "../src/scene-cli.js";

// --- fixtures -------------------------------------------------------------

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="#ff0000"/></svg>`;

interface Fix {
  root: string;
  projectRoot: string;
  lib: Library;
  svgHash: string;
  sceneFile: string;
}

let fix: Fix;

beforeAll(async () => {
  const root = await mkdtemp(path.join(tmpdir(), "thumby-scene-"));
  const projectRoot = path.join(root, "project");
  const libRoot = path.join(root, "library");
  await mkdir(path.join(libRoot, "plates", "demo-plate"), { recursive: true });
  await writeFile(
    path.join(libRoot, "plates", "demo-plate", "meta.json"),
    JSON.stringify({ kind: "plate", id: "demo-plate", name: "Demo Plate", tags: [] }),
  );
  await writeFile(path.join(libRoot, "plates", "demo-plate", "demo-plate.svg"), SVG);
  await mkdir(projectRoot, { recursive: true });
  await writeFile(path.join(projectRoot, "bg.svg"), SVG);
  const sceneFile = path.join(projectRoot, "scene.json");
  await writeFile(
    sceneFile,
    JSON.stringify(scene([imageLayer({ asset: "./bg.svg" }), textLayer()])),
  );
  fix = {
    root,
    projectRoot,
    lib: await scanLibrary(libRoot),
    svgHash: contentHash(Buffer.from(SVG, "utf8")),
    sceneFile,
  };
});

afterAll(async () => {
  await rm(fix.root, { recursive: true, force: true });
});

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

const textLayer = (over: Record<string, unknown> = {}): SceneLayer =>
  ({
    id: "title",
    type: "text",
    text: "Big news",
    font: "Anton",
    fontSize: 120,
    position: { x: 60, y: 500 },
    size: { width: 900, height: 180 },
    ...over,
  }) as SceneLayer;

const scene = (layers: SceneLayer[]): Scene => ({
  schemaVersion: 1,
  canvas: { width: 1280, height: 720 },
  layers,
});

async function load(raw: unknown): Promise<Extract<LoadResult, { ok: true }>> {
  const result = await loadScene(fix.projectRoot, fix.lib, raw);
  expect(result.ok).toBe(true);
  return result as Extract<LoadResult, { ok: true }>;
}

async function loadErrors(raw: unknown): Promise<{ path: string; message: string }[]> {
  const result = await loadScene(fix.projectRoot, fix.lib, raw);
  expect(result.ok).toBe(false);
  return (result as { ok: false; errors: { path: string; message: string }[] }).errors;
}

async function htmlOf(layers: SceneLayer[]): Promise<string> {
  const { resolved } = await load(scene(layers));
  return scenePageHtml(resolved);
}

// --- validation ---------------------------------------------------------------

describe("scene validation", () => {
  it("accepts a valid scene with library and project assets", async () => {
    const { resolved } = await load(scene([imageLayer(), textLayer()]));
    expect(resolved.scene.layers).toHaveLength(2);
    const bg = resolved.assets.get("bg")!;
    expect(bg.hash).toBe(fix.svgHash);
    expect(bg.kind).toBe("plate");
    expect(bg.mediaType).toBe("image/svg+xml");
  });

  it("supports hash-pinned library refs and fails loudly on a stale pin", async () => {
    const pinned = await load(scene([imageLayer({ asset: `demo-plate@${fix.svgHash}` })]));
    expect(pinned.resolved.assets.get("bg")!.hash).toBe(fix.svgHash);

    const stale = await loadErrors(scene([imageLayer({ asset: "demo-plate@deadbeef" })]));
    expect(stale[0]!.path).toBe("layers[0].asset");
    expect(stale[0]!.message).toMatch(/mismatch|re-pin/);
  });

  it("rejects an unsupported schema version with a versioned message", async () => {
    const errors = await loadErrors({ ...scene([]), schemaVersion: 2 });
    expect(errors[0]!.path).toBe("schemaVersion");
    expect(errors[0]!.message).toMatch(/unsupported.*version 1/);
  });

  it("rejects a canvas other than 1280×720", async () => {
    const errors = await loadErrors({
      ...scene([]),
      canvas: { width: 1920, height: 1080 },
    });
    const paths = errors.map((e) => e.path);
    expect(paths).toContain("canvas.width");
    expect(paths).toContain("canvas.height");
    expect(errors[0]!.message).toMatch(/1280×720/);
  });

  it("rejects duplicate layer ids naming the second occurrence", async () => {
    const errors = await loadErrors(scene([imageLayer(), imageLayer()]));
    expect(errors[0]!.path).toBe("layers[1].id");
    expect(errors[0]!.message).toMatch(/duplicate layer id "bg"/);
  });

  it("rejects unknown layer types", async () => {
    const errors = await loadErrors(scene([{ ...imageLayer(), type: "shape" }]));
    expect(errors[0]!.path).toBe("layers[0].type");
    expect(errors[0]!.message).toMatch(/unknown layer type "shape"/);
  });

  it("rejects unknown layer properties", async () => {
    const errors = await loadErrors(scene([textLayer({ tint: "#fff" })]));
    expect(errors.map((e) => e.path)).toContain("layers[0].tint");
  });

  it("requires position and size on every layer", async () => {
    const { id, type, ...layer } = imageLayer();
    const errors = await loadErrors(scene([{ id, type } as SceneLayer]));
    const paths = errors.map((e) => e.path);
    expect(paths).toContain("layers[0].position");
    expect(paths).toContain("layers[0].size");
  });

  it("rejects non-positive sizes", async () => {
    const errors = await loadErrors(
      scene([imageLayer({ size: { width: 0, height: 720 } })]),
    );
    expect(errors[0]!.path).toBe("layers[0].size.width");
  });

  it("rejects out-of-range opacity", async () => {
    const errors = await loadErrors(scene([textLayer({ opacity: 1.5 })]));
    expect(errors[0]!.path).toBe("layers[0].opacity");
  });

  it("requires an asset on image layers", async () => {
    const errors = await loadErrors(scene([imageLayer({ asset: undefined })]));
    expect(errors[0]!.path).toBe("layers[0].asset");
  });

  it("reports a missing project asset by field and path", async () => {
    const errors = await loadErrors(scene([imageLayer({ asset: "./nope.png" })]));
    expect(errors[0]!.path).toBe("layers[0].asset");
    expect(errors[0]!.message).toMatch(/missing project asset "\.\/nope\.png"/);
  });

  it("rejects an unknown library asset with the available ids", async () => {
    const errors = await loadErrors(scene([imageLayer({ asset: "no-such-plate" })]));
    expect(errors[0]!.path).toBe("layers[0].asset");
    expect(errors[0]!.message).toMatch(/unknown library asset "no-such-plate"/);
  });

  it("rejects crop and fit on text layers", async () => {
    const crop = await loadErrors(
      scene([textLayer({ crop: { left: 0, top: 0, right: 0, bottom: 0 } })]),
    );
    expect(crop[0]!.path).toBe("layers[0].crop");
    const fit = await loadErrors(scene([textLayer({ fit: "cover" })]));
    expect(fit[0]!.path).toBe("layers[0].fit");
  });

  it("rejects text-only fields on image layers", async () => {
    const errors = await loadErrors(scene([imageLayer({ text: "hi" })]));
    expect(errors[0]!.path).toBe("layers[0].text");
  });

  it("rejects crop insets that leave no source width or height", async () => {
    const errors = await loadErrors(
      scene([imageLayer({ crop: { left: 60, top: 0, right: 60, bottom: 0 } })]),
    );
    expect(errors[0]!.path).toBe("layers[0].crop");
    expect(errors[0]!.message).toMatch(/100%/);
  });

  it("rejects an unknown text font naming the bundled families", async () => {
    const errors = await loadErrors(scene([textLayer({ font: "Comic Sans" })]));
    expect(errors[0]!.path).toBe("layers[0].font");
    expect(errors[0]!.message).toMatch(/unknown font family "Comic Sans"/);
    expect(errors[0]!.message).toMatch(/Anton/);
  });

  it("requires font and fontSize on text layers", async () => {
    const noFont = await loadErrors(scene([textLayer({ font: undefined })]));
    expect(noFont[0]!.path).toBe("layers[0].font");
    const noSize = await loadErrors(scene([textLayer({ fontSize: undefined })]));
    expect(noSize[0]!.path).toBe("layers[0].fontSize");
  });

  it("rejects non-positive fontSize", async () => {
    const errors = await loadErrors(scene([textLayer({ fontSize: 0 })]));
    expect(errors[0]!.path).toBe("layers[0].fontSize");
  });
});

// --- bundled face registry --------------------------------------------------

describe("bundled face registry", () => {
  it("exposes every pairing face keyed by family", () => {
    expect(BUNDLED_FACES.get("Anton")?.file).toBe("anton.ttf");
    expect(BUNDLED_FACES.get("Source Sans 3")).toBeTruthy();
  });

  it("resolves a bundled family and fails loudly otherwise", () => {
    expect(resolveFace("Anton").family).toBe("Anton");
    expect(() => resolveFace("Comic Sans")).toThrow(/bundled families/);
  });
});

// --- page construction --------------------------------------------------------

describe("scene page html", () => {
  it("composites layers in array order — later layers later in the DOM", async () => {
    const html = await htmlOf([imageLayer(), textLayer()]);
    const bg = html.indexOf('data-layer-id="bg"');
    const title = html.indexOf('data-layer-id="title"');
    expect(bg).toBeGreaterThan(-1);
    expect(title).toBeGreaterThan(bg);
  });

  it("applies the shared transform set", async () => {
    const html = await htmlOf([
      textLayer({
        rotation: 45,
        mirror: true,
        opacity: 0.5,
        visible: false,
      }),
    ]);
    const el = html.slice(html.indexOf('data-layer-id="title"'));
    expect(el).toMatch(/rotate\(45deg\)/);
    expect(el).toMatch(/scaleX\(-1\)/);
    expect(el).toMatch(/opacity:0\.5/);
    expect(el).toMatch(/display:none/);
  });

  it("applies fit to image layers", async () => {
    const html = await htmlOf([imageLayer({ fit: "contain" })]);
    expect(html).toMatch(/object-fit:contain/);
  });

  it("applies crop insets by scaling the source inside a clipped box", async () => {
    const html = await htmlOf([
      imageLayer({ crop: { left: 10, top: 20, right: 10, bottom: 0 } }),
    ]);
    const layer = html.slice(html.indexOf('data-layer-id="bg"'));
    expect(layer).toMatch(/overflow:hidden/);
    expect(layer).toMatch(/width:125%/); // 100 / (1 - 0.10 - 0.10)
    expect(layer).toMatch(/left:-12\.5%/); // -10 / 0.80
    expect(layer).toMatch(/height:125%/); // 100 / (1 - 0.20)
    expect(layer).toMatch(/top:-25%/); // -20 / 0.80
  });

  it("renders text with the bundled face, size, and explicit line breaks", async () => {
    const html = await htmlOf([
      textLayer({ text: "Two\nlines", color: "#ffcc00", align: "center" }),
    ]);
    expect(html).toMatch(/font-family:'Anton'/);
    expect(html).toMatch(/font-size:120px/);
    expect(html).toMatch(/font-weight:400/);
    expect(html).toMatch(/color:#ffcc00/);
    expect(html).toMatch(/text-align:center/);
    expect(html).toMatch(/white-space:pre-line/);
    expect(html).toMatch(/@font-face \{ font-family: "Anton"; font-weight: 400;/);
    expect(html).toMatch(/src: url\(data:font\/ttf;base64,/);
    expect(html).toContain("Two\nlines");
  });

  it("escapes HTML-significant characters in text content", async () => {
    const html = await htmlOf([textLayer({ text: "a <b> & c" })]);
    expect(html).toContain("a &lt;b&gt; &amp; c");
    expect(html).not.toContain("a <b> & c");
  });

  it("emits @font-face rules only for faces the scene uses", async () => {
    const html = await htmlOf([textLayer()]);
    expect(html).toMatch(/@font-face \{ font-family: "Anton"/);
    expect(html).not.toMatch(/Bevan/);
  });
});

// --- render --------------------------------------------------------------------

describe("scene render", () => {
  it("renders exactly 1280×720", async () => {
    const { resolved } = await load(scene([imageLayer({ asset: "./bg.svg" }), textLayer()]));
    const { png, width, height } = await renderScene(resolved);
    expect(width).toBe(1280);
    expect(height).toBe(720);
    expect(png.readUInt32BE(16)).toBe(1280);
    expect(png.readUInt32BE(20)).toBe(720);
  });

  it("renders with every network request aborted — data URIs only, no implicit generation", async () => {
    const { resolved } = await load(scene([imageLayer({ asset: "./bg.svg" }), textLayer()]));
    const browser = await chromium.launch();
    try {
      const ctx = await browser.newContext();
      await ctx.route("**/*", (route) => route.abort());
      const page = await ctx.newPage();
      const { png } = await renderScene(resolved, { page });
      expect(png.readUInt32BE(16)).toBe(1280);
    } finally {
      await browser.close();
    }
  });
});

// --- cli ------------------------------------------------------------------------

describe("scene cli", () => {
  it("schema returns the machine-readable JSON Schema document", async () => {
    const { exitCode, output } = await cliRun(["schema"]);
    expect(exitCode).toBe(0);
    const schema = output as typeof SCENE_SCHEMA;
    expect(schema.definitions?.layer).toBeTruthy();
    expect(schema.properties?.layers?.type).toBe("array");
  });

  it("validate reports a valid scene", async () => {
    const { exitCode, output } = await cliRun(["validate", fix.sceneFile]);
    expect(exitCode).toBe(0);
    expect(output).toMatchObject({ ok: true, layerCount: 2 });
  });

  it("validate returns field-specific errors with exit code 1", async () => {
    const bad = path.join(fix.projectRoot, "bad.json");
    await writeFile(
      bad,
      JSON.stringify(scene([imageLayer({ id: "x" }), imageLayer({ id: "x" })])),
    );
    const { exitCode, output } = await cliRun(["validate", bad]);
    expect(exitCode).toBe(1);
    const errors = (output as { errors: { path: string; message: string }[] }).errors;
    expect(errors[0]!.path).toBe("layers[1].id");
  });

  it("validate reports invalid JSON as a structured error", async () => {
    const bad = path.join(fix.projectRoot, "broken.json");
    await writeFile(bad, "{ not json");
    const { exitCode, output } = await cliRun(["validate", bad]);
    expect(exitCode).toBe(1);
    const errors = (output as { errors: { path: string; message: string }[] }).errors;
    expect(errors[0]!.message).toMatch(/invalid JSON/);
  });

  it("inspect reports layer facts and the resolved asset hash", async () => {
    const { exitCode, output } = await cliRun(["inspect", fix.sceneFile]);
    expect(exitCode).toBe(0);
    const { layers } = output as { layers: Record<string, any>[] };
    expect(layers).toHaveLength(2);
    expect(layers[0]).toMatchObject({
      id: "bg",
      type: "image",
      asset: "./bg.svg",
      resolvedAsset: { scope: "project", path: "bg.svg", hash: fix.svgHash },
    });
    expect(layers[1]).toMatchObject({ id: "title", type: "text", font: "Anton", fontSize: 120 });
  });

  it("render writes a 1280×720 png and reports the output", async () => {
    const out = path.join(fix.projectRoot, "rendered.png");
    const { exitCode, output } = await cliRun(["render", fix.sceneFile, "--out", out]);
    expect(exitCode).toBe(0);
    expect(output).toMatchObject({ ok: true, width: 1280, height: 720 });
    const bytes = await readFile(out);
    expect(bytes.readUInt32BE(16)).toBe(1280);
    expect(bytes.readUInt32BE(20)).toBe(720);
  });

  it("exits 2 with usage on an unknown command", async () => {
    const { exitCode, output } = await cliRun(["nonsense"]);
    expect(exitCode).toBe(2);
    expect((output as { errors: { message: string }[] }).errors[0]!.message).toMatch(
      /unknown command "nonsense"/,
    );
  });
});
