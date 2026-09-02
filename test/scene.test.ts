import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import Ajv from "ajv";
import { contentHash, scanLibrary, type Library } from "../src/assets.js";
import { BUNDLED_FACES, resolveFace } from "../src/fonts.js";
import {
  loadScene,
  SCENE_SCHEMA,
  type Scene,
  type SceneLayer,
  type LoadResult,
} from "../src/scene.js";
import { scenePageHtml, renderScene, type ImageSize } from "../src/scene-render.js";
import { run as cliRun } from "../src/scene-cli.js";
import { decodePng } from "./png.js";

// --- fixtures -------------------------------------------------------------

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="#ff0000"/></svg>`;

/** Top half red, bottom half blue — spatial variation, so crop math is visible in pixels. */
const QUAD_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="50" fill="#ff0000"/><rect y="50" width="100" height="50" fill="#0000ff"/></svg>`;

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
  await writeFile(path.join(projectRoot, "quad.svg"), QUAD_SVG);
  // Lives outside the project root on purpose — containment tests read it.
  await writeFile(path.join(root, "outside.svg"), SVG);
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

/** A text layer whose content is styled spans instead of plain text. */
const spanLayer = (
  spans: Record<string, unknown>[],
  over: Record<string, unknown> = {},
): SceneLayer => textLayer({ text: undefined, spans, ...over }) as SceneLayer;

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
  return scenePageHtml(resolved, natural ?? new Map([["bg", { width: 100, height: 100 }]]));
}

// --- pixel decoding -----------------------------------------------------------

/** Pixel assertions decode the composited screenshot — one reader in test/png.ts. */

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
    const errors = await loadErrors(
      scene([{ ...imageLayer(), type: "emitter" } as unknown as SceneLayer]),
    );
    expect(errors[0]!.path).toBe("layers[0].type");
    expect(errors[0]!.message).toMatch(/unknown layer type "emitter"/);
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
    expect(errors[0]!.message).toMatch(/"asset" is required on image layers/);
  });

  it("reports a missing project asset by field and path", async () => {
    const errors = await loadErrors(scene([imageLayer({ asset: "./nope.png" })]));
    expect(errors[0]!.path).toBe("layers[0].asset");
    expect(errors[0]!.message).toMatch(/missing project asset "\.\/nope\.png"/);
  });

  it("rejects project refs that escape the scene directory", async () => {
    const rel = await loadErrors(scene([imageLayer({ asset: "../outside.svg" })]));
    expect(rel[0]!.path).toBe("layers[0].asset");
    expect(rel[0]!.message).toMatch(/escapes the project directory/);

    const abs = await loadErrors(
      scene([imageLayer({ asset: path.join(fix.root, "outside.svg") })]),
    );
    expect(abs[0]!.message).toMatch(/escapes the project directory/);
  });

  it("rejects a symlink that points outside the scene directory", async () => {
    const link = path.join(fix.projectRoot, "link.svg");
    await symlink(path.join(fix.root, "outside.svg"), link);
    const errors = await loadErrors(scene([imageLayer({ asset: "./link.svg" })]));
    expect(errors[0]!.path).toBe("layers[0].asset");
    expect(errors[0]!.message).toMatch(/escapes the project directory/);
  });

  it("scans the library only when a scene references a library asset", async () => {
    let scans = 0;
    const result = await loadScene(
      fix.projectRoot,
      async () => {
        scans++;
        return fix.lib;
      },
      scene([imageLayer({ asset: "./bg.svg" })]),
    );
    expect(result.ok).toBe(true);
    expect(scans).toBe(0);
  });

  it("lands a corrupt-library failure on the layer that referenced it", async () => {
    const result = await loadScene(
      fix.projectRoot,
      async () => {
        throw new Error("library is corrupt");
      },
      scene([imageLayer()]),
    );
    expect(result.ok).toBe(false);
    const errors = (result as { errors: { path: string; message: string }[] }).errors;
    expect(errors[0]!.path).toBe("layers[0].asset");
    expect(errors[0]!.message).toMatch(/library is corrupt/);
  });

  it("rejects an unknown library asset with the available ids", async () => {
    const errors = await loadErrors(scene([imageLayer({ asset: "no-such-plate" })]));
    expect(errors[0]!.path).toBe("layers[0].asset");
    expect(errors[0]!.message).toMatch(/unknown library asset "no-such-plate"/);
  });

  it("rejects crop and fit on text layers — from the schema's oneOf branches", async () => {
    const crop = await loadErrors(
      scene([textLayer({ crop: { left: 0, top: 0, right: 0, bottom: 0 } })]),
    );
    expect(crop[0]!.path).toBe("layers[0].crop");
    expect(crop[0]!.message).toMatch(/"crop" is not a valid layer property/);
    const fit = await loadErrors(scene([textLayer({ fit: "cover" })]));
    expect(fit[0]!.path).toBe("layers[0].fit");
    expect(fit[0]!.message).toMatch(/"fit" is not a valid layer property/);
  });

  it("rejects text-only fields on image layers — from the schema's oneOf branches", async () => {
    const errors = await loadErrors(scene([imageLayer({ text: "hi" })]));
    expect(errors[0]!.path).toBe("layers[0].text");
    expect(errors[0]!.message).toMatch(/"text" is not a valid layer property/);
  });

  it("exports every layer type as a separate oneOf branch — the schema matches enforcement", async () => {
    const layer = (SCENE_SCHEMA.definitions as Record<string, any>).layer;
    expect(layer.oneOf).toHaveLength(5);
    expect(layer.oneOf.map((b: { $ref: string }) => b.$ref)).toEqual([
      "#/definitions/imageLayer",
      "#/definitions/textLayer",
      "#/definitions/shapeLayer",
      "#/definitions/groupLayer",
      "#/definitions/connectorLayer",
    ]);
    // Each branch is closed and requires its own type's fields.
    for (const name of ["imageLayer", "textLayer", "shapeLayer", "groupLayer", "connectorLayer"] as const) {
      const branch = (SCENE_SCHEMA.definitions as Record<string, any>)[name];
      expect(branch.additionalProperties).toBe(false);
      expect(branch.required).toContain("type");
    }
    expect((SCENE_SCHEMA.definitions as Record<string, any>).imageLayer.required).toContain("asset");
    expect((SCENE_SCHEMA.definitions as Record<string, any>).textLayer.required).toContain("font");
    expect((SCENE_SCHEMA.definitions as Record<string, any>).shapeLayer.required).toContain("shape");
    expect((SCENE_SCHEMA.definitions as Record<string, any>).groupLayer.required).toContain("layers");
  });

  it("rejects a non-object layer", async () => {
    const errors = await loadErrors(scene(["nope" as unknown as SceneLayer]));
    expect(errors[0]!.path).toBe("layers[0]");
    expect(errors[0]!.message).toMatch(/image, text, shape, group, or connector object/);
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
    expect(noFont[0]!.message).toMatch(/"font" is required on text layers/);
  });

  it("rejects a text layer with neither fontSize nor autoFit", async () => {
    const errors = await loadErrors(scene([textLayer({ fontSize: undefined })]));
    expect(errors[0]!.path).toBe("layers[0].fontSize");
    expect(errors[0]!.message).toMatch(/"fontSize" or "autoFit"/);
  });

  it("rejects a layer with both fontSize and autoFit", async () => {
    const errors = await loadErrors(
      scene([textLayer({ autoFit: { min: 20, max: 120 } })]),
    );
    expect(errors[0]!.path).toBe("layers[0].autoFit");
    expect(errors[0]!.message).toMatch(/mutually exclusive/);
  });

  it("rejects an inverted autoFit range", async () => {
    const errors = await loadErrors(
      scene([textLayer({ fontSize: undefined, autoFit: { min: 120, max: 20 } })]),
    );
    expect(errors[0]!.path).toBe("layers[0].autoFit");
    expect(errors[0]!.message).toMatch(/min .* max/);
  });

  it("publishes the whole text contract in the schema document itself", () => {
    // The machine-readable contract must reject what thumby rejects —
    // independent of the semantic pass.
    const validate = new Ajv().compile({
      ...(SCENE_SCHEMA.definitions as Record<string, any>).textLayer,
      definitions: SCENE_SCHEMA.definitions,
    });
    const base = textLayer() as unknown as Record<string, unknown>;
    const invalid = (over: Record<string, unknown>) =>
      !validate({ ...base, ...over });
    expect(invalid({ spans: [{ text: "Run" }] })).toBe(true); // text + spans
    expect(invalid({ autoFit: { min: 20, max: 120 } })).toBe(true); // fontSize + autoFit
    expect(invalid({ color: "#ffffff", fill: { from: "#ff0000", to: "#0000ff" } })).toBe(true); // color + fill
    // Content and sizing are exactly-one: neither present is rejected too.
    expect(invalid({ text: undefined })).toBe(true);
    expect(invalid({ fontSize: undefined })).toBe(true);
    // Either side alone stays valid.
    expect(validate({ ...base, fontSize: undefined, autoFit: { min: 20, max: 120 } })).toBe(true);
    expect(validate({ ...base, color: undefined, fill: { from: "#ff0000", to: "#0000ff" } })).toBe(true);
  });

  it("rejects non-positive fontSize", async () => {
    const errors = await loadErrors(scene([textLayer({ fontSize: 0 })]));
    expect(errors[0]!.path).toBe("layers[0].fontSize");
  });

  it("rejects both text and spans — content lives in one place", async () => {
    const errors = await loadErrors(
      scene([textLayer({ spans: [{ text: "Run" }] })]),
    );
    expect(errors[0]!.path).toBe("layers[0].spans");
    expect(errors[0]!.message).toMatch(/mutually exclusive/);
  });

  it("rejects a text layer with neither text nor spans", async () => {
    const errors = await loadErrors(scene([textLayer({ text: undefined })]));
    expect(errors[0]!.path).toBe("layers[0].text");
    expect(errors[0]!.message).toMatch(/"text" or "spans"/);
  });

  it("requires text on every span", async () => {
    const errors = await loadErrors(
      scene([spanLayer([{ color: "#fff" }])]),
    );
    expect(errors[0]!.path).toBe("layers[0].spans[0].text");
    expect(errors[0]!.message).toMatch(/"text" is required on spans/);
  });

  it("rejects unknown span properties", async () => {
    const errors = await loadErrors(
      scene([spanLayer([{ text: "Run", swirl: 2 }])]),
    );
    expect(errors[0]!.path).toBe("layers[0].spans[0].swirl");
    expect(errors[0]!.message).toMatch(/"swirl" is not a valid span property/);
  });

  it("rejects empty span text", async () => {
    const errors = await loadErrors(scene([spanLayer([{ text: "" }])]));
    expect(errors[0]!.path).toBe("layers[0].spans[0].text");
  });

  it("rejects an unknown span font naming the bundled families", async () => {
    const errors = await loadErrors(
      scene([spanLayer([{ text: "Run", font: "Comic Sans" }])]),
    );
    expect(errors[0]!.path).toBe("layers[0].spans[0].font");
    expect(errors[0]!.message).toMatch(/unknown font family "Comic Sans"/);
  });

  it("rejects out-of-range weight", async () => {
    const zero = await loadErrors(scene([textLayer({ weight: 0 })]));
    expect(zero[0]!.path).toBe("layers[0].weight");
    const big = await loadErrors(scene([textLayer({ weight: 1001 })]));
    expect(big[0]!.path).toBe("layers[0].weight");
  });

  it("rejects an unknown casing value", async () => {
    const errors = await loadErrors(scene([textLayer({ casing: "small-caps" })]));
    expect(errors[0]!.path).toBe("layers[0].casing");
  });

  it("rejects a layer with both color and fill — one fill per layer", async () => {
    const errors = await loadErrors(
      scene([
        textLayer({ color: "#fff", fill: { from: "#ff0000", to: "#0000ff" } }),
      ]),
    );
    expect(errors[0]!.path).toBe("layers[0].fill");
    expect(errors[0]!.message).toMatch(/mutually exclusive/);
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

  it("fits the cropped window per fit — cover crops further to preserve aspect", async () => {
    const html = await htmlOf([
      imageLayer({ crop: { left: 10, top: 20, right: 10, bottom: 0 } }),
    ]);
    const layer = html.slice(html.indexOf('data-layer-id="bg"'));
    expect(layer).toMatch(/overflow:hidden/);
    // Source window 80×80 (of 100×100) into 1280×720: cover scales by 16 →
    // window 1280×1280 clipped by the layer, vertically centered.
    expect(layer).toMatch(/left:0px;top:-280px;width:1280px;height:1280px/);
    // The full image sits at 1600×1600 inside the window, shifted up so the
    // window's content (and only it) fills the visible box.
    expect(layer).toMatch(/left:-160px;top:-320px;width:1600px;height:1600px/);
  });

  it("stretch-fills the cropped window on fill", async () => {
    const html = await htmlOf([
      imageLayer({ crop: { left: 10, top: 20, right: 10, bottom: 0 }, fit: "fill" }),
    ]);
    const layer = html.slice(html.indexOf('data-layer-id="bg"'));
    // Window is the box itself; the full image stretches independently per axis.
    expect(layer).toMatch(/left:0px;top:0px;width:1280px;height:720px/);
    expect(layer).toMatch(/left:-160px;top:-180px;width:1600px;height:900px/);
  });

  it("letterboxes the cropped window on contain", async () => {
    const html = await htmlOf([
      imageLayer({ crop: { left: 10, top: 20, right: 10, bottom: 0 }, fit: "contain" }),
    ]);
    const layer = html.slice(html.indexOf('data-layer-id="bg"'));
    // Contain scales by 9 → window 720×720, centered horizontally with margins.
    expect(layer).toMatch(/left:280px;top:0px;width:720px;height:720px/);
    expect(layer).toMatch(/left:-90px;top:-180px;width:900px;height:900px/);
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

  it("ships @font-face bytes for span font overrides too — no silent fallback", async () => {
    const html = await htmlOf([
      spanLayer([{ text: "quiet " }, { text: "LOUD", font: "Archivo Black" }]),
    ]);
    expect(html).toMatch(/@font-face \{ font-family: "Anton"/);
    expect(html).toMatch(/@font-face \{ font-family: "Archivo Black"/);
    expect(html).toMatch(/font-family:'Archivo Black'/);
  });

  it("renders spans as inline elements styled inside the layer", async () => {
    const html = await htmlOf([
      spanLayer([{ text: "Big " }, { text: "news", color: "#00c2ff", fontSize: 96 }]),
    ]);
    const el = html.slice(html.indexOf('data-layer-id="title"'));
    // Layer-level typography stays on the layer element; spans carry only their overrides.
    expect(el).toMatch(/font-family:'Anton'/);
    expect(el).toMatch(/font-size:120px/);
    expect(el).toMatch(/<span>Big <\/span>/);
    expect(el).toMatch(/<span style="font-size:96px;color:#00c2ff">news<\/span>/);
  });

  it("escapes HTML-significant characters in span content", async () => {
    const html = await htmlOf([spanLayer([{ text: "a <b> & c" }])]);
    expect(html).toContain("<span>a &lt;b&gt; &amp; c</span>");
    expect(html).not.toContain("<b>");
  });

  it("applies weight, tracking, and casing as inline layer styles", async () => {
    const html = await htmlOf(
      [textLayer({ weight: 900, tracking: -0.02, casing: "upper" })],
    );
    const el = html.slice(html.indexOf('data-layer-id="title"'));
    expect(el).toMatch(/font-weight:900/);
    expect(el).toMatch(/letter-spacing:-0\.02em/);
    expect(el).toMatch(/text-transform:uppercase/);
  });

  it("leaves casing and tracking off when unset", async () => {
    const html = await htmlOf([textLayer()]);
    const el = html.slice(html.indexOf('data-layer-id="title"'));
    expect(el).not.toMatch(/text-transform/);
    expect(el).not.toMatch(/letter-spacing/);
  });

  it("spans override weight, tracking, and casing independently", async () => {
    const html = await htmlOf([
      spanLayer([
        { text: "quiet " },
        { text: "LOUD", weight: 800, tracking: 0.1, casing: "upper" },
      ]),
    ]);
    const el = html.slice(html.indexOf('data-layer-id="title"'));
    expect(el).toMatch(/<span>quiet <\/span>/);
    expect(el).toMatch(
      /<span style="font-weight:800;letter-spacing:0\.1em;text-transform:uppercase">LOUD<\/span>/,
    );
  });

  it("paints a gradient fill through background-clip, not color", async () => {
    const html = await htmlOf([
      textLayer({ color: undefined, fill: { from: "#ff0000", to: "#0000ff", angle: 45 } }),
    ]);
    const el = html.slice(html.indexOf('data-layer-id="title"'));
    expect(el).toMatch(/color:transparent/);
    expect(el).toMatch(/background:linear-gradient\(45deg,#ff0000,#0000ff\)/);
    expect(el).toMatch(/-webkit-background-clip:text/);
    expect(el).toMatch(/background-clip:text/);
    expect(el).toMatch(/-webkit-text-fill-color:transparent/);
    expect(el).not.toMatch(/color:#000/);
  });

  it("defaults the gradient angle to left→right", async () => {
    const html = await htmlOf([
      textLayer({ color: undefined, fill: { from: "#ff0000", to: "#0000ff" } }),
    ]);
    expect(html).toMatch(/linear-gradient\(90deg,#ff0000,#0000ff\)/);
  });

  it("restates an explicit span color over a gradient fill — the clip would hide it", async () => {
    const html = await htmlOf([
      spanLayer(
        [{ text: "hot", color: "#ffd400" }, { text: " cold" }],
        { color: undefined, fill: { from: "#ff0000", to: "#0000ff" } },
      ),
    ]);
    const el = html.slice(html.indexOf('data-layer-id="title"'));
    expect(el).toMatch(/-webkit-text-fill-color:#ffd400/);
    // The colorless span keeps the gradient.
    expect(el).toMatch(/<span> cold<\/span>/);
    expect(el).not.toMatch(/<span style="color:#ffd400">/);
  });

  it("strokes outside the glyphs and lists shadows back to front", async () => {
    const html = await htmlOf([
      textLayer({
        stroke: { width: 8, color: "#111318" },
        shadows: [
          { x: 0, y: 6, blur: 0, color: "#ff00ff" },
          { x: 2, y: 2, blur: 18, color: "#000000" },
        ],
      }),
    ]);
    const el = html.slice(html.indexOf('data-layer-id="title"'));
    expect(el).toMatch(/-webkit-text-stroke:8px #111318/);
    expect(el).toMatch(/paint-order:stroke fill/);
    // CSS paints the first text-shadow on top, so back-to-front listing
    // emits reversed — the last-listed shadow lands front-most.
    expect(el).toMatch(
      /text-shadow:2px 2px 18px #000000,0px 6px 0px #ff00ff/,
    );
  });

  it("keeps the glyph interior when stroked — paint-order works in pixels", async () => {
    // If Chromium ignored paint-order, a centered stroke would eat the glyph
    // interior: stroked blue coverage must nearly match the unstroked render.
    const blueCount = async (stroked: boolean) => {
      const { resolved } = await load(
        scene([
          textLayer({
            font: "Archivo Black",
            fontSize: 300,
            position: { x: 100, y: 180 },
            size: { width: 1080, height: 380 },
            color: "#0000ff",
            stroke: stroked ? { width: 40, color: "#ff0000" } : undefined,
            text: "IO",
          }),
        ]),
      );
      const { png } = await renderScene(resolved);
      const img = decodePng(png);
      let blue = 0;
      for (let y = 160; y < 580; y += 2)
        for (let x = 80; x < 1200; x += 2) {
          const [r, g, b] = img.px(x, y);
          if (b > 200 && r < 80 && g < 80) blue++;
        }
      return blue;
    };
    const plain = await blueCount(false);
    const stroked = await blueCount(true);
    expect(plain).toBeGreaterThan(1000);
    expect(stroked).toBeGreaterThanOrEqual(plain * 0.9);
  });

  it("paints overlapping shadows with the last listed front-most", async () => {
    // Two hard shadows at the same offset fully overlap: the front one must
    // cover the back one completely, so blue (listed last) wins and no red
    // survives — the reversed emission order, proven in pixels.
    const { resolved } = await load(
      scene([
        textLayer({
          font: "Archivo Black",
          fontSize: 140,
          position: { x: 100, y: 280 },
          size: { width: 1080, height: 180 },
          color: "#101318",
          shadows: [
            { x: 10, y: 10, blur: 0, color: "#ff0000" },
            { x: 10, y: 10, blur: 0, color: "#0000ff" },
          ],
          text: "ORDER",
        }),
      ]),
    );
    const { png } = await renderScene(resolved);
    const img = decodePng(png);
    let red = false;
    let blue = false;
    for (let y = 260; y < 500; y += 2)
      for (let x = 80; x < 1200; x += 2) {
        const [r, g, b] = img.px(x, y);
        if (r > 200 && g < 80 && b < 80) red = true;
        if (b > 200 && r < 80 && g < 80) blue = true;
      }
    expect(blue).toBe(true);
    expect(red).toBe(false);
  }, 20000);
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
  }, 20000);

  it("composites real pixels — crop selects the source window before fitting", async () => {
    // quad.svg: top half red, bottom half blue. Cropping off the top 50% must
    // leave an all-blue canvas; if crop were ignored, the top half would be red.
    const { resolved } = await load(
      scene([
        imageLayer({
          id: "quad",
          asset: "./quad.svg",
          crop: { left: 0, top: 50, right: 0, bottom: 0 },
        }),
      ]),
    );
    const { png } = await renderScene(resolved);
    const img = decodePng(png);
    expect(img.width).toBe(1280);
    expect(img.px(100, 100)).toEqual([0, 0, 255, 255]);
    expect(img.px(1100, 600)).toEqual([0, 0, 255, 255]);
  }, 20000);

  it("centers the cropped window on cover — red above, blue below", async () => {
    // Window = left half (red over blue, 100×200 of a 200×200 source) covered
    // into 1280×720: scale 12.8 → the visible band shows source y 71.9..128.1,
    // i.e. red in the upper part of the canvas, blue in the lower part. An
    // offset error shifts the band and turns the canvas single-colored.
    const { resolved } = await load(
      scene([
        imageLayer({
          id: "quad",
          asset: "./quad.svg",
          crop: { left: 0, top: 0, right: 50, bottom: 0 },
        }),
      ]),
    );
    const { png } = await renderScene(resolved);
    const img = decodePng(png);
    expect(img.px(640, 100)[0]).toBeGreaterThan(200); // red channel dominates
    expect(img.px(640, 600)[2]).toBeGreaterThan(200); // blue channel dominates
  }, 20000);

  it("letterboxes contain with background instead of stretching", async () => {
    const { resolved } = await load(scene([imageLayer({ asset: "./bg.svg", fit: "contain" })]));
    const { png } = await renderScene(resolved);
    const img = decodePng(png);
    expect(img.px(5, 5)).toEqual([255, 255, 255, 255]);
    expect(img.px(640, 360)).toEqual([255, 0, 0, 255]);
  }, 20000);

  it("text layers change pixels — a render without them differs", async () => {
    const base = await load(scene([imageLayer({ asset: "./bg.svg" })]));
    const withText = await load(
      scene([imageLayer({ asset: "./bg.svg" }), textLayer({ color: "#ffffff" })]),
    );
    const without = await renderScene(base.resolved);
    const with_ = await renderScene(withText.resolved);
    expect(with_.png.equals(without.png)).toBe(false);
  }, 20000);

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
  }, 20000);

  it("applies casing in pixels — transformed and literal text render identically", async () => {
    const lowered = await load(scene([textLayer({ text: "aaa", casing: "upper" })]));
    const literal = await load(scene([textLayer({ text: "AAA" })]));
    const a = await renderScene(lowered.resolved);
    const b = await renderScene(literal.resolved);
    expect(a.png.equals(b.png)).toBe(true);
  }, 20000);

  it("tracking changes the rendered layout", async () => {
    const tight = await load(scene([textLayer({ text: "tracking", tracking: 0 })]));
    const wide = await load(scene([textLayer({ text: "tracking", tracking: 0.5 })]));
    const a = await renderScene(tight.resolved);
    const b = await renderScene(wide.resolved);
    expect(a.png.equals(b.png)).toBe(false);
  }, 20000);

  it("off-face weight changes pixels — synthesized, never silent", async () => {
    // Anton ships weight 400 only; 900 renders through Chromium's synthetic
    // bold, so the two renders must visibly differ.
    const natural = await load(scene([textLayer({ text: "weight", weight: 400 })]));
    const synthesized = await load(scene([textLayer({ text: "weight", weight: 900 })]));
    const a = await renderScene(natural.resolved);
    const b = await renderScene(synthesized.resolved);
    expect(a.png.equals(b.png)).toBe(false);
  }, 20000);

  it("tracks the gradient across glyphs — left reddish, right bluish", async () => {
    const { resolved } = await load(
      scene([
        textLayer({
          font: "Archivo Black",
          fontSize: 160,
          position: { x: 100, y: 260 },
          size: { width: 1080, height: 220 },
          color: undefined,
          fill: { from: "#ff0000", to: "#0000ff" },
          text: "GRAD GRAD",
        }),
      ]),
    );
    const { png } = await renderScene(resolved);
    const img = decodePng(png);
    const dominant = (x: number, y: number) => {
      const [r, g, b] = img.px(x, y);
      return r > 180 && g < 100 && b < 100 ? "red" : b > 180 && r < 100 && g < 100 ? "blue" : null;
    };
    let red = false;
    let blue = false;
    for (let y = 260; y < 500; y += 2)
      for (let x = 100; x < 700; x += 2) red ||= dominant(x, y) === "red";
    for (let y = 260; y < 500; y += 2)
      for (let x = 700; x < 1180; x += 2) blue ||= dominant(x, y) === "blue";
    expect(red).toBe(true);
    expect(blue).toBe(true);
  }, 20000);

  it("shrinks to the largest size that fits the layer box — nothing spills outside", async () => {
    const { resolved } = await load(
      scene([
        textLayer({
          font: "Archivo Black",
          text: "AUTO FIT KEEPS EVERY GLYPH INSIDE THE BOX",
          fontSize: undefined,
          autoFit: { min: 20, max: 300 },
          position: { x: 100, y: 300 },
          size: { width: 900, height: 140 },
          color: "#ff0000",
        }),
      ]),
    );
    const { png } = await renderScene(resolved);
    const img = decodePng(png);
    const reddish = ([r, g, b]: number[]) => r > 150 && g < 120 && b < 120;
    let inside = false;
    let outside = false;
    for (let y = 0; y < 720; y += 2)
      for (let x = 0; x < 1280; x += 2) {
        if (!reddish(img.px(x, y))) continue;
        const inBox =
          x >= 98 && x <= 1002 && y >= 298 && y <= 442;
        if (inBox) inside = true;
        else outside = true;
      }
    expect(inside).toBe(true);
    expect(outside).toBe(false);
  }, 20000);

  it("honors the whole autoFit range — a higher max renders bigger", async () => {
    const base = {
      font: "Archivo Black",
      text: "SIZING",
      position: { x: 100, y: 300 },
      size: { width: 900, height: 140 },
      color: "#ff0000",
    };
    const capped = await load(
      scene([textLayer({ ...base, fontSize: undefined, autoFit: { min: 20, max: 60 } })]),
    );
    const free = await load(
      scene([textLayer({ ...base, fontSize: undefined, autoFit: { min: 20, max: 240 } })]),
    );
    const a = await renderScene(capped.resolved);
    const b = await renderScene(free.resolved);
    expect(a.png.equals(b.png)).toBe(false);
  }, 20000);

  it("keeps explicit span sizes absolute while the layer auto-fits", async () => {
    const base = {
      font: "Archivo Black",
      text: undefined,
      fontSize: undefined,
      spans: [{ text: "FIXED ", fontSize: 80 }, { text: "REST" }],
      autoFit: { min: 20, max: 200 },
      position: { x: 100, y: 300 },
      size: { width: 900, height: 200 },
      color: "#ff0000",
    };
    const at80 = await load(scene([textLayer({ ...base })]));
    const at40 = await load(
      scene([
        textLayer({
          ...base,
          spans: [{ text: "FIXED ", fontSize: 40 }, { text: "REST" }],
        }),
      ]),
    );
    const a = await renderScene(at80.resolved);
    const b = await renderScene(at40.resolved);
    // Dropping span sizing entirely would change this render — the explicit
    // span fontSize is load-bearing.
    expect(a.png.equals(b.png)).toBe(false);
    let red = false;
    const img = decodePng(b.png);
    for (let y = 280; y < 520; y++)
      for (let x = 80; x < 1200; x += 2) {
        const [r, g, bl] = img.px(x, y);
        if (r > 150 && g < 120 && bl < 120) red = true;
      }
    expect(red).toBe(true);
  }, 20000);

  it("reports an auto-fit layer that cannot fit at its min floor", async () => {
    const { resolved } = await load(
      scene([
        textLayer({
          id: "floor",
          font: "Archivo Black",
          text: "THIS TEXT CANNOT FIT AT ANY SIZE IN ITS RANGE",
          fontSize: undefined,
          autoFit: { min: 90, max: 120 },
          position: { x: 100, y: 300 },
          size: { width: 400, height: 60 },
          color: "#ff0000",
        }),
      ]),
    );
    const { warnings } = await renderScene(resolved);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/layer "floor"/);
    expect(warnings[0]).toMatch(/90px floor/);
  }, 20000);

  it("renders stroke and shadow colors onto the canvas", async () => {
    const { resolved } = await load(
      scene([
        textLayer({
          font: "Archivo Black",
          fontSize: 140,
          position: { x: 100, y: 280 },
          size: { width: 1080, height: 180 },
          color: "#ffffff",
          stroke: { width: 10, color: "#0000ff" },
          shadows: [{ x: 14, y: 14, blur: 0, color: "#ff0000" }],
          text: "POP",
        }),
      ]),
    );
    const { png } = await renderScene(resolved);
    const img = decodePng(png);
    const hasColor = (want: (p: number[]) => boolean) => {
      for (let y = 260; y < 500; y += 2)
        for (let x = 80; x < 1200; x += 2) if (want(img.px(x, y))) return true;
      return false;
    };
    expect(hasColor(([r, g, b]) => b > 200 && r < 80 && g < 80)).toBe(true); // stroke
    expect(hasColor(([r, g, b]) => r > 200 && g < 80 && b < 80)).toBe(true); // shadow
  }, 20000);

  it("renders independently styled spans — each span's color lands on canvas", async () => {
    // Pure red and pure blue spans on a white canvas: each color must actually
    // appear, so per-span styling demonstrably reaches pixels.
    const { resolved } = await load(
      scene([
        textLayer({
          font: "Archivo Black",
          fontSize: 90,
          position: { x: 100, y: 300 },
          size: { width: 1080, height: 140 },
          text: undefined,
          spans: [
            { text: "RED", color: "#ff0000" },
            { text: " BLUE", color: "#0000ff" },
          ],
        }),
      ]),
    );
    const { png } = await renderScene(resolved);
    const img = decodePng(png);
    const hasColor = (r: number, g: number, b: number) => {
      for (let y = 280; y < 460; y += 2)
        for (let x = 80; x < 1200; x += 2) {
          const [pr, pg, pb] = img.px(x, y);
          if (pr > r && pg < g && pb < b) return true;
        }
      return false;
    };
    expect(hasColor(200, 80, 80)).toBe(true);
    expect(hasColor(80, 80, 200)).toBe(true);
  }, 20000);
});

// --- cli ------------------------------------------------------------------------

describe("committed fixtures", () => {
  const FIXTURES_DIR = path.join(import.meta.dir, "fixtures", "text");

  it("every fixture scene validates as text-only", async () => {
    const files = (await readdir(FIXTURES_DIR)).filter((f) => f.endsWith(".json"));
    expect(files.length).toBeGreaterThanOrEqual(4);
    for (const file of files) {
      const raw = JSON.parse(await readFile(path.join(FIXTURES_DIR, file), "utf8"));
      // Fixtures carry no assets — a library scan attempt is a fixture bug.
      const result = await loadScene(
        FIXTURES_DIR,
        async () => {
          throw new Error(`${file} must not reference library assets`);
        },
        raw,
      );
      expect(result.ok).toBe(true);
    }
  });
});

describe("scene cli", () => {
  it("schema returns the machine-readable JSON Schema document", async () => {
    const { exitCode, output } = await cliRun(["schema"]);
    expect(exitCode).toBe(0);
    const schema = output as typeof SCENE_SCHEMA;
    const layer = schema.definitions?.layer as unknown as { oneOf?: { $ref: string }[] };
    expect(layer.oneOf).toHaveLength(5);
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

  it("inspect summarizes rich text properties", async () => {
    const rich = path.join(fix.projectRoot, "rich.json");
    await writeFile(
      rich,
      JSON.stringify(
        scene([
          textLayer({
            text: undefined,
            spans: [{ text: "Go ", color: "#ff0000" }, { text: "FAST" }],
            autoFit: { min: 40, max: 180 },
            fontSize: undefined,
            weight: 800,
            tracking: -0.01,
            casing: "upper",
            stroke: { width: 6, color: "#111318" },
            shadows: [{ x: 0, y: 6, blur: 12, color: "#000000" }],
          }),
        ]),
      ),
    );
    const { exitCode, output } = await cliRun(["inspect", rich]);
    expect(exitCode).toBe(0);
    const [layer] = (output as { layers: Record<string, any>[] }).layers;
    expect(layer).toMatchObject({
      spans: [{ text: "Go ", color: "#ff0000" }, { text: "FAST" }],
      autoFit: { min: 40, max: 180 },
      weight: 800,
      tracking: -0.01,
      casing: "upper",
      stroke: { width: 6, color: "#111318" },
      shadows: [{ x: 0, y: 6, blur: 12, color: "#000000" }],
    });
    expect(layer.text).toBeUndefined();
  });

  it("render writes a 1280×720 png and reports the output", async () => {
    const out = path.join(fix.projectRoot, "rendered.png");
    const { exitCode, output } = await cliRun(["render", fix.sceneFile, "--out", out]);
    expect(exitCode).toBe(0);
    expect(output).toMatchObject({ ok: true, width: 1280, height: 720 });
    const bytes = await readFile(out);
    expect(bytes.readUInt32BE(16)).toBe(1280);
    expect(bytes.readUInt32BE(20)).toBe(720);
  }, 20000);

  it("refuses --out outside the scene directory", async () => {
    const { exitCode, output } = await cliRun([
      "render",
      fix.sceneFile,
      "--out",
      path.join(fix.root, "evil.png"),
    ]);
    expect(exitCode).toBe(2);
    const errors = (output as { errors: { message: string }[] }).errors;
    expect(errors[0]!.message).toMatch(/must stay inside the scene's directory/);
  });

  it("reports a crashed render as structured JSON, not a stack trace", async () => {
    // A directory at the output path makes writeFile fail after the render —
    // the error boundary must turn that into {ok:false,errors} with exit 1.
    await mkdir(path.join(fix.projectRoot, "out"), { recursive: true });
    const { exitCode, output } = await cliRun([
      "render",
      fix.sceneFile,
      "--out",
      path.join(fix.projectRoot, "out"),
    ]);
    expect(exitCode).toBe(1);
    const { ok, errors } = output as { ok: boolean; errors: { path: string; message: string }[] };
    expect(ok).toBe(false);
    expect(errors[0]!.path).toBe("render");
    expect(errors[0]!.message).toMatch(/EISDIR|directory/);
  }, 20000);

  it("exits 2 with usage on an unknown command", async () => {
    const { exitCode, output } = await cliRun(["nonsense"]);
    expect(exitCode).toBe(2);
    const message = (output as { errors: { message: string }[] }).errors[0]!.message;
    expect(message).toMatch(/unknown command "nonsense"/);
    expect(message).toMatch(/expected .*author/);
  });
});
