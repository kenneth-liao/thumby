import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { contentHash, scanLibrary, type Library } from "../src/assets.js";
import { THEMES, themeRevision } from "../src/themes.js";
import { loadScene, SCENE_SCHEMA, type Scene, type SceneLayer, type LoadResult } from "../src/scene.js";
import { resolveVariant } from "../src/variants.js";
import { renderScene } from "../src/scene-render.js";
import { run as cliRun } from "../src/scene-cli.js";
import { decodePng } from "./png.js";

// --- fixtures -------------------------------------------------------------

const RED_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="#ff0000"/></svg>`;
const BLUE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="#0000ff"/></svg>`;

interface Fix {
  root: string;
  projectRoot: string;
  lib: Library;
}

let fix: Fix;

beforeAll(async () => {
  const root = await mkdtemp(path.join(tmpdir(), "thumby-variant-"));
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
  await writeFile(path.join(projectRoot, "blue.svg"), BLUE_SVG);
  fix = {
    root,
    projectRoot,
    lib: await scanLibrary(libRoot),
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
  }) as unknown as SceneLayer;

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
  }) as unknown as SceneLayer;

const variantScene = (
  layers: SceneLayer[],
  variants: Record<string, unknown>,
): Scene => ({ schemaVersion: 1, canvas: { width: 1280, height: 720 }, layers, variants }) as Scene;

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

/** Gate a variant end to end: resolve by name, then load the patched document. */
async function resolveAndLoad(
  raw: Scene,
  name: string,
): Promise<Extract<LoadResult, { ok: true }>> {
  const applied = resolveVariant(raw, name);
  expect(applied.ok).toBe(true);
  return load((applied as { ok: true; raw: unknown }).raw);
}

// --- schema -----------------------------------------------------------------

describe("variant schema", () => {
  it("publishes the variants block in the machine-readable schema", () => {
    expect(SCENE_SCHEMA.properties.variants).toBeDefined();
    expect(SCENE_SCHEMA.definitions.variant).toBeDefined();
    expect(SCENE_SCHEMA.definitions.change).toBeDefined();
  });

  it("still accepts scenes without variants", async () => {
    await load({ schemaVersion: 1, canvas: { width: 1280, height: 720 }, layers: [textLayer()] });
  });
});

// --- sparse storage and application ------------------------------------------

describe("variant resolution — sparse patches over the canonical base", () => {
  it("applies a text/style patch and leaves every other fact in the base Scene", async () => {
    const raw = variantScene([imageLayer(), textLayer()], {
      alt: {
        description: "Louder headline",
        changes: [{ layer: "title", set: { text: "New claim", color: "#ff0000" } }],
      },
    });
    const base = await load(raw);
    const variant = await resolveAndLoad(raw, "alt");

    // The base scene stays canonical — resolution never mutated it.
    const baseTitle = base.resolved.scene.layers[1] as unknown as Record<string, unknown>;
    expect(baseTitle.text).toBe("Big news");
    expect(baseTitle.color).toBeUndefined();

    // The variant's own layer carries the patch; nothing else moved.
    const vTitle = variant.resolved.scene.layers[1] as unknown as Record<string, unknown>;
    expect(vTitle.text).toBe("New claim");
    expect(vTitle.color).toBe("#ff0000");
    expect(variant.resolved.scene.layers[0]).toEqual(base.resolved.scene.layers[0]);
    expect((variant.resolved.scene.layers[1] as unknown as { position: unknown }).position).toEqual(baseTitle.position);
    expect((variant.resolved.scene.layers[1] as unknown as { size: unknown }).size).toEqual(baseTitle.size);
  });

  it("patches transforms, visibility, and effects on their layer", async () => {
    const raw = variantScene([imageLayer(), textLayer()], {
      moved: {
        changes: [
          {
            layer: "bg",
            set: { position: { x: 10, y: 20 }, rotation: 15, mirror: true, opacity: 0.5 },
          },
          { layer: "title", set: { visible: false } },
        ],
      },
    });
    const base = await load(raw);
    const variant = await resolveAndLoad(raw, "moved");
    const bg = variant.resolved.scene.layers[0] as unknown as Record<string, unknown>;
    expect(bg.position).toEqual({ x: 10, y: 20 });
    expect(bg.rotation).toBe(15);
    expect(bg.mirror).toBe(true);
    expect(bg.opacity).toBe(0.5);
    expect((variant.resolved.scene.layers[1] as unknown as Record<string, unknown>).visible).toBe(false);
    // Base untouched.
    expect((base.resolved.scene.layers[1] as unknown as Record<string, unknown>).visible).toBeUndefined();
  });

  it("swaps an Asset reference and resolves the new exact bytes", async () => {
    const raw = variantScene([imageLayer({ asset: "./red.svg" })], {
      swap: { changes: [{ layer: "bg", set: { asset: "./blue.svg" } }] },
    });
    const base = await load(raw);
    const variant = await resolveAndLoad(raw, "swap");
    const redHash = contentHash(Buffer.from(RED_SVG, "utf8"));
    const blueHash = contentHash(Buffer.from(BLUE_SVG, "utf8"));
    expect(base.resolved.assets.get("bg")!.hash).toBe(redHash);
    expect(variant.resolved.assets.get("bg")!.hash).toBe(blueHash);
  });

  it("targets nested group children by their stable ids", async () => {
    const group: SceneLayer = {
      id: "card",
      type: "group",
      position: { x: 100, y: 100 },
      size: { width: 400, height: 200 },
      layers: [
        { id: "chip", type: "shape", shape: "rect", position: { x: 0, y: 0 }, size: { width: 100, height: 50 } },
      ],
    } as unknown as SceneLayer;
    const raw = variantScene([group], {
      recolor: { changes: [{ layer: "chip", set: { color: "#00ff00" } }] },
    });
    const variant = await resolveAndLoad(raw, "recolor");
    const g = variant.resolved.scene.layers[0] as unknown as { layers: Record<string, unknown>[] };
    expect(g.layers[0].color).toBe("#00ff00");
  });

  it("an explicit variant value wins over the theme default", async () => {
    const theme = THEMES.find((t) => t.name === "midnight")!;
    const raw = {
      schemaVersion: 1,
      canvas: { width: 1280, height: 720 },
      theme: { name: theme.name, revision: themeRevision(theme) },
      layers: [textLayer()],
      variants: { lit: { changes: [{ layer: "title", set: { color: "#ff0000" } }] } },
    };
    const base = await load(raw);
    const variant = await resolveAndLoad(raw as Scene, "lit");
    expect((base.resolved.scene.layers[0] as unknown as Record<string, unknown>).color).toBe("#f5f5f7");
    expect((variant.resolved.scene.layers[0] as unknown as Record<string, unknown>).color).toBe("#ff0000");
  });
});

// --- field-specific failures ---------------------------------------------------

describe("variant validation — field-specific failures at the gate", () => {
  it("rejects an unknown target layer, naming the variant change", async () => {
    const raw = variantScene([textLayer()], {
      alt: { changes: [{ layer: "nope", set: { text: "x" } }] },
    });
    const errors = await loadErrors(raw);
    expect(errors.map((e) => e.path)).toContain(`variants["alt"].changes[0].layer`);
  });

  it("rejects an invalid patched value, naming the patched property", async () => {
    const raw = variantScene([textLayer()], {
      alt: { changes: [{ layer: "title", set: { opacity: 2 } }] },
    });
    const errors = await loadErrors(raw);
    expect(errors.map((e) => e.path)).toContain(`variants["alt"].changes[0].set.opacity`);
  });

  it("rejects a property the target layer type does not support", async () => {
    const raw = variantScene([imageLayer()], {
      alt: { changes: [{ layer: "bg", set: { fontSize: 40 } }] },
    });
    const errors = await loadErrors(raw);
    const hit = errors.find((e) => e.path === `variants["alt"].changes[0].set.fontSize`);
    expect(hit).toBeDefined();
    expect(hit!.message).toMatch(/patchable/);
  });

  it("rejects patching identity fields — id and type", async () => {
    const raw = variantScene([textLayer()], {
      alt: { changes: [{ layer: "title", set: { id: "other", type: "shape" } }] },
    });
    const errors = await loadErrors(raw);
    const paths = errors.map((e) => e.path);
    expect(paths).toContain(`variants["alt"].changes[0].set.id`);
    expect(paths).toContain(`variants["alt"].changes[0].set.type`);
  });

  it("rejects replacing a group's subtree — children are addressed by their own ids", async () => {
    const group: SceneLayer = {
      id: "card",
      type: "group",
      position: { x: 0, y: 0 },
      size: { width: 400, height: 200 },
      layers: [
        { id: "chip", type: "shape", shape: "rect", position: { x: 0, y: 0 }, size: { width: 100, height: 50 } },
      ],
    } as unknown as SceneLayer;
    const raw = variantScene([group], {
      alt: { changes: [{ layer: "card", set: { layers: [] } }] },
    });
    const errors = await loadErrors(raw);
    const hit = errors.find((e) => e.path === `variants["alt"].changes[0].set.layers`);
    expect(hit).toBeDefined();
    expect(hit!.message).toMatch(/patchable/);
  });

  it("reports the invalid set of a duplicate-target change too", async () => {
    const raw = variantScene([textLayer()], {
      alt: {
        changes: [
          { layer: "title", set: { text: "a" } },
          { layer: "title", set: { opacity: 5 } },
        ],
      },
    });
    const errors = await loadErrors(raw);
    const paths = errors.map((e) => e.path);
    expect(paths).toContain(`variants["alt"].changes[1].layer`);
    expect(paths).toContain(`variants["alt"].changes[1].set.opacity`);
  });

  it("rejects two changes naming the same layer in one variant", async () => {
    const raw = variantScene([textLayer()], {
      alt: {
        changes: [
          { layer: "title", set: { text: "a" } },
          { layer: "title", set: { color: "#fff" } },
        ],
      },
    });
    const errors = await loadErrors(raw);
    const hit = errors.find((e) => e.path.startsWith(`variants["alt"].changes[1].layer`));
    expect(hit).toBeDefined();
    expect(hit!.message).toMatch(/duplicate/i);
  });

  it("rejects variant names that could not name a render output file", async () => {
    const raw = variantScene([textLayer()], {
      "../escape": { changes: [{ layer: "title", set: { text: "x" } }] },
    });
    const errors = await loadErrors(raw);
    const hit = errors.find((e) => e.path.startsWith("variants["));
    expect(hit).toBeDefined();
    expect(hit!.message).toMatch(/variant name/i);
  });

  it("reports an unknown variant name at resolution, not a silent base render", () => {
    const raw = variantScene([textLayer()], {
      alt: { changes: [{ layer: "title", set: { text: "x" } }] },
    });
    const applied = resolveVariant(raw, "missing");
    expect(applied.ok).toBe(false);
    const errors = (applied as { ok: false; errors: { path: string }[] }).errors;
    expect(errors[0]!.path).toBe(`variants["missing"]`);
  });

  it("a contract-breaking patch fails at resolution instead of rendering", async () => {
    // The base layer uses a gradient fill; a variant adding `color` would
    // make the merged layer violate the fill contract — caught by the gate.
    const raw = variantScene([textLayer({ color: undefined, fill: { from: "#000", to: "#fff" } })], {
      alt: { changes: [{ layer: "title", set: { color: "#ff0000" } }] },
    });
    await load(raw); // base itself is fine
    const applied = resolveVariant(raw, "alt");
    expect(applied.ok).toBe(true);
    const result = await loadScene(
      fix.projectRoot,
      async () => fix.lib,
      (applied as { ok: true; raw: unknown }).raw,
    );
    expect(result.ok).toBe(false);
    const errors = (result as { ok: false; errors: { path: string; message: string }[] }).errors;
    expect(errors[0]!.message).toMatch(/mutually exclusive/);
  });
});

// --- render ----------------------------------------------------------------------

describe("variant render — offline, one and many", () => {
  it("renders a resolved variant with every network route aborted — 1280×720, patched pixels", async () => {
    const { chromium } = await import("playwright");
    const raw = variantScene([imageLayer({ asset: "./red.svg" })], {
      blue: { changes: [{ layer: "bg", set: { asset: "./blue.svg" } }] },
    });
    const base = await load(raw);
    const variant = await resolveAndLoad(raw, "blue");
    const browser = await chromium.launch();
    try {
      const ctx = await browser.newContext();
      await ctx.route("**/*", (route) => route.abort());
      const page = await ctx.newPage();
      const a = await renderScene(base.resolved, { page });
      const b = await renderScene(variant.resolved, { page });
      expect(b.width).toBe(1280);
      expect(b.height).toBe(720);
      // The patch changed real pixels — the asset swap is visible.
      expect(b.png.equals(a.png)).toBe(false);
      const img = decodePng(b.png);
      const [r, g, bl] = img.px(640, 360);
      expect(bl).toBeGreaterThan(200);
      expect(r).toBeLessThan(80);
    } finally {
      await browser.close();
    }
  }, 20000);
});

describe("scene CLI — variant render and batch review", () => {
  let sceneFile: string;

  beforeAll(async () => {
    sceneFile = path.join(fix.projectRoot, "variants.json");
    await writeFile(
      sceneFile,
      JSON.stringify(
        variantScene([imageLayer({ asset: "./red.svg" }), textLayer()], {
          blue: { description: "Blue bg", changes: [{ layer: "bg", set: { asset: "./blue.svg" } }] },
          shifted: { changes: [{ layer: "bg", set: { position: { x: 40, y: 0 } } }] },
        }),
      ),
    );
  });

  it("renders one variant next to the scene as <scene>.<variant>.png", async () => {
    const { exitCode, output } = await cliRun(["render", sceneFile, "--variant", "blue"]);
    expect(exitCode).toBe(0);
    const out = (output as { outputs: { variant: string; output: string; width: number }[] }).outputs;
    expect(out).toHaveLength(1);
    expect(out[0]!.variant).toBe("blue");
    expect(out[0]!.width).toBe(1280);
    expect(out[0]!.output).toBe(path.join(fix.projectRoot, "out", "variants.blue.png"));
    expect(existsSync(out[0]!.output)).toBe(true);
  });

  it("renders a batch of variants plus a contact sheet with 168px cells", async () => {
    const { exitCode, output } = await cliRun(["render", sceneFile, "--variant", "blue,shifted"]);
    expect(exitCode).toBe(0);
    const out = output as {
      outputs: { variant: string; output: string }[];
      contact: { output: string; width: number; height: number };
    };
    expect(out.outputs.map((o) => o.variant)).toEqual(["blue", "shifted"]);
    for (const o of out.outputs) expect(existsSync(o.output)).toBe(true);
    // Full-size and 168px representations both exist for every rendered output.
    expect(existsSync(out.contact.output)).toBe(true);
    const sheet = decodePng(await readFile(out.contact.output));
    // padding 8 + cell 168 + gap 8 + cell 168 + padding 8
    expect(out.contact.width).toBe(360);
    expect(sheet.width).toBe(360);
    expect(sheet.height).toBeGreaterThan(94);
    // The two cells differ — each output's own pixels, not a repeated image.
    const left = sheet.px(92, 50);
    const right = sheet.px(268, 50);
    expect(left).not.toEqual(right);
  }, 30000);

  it("renders each single variant at full size without a contact sheet", async () => {
    const { output } = await cliRun(["render", sceneFile, "--variant", "blue"]);
    const out = output as { outputs: unknown[]; contact?: unknown };
    expect(out.outputs).toHaveLength(1);
    expect(out.contact).toBeUndefined();
  });

  it("an explicit --out applies to a single-variant render only", async () => {
    const { exitCode, output } = await cliRun([
      "render",
      sceneFile,
      "--variant",
      "blue",
      "--out",
      path.join(fix.projectRoot, "one.png"),
    ]);
    expect(exitCode).toBe(0);
    expect((output as { outputs: { output: string }[] }).outputs[0]!.output).toBe(
      path.join(fix.projectRoot, "one.png"),
    );
    const batch = await cliRun([
      "render",
      sceneFile,
      "--variant",
      "blue,shifted",
      "--out",
      path.join(fix.projectRoot, "two.png"),
    ]);
    expect(batch.exitCode).toBe(2);
  });

  it("an unknown variant name fails with its field path, exit 1", async () => {
    const { exitCode, output } = await cliRun(["render", sceneFile, "--variant", "missing"]);
    expect(exitCode).toBe(1);
    const errors = (output as { errors: { path: string }[] }).errors;
    expect(errors[0]!.path).toBe(`variants["missing"]`);
  });

  it("a failing batch writes nothing — the out directory stays untouched", async () => {
    // Earlier tests in this suite legitimately rendered blue; clear the
    // output so this test proves the failing batch wrote nothing itself.
    await rm(path.join(fix.projectRoot, "out", "variants.blue.png"), { force: true });
    const { exitCode } = await cliRun(["render", sceneFile, "--variant", "blue,missing"]);
    expect(exitCode).toBe(1);
    expect(existsSync(path.join(fix.projectRoot, "out", "variants.blue.png"))).toBe(false);
  });

  it("rejects duplicate names, repeated flags, and flag-shaped values", async () => {
    const twice = await cliRun(["render", sceneFile, "--variant", "blue,blue"]);
    expect(twice.exitCode).toBe(2);
    const repeated = await cliRun([
      "render",
      sceneFile,
      "--variant",
      "blue",
      "--variant",
      "shifted",
    ]);
    expect(repeated.exitCode).toBe(2);
    const flagValue = await cliRun(["render", sceneFile, "--variant", "--out", "x.png"]);
    expect(flagValue.exitCode).toBe(2);
  });

  it("inspect --variant returns the stored sparse changes verbatim beside the resolved layers", async () => {
    const { exitCode, output } = await cliRun(["inspect", sceneFile, "--variant", "blue"]);
    expect(exitCode).toBe(0);
    const out = output as {
      variant: { name: string; description?: string; changes: unknown[] };
      layers: Record<string, unknown>[];
    };
    // Storage proof: the variant carries only what it changes — no copy of
    // the untouched layer facts (the bg box, the whole text layer, ...).
    expect(out.variant.name).toBe("blue");
    expect(out.variant.description).toBe("Blue bg");
    expect(out.variant.changes).toEqual([{ layer: "bg", set: { asset: "./blue.svg" } }]);
    // Resolution proof: the patched field lands, everything else comes from
    // the base — the resolved bg differs from base only in `asset` (and the
    // resolvedAsset identity derived from it, which must be the blue bytes).
    const base = (await cliRun(["inspect", sceneFile])).output as {
      layers: Record<string, unknown>[];
    };
    const vBg = out.layers.find((l) => l.id === "bg")!;
    const baseBg = base.layers.find((l) => l.id === "bg")!;
    expect(vBg.asset).toBe("./blue.svg");
    const strip = (l: Record<string, unknown>) => ({ ...l, asset: undefined, resolvedAsset: undefined });
    expect(strip(vBg)).toEqual(strip(baseBg));
    expect((vBg.resolvedAsset as { hash: string }).hash).toBe(contentHash(Buffer.from(BLUE_SVG, "utf8")));
    const vTitle = out.layers.find((l) => l.id === "title")!;
    const baseTitle = base.layers.find((l) => l.id === "title")!;
    expect(vTitle).toEqual(baseTitle);
  });

  it("inspect still works without --variant on a scene that has variants", async () => {
    const { exitCode, output } = await cliRun(["inspect", sceneFile]);
    expect(exitCode).toBe(0);
    expect((output as { layers: unknown[] }).layers).toHaveLength(2);
    expect((output as unknown as Record<string, unknown>).variant).toBeUndefined();
  });
});
