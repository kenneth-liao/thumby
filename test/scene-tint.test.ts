/**
 * Uniform Image-layer tint (US-034, US-035, DEC-021): an authored color
 * painted through the resolved Asset's alpha — tint × alpha over the
 * backdrop, transparent pixels preserved, source bytes untouched. The tint
 * is a render-time Image-layer property with the same authored semantics for
 * raster and vector Assets, patchable as a whole field by Variants; the
 * masked `adjust` composes over the tinted result (the named-mask contract
 * is untouched).
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { contentHash, EMPTY_LIBRARY, scanLibrary, type Library } from "../src/assets.js";
import { loadScene, SCENE_SCHEMA, type Scene, type SceneLayer, type LoadResult } from "../src/scene.js";
import { resolveVariant } from "../src/variants.js";
import { renderScene } from "../src/scene-render.js";
import { encodePng, decodePng } from "./png.js";
import { run as cliRun } from "../src/scene-cli.js";

// --- fixtures ------------------------------------------------------------

const W = 8;
const H = 8;

/**
 * One alpha geography shared by the raster and vector fixtures — same
 * authored tint semantics must hold for both (TEST-014):
 *   x < 4            → opaque   (alpha 255)   → renders exactly the tint
 *   x ≥ 4 && y < 4   → transparent (alpha 0)  → untouched backdrop
 *   x ≥ 4 && y ≥ 4   → 50% alpha              → proportional tint blend
 */
const isOpaque = (x: number, y: number) => x < 4;
const isHalf = (x: number, y: number) => x >= 4 && y >= 4;
const isClear = (x: number, y: number) => !isOpaque(x, y) && !isHalf(x, y);

const rasterPng = encodePng(W, H, (x, y) =>
  isOpaque(x, y) ? [255, 0, 0, 255] : isHalf(x, y) ? [0, 255, 0, 128] : [0, 0, 0, 0],
);
const vectorSvg =
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">` +
  `<rect x="0" y="0" width="4" height="8" fill="#ff0000"/>` +
  `<rect x="4" y="4" width="4" height="4" fill="#00ff00" fill-opacity="0.5"/>` +
  `</svg>`;

const TINT = "#1565d8";
const tintRgb = [0x15, 0x65, 0xd8] as const;

interface Fix {
  root: string;
  projectRoot: string;
  rasterBytes: Buffer;
  libRoot: string;
  lib: Library;
  maskHash: string;
}

let fix: Fix;

beforeAll(async () => {
  const root = await mkdtemp(path.join(tmpdir(), "thumby-tint-"));
  const projectRoot = path.join(root, "project");
  await mkdir(projectRoot, { recursive: true });
  await writeFile(path.join(projectRoot, "tint-fixture.png"), rasterPng);
  await writeFile(path.join(projectRoot, "tint-fixture.svg"), vectorSvg);
  // A library Creator Asset carrying one named mask (the named-mask contract
  // is untouched by tint): the cutout shares the raster fixture's bytes, the
  // mask selects source 2..5 × 2..5.
  const isShirt = (x: number, y: number) => x >= 2 && x <= 5 && y >= 2 && y <= 5;
  const shirtMaskPng = encodePng(W, H, (x, y) =>
    isShirt(x, y) ? [255, 255, 255, 255] : [0, 0, 0, 0],
  );
  const libRoot = path.join(root, "library");
  await mkdir(path.join(libRoot, "cutouts", "ken"), { recursive: true });
  await mkdir(path.join(libRoot, "masks", "ken-shirt"), { recursive: true });
  await writeFile(path.join(libRoot, "cutouts", "ken", "cutout.png"), rasterPng);
  await writeFile(
    path.join(libRoot, "cutouts", "ken", "meta.json"),
    JSON.stringify({
      kind: "cutout",
      id: "ken",
      name: "Ken",
      tags: [],
      approval: "approved",
      masks: { shirt: "ken-shirt" },
    }),
  );
  await writeFile(path.join(libRoot, "masks", "ken-shirt", "mask.png"), shirtMaskPng);
  await writeFile(
    path.join(libRoot, "masks", "ken-shirt", "meta.json"),
    JSON.stringify({ kind: "mask", id: "ken-shirt", name: "Ken shirt", tags: [] }),
  );
  fix = {
    root,
    projectRoot,
    rasterBytes: rasterPng,
    libRoot,
    lib: await scanLibrary(libRoot),
    maskHash: contentHash(new Uint8Array(shirtMaskPng)),
  };
});

afterAll(async () => {
  await rm(fix.root, { recursive: true, force: true });
});

// --- helpers -------------------------------------------------------------

const imageLayer = (over: Record<string, unknown> = {}): SceneLayer =>
  ({
    id: "logo",
    type: "image",
    asset: "./tint-fixture.png",
    position: { x: 100, y: 100 },
    size: { width: W, height: H },
    ...over,
  }) as unknown as SceneLayer;

const sceneOf = (layers: SceneLayer[]): Scene =>
  ({ schemaVersion: 1, canvas: { width: 1280, height: 720 }, layers }) as Scene;

async function load(
  raw: unknown,
  library: () => Promise<Library> = async () => EMPTY_LIBRARY,
): Promise<Extract<LoadResult, { ok: true }>> {
  const result = await loadScene(fix.projectRoot, library, raw);
  expect(result.ok).toBe(true);
  return result as Extract<LoadResult, { ok: true }>;
}

async function loadErrors(
  raw: unknown,
  library: () => Promise<Library> = async () => EMPTY_LIBRARY,
): Promise<{ path: string; message: string }[]> {
  const result = await loadScene(fix.projectRoot, library, raw);
  expect(result.ok).toBe(false);
  return (result as { ok: false; errors: { path: string; message: string }[] }).errors;
}

// --- schema ---------------------------------------------------------------

describe("schema — tint on image layers", () => {
  it("publishes the tint definition in the machine-readable schema", () => {
    const props = SCENE_SCHEMA.definitions.imageLayer.properties as Record<string, unknown>;
    expect(props.tint).toBeDefined();
    // One home for color shape: the shared hex-color definition.
    expect((props.tint as Record<string, unknown>).$ref).toBe("#/definitions/color");
  });

  it("accepts a well-formed tint on an image layer", async () => {
    await load(sceneOf([imageLayer({ tint: TINT })]));
  });

  it("accepts a tint with alpha (#rrggbbaa)", async () => {
    await load(sceneOf([imageLayer({ tint: "#1565d880" })]));
  });

  it("rejects a non-hex tint value with a field-specific error", async () => {
    const errors = await loadErrors(sceneOf([imageLayer({ tint: "red" })]));
    expect(errors.some((e) => e.path === "layers[0].tint")).toBe(true);
  });

  it("rejects tint on a text layer with a field-specific error", async () => {
    const errors = await loadErrors(
      sceneOf([
        {
          id: "t",
          type: "text",
          text: "x",
          font: "Anton",
          fontSize: 40,
          position: { x: 0, y: 0 },
          size: { width: 100, height: 50 },
          tint: TINT,
        } as unknown as SceneLayer,
      ]),
    );
    expect(errors.some((e) => e.path === "layers[0].tint" && /not a valid .* property/.test(e.message))).toBe(true);
  });

  it("rejects tint on a shape layer with a field-specific error", async () => {
    const errors = await loadErrors(
      sceneOf([
        {
          id: "s",
          type: "shape",
          shape: "rect",
          position: { x: 0, y: 0 },
          size: { width: 100, height: 50 },
          color: "#000",
          tint: TINT,
        } as unknown as SceneLayer,
      ]),
    );
    expect(errors.some((e) => e.path === "layers[0].tint" && /not a valid .* property/.test(e.message))).toBe(true);
  });

  it("accepts tint together with adjust — tint paints, adjust blends over it", async () => {
    // DEC-021 leaves the named-mask contract untouched: a Creator Asset with
    // named masks can carry a tint, and the adjust composes over it.
    await load(
      sceneOf([imageLayer({ asset: "ken", tint: TINT, adjust: { mask: "shirt", color: "#ff0000" } })]),
      async () => fix.lib,
    );
  });

  it("accepts a Variant patching adjust onto a tinted layer", async () => {
    const raw = sceneOf([imageLayer({ asset: "ken", tint: TINT })]);
    raw.variants = { masked: { changes: [{ layer: "logo", set: { adjust: { mask: "shirt", color: "#ff0000" } } }] } };
    const applied = resolveVariant(raw, "masked");
    expect(applied.ok).toBe(true);
    await load((applied as { ok: true; raw: unknown }).raw, async () => fix.lib);
  });

  it("accepts tint as a variant patch value (whole-field set)", async () => {
    const raw = sceneOf([imageLayer()]);
    raw.variants = { red: { changes: [{ layer: "logo", set: { tint: "#ff0000" } }] } };
    await load(raw);
  });
});

// --- render: tint × alpha at the pixel boundary ----------------------------

describe("tinted render — the authored color through the Asset's alpha", () => {
  // One browser + route-aborting page for the whole describe: every render
  // must be offline, and shared browser state avoids a launch per test.
  let browser: import("playwright").Browser;
  let ctx: import("playwright").BrowserContext;
  let page: import("playwright").Page;

  beforeAll(async () => {
    const { chromium } = await import("playwright");
    browser = await chromium.launch();
    ctx = await browser.newContext();
    await ctx.route("**/*", (route) => route.abort());
    page = await ctx.newPage();
  });
  afterAll(async () => {
    await ctx.close();
    await browser.close();
  });

  /** Pixels that must be byte-identical between two renders, counted without
   *  a per-pixel expect: returns the count of differing pixels. */
  const diffCount = (a: ReturnType<typeof decodePng>, b: ReturnType<typeof decodePng>) => {
    let diff = 0;
    for (let y = 0; y < 720; y++)
      for (let x = 0; x < 1280; x++)
        if (a.px(x, y).join() !== b.px(x, y).join()) diff++;
    return diff;
  };

  /** Expected tint×alpha composite over the white page backdrop, ±1 for
   *  browser rounding: tint·a + 255·(1−a) per channel. */
  const overWhite = (channel: number, alpha: number) =>
    channel * alpha + 255 * (1 - alpha);
  const near = (v: number, want: number) => Math.abs(v - want) <= 1;

  /** Render the same layer geometry with and without the tint, decoded.
   *  `a` is the untinted render, `b` the tinted one. */
  async function renderPair(
    asset: string,
    layerOver: Record<string, unknown>,
  ) {
    const { tint, ...baseOver } = layerOver;
    const a = (await load(sceneOf([imageLayer({ asset, ...baseOver })]))).resolved;
    const b = (await load(sceneOf([imageLayer({ asset, tint: TINT, ...baseOver })]))).resolved;
    return {
      a: decodePng((await renderScene(a, { page })).png),
      b: decodePng((await renderScene(b, { page })).png),
    };
  }

  /** The shared assertions for one fixture rendered 1:1 in an 8×8 box at
   *  (100,100): opaque pixels exactly the tint, transparent pixels untouched,
   *  50% pixels the proportional blend, and nothing else on canvas changed. */
  async function expectTintSemantics(asset: string) {
    const { a, b } = await renderPair(asset, {});
    // Exactly the alpha-bearing pixels changed: 32 opaque + 16 half.
    expect(diffCount(a, b)).toBe(48);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const [r, g, bl] = b.px(x + 100, y + 100);
        if (isOpaque(x, y)) expect([r, g, bl]).toEqual([...tintRgb]);
        else if (isHalf(x, y)) {
          const alpha = 128 / 255;
          expect(near(r, overWhite(tintRgb[0], alpha))).toBe(true);
          expect(near(g, overWhite(tintRgb[1], alpha))).toBe(true);
          expect(near(bl, overWhite(tintRgb[2], alpha))).toBe(true);
        } else expect([r, g, bl]).toEqual([255, 255, 255]);
      }
    // Transparent pixels are byte-identical to the untinted render — and
    // nothing outside the layer box differs at all.
    for (let y = 0; y < 720; y++)
      for (let x = 0; x < 1280; x++)
        if (isClear(x - 100, y - 100)) expect(b.px(x, y)).toEqual(a.px(x, y));
  }

  it("paints the authored color through a raster Asset's alpha", async () => {
    await expectTintSemantics("./tint-fixture.png");
  }, 30000);

  it("paints the same authored semantics through a vector Asset's alpha", async () => {
    await expectTintSemantics("./tint-fixture.svg");
  }, 30000);

  it("keeps tint/img alignment on a non-square box with fit: contain", async () => {
    // A 16×8 box at (100,60): `contain` scales the square 8×8 asset to 8×8
    // and centers it at box-local x 4..12 — canvas x 104..112, y 60..68. A
    // wrong mask-size would stretch the tint across the full box.
    const { a, b } = await renderPair("./tint-fixture.png", {
      position: { x: 100, y: 60 },
      size: { width: 16, height: 8 },
      fit: "contain",
    });
    // Exactly the 48 alpha-bearing displayed pixels change — nothing else.
    expect(diffCount(a, b)).toBe(48);
    for (let y = 0; y < 720; y++)
      for (let x = 0; x < 1280; x++) {
        const sx = x - 104;
        const sy = y - 60;
        const inFootprint = sx >= 0 && sx < 8 && sy >= 0 && sy < 8;
        if (!inFootprint || isClear(sx, sy)) expect(b.px(x, y)).toEqual(a.px(x, y));
        else expect(b.px(x, y).join()).not.toBe(a.px(x, y).join());
      }
  }, 30000);

  it("composes with crop: exactly the cropped silhouette is tinted", async () => {
    // Crop keeps the source's top-left quadrant (all opaque); the box is
    // exactly the crop window's size, so the scale is 1 and the whole box is
    // the tint. The overlay must take the img's exact geometry — a wrong box
    // would paint tint over cleared source regions instead.
    const { a, b } = await renderPair("./tint-fixture.png", {
      position: { x: 200, y: 300 },
      size: { width: 4, height: 4 },
      crop: { left: 0, top: 0, right: 50, bottom: 50 },
    });
    expect(diffCount(a, b)).toBe(16);
    for (let y = 300; y < 304; y++)
      for (let x = 200; x < 204; x++) expect(b.px(x, y).slice(0, 3)).toEqual([...tintRgb]);
  }, 30000);

  it("composes with layer opacity: the tinted layer composites at its opacity", async () => {
    const { a, b } = await renderPair("./tint-fixture.png", { opacity: 0.5 });
    expect(diffCount(a, b)).toBe(48);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const [r, g, bl] = b.px(x + 100, y + 100);
        if (isOpaque(x, y)) {
          // Full tint at half layer opacity: midpoint between tint and white.
          expect(near(r, (tintRgb[0] + 255) / 2)).toBe(true);
          expect(near(g, (tintRgb[1] + 255) / 2)).toBe(true);
          expect(near(bl, (tintRgb[2] + 255) / 2)).toBe(true);
        } else if (isClear(x, y)) expect([r, g, bl]).toEqual([255, 255, 255]);
      }
  }, 30000);

  it("composes with the effect order: effects grade the tinted result", async () => {
    // The tint paints the content, then the one filter chain grades it:
    // brightness(0) turns the tinted silhouette black — the asset's own
    // colors never reappear.
    const { b } = await renderPair("./tint-fixture.png", {
      effects: { colorAdjust: { brightness: 0 } },
    });
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const px = b.px(x + 100, y + 100);
        if (isOpaque(x, y)) expect(px).toEqual([0, 0, 0, 255]);
        else if (isClear(x, y)) expect(px).toEqual([255, 255, 255, 255]);
      }
  }, 30000);

  it("two differently tinted Layers share one Asset without touching its bytes", async () => {
    const blue = (await load(sceneOf([
      imageLayer({ id: "a", position: { x: 100, y: 100 }, tint: TINT }),
      imageLayer({ id: "b", position: { x: 300, y: 100 }, tint: "#ff0000" }),
    ]))).resolved;
    // One Asset identity serves both layers.
    expect(blue.assets.get("a")!.hash).toBe(blue.assets.get("b")!.hash);
    const png = decodePng((await renderScene(blue, { page })).png);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < 4; x++) {
        expect(png.px(x + 100, y + 100).slice(0, 3)).toEqual([...tintRgb]);
        expect(png.px(x + 300, y + 100).slice(0, 3)).toEqual([255, 0, 0]);
      }
    // The source Asset's bytes on disk are unchanged (TEST-015): after the
    // tinted render the file still hashes to the fixture's original identity.
    expect(
      contentHash(new Uint8Array(await readFile(path.join(fix.projectRoot, "tint-fixture.png")))),
    ).toBe(contentHash(new Uint8Array(fix.rasterBytes)));
  }, 30000);

  it("two Variants tint the same unchanged Asset differently", async () => {
    const raw = sceneOf([imageLayer()]);
    raw.variants = {
      red: { changes: [{ layer: "logo", set: { tint: "#ff0000" } }] },
      blue: { changes: [{ layer: "logo", set: { tint: TINT } }] },
    };
    const resolvedFor = async (name: string) => {
      const applied = resolveVariant(raw, name);
      expect(applied.ok).toBe(true);
      return (await load((applied as { ok: true; raw: unknown }).raw)).resolved;
    };
    const red = await resolvedFor("red");
    const blue = await resolvedFor("blue");
    // Same unchanged asset identity under both Variants.
    expect(red.assets.get("logo")!.hash).toBe(blue.assets.get("logo")!.hash);
    const r = decodePng((await renderScene(red, { page })).png);
    const bl = decodePng((await renderScene(blue, { page })).png);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < 4; x++) {
        expect(r.px(x + 100, y + 100).slice(0, 3)).toEqual([255, 0, 0]);
        expect(bl.px(x + 100, y + 100).slice(0, 3)).toEqual([...tintRgb]);
      }
  }, 30000);

  it("composes with the masked adjust: tint paints, adjust recolors its mask", async () => {
    // DEC-021 leaves the named-mask contract untouched: the tint repaints the
    // whole silhouette, then the adjust blends over the tinted result inside
    // its mask (hue/saturation from the adjust color, luminance from the
    // tint); outside the mask the tinted pixels are byte-identical.
    const tintOnly = (await load(sceneOf([imageLayer({ asset: "ken", tint: TINT })]), async () => fix.lib)).resolved;
    const both = (
      await load(
        sceneOf([imageLayer({ asset: "ken", tint: TINT, adjust: { mask: "shirt", color: "#ff0000" } })]),
        async () => fix.lib,
      )
    ).resolved;
    const a = decodePng((await renderScene(tintOnly, { page })).png);
    const b = decodePng((await renderScene(both, { page })).png);
    // Exactly the 16 masked pixels change (source 2..5 × 2..5 at 1:1).
    expect(diffCount(a, b)).toBe(16);
    for (let y = 0; y < 720; y++)
      for (let x = 0; x < 1280; x++) {
        const inMask = x >= 102 && x < 106 && y >= 102 && y < 106;
        if (!inMask) expect(b.px(x, y)).toEqual(a.px(x, y));
      }
    // Inside the mask: red hue over the tinted silhouette.
    for (let y = 102; y < 106; y++)
      for (let x = 102; x < 106; x++) {
        const [r, g, bl] = b.px(x, y);
        expect(r).toBeGreaterThan(g);
        expect(r).toBeGreaterThan(bl);
      }
  }, 30000);
});

// --- inspection, manifests, offline rerender --------------------------------

describe("tint through the CLI — inspection, manifests, rerender", () => {
  it("inspect surfaces the tint on the layer summary", async () => {
    const sceneFile = path.join(fix.projectRoot, "tint-inspect.json");
    await writeFile(
      sceneFile,
      JSON.stringify(sceneOf([
        imageLayer({ tint: TINT }),
        imageLayer({ id: "plain", position: { x: 300, y: 100 } }),
      ])),
    );
    const { exitCode, output } = await cliRun(["inspect", sceneFile]);
    expect(exitCode).toBe(0);
    const layers = (output as { layers: Record<string, unknown>[] }).layers;
    expect(layers[0]!.tint).toBe(TINT);
    expect(layers[1]!).not.toHaveProperty("tint");
  });

  it("renders through the CLI and the manifest round-trips offline", async () => {
    const sceneFile = path.join(fix.projectRoot, "tint-manifest.json");
    await writeFile(sceneFile, JSON.stringify(sceneOf([imageLayer({ tint: TINT })])));
    const { exitCode, output } = await cliRun(["render", sceneFile]);
    expect(exitCode).toBe(0);
    const manifest = JSON.parse(
      await readFile((output as { manifest: string }).manifest, "utf8"),
    );
    // The tint is Scene data, not a second Asset: the render's asset identity
    // is the unchanged source, and no mask identities are recorded.
    expect(manifest.outputs[0].assets).toEqual([
      expect.objectContaining({ layer: "logo", mediaType: "image/png" }),
    ]);
    expect(manifest.outputs[0].masks).toBeUndefined();
    const rer = await cliRun(["rerender", (output as { manifest: string }).manifest]);
    expect(rer.exitCode).toBe(0);
  });
});