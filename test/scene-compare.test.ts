import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { scanLibrary, type Library } from "../src/assets.js";
import { loadScene, SCENE_SCHEMA, type Scene, type SceneLayer } from "../src/scene.js";
import { encodePngRgba, decodePng } from "../src/png.js";
import { checkReference, diffPng } from "../src/compare.js";
import { run as cliRun } from "../src/scene-cli.js";

// --- fixtures --------------------------------------------------------------

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720"><rect width="1280" height="720" fill="#ff0000"/></svg>`;

interface Fix {
  root: string;
  projectRoot: string;
  lib: Library;
  sceneFile: string;
}

let fix: Fix;

/** Solid RGBA buffer. */
const solid = (w: number, h: number, [r, g, b, a]: [number, number, number, number]): Buffer =>
  Buffer.from(new Uint8Array(w * h * 4).map((_, i) => [r, g, b, a][i % 4]!));

/** Left half red, right half blue — a dimension-valid reference with spatial variation. */
const halfReference = (w = 1280, h = 720): Buffer => {
  const rgba = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      rgba[i] = x < w / 2 ? 255 : 0;
      rgba[i + 2] = x < w / 2 ? 0 : 255;
      rgba[i + 3] = 255;
    }
  return rgba;
};

const writePng = (file: string, rgba: Buffer, w = 1280, h = 720) =>
  writeFile(file, encodePngRgba(w, h, rgba));

const scene = (layers: SceneLayer[], over: Record<string, unknown> = {}): Scene =>
  ({
    schemaVersion: 1,
    canvas: { width: 1280, height: 720 },
    layers,
    ...over,
  }) as Scene;

const imageLayer = (over: Record<string, unknown> = {}): SceneLayer =>
  ({
    id: "bg",
    type: "image",
    asset: "./bg.svg",
    position: { x: 0, y: 0 },
    size: { width: 1280, height: 720 },
    ...over,
  }) as SceneLayer;

beforeAll(async () => {
  const root = await mkdtemp(path.join(tmpdir(), "thumby-compare-"));
  const projectRoot = path.join(root, "project");
  const libRoot = path.join(root, "library");
  await mkdir(path.join(projectRoot, "out"), { recursive: true });
  await mkdir(libRoot, { recursive: true });
  await writeFile(path.join(projectRoot, "bg.svg"), SVG);
  const sceneFile = path.join(projectRoot, "scene.json");
  await writeFile(sceneFile, JSON.stringify(scene([imageLayer()])));
  fix = {
    root,
    projectRoot,
    lib: await scanLibrary(libRoot),
    sceneFile,
  };
});

afterAll(async () => {
  await rm(fix.root, { recursive: true, force: true });
});

/** Write a scene file with the given extra top-level fields, return its path. */
async function sceneWith(over: Record<string, unknown>, name = "scene.json"): Promise<string> {
  const file = path.join(fix.projectRoot, name);
  await writeFile(file, JSON.stringify({ ...scene([imageLayer()]), ...over }));
  return file;
}

async function cliErrors(argv: string[]): Promise<{ path: string; message: string }[]> {
  const { exitCode, output } = await cliRun(argv);
  expect(exitCode).toBe(1);
  const { ok, errors } = output as { ok: boolean; errors: { path: string; message: string }[] };
  expect(ok).toBe(false);
  return errors;
}

// --- schema ----------------------------------------------------------------

describe("reference schema", () => {
  it("the schema declares reference as an optional object with a path", () => {
    const ref = (SCENE_SCHEMA as { properties: { reference: Record<string, unknown> } }).properties
      .reference;
    expect(ref).toBeDefined();
    expect(ref).toMatchObject({ type: "object", required: ["path"] });
  });

  it("a scene without a reference still validates — the field is optional", async () => {
    const result = await loadScene(fix.projectRoot, () => Promise.resolve(fix.lib), scene([imageLayer()]));
    expect(result.ok).toBe(true);
  });
});

// --- checkReference ----------------------------------------------------------

describe("checkReference", () => {
  it("accepts a 1280×720 PNG inside the project root and returns its decoded pixels", async () => {
    await writePng(path.join(fix.projectRoot, "ref.png"), halfReference());
    const file = await sceneWith({ reference: { path: "./ref.png" } }, "valid.json");
    const { exitCode, output } = await cliRun(["validate", file]);
    expect(exitCode).toBe(0);
    expect(output).toMatchObject({ ok: true, reference: "./ref.png" });
  });

  it("a scene without a reference passes the check (no-op)", async () => {
    const { exitCode } = await cliRun(["validate", fix.sceneFile]);
    expect(exitCode).toBe(0);
  });

  it("a missing reference file produces an actionable validation error", async () => {
    const file = await sceneWith({ reference: { path: "./nope.png" } }, "missing.json");
    const errors = await cliErrors(["validate", file]);
    expect(errors[0]!.path).toBe("reference.path");
    expect(errors[0]!.message).toMatch(/not found|missing/);
    expect(errors[0]!.message).toMatch(/nope\.png/);
  });

  it("a non-PNG reference is refused with a convert-locally hint", async () => {
    await writeFile(path.join(fix.projectRoot, "photo.jpg"), Buffer.from("not a png"));
    const file = await sceneWith({ reference: { path: "./photo.jpg" } }, "jpeg.json");
    const errors = await cliErrors(["validate", file]);
    expect(errors[0]!.path).toBe("reference.path");
    expect(errors[0]!.message).toMatch(/PNG/);
  });

  it("a dimension-mismatched reference names the actual dimensions and the required ones", async () => {
    await writePng(path.join(fix.projectRoot, "small.png"), solid(640, 360, [0, 0, 0, 255]), 640, 360);
    const file = await sceneWith({ reference: { path: "./small.png" } }, "small.json");
    const errors = await cliErrors(["validate", file]);
    expect(errors[0]!.path).toBe("reference.path");
    expect(errors[0]!.message).toMatch(/1280×720/);
    expect(errors[0]!.message).toMatch(/640×360/);
  });

  it("a reference outside the project root is refused — the bundle must stay relocatable", async () => {
    await writePng(path.join(fix.root, "outside.png"), solid(1280, 720, [0, 0, 0, 255]));
    const file = await sceneWith({ reference: { path: "../outside.png" } }, "outside.json");
    const errors = await cliErrors(["validate", file]);
    expect(errors[0]!.path).toBe("reference.path");
    expect(errors[0]!.message).toMatch(/inside the scene's directory/);
  });

  it("an in-project symlink to an out-of-tree file is refused too — containment resolves aliases", async () => {
    await writePng(path.join(fix.root, "outside.png"), solid(1280, 720, [0, 0, 0, 255]));
    await symlink(
      path.join(fix.root, "outside.png"),
      path.join(fix.projectRoot, "alias.png"),
    );
    const file = await sceneWith({ reference: { path: "./alias.png" } }, "alias.json");
    for (const cmd of ["validate", "compare"] as const) {
      const errors = await cliErrors([cmd, file]);
      expect(errors[0]!.path).toBe("reference.path");
      expect(errors[0]!.message).toMatch(/escapes the scene's directory.*symlink/);
    }
  });

  it("render ignores the reference entirely — a missing reference file still renders", async () => {
    const file = await sceneWith({ reference: { path: "./gone.png" } }, "renderable.json");
    const out = path.join(fix.projectRoot, "out", "renderable.png");
    const { exitCode, output } = await cliRun(["render", file, "--out", out]);
    expect(exitCode).toBe(0);
    expect(output).toMatchObject({ ok: true, width: 1280, height: 720 });
  }, 20000);
});

// --- diff --------------------------------------------------------------------

describe("diffPng", () => {
  it("computes the per-channel absolute difference with opaque output", () => {
    const a = encodePngRgba(
      2,
      1,
      Buffer.from([255, 0, 0, 255, 10, 20, 30, 255]),
    );
    const refRgba = Buffer.from([0, 100, 0, 255, 10, 0, 30, 40]);
    const ref = {
      path: "/x/ref.png",
      width: 2,
      height: 1,
      rgba: refRgba,
      bytes: encodePngRgba(2, 1, refRgba),
    };
    const diff = decodePng(diffPng(a, ref));
    expect(diff.width).toBe(2);
    expect([...diff.rgba.subarray(0, 8)]).toEqual([255, 100, 0, 255, 0, 20, 0, 255]);
  });

  it("identical inputs produce an all-zero diff", () => {
    const rgba = halfReference();
    const png = encodePngRgba(1280, 720, rgba);
    const ref = { path: "/x/ref.png", width: 1280, height: 720, rgba, bytes: png };
    const diff = decodePng(diffPng(png, ref));
    // Every pixel channel except alpha is zero.
    for (let i = 0; i < diff.rgba.length; i += 4) {
      expect(diff.rgba[i]).toBe(0);
      expect(diff.rgba[i + 1]).toBe(0);
      expect(diff.rgba[i + 2]).toBe(0);
      expect(diff.rgba[i + 3]).toBe(255);
    }
  });
});

// --- scene compare CLI ---------------------------------------------------------

describe("scene compare", () => {
  it("writes the sheet, the diff, and the render — and no manifest", async () => {
    await writePng(path.join(fix.projectRoot, "ref.png"), halfReference());
    const file = await sceneWith({ reference: { path: "./ref.png" } }, "compare.json");
    const { exitCode, output } = await cliRun(["compare", file]);
    expect(exitCode).toBe(0);
    const out = output as {
      ok: boolean;
      output: string;
      diff: string;
      render: string;
      reference: string;
    };
    expect(out.ok).toBe(true);
    expect(out.reference).toBe("./ref.png");
    const html = await readFile(out.output, "utf8");
    // CSP: no script, remote nothing — the executable-document boundary.
    expect(html).toMatch(/default-src 'none'/);
    expect(html).not.toMatch(/<script/i);
    // Side by side (full + 168px), overlay, and difference views are present.
    // The 168px figures carry their size class, and the overlay's opacity
    // rules reach the stack through the sibling selector — both are pure-CSS
    // contracts a typo would silently break (caught by eye, guarded here).
    expect(html).toMatch(/168/);
    expect(html).toMatch(/figure class="small"/);
    expect(html).toMatch(/#alpha-50:checked ~ \.stack \.render\{opacity:0\.5\}/);
    expect(html).toMatch(/type="radio"/);
    expect(html).toMatch(new RegExp(`file://${out.render.replace(/[./]/g, "\\$&")}`));
    expect(html).toMatch(new RegExp(`file://${out.diff.replace(/[./]/g, "\\$&")}`));
    // The diff decodes at the aligned canvas size.
    const diff = decodePng(await readFile(out.diff));
    expect(diff.width).toBe(1280);
    expect(diff.height).toBe(720);
    // The render half is exact red, the reference's right half is blue — the
    // right half of the diff must differ, the left must not.
    const px = (x: number) => {
      const i = (360 * 1280 + x) * 4;
      return [diff.rgba[i]!, diff.rgba[i + 1]!, diff.rgba[i + 2]!];
    };
    expect(px(100)).toEqual([0, 0, 0]);
    expect(px(1200)[0]).toBeGreaterThan(200);
    // Review artifacts, never a Render: no manifest beside them. Order is
    // the filesystem's, not the assertion's — compare as sorted sets.
    const files = await readdir(path.join(fix.projectRoot, "out"));
    expect(files.filter((f) => f.startsWith("compare.")).sort()).toEqual(
      ["compare.compare.html", "compare.diff.png", "compare.compare.render.png"].sort(),
    );
  }, 20000);

  it("a scene with an invalid reference fails before any artifact is written", async () => {
    const file = await sceneWith({ reference: { path: "./nope.png" } }, "bad-compare.json");
    const errors = await cliErrors(["compare", file]);
    expect(errors[0]!.path).toBe("reference.path");
    const files = await readdir(path.join(fix.projectRoot, "out"));
    expect(files.filter((f) => f.startsWith("bad-compare."))).toEqual([]);
  });

  it("refuses to overwrite a recorded Render output and writes no artifacts", async () => {
    // A previous render claimed the default diff path via --out; its manifest
    // records it. Compare must refuse before any browser work or file write.
    const seeder = await sceneWith({}, "seeder.json");
    const claimed = path.join(fix.projectRoot, "out", "conflict.diff.png");
    const seeded = await cliRun(["render", seeder, "--out", claimed]);
    expect(seeded.exitCode).toBe(0);
    const file = await sceneWith({ reference: { path: "./ref.png" } }, "conflict.json");
    const errors = await cliErrors(["compare", file]);
    expect(errors[0]!.path).toBe("compare");
    expect(errors[0]!.message).toMatch(/never overwrite a final Render/);
    const files = await readdir(path.join(fix.projectRoot, "out"));
    expect(files.filter((f) => f.startsWith("conflict.compare."))).toEqual([]);
  }, 20000);

  it("the render manifest never records the reference — it is not Render input", async () => {
    const file = await sceneWith({ reference: { path: "./ref.png" } }, "manifest.json");
    const out = path.join(fix.projectRoot, "out", "manifest.png");
    const { exitCode } = await cliRun(["render", file, "--out", out]);
    expect(exitCode).toBe(0);
    const manifest = JSON.parse(
      await readFile(out.replace(/\.png$/, "") + ".manifest.json", "utf8"),
    ) as {
      scene: Record<string, unknown>;
    };
    expect(JSON.stringify(manifest)).not.toContain("reference.png");
  }, 20000);

  it("a scene without a reference is refused with a hint to associate one", async () => {
    const errors = await cliErrors(["compare", fix.sceneFile]);
    expect(errors[0]!.path).toBe("reference");
    expect(errors[0]!.message).toMatch(/reference\.path/);
  });

  it("usage errors: no file, extra arguments, unknown command lists compare", async () => {
    const noFile = await cliRun(["compare"]);
    expect(noFile.exitCode).toBe(2);
    const extra = await cliRun(["compare", fix.sceneFile, "--out", "x.png"]);
    expect(extra.exitCode).toBe(2);
    const unknown = await cliRun(["nonsense"]);
    expect(unknown.exitCode).toBe(2);
    expect((unknown.output as { errors: { message: string }[] }).errors[0]!.message).toMatch(
      /expected schema, .*compare/,
    );
  });
});
