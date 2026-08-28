import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { inflateSync } from "node:zlib";
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
import { scenePageHtml, renderScene, type ImageSize } from "../src/scene-render.js";
import { run as cliRun } from "../src/scene-cli.js";

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

/**
 * Minimal PNG reader for 8-bit non-interlaced RGB/RGBA screenshots:
 * inflates the IDAT stream and unfilters scanlines so tests can assert on
 * actual composited pixels, not just header dimensions.
 */
function decodePng(buf: Buffer): {
  width: number;
  height: number;
  px: (x: number, y: number) => number[];
} {
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const colorType = buf[25]!;
  const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : NaN;
  if (!Number.isInteger(bpp)) throw new Error(`unsupported PNG color type ${colorType}`);

  const idat: Buffer[] = [];
  let off = 8;
  while (off + 12 <= buf.length) {
    const len = buf.readUInt32BE(off);
    if (buf.toString("ascii", off + 4, off + 8) === "IDAT")
      idat.push(buf.subarray(off + 8, off + 8 + len));
    off += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));

  const stride = width * bpp;
  const out = Buffer.alloc(height * stride);
  const paeth = (a: number, b: number, c: number) => {
    const p = a + b - c;
    const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++]!;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp]! : 0;
      const b = prev ? prev[x]! : 0;
      const c = prev && x >= bpp ? prev[x - bpp]! : 0;
      let v = raw[pos + x]!;
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) v += paeth(a, b, c);
      cur[x] = v & 0xff;
    }
    pos += stride;
  }
  return {
    width,
    height,
    px: (x, y) => {
      const at = y * stride + x * bpp;
      const rgb = Array.from(out.subarray(at, at + bpp));
      return bpp === 3 ? [...rgb, 255] : rgb;
    },
  };
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

  it("exports image and text as separate oneOf branches — the schema matches enforcement", async () => {
    const layer = (SCENE_SCHEMA.definitions as Record<string, any>).layer;
    expect(layer.oneOf).toHaveLength(2);
    expect(layer.oneOf.map((b: { $ref: string }) => b.$ref)).toEqual([
      "#/definitions/imageLayer",
      "#/definitions/textLayer",
    ]);
    // Each branch is closed and requires its own type's fields.
    for (const name of ["imageLayer", "textLayer"] as const) {
      const branch = (SCENE_SCHEMA.definitions as Record<string, any>)[name];
      expect(branch.additionalProperties).toBe(false);
      expect(branch.required).toContain("type");
    }
    expect((SCENE_SCHEMA.definitions as Record<string, any>).imageLayer.required).toContain("asset");
    expect((SCENE_SCHEMA.definitions as Record<string, any>).textLayer.required).toContain("font");
  });

  it("rejects a non-object layer", async () => {
    const errors = await loadErrors(scene(["nope" as unknown as SceneLayer]));
    expect(errors[0]!.path).toBe("layers[0]");
    expect(errors[0]!.message).toMatch(/image or text object/);
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
    const noSize = await loadErrors(scene([textLayer({ fontSize: undefined })]));
    expect(noSize[0]!.path).toBe("layers[0].fontSize");
    expect(noSize[0]!.message).toMatch(/"fontSize" is required on text layers/);
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
  });

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
  });

  it("letterboxes contain with background instead of stretching", async () => {
    const { resolved } = await load(scene([imageLayer({ asset: "./bg.svg", fit: "contain" })]));
    const { png } = await renderScene(resolved);
    const img = decodePng(png);
    expect(img.px(5, 5)).toEqual([255, 255, 255, 255]);
    expect(img.px(640, 360)).toEqual([255, 0, 0, 255]);
  });

  it("text layers change pixels — a render without them differs", async () => {
    const base = await load(scene([imageLayer({ asset: "./bg.svg" })]));
    const withText = await load(
      scene([imageLayer({ asset: "./bg.svg" }), textLayer({ color: "#ffffff" })]),
    );
    const without = await renderScene(base.resolved);
    const with_ = await renderScene(withText.resolved);
    expect(with_.png.equals(without.png)).toBe(false);
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
    const layer = schema.definitions?.layer as { oneOf?: { $ref: string }[] };
    expect(layer.oneOf).toHaveLength(2);
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
  });

  it("exits 2 with usage on an unknown command", async () => {
    const { exitCode, output } = await cliRun(["nonsense"]);
    expect(exitCode).toBe(2);
    expect((output as { errors: { message: string }[] }).errors[0]!.message).toMatch(
      /unknown command "nonsense"/,
    );
  });
});
