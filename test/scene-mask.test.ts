/**
 * Named masks on Creator Assets (REQ-019): a masked color adjustment on an
 * Image layer changes only the pixels the mask selects — every pixel outside
 * the mask stays byte-identical — and missing / unknown / non-PNG /
 * dimension-mismatched masks fail at the load gate, before any render.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { contentHash, scanLibrary, type Library } from "../src/assets.js";
import { loadScene, SCENE_SCHEMA, type Scene, type SceneLayer, type LoadResult } from "../src/scene.js";
import { resolveVariant } from "../src/variants.js";
import { renderScene } from "../src/scene-render.js";
import { encodePng, decodePng } from "./png.js";
import { run as cliRun } from "../src/scene-cli.js";

// --- fixtures ------------------------------------------------------------

const W = 8;
const H = 8;

/** Shirt region: a centered 4×4 block. Left columns gray 100, right gray 160 —
 *  two luminance levels inside one mask, so tests can prove shading survives
 *  colorization (a flat flood fill would render both identically). */
const isShirt = (x: number, y: number) => x >= 2 && x <= 5 && y >= 2 && y <= 5;

const cutoutPng = encodePng(W, H, (x, y) =>
  isShirt(x, y) ? [(x < 4 ? 100 : 160) as number, (x < 4 ? 100 : 160) as number, (x < 4 ? 100 : 160) as number, 255] : [255, 0, 0, 255],
);
const shirtMaskPng = encodePng(W, H, (x, y) =>
  isShirt(x, y) ? [255, 255, 255, 255] : [0, 0, 0, 0],
);
const smallMaskPng = encodePng(4, 4, () => [255, 255, 255, 255]);
const redSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#ff0000"/></svg>`;

interface Fix {
  root: string;
  projectRoot: string;
  libRoot: string;
  lib: Library;
  maskHash: string;
  cutoutBytes: Buffer;
}

let fix: Fix;

beforeAll(async () => {
  const root = await mkdtemp(path.join(tmpdir(), "thumby-mask-"));
  const projectRoot = path.join(root, "project");
  const libRoot = path.join(root, "library");
  await mkdir(path.join(libRoot, "cutouts", "ken"), { recursive: true });
  await mkdir(path.join(libRoot, "plates", "demo-plate"), { recursive: true });
  await mkdir(path.join(libRoot, "masks", "ken-shirt"), { recursive: true });
  await mkdir(path.join(libRoot, "masks", "ken-bad-dims"), { recursive: true });
  await mkdir(path.join(libRoot, "masks", "ken-svg-mask"), { recursive: true });
  await writeFile(path.join(libRoot, "cutouts", "ken", "cutout.png"), cutoutPng);
  await writeFile(path.join(libRoot, "plates", "demo-plate", "demo-plate.svg"), redSvg);
  await writeFile(
    path.join(libRoot, "plates", "demo-plate", "meta.json"),
    JSON.stringify({ kind: "plate", id: "demo-plate", name: "Demo", tags: [] }),
  );
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
  await writeFile(path.join(libRoot, "masks", "ken-bad-dims", "mask.png"), smallMaskPng);
  await writeFile(
    path.join(libRoot, "masks", "ken-bad-dims", "meta.json"),
    JSON.stringify({ kind: "mask", id: "ken-bad-dims", name: "Wrong size", tags: [] }),
  );
  await writeFile(path.join(libRoot, "masks", "ken-svg-mask", "mask.svg"), redSvg);
  await writeFile(
    path.join(libRoot, "masks", "ken-svg-mask", "meta.json"),
    JSON.stringify({ kind: "mask", id: "ken-svg-mask", name: "SVG mask", tags: [] }),
  );
  await mkdir(projectRoot, { recursive: true });
  fix = {
    root,
    projectRoot,
    libRoot,
    lib: await scanLibrary(libRoot),
    maskHash: contentHash(new Uint8Array(shirtMaskPng)),
    cutoutBytes: cutoutPng,
  };
});

afterAll(async () => {
  await rm(fix.root, { recursive: true, force: true });
});

// --- helpers -------------------------------------------------------------

const kenLayer = (over: Record<string, unknown> = {}): SceneLayer =>
  ({
    id: "ken",
    type: "image",
    asset: "ken",
    position: { x: 0, y: 0 },
    size: { width: W, height: H },
    ...over,
  }) as unknown as SceneLayer;

const plateLayer = (over: Record<string, unknown> = {}): SceneLayer =>
  ({
    id: "bg",
    type: "image",
    asset: "demo-plate",
    position: { x: 100, y: 100 },
    size: { width: W, height: H },
    ...over,
  }) as unknown as SceneLayer;

const maskScene = (layers: SceneLayer[]): Scene =>
  ({ schemaVersion: 1, canvas: { width: 1280, height: 720 }, layers }) as Scene;

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

// --- schema ---------------------------------------------------------------

describe("schema — adjust on image layers", () => {
  it("publishes the adjust definition in the machine-readable schema", () => {
    const props = SCENE_SCHEMA.definitions.imageLayer.properties as Record<string, unknown>;
    expect(props.adjust).toBeDefined();
  });

  it("accepts a well-formed masked adjustment", async () => {
    await load(maskScene([kenLayer({ adjust: { mask: "shirt", color: "#ff0000" } })]));
  });

  it("rejects adjust missing color with a field-specific error", async () => {
    const errors = await loadErrors(maskScene([kenLayer({ adjust: { mask: "shirt" } })]));
    expect(errors.some((e) => e.path === "layers[0].adjust.color" && /required/i.test(e.message))).toBe(true);
  });

  it("rejects unknown fields inside adjust", async () => {
    const errors = await loadErrors(
      maskScene([kenLayer({ adjust: { mask: "shirt", color: "#ff0000", blend: "multiply" } })]),
    );
    expect(errors.some((e) => e.path === "layers[0].adjust.blend" && /not a valid/.test(e.message))).toBe(true);
  });

  it("rejects adjust on non-image layers", async () => {
    const errors = await loadErrors(
      maskScene([
        {
          id: "t",
          type: "text",
          text: "x",
          font: "Anton",
          fontSize: 40,
          position: { x: 0, y: 0 },
          size: { width: 100, height: 50 },
          adjust: { mask: "shirt", color: "#ff0000" },
        } as unknown as SceneLayer,
      ]),
    );
    expect(errors.some((e) => e.path === "layers[0].adjust" && /not a valid .* property/.test(e.message))).toBe(true);
  });

  it("accepts adjust as a variant patch value (whole-field set)", async () => {
    const raw = maskScene([kenLayer()]);
    raw.variants = {
      blue: { changes: [{ layer: "ken", set: { adjust: { mask: "shirt", color: "#0000ff" } } }] },
    };
    await load(raw);
  });
});

// --- render: pixel invariance and local colorization -----------------------

describe("masked render — local colorization, not a flood fill", () => {
  // One browser + route-aborting page for the whole describe: every render
  // must be offline, and shared browser state avoids a launch per test.
  let page: import("playwright").Page;

  beforeAll(async () => {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch();
    const ctx = await browser.newContext();
    await ctx.route("**/*", (route) => route.abort());
    page = await ctx.newPage();
    // The browser outlives the tests (bun's teardown, not a finally): a
    // per-test close is what made a slow launch cascade into timeouts.
    process.on("exit", () => void browser.close());
  });

  /** Pixels that must be byte-identical between two renders, checked without
   *  a per-pixel expect: returns the count of differing pixels. */
  const diffCount = (a: ReturnType<typeof decodePng>, b: ReturnType<typeof decodePng>) => {
    let diff = 0;
    for (let y = 0; y < 720; y++)
      for (let x = 0; x < 1280; x++)
        if (a.px(x, y).join() !== b.px(x, y).join()) diff++;
    return diff;
  };
  const lum = (p: number[]) => 0.2126 * p[0]! + 0.7152 * p[1]! + 0.0722 * p[2]!;

  /** Render the same layer geometry with and without the adjustment, decoded.
   *  `a` is the unadjusted render, `b` the adjusted one. */
  async function renderPair(layerOver: Record<string, unknown>) {
    const { adjust, ...baseOver } = layerOver;
    const a = (await load(maskScene([kenLayer(baseOver)]))).resolved;
    const b = (await load(maskScene([kenLayer(layerOver)]))).resolved;
    return {
      a: decodePng((await renderScene(a, { page })).png),
      b: decodePng((await renderScene(b, { page })).png),
    };
  }

  it("changes every masked pixel and leaves every pixel outside the mask byte-identical", async () => {
    const { a, b } = await renderPair({ adjust: { mask: "shirt", color: "#ff0000" } });

    // Outside the mask: byte-identical to the unadjusted render.
    expect(diffCount(a, b) - 16).toBe(0); // 16 = the 4×4 masked region
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++)
        if (!isShirt(x, y)) expect(b.px(x, y)).toEqual(a.px(x, y));

    // Inside the mask: changed, red hue, and shading survives — the gray-100
    // half stays darker than the gray-160 half (an opaque flood fill would
    // render both identically).
    for (let y = 2; y <= 5; y++)
      for (let x = 2; x <= 5; x++) {
        const [r, g, bl] = b.px(x, y);
        expect([r, g, bl]).not.toEqual(a.px(x, y));
        expect(r).toBeGreaterThan(g);
        expect(r).toBeGreaterThan(bl);
        expect(Math.abs(g - bl)).toBeLessThanOrEqual(8); // gray backdrop → hue-only shift
      }
    expect(lum(b.px(2, 2))).toBeLessThan(lum(b.px(4, 2)));
  }, 30000);

  it("keeps mask/img alignment on a non-square box with fit: contain", async () => {
    // A 16×8 box at (100, 60): `contain` scales the square 8×8 asset to 8×8
    // and centers it at box-local x 4..12 — canvas x 104..112, y 60..68. The
    // shirt (source 2..6) lands at canvas 106..110 × 62..66. Misaligned
    // mask-size would repaint red backdrop or empty box area instead.
    const geo = { position: { x: 100, y: 60 }, size: { width: 16, height: 8 }, fit: "contain" as const };
    const { a, b } = await renderPair({ ...geo, adjust: { mask: "shirt", color: "#ff0000" } });
    // Exactly the 16 displayed shirt pixels change — nothing else on canvas.
    expect(diffCount(a, b)).toBe(16);
    for (let y = 0; y < 720; y++)
      for (let x = 0; x < 1280; x++) {
        const inShirt = x >= 106 && x < 110 && y >= 62 && y < 66;
        if (!inShirt) expect(b.px(x, y)).toEqual(a.px(x, y));
        else expect(b.px(x, y).join()).not.toBe(a.px(x, y).join());
      }
  }, 30000);

  it("keeps mask/img alignment with crop and adjust", async () => {
    // Crop keeps the source's top-left quadrant. The box is exactly the crop
    // window's size, so the scale is 1 and mask edges stay crisp — the strict
    // byte-identical invariant holds. (At scale ≠ 1 the browser resamples the
    // mask like the image, so mask-edge display pixels blend partial
    // selection — documented in ADR-0007; the selection is defined on the
    // asset's pixel grid.) The cropped-overlay branch must take the img's
    // exact geometry: a wrong box would compress the mask into the window and
    // colorize the wrong pixels.
    const { a, b } = await renderPair({
      position: { x: 200, y: 300 },
      size: { width: 4, height: 4 },
      crop: { left: 0, top: 0, right: 50, bottom: 50 },
      adjust: { mask: "shirt", color: "#ff0000" },
    });
    // Visible shirt: source 2..4 of the 0..4 window → canvas 202..204 × 302..304.
    expect(diffCount(a, b)).toBe(4);
    for (let y = 0; y < 720; y++)
      for (let x = 0; x < 1280; x++) {
        const inShirt = x >= 202 && x < 204 && y >= 302 && y < 304;
        if (!inShirt) expect(b.px(x, y)).toEqual(a.px(x, y));
        else expect(b.px(x, y).join()).not.toBe(a.px(x, y).join());
      }
  }, 30000);

  it("two Variants colorize differently over the same unchanged Creator Asset", async () => {
    const raw = maskScene([kenLayer()]);
    raw.variants = {
      red: { changes: [{ layer: "ken", set: { adjust: { mask: "shirt", color: "#ff0000" } } }] },
      blue: { changes: [{ layer: "ken", set: { adjust: { mask: "shirt", color: "#0000ff" } } }] },
    };
    const red = (await (async () => {
      const applied = resolveVariant(raw, "red");
      expect(applied.ok).toBe(true);
      return load((applied as { ok: true; raw: unknown }).raw);
    })()).resolved;
    const blue = (await (async () => {
      const applied = resolveVariant(raw, "blue");
      expect(applied.ok).toBe(true);
      return load((applied as { ok: true; raw: unknown }).raw);
    })()).resolved;
    // Same unchanged asset identity under both Variants.
    expect(red.assets.get("ken")!.hash).toBe(blue.assets.get("ken")!.hash);

    const r = decodePng((await renderScene(red, { page })).png);
    const bl = decodePng((await renderScene(blue, { page })).png);
    // Masked pixels differ between the color variants…
    for (let y = 2; y <= 5; y++)
      for (let x = 2; x <= 5; x++) expect(r.px(x, y).join()).not.toBe(bl.px(x, y).join());
    // …and every pixel outside the mask is identical between them.
    expect(diffCount(r, bl) - 16).toBe(0);
  }, 60000);
});

// --- manifest and rerender -------------------------------------------------

describe("manifest — mask identities recorded and verified", () => {
  it("renders through the CLI and records the mask identity on the output", async () => {
    const sceneFile = path.join(fix.projectRoot, "mask.json");
    await writeFile(
      sceneFile,
      JSON.stringify(maskScene([kenLayer({ adjust: { mask: "shirt", color: "#ff0000" } })])),
    );
    const { exitCode, output } = await cliRun(["render", sceneFile], { libraryRoot: fix.libRoot });
    expect(exitCode).toBe(0);
    const manifestFile = (output as { manifest: string }).manifest;
    const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
    expect(manifest.manifestVersion).toBe(4);
    expect(manifest.outputs[0].masks).toEqual([
      expect.objectContaining({ layer: "ken", kind: "mask", hash: fix.maskHash }),
    ]);
  });

  it("rerender succeeds while the mask bytes are unchanged", async () => {
    const sceneFile = path.join(fix.projectRoot, "mask.json");
    const libRoot = fix.libRoot;
    const { exitCode, output } = await cliRun(["render", sceneFile], { libraryRoot: libRoot });
    expect(exitCode).toBe(0);
    const rer = await cliRun(["rerender", (output as { manifest: string }).manifest], { libraryRoot: libRoot });
    expect(rer.exitCode).toBe(0);
  });

  it("rerender rejects drifted mask bytes with an identity mismatch", async () => {
    const sceneFile = path.join(fix.projectRoot, "mask.json");
    const libRoot = fix.libRoot;
    const { exitCode, output } = await cliRun(["render", sceneFile], { libraryRoot: libRoot });
    expect(exitCode).toBe(0);
    const manifestFile = (output as { manifest: string }).manifest;
    // Swap the mask's bytes: different selection, same dimensions.
    try {
      await writeFile(
        path.join(libRoot, "masks", "ken-shirt", "mask.png"),
        encodePng(W, H, (x, y) => [255, 255, 255, 255]),
      );
      const rer = await cliRun(["rerender", manifestFile], { libraryRoot: libRoot });
      expect(rer.exitCode).toBe(1);
      const errors = (rer.output as { errors: { path: string; message: string }[] }).errors;
      expect(errors[0]!.path).toBe("outputs[0].masks[0].hash");
      expect(errors[0]!.message).toMatch(/mask identity mismatch/);
    } finally {
      // Restore the fixture's mask bytes — later tests assert against them.
      await writeFile(path.join(libRoot, "masks", "ken-shirt", "mask.png"), shirtMaskPng);
    }
  });
});

// --- mask resolution -------------------------------------------------------

describe("mask resolution — Creator Asset named masks through the one contract", () => {
  it("resolves the named mask to exact bytes keyed by layer id", async () => {
    const { resolved } = await load(maskScene([kenLayer({ adjust: { mask: "shirt", color: "#ff0000" } })]));
    const mask = resolved.masks.get("ken");
    expect(mask).toBeDefined();
    expect(mask!.hash).toBe(fix.maskHash);
    expect(mask!.mediaType).toBe("image/png");
    expect(mask!.kind).toBe("mask");
  });

  it("fails on an unknown mask name, listing the available ones", async () => {
    const errors = await loadErrors(
      maskScene([kenLayer({ adjust: { mask: "sleeve", color: "#ff0000" } })]),
    );
    const hit = errors.find((e) => e.path === "layers[0].adjust.mask");
    expect(hit).toBeDefined();
    expect(hit!.message).toMatch(/sleeve/);
    expect(hit!.message).toMatch(/shirt/);
  });

  it("fails when the asset defines no named masks at all", async () => {
    const errors = await loadErrors(
      maskScene([plateLayer({ adjust: { mask: "shirt", color: "#ff0000" } })]),
    );
    const hit = errors.find((e) => e.path === "layers[0].adjust.mask");
    expect(hit).toBeDefined();
    expect(hit!.message).toMatch(/demo-plate/);
    expect(hit!.message).toMatch(/no named masks/i);
  });

  it("fails when the mask reference is missing from the library", async () => {
    // Library cutout metas are immutable on disk, so the broken ref is a
    // fresh library whose cutout names a mask id that is not there.
    const libRoot = fix.libRoot;
    const lib2Root = path.join(path.dirname(libRoot), "library2");
    await mkdir(path.join(lib2Root, "cutouts", "ghost"), { recursive: true });
    await writeFile(path.join(lib2Root, "cutouts", "ghost", "cutout.png"), cutoutPng);
    await writeFile(
      path.join(lib2Root, "cutouts", "ghost", "meta.json"),
      JSON.stringify({
        kind: "cutout",
        id: "ghost",
        tags: [],
        approval: "approved",
        masks: { shirt: "missing-mask" },
      }),
    );
    const lib2 = await scanLibrary(lib2Root);
    const result = await loadScene(fix.projectRoot, async () => lib2, maskScene([
      kenLayer({ asset: "ghost", adjust: { mask: "shirt", color: "#ff0000" } }),
    ]));
    expect(result.ok).toBe(false);
    const errors = (result as { ok: false; errors: { path: string; message: string }[] }).errors;
    const hit = errors.find((e) => e.path === "layers[0].adjust.mask");
    expect(hit).toBeDefined();
    expect(hit!.message).toMatch(/missing-mask/);
  });

  it("fails when the mask reference names a non-mask asset (kind-restricted)", async () => {
    // A cutout id in a masks map is library state that failed validation —
    // resolution is kind-restricted, so it can never serve as a mask (and a
    // trial cutout can never enter a render unmarked this way, PROD-1).
    const libRoot = path.dirname(path.dirname(fix.lib.cutouts[0]!.imagePath));
    const lib5Root = path.join(path.dirname(libRoot), "library5");
    await mkdir(path.join(lib5Root, "cutouts", "ken"), { recursive: true });
    await mkdir(path.join(lib5Root, "cutouts", "ken-copy"), { recursive: true });
    await writeFile(path.join(lib5Root, "cutouts", "ken", "cutout.png"), cutoutPng);
    await writeFile(
      path.join(lib5Root, "cutouts", "ken", "meta.json"),
      JSON.stringify({
        kind: "cutout",
        id: "ken",
        tags: [],
        approval: "approved",
        masks: { shirt: "ken-copy" },
      }),
    );
    await writeFile(path.join(lib5Root, "cutouts", "ken-copy", "cutout.png"), cutoutPng);
    await writeFile(
      path.join(lib5Root, "cutouts", "ken-copy", "meta.json"),
      JSON.stringify({ kind: "cutout", id: "ken-copy", tags: [], approval: "approved" }),
    );
    const lib5 = await scanLibrary(lib5Root);
    const result = await loadScene(fix.projectRoot, async () => lib5, maskScene([
      kenLayer({ adjust: { mask: "shirt", color: "#ff0000" } }),
    ]));
    expect(result.ok).toBe(false);
    const errors = (result as { ok: false; errors: { path: string; message: string }[] }).errors;
    const hit = errors.find((e) => e.path === "layers[0].adjust.mask");
    expect(hit).toBeDefined();
    expect(hit!.message).toMatch(/unknown library mask "ken-copy"/);
  });

  it("fails on a non-PNG mask (dimension checks need raster bytes)", async () => {
    const libRoot = fix.libRoot;
    const lib3Root = path.join(path.dirname(libRoot), "library3");
    await mkdir(path.join(lib3Root, "cutouts", "ken"), { recursive: true });
    await mkdir(path.join(lib3Root, "masks", "svg-mask"), { recursive: true });
    await writeFile(path.join(lib3Root, "cutouts", "ken", "cutout.png"), cutoutPng);
    await writeFile(
      path.join(lib3Root, "cutouts", "ken", "meta.json"),
      JSON.stringify({
        kind: "cutout",
        id: "ken",
        tags: [],
        approval: "approved",
        masks: { shirt: "svg-mask" },
      }),
    );
    await writeFile(path.join(lib3Root, "masks", "svg-mask", "mask.svg"), redSvg);
    await writeFile(
      path.join(lib3Root, "masks", "svg-mask", "meta.json"),
      JSON.stringify({ kind: "mask", id: "svg-mask", tags: [] }),
    );
    const lib3 = await scanLibrary(lib3Root);
    const result = await loadScene(fix.projectRoot, async () => lib3, maskScene([
      kenLayer({ adjust: { mask: "shirt", color: "#ff0000" } }),
    ]));
    expect(result.ok).toBe(false);
    const errors = (result as { ok: false; errors: { path: string; message: string }[] }).errors;
    const hit = errors.find((e) => e.path === "layers[0].adjust.mask");
    expect(hit).toBeDefined();
    expect(hit!.message).toMatch(/PNG/i);
  });

  it("fails on a dimension-mismatched mask, naming both sizes", async () => {
    const libRoot = fix.libRoot;
    const lib4Root = path.join(path.dirname(libRoot), "library4");
    await mkdir(path.join(lib4Root, "cutouts", "ken"), { recursive: true });
    await mkdir(path.join(lib4Root, "masks", "bad-dims"), { recursive: true });
    await writeFile(path.join(lib4Root, "cutouts", "ken", "cutout.png"), cutoutPng);
    await writeFile(
      path.join(lib4Root, "cutouts", "ken", "meta.json"),
      JSON.stringify({
        kind: "cutout",
        id: "ken",
        tags: [],
        approval: "approved",
        masks: { shirt: "bad-dims" },
      }),
    );
    await writeFile(path.join(lib4Root, "masks", "bad-dims", "mask.png"), smallMaskPng);
    await writeFile(
      path.join(lib4Root, "masks", "bad-dims", "meta.json"),
      JSON.stringify({ kind: "mask", id: "bad-dims", tags: [] }),
    );
    const lib4 = await scanLibrary(lib4Root);
    const result = await loadScene(fix.projectRoot, async () => lib4, maskScene([
      kenLayer({ adjust: { mask: "shirt", color: "#ff0000" } }),
    ]));
    expect(result.ok).toBe(false);
    const errors = (result as { ok: false; errors: { path: string; message: string }[] }).errors;
    const hit = errors.find((e) => e.path === "layers[0].adjust.mask");
    expect(hit).toBeDefined();
    expect(hit!.message).toMatch(/8×8/);
    expect(hit!.message).toMatch(/4×4/);
  });

  it("never mutates the source Creator Asset bytes", async () => {
    await load(maskScene([kenLayer({ adjust: { mask: "shirt", color: "#ff0000" } })]));
    expect(fix.lib.cutouts[0]!.hash).toBe(contentHash(new Uint8Array(fix.cutoutBytes)));
  });
});
