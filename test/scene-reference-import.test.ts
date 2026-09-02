/**
 * Reference Thumbnail import (US-001–US-004) — tested at the public CLI
 * boundary (TEST-001): the command accepts supported local raster input,
 * normalizes it to the canonical 1280×720 PNG profile (TEST-002), stores the
 * copy inside the relocatable Scene bundle, records supplied provenance, and
 * replaces the Scene atomically — every refusal leaves the previous Scene and
 * its associated files untouched and usable.
 *
 * One browser-backed suite per file (TEST-003): normalization decodes input
 * bytes on the shared render page, exactly like every render path. Nothing
 * here generates, spends, or touches the network.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { realpath } from "node:fs/promises";
import { decodePng, encodePngRgba, MAX_ENCODED_BYTES } from "../src/png.js";
import { run as cliRun } from "../src/scene-cli.js";
import { importReference, atomicReplace } from "../src/reference-import.js";
import { readRasterMeta } from "../src/raster-meta.js";
import { withRenderPage } from "../src/browser.js";
import { chromium } from "playwright";

// --- fixtures --------------------------------------------------------------

interface Fix {
  root: string;
  projectRoot: string;
  sceneFile: string;
}

let fix: Fix;

const LAYERS = [
  {
    id: "bg",
    type: "shape",
    shape: "rect",
    position: { x: 0, y: 0 },
    size: { width: 1280, height: 720 },
    color: "#101418",
  },
];

const sceneDoc = (over: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  canvas: { width: 1280, height: 720 },
  layers: LAYERS,
  ...over,
});

/** A quadrant grid — four flat color fields, so scaling behavior is visible
 *  in pixels: every quadrant keeps its hue after a non-distorting resample. */
const quadrants = (w: number, h: number): Buffer => {
  const rgba = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const [r, g, b] =
        x < w / 2 && y < h / 2
          ? [220, 40, 40] // red — top left
          : x >= w / 2 && y < h / 2
            ? [40, 160, 220] // blue — top right
            : x < w / 2
              ? [240, 200, 40] // yellow — bottom left
              : [60, 180, 90]; // green — bottom right
      rgba[i] = r!;
      rgba[i + 1] = g!;
      rgba[i + 2] = b!;
      rgba[i + 3] = 255;
    }
  return rgba;
};

beforeAll(async () => {
  const root = await mkdtemp(path.join(tmpdir(), "thumby-ref-import-"));
  const projectRoot = path.join(root, "project");
  await mkdir(projectRoot, { recursive: true });
  const sceneFile = path.join(projectRoot, "scene.json");
  await writeFile(sceneFile, JSON.stringify(sceneDoc(), null, 2) + "\n");
  fix = { root, projectRoot, sceneFile };
});

afterAll(async () => {
  await rm(fix.root, { recursive: true, force: true });
});

/** Run the import command and hand back the parsed JSON output. */
async function importRun(
  argv: string[],
): Promise<{ exitCode: number; output: Record<string, unknown> }> {
  const { exitCode, output } = await cliRun(argv);
  return { exitCode, output: output as Record<string, unknown> };
}

/** A fresh scene file with the given top-level overrides. */
async function sceneFileWith(over: Record<string, unknown>, name: string): Promise<string> {
  const file = path.join(fix.projectRoot, name);
  await writeFile(file, JSON.stringify(sceneDoc(over), null, 2) + "\n");
  return file;
}

// --- import transaction ------------------------------------------------------

describe("scene reference import", () => {
  it("normalizes a 16:9 raster to an exact 1280×720 PNG inside the scene bundle and associates it", async () => {
    const input = path.join(fix.root, "shot-1920.png");
    await writeFile(input, encodePngRgba(1920, 1080, quadrants(1920, 1080)));
    const before = await readFile(fix.sceneFile);

    const { exitCode, output } = await importRun(["reference", "import", fix.sceneFile, input]);
    expect(exitCode).toBe(0);
    expect(output.ok).toBe(true);
    // The association is reported as recorded: a contained, scene-relative path.
    const reference = output.reference as { path: string };
    expect(reference.path).toBe("scene.reference.png");
    // The normalized profile facts come back: the copy is 1280×720 and the
    // source dimensions are reported too.
    expect(output.normalized).toMatchObject({
      width: 1280,
      height: 720,
      source: { width: 1920, height: 1080 },
    });

    // The stored copy is a real PNG at exactly 1280×720, inside the bundle.
    const storedPath = path.join(fix.projectRoot, "scene.reference.png");
    const decoded = decodePng(await readFile(storedPath));
    expect(decoded.width).toBe(1280);
    expect(decoded.height).toBe(720);

    // The Scene points only at the stored copy.
    const scene = JSON.parse(await readFile(fix.sceneFile, "utf8")) as {
      reference?: { path: string };
    };
    expect(scene.reference).toEqual({ path: "scene.reference.png" });

    // The complete resulting Scene passes the existing validation boundary.
    const { exitCode: vCode, output: vOut } = await importRun(["validate", fix.sceneFile]);
    expect(vCode).toBe(0);
    expect(vOut.ok).toBe(true);
    expect(vOut.reference).toBe("scene.reference.png");

    // The previous Scene bytes are replaced only by the validated update —
    // the file changed (reference added) and nothing else did.
    expect(await readFile(fix.sceneFile)).not.toEqual(before);
  }, 20000);

  it("downscales non-distortingly — every quadrant keeps its hue in pixels", async () => {
    const input = path.join(fix.root, "shot-2560.png");
    await writeFile(input, encodePngRgba(2560, 1440, quadrants(2560, 1440)));
    const file = await sceneFileWith({}, "quadrants.json");
    const { exitCode } = await importRun(["reference", "import", file, input]);
    expect(exitCode).toBe(0);
    const decoded = decodePng(await readFile(path.join(fix.projectRoot, "quadrants.reference.png")));
    // Sample well inside each quadrant, away from the diagonals and the
    // edge — a non-distorting 2× downscale keeps each field's hue dominant.
    const px = (x: number, y: number) => {
      const i = (y * 1280 + x) * 4;
      return [decoded.rgba[i]!, decoded.rgba[i + 1]!, decoded.rgba[i + 2]!] as const;
    };
    const [rr, rg, rb] = px(220, 140); // red — top left
    expect(rr).toBeGreaterThan(150);
    expect(rg).toBeLessThan(120);
    expect(rb).toBeLessThan(120);
    const [br, bg, bb] = px(1060, 140); // blue — top right
    expect(br).toBeLessThan(120);
    expect(bg).toBeGreaterThan(80);
    expect(bb).toBeGreaterThan(150);
    const [yr, yg, yb] = px(220, 580); // yellow — bottom left
    expect(yr).toBeGreaterThan(180);
    expect(yg).toBeGreaterThan(140);
    expect(yb).toBeLessThan(120);
    const [gr, gg, gb] = px(1060, 580); // green — bottom right
    expect(gr).toBeLessThan(120);
    expect(gg).toBeGreaterThan(120);
    expect(gb).toBeLessThan(140);
  }, 20000);

  it("an exactly 1280×720 input is stored pixel-identical — 1:1, no resample drift", async () => {
    const input = path.join(fix.root, "exact.png");
    const source = quadrants(1280, 720);
    await writeFile(input, encodePngRgba(1280, 720, source));
    const file = await sceneFileWith({}, "exact.json");
    const { exitCode } = await importRun(["reference", "import", file, input]);
    expect(exitCode).toBe(0);
    const decoded = decodePng(await readFile(path.join(fix.projectRoot, "exact.reference.png")));
    expect(decoded.width).toBe(1280);
    expect(decoded.height).toBe(720);
    // Opaque pixels survive the 1:1 blit and PNG round-trip byte-for-byte.
    expect(Buffer.from(decoded.rgba).equals(source)).toBe(true);
  }, 20000);

  it("normalizes JPEG and WebP input to a real PNG copy", async () => {
    // Fixtures are encoded by the same bundled browser that decodes imports.
    const [jpeg, webp] = (await withRenderPage((page) =>
      page.evaluate(() => {
        const encode = (kind: "image/jpeg" | "image/webp") => {
          const c = document.createElement("canvas");
          c.width = 640;
          c.height = 360;
          const ctx = c.getContext("2d")!;
          ctx.fillStyle = "#2080c0";
          ctx.fillRect(0, 0, 640, 360);
          ctx.fillStyle = "#e0c030";
          ctx.fillRect(320, 0, 320, 360);
          return c.toDataURL(kind);
        };
        return [encode("image/jpeg"), encode("image/webp")];
      }),
    )) as [string, string];
    const jpegInput = path.join(fix.root, "shot.jpg");
    const webpInput = path.join(fix.root, "shot.webp");
    await writeFile(jpegInput, Buffer.from(jpeg.replace(/^data:image\/jpeg;base64,/, ""), "base64"));
    await writeFile(webpInput, Buffer.from(webp.replace(/^data:image\/webp;base64,/, ""), "base64"));
    for (const [input, name] of [
      [jpegInput, "jpeg"],
      [webpInput, "webp"],
    ] as const) {
      const file = await sceneFileWith({}, `${name}.json`);
      const { exitCode, output } = await importRun(["reference", "import", file, input]);
      // On any failure the structured CLI error is the assertion message —
      // the import contract is actionable, so the test failure must be too.
      expect(exitCode, JSON.stringify(output)).toBe(0);
      // The stored copy is a genuine PNG (decoded by the strict parser) at
      // the canonical profile — never the source format.
      const decoded = decodePng(
        await readFile(path.join(fix.projectRoot, `${name}.reference.png`)),
      );
      expect(decoded.width).toBe(1280);
      expect(decoded.height).toBe(720);
    }
  }, 20000);

  it("refuses a non-16:9 input before anything is written, with actionable guidance", async () => {
    const input = path.join(fix.root, "square.png");
    await writeFile(input, encodePngRgba(1000, 1000, quadrants(1000, 1000)));
    const file = await sceneFileWith({ reference: { path: "./kept.png" } }, "refusal.json");
    const sceneBefore = await readFile(file);
    const dirBefore = (await readdir(fix.projectRoot)).sort();

    const { exitCode, output } = await importRun(["reference", "import", file, input]);
    expect(exitCode).toBe(1);
    expect(output.ok).toBe(false);
    const errors = output.errors as { path: string; message: string }[];
    expect(errors[0]!.path).toBe("file");
    expect(errors[0]!.message).toMatch(/1000×1000/);
    expect(errors[0]!.message).toMatch(/1280×720/);
    expect(errors[0]!.message).toMatch(/crop/i);

    // Nothing changed: the scene bytes, and the directory listing — no
    // partial copy, and the previous association's file untouched.
    expect(await readFile(file)).toEqual(sceneBefore);
    expect((await readdir(fix.projectRoot)).sort()).toEqual(dirBefore.sort());
  }, 20000);

  it("refuses a missing, an unreadable, and a non-image input the same way — nothing written", async () => {
    const missing = path.join(fix.root, "no-such-file.png");
    const corrupt = path.join(fix.root, "corrupt.png");
    await writeFile(corrupt, Buffer.from("this is not an image"));
    const svg = path.join(fix.root, "vector.svg");
    await writeFile(svg, `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720"></svg>`);
    for (const input of [missing, corrupt, svg]) {
      const file = await sceneFileWith({}, `refusal-${path.basename(input)}.json`);
      const sceneBefore = await readFile(file);
      const dirBefore = (await readdir(fix.projectRoot)).sort();
      const { exitCode, output } = await importRun(["reference", "import", file, input]);
      expect(exitCode).toBe(1);
      expect(output.ok).toBe(false);
      const errors = output.errors as { path: string; message: string }[];
      expect(errors[0]!.path).toBe("file");
      expect(errors[0]!.message).toMatch(new RegExp(input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      expect(await readFile(file)).toEqual(sceneBefore);
      expect((await readdir(fix.projectRoot)).sort()).toEqual(dirBefore);
    }
  }, 20000);

  it("records --source as reference.source free text; no flag means no source field", async () => {
    const input = path.join(fix.root, "shot-1280.png");
    await writeFile(input, encodePngRgba(1280, 720, quadrants(1280, 720)));

    const withSource = await sceneFileWith({}, "source.json");
    const { exitCode } = await importRun([
      "reference",
      "import",
      withSource,
      input,
      "--source",
      "macOS screenshot of Linear, 2024-06-01",
    ]);
    expect(exitCode).toBe(0);
    const recorded = JSON.parse(await readFile(withSource, "utf8")) as {
      reference: { path: string; source?: string };
    };
    expect(recorded.reference.source).toBe("macOS screenshot of Linear, 2024-06-01");

    const without = await sceneFileWith({}, "nosource.json");
    const { exitCode: nCode } = await importRun(["reference", "import", without, input]);
    expect(nCode).toBe(0);
    const plain = JSON.parse(await readFile(without, "utf8")) as {
      reference: Record<string, unknown>;
    };
    expect(Object.keys(plain.reference)).toEqual(["path"]);
  }, 20000);

  it("a taken stored name gets the next suffix — an existing file is never overwritten", async () => {
    const input = path.join(fix.root, "shot-640.png");
    await writeFile(input, encodePngRgba(640, 360, quadrants(640, 360)));
    const existing = path.join(fix.projectRoot, "taken.reference.png");
    await writeFile(existing, Buffer.from("previous association bytes"));
    const file = await sceneFileWith({}, "taken.json");

    const { exitCode, output } = await importRun(["reference", "import", file, input]);
    expect(exitCode).toBe(0);
    expect(output.reference).toMatchObject({ path: "taken.reference-2.png" });

    // The pre-existing file's bytes are untouched, and the scene points at
    // the new copy only.
    expect(await readFile(existing)).toEqual(Buffer.from("previous association bytes"));
    const recorded = JSON.parse(await readFile(file, "utf8")) as {
      reference: { path: string };
    };
    expect(recorded.reference.path).toBe("taken.reference-2.png");
  }, 20000);

  it("a symlink at the stored path is never written through — the copy goes to the next suffix", async () => {
    const outside = path.join(fix.root, "outside-target.png");
    await writeFile(outside, encodePngRgba(1280, 720, quadrants(1280, 720)));
    const alias = path.join(fix.projectRoot, "aliased.reference.png");
    await symlink(outside, alias);
    const input = path.join(fix.root, "shot-1920b.png");
    await writeFile(input, encodePngRgba(1920, 1080, quadrants(1920, 1080)));
    const file = await sceneFileWith({}, "aliased.json");

    const { exitCode, output } = await importRun(["reference", "import", file, input]);
    expect(exitCode).toBe(0);
    // The alias was skipped, not written through: it still resolves to the
    // out-of-tree target, and the copy landed at the next free name.
    const target = decodePng(await readFile(outside));
    expect(target.width).toBe(1280);
    expect(target.height).toBe(720);
    expect(output.reference).toMatchObject({ path: "aliased.reference-2.png" });
    const stored = decodePng(await readFile(path.join(fix.projectRoot, "aliased.reference-2.png")));
    expect(stored.width).toBe(1280);
    const recorded = JSON.parse(await readFile(file, "utf8")) as {
      reference: { path: string };
    };
    expect(recorded.reference.path).toBe("aliased.reference-2.png");
  }, 20000);

  it("a failed commit rolls the new copy back — the previous Scene and reference stay byte-identical", async () => {
    // First import succeeds and becomes the association a later failed
    // commit must preserve.
    const input = path.join(fix.root, "shot-first.png");
    await writeFile(input, encodePngRgba(1280, 720, quadrants(1280, 720)));
    const file = await sceneFileWith({}, "rollback.json");
    const first = await importRun(["reference", "import", file, input]);
    expect(first.exitCode).toBe(0);
    const sceneBefore = await readFile(file);
    const firstReference = await readFile(path.join(fix.projectRoot, "rollback.reference.png"));

    // A second import whose Scene commit fails (the documented
    // fault-injection seam — production always performs the real write):
    // the new copy is rolled back and nothing else changes.
    const secondInput = path.join(fix.root, "shot-second.png");
    await writeFile(secondInput, encodePngRgba(1920, 1080, quadrants(1920, 1080)));
    const result = await importReference(file, secondInput, {
      writeScene: () => Promise.reject(new Error("injected commit failure")),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]!.path).toBe("scene");
      expect(result.errors[0]!.message).toMatch(/injected commit failure/);
      expect(result.errors[0]!.message).toMatch(/unchanged and usable/);
    }
    // Previous Scene bytes and its associated file: byte-identical, usable.
    expect(await readFile(file)).toEqual(sceneBefore);
    expect(await readFile(path.join(fix.projectRoot, "rollback.reference.png"))).toEqual(firstReference);
    // The rolled-back copy is gone.
    await expect(readFile(path.join(fix.projectRoot, "rollback.reference-2.png"))).rejects.toThrow();
    // The untouched Scene still validates with its original reference.
    const { exitCode: vCode, output: vOut } = await importRun(["validate", file]);
    expect(vCode).toBe(0);
    expect(vOut.reference).toBe("rollback.reference.png");
  }, 20000);

  it("rendering the imported Scene yields the same pixels and the same resolved Asset identities as an equivalent Scene without the reference — the Scene's byte identity changes by design", async () => {
    // Two identical projects; only one gets a Reference Thumbnail.
    const mk = async (name: string): Promise<string> => {
      const dir = path.join(fix.root, name);
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, "bg.svg"),
        `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720"><rect width="1280" height="720" fill="#22303c"/></svg>`);
      const file = path.join(dir, "iso.json");
      await writeFile(
        file,
        JSON.stringify(
          sceneDoc({
            layers: [
              {
                id: "bg",
                type: "image",
                asset: "./bg.svg",
                position: { x: 0, y: 0 },
                size: { width: 1280, height: 720 },
              },
            ],
          }),
          null,
          2,
        ) + "\n",
      );
      return file;
    };
    const plainFile = await mk("iso-plain");
    const refFile = await mk("iso-ref");
    const input = path.join(fix.root, "iso-input.png");
    await writeFile(input, encodePngRgba(1280, 720, quadrants(1280, 720)));
    const imported = await importRun(["reference", "import", refFile, input]);
    expect(imported.exitCode).toBe(0);

    const renderPlain = await importRun(["render", plainFile]);
    const renderRef = await importRun(["render", refFile]);
    expect(renderPlain.exitCode).toBe(0);
    expect(renderRef.exitCode).toBe(0);

    // Same pixels.
    const plainPng = await readFile(renderPlain.output.output as string);
    const refPng = await readFile(renderRef.output.output as string);
    expect(refPng.equals(plainPng)).toBe(true);

    // Same manifest identity facts — dimensions and every resolved Asset
    // identity — and the manifest never mentions the reference.
    const readManifest = async (manifestFile: string) =>
      JSON.parse(await readFile(manifestFile, "utf8")) as {
        scene: { sha256: string };
        outputs: { width: number; height: number; assets: unknown[] }[];
      };
    const pm = await readManifest(renderPlain.output.manifest as string);
    const rm2 = await readManifest(renderRef.output.manifest as string);
    expect(rm2.outputs.map((o) => ({ width: o.width, height: o.height, assets: o.assets })))
      .toEqual(pm.outputs.map((o) => ({ width: o.width, height: o.height, assets: o.assets })));
    expect(JSON.stringify(rm2)).not.toContain("reference");
    // The scene identity differs by design — the reference metadata is part
    // of the Scene bytes — so it is the only fact allowed to differ.
    expect(rm2.scene.sha256).not.toBe(pm.scene.sha256);
  }, 20000);

  it("a Scene the validation gate rejects is refused — the new copy rolls back, nothing changes", async () => {
    // The complete resulting document must pass the gate before commit, so a
    // broken scene can never gain a reference (DEC-004).
    const broken = await sceneFileWith(
      { layers: [{ id: "broken", type: "text", font: "inter", size: { width: 10, height: 10 } }] },
      "broken.json",
    );
    const sceneBefore = await readFile(broken);
    const dirBefore = (await readdir(fix.projectRoot)).sort();
    const input = path.join(fix.root, "shot-gate.png");
    await writeFile(input, encodePngRgba(1280, 720, quadrants(1280, 720)));

    const { exitCode, output } = await importRun(["reference", "import", broken, input]);
    expect(exitCode).toBe(1);
    expect(output.ok).toBe(false);
    const errors = output.errors as { path: string; message: string }[];
    expect(errors.some((e) => e.path.startsWith("layers"))).toBe(true);
    // The previous scene bytes are untouched and no copy was left behind.
    expect(await readFile(broken)).toEqual(sceneBefore);
    expect((await readdir(fix.projectRoot)).sort()).toEqual(dirBefore);
  }, 20000);

  it("imports with every network request aborted — local bytes only, offline", async () => {
    const input = path.join(fix.root, "offline.png");
    await writeFile(input, encodePngRgba(1280, 720, quadrants(1280, 720)));
    const file = await sceneFileWith({}, "offline.json");
    const sceneBefore = await readFile(file);

    // A route-aborted page (the renderScene offline precedent): any fetch —
    // decoding via a URL, telemetry, anything — would fail the import.
    const browser = await chromium.launch();
    try {
      const ctx = await browser.newContext();
      await ctx.route("**/*", (route) => route.abort());
      const page = await ctx.newPage();
      const result = await importReference(file, input, { page });
      expect(result.ok).toBe(true);
      expect(result.ok && result.imported.normalized).toMatchObject({ width: 1280, height: 720 });
    } finally {
      await browser.close();
    }
    // The Scene committed the association.
    const recorded = JSON.parse(await readFile(file, "utf8")) as {
      reference: { path: string };
    };
    expect(recorded.reference.path).toBe("offline.reference.png");
    expect(await readFile(file)).not.toEqual(sceneBefore);
  }, 20000);

  it("usage errors: missing arguments, unknown subcommand, bad --source, extra arguments", async () => {
    const noArgs = await importRun(["reference", "import"]);
    expect(noArgs.exitCode).toBe(2);
    const oneArg = await importRun(["reference", "import", fix.sceneFile]);
    expect(oneArg.exitCode).toBe(2);
    const unknownSub = await importRun(["reference", "frobnicate", fix.sceneFile]);
    expect(unknownSub.exitCode).toBe(2);
    expect((unknownSub.output.errors as { message: string }[])[0]!.message).toMatch(/expected "import/);
    const bareSource = await importRun(["reference", "import", fix.sceneFile, "x.png", "--source"]);
    expect(bareSource.exitCode).toBe(2);
    const flagValue = await importRun(["reference", "import", fix.sceneFile, "x.png", "--source", "--out"]);
    expect(flagValue.exitCode).toBe(2);
    const dupSource = await importRun([
      "reference", "import", fix.sceneFile, "x.png", "--source", "a", "--source", "b",
    ]);
    expect(dupSource.exitCode).toBe(2);
    const extra = await importRun(["reference", "import", fix.sceneFile, "x.png", "y.png"]);
    expect(extra.exitCode).toBe(2);
    // The unknown-command list mentions the new command.
    const unknownCmd = await importRun(["nonsense"]);
    expect(unknownCmd.exitCode).toBe(2);
    expect((unknownCmd.output.errors as { message: string }[])[0]!.message).toMatch(
      /expected schema, .*reference import/,
    );
  });
});

// --- serialized transaction (INT-1, PROD-1, PROD-2, PROD-3) -------------------

describe("scene reference import — serialized transaction", () => {
  it("serializes concurrent imports — both succeed, both copies survive intact, the Scene points at the last", async () => {
    const input = path.join(fix.root, "shot-concurrent.png");
    await writeFile(input, encodePngRgba(1280, 720, quadrants(1280, 720)));
    const file = await sceneFileWith({}, "concurrent.json");

    // Two imports of the same Scene at once: the per-Scene lock serializes
    // them, so the second reads the first's committed Scene, reserves the
    // next free name exclusively, and commits on top — no copy replaced, no
    // Scene overwrite of an intervening edit.
    const [a, b] = await Promise.all([
      importRun(["reference", "import", file, input]),
      importRun(["reference", "import", file, input]),
    ]);
    expect(a.exitCode).toBe(0);
    expect(b.exitCode).toBe(0);
    const names = (await readdir(fix.projectRoot))
      .filter((f) => f.startsWith("concurrent.reference"))
      .sort();
    expect(names).toEqual(["concurrent.reference-2.png", "concurrent.reference.png"]);
    for (const name of names) {
      const decoded = decodePng(await readFile(path.join(fix.projectRoot, name)));
      expect(decoded.width).toBe(1280);
      expect(decoded.height).toBe(720);
    }
    const scene = JSON.parse(await readFile(file, "utf8")) as {
      reference: { path: string };
    };
    expect(scene.reference.path).toBe("concurrent.reference-2.png");
    const { exitCode } = await importRun(["validate", file]);
    expect(exitCode).toBe(0);
  }, 60000);

  it("reserves the destination exclusively — taken names are skipped, their bytes never replaced", async () => {
    const first = path.join(fix.projectRoot, "exclusive.reference.png");
    const second = path.join(fix.projectRoot, "exclusive.reference-2.png");
    await writeFile(first, Buffer.from("first association bytes"));
    await writeFile(second, Buffer.from("second association bytes"));
    const input = path.join(fix.root, "shot-exclusive.png");
    await writeFile(input, encodePngRgba(1280, 720, quadrants(1280, 720)));
    const file = await sceneFileWith({}, "exclusive.json");

    const { exitCode, output } = await importRun(["reference", "import", file, input]);
    expect(exitCode).toBe(0);
    expect(output.reference).toMatchObject({ path: "exclusive.reference-3.png" });
    // The taken names' bytes were never replaced.
    expect(await readFile(first)).toEqual(Buffer.from("first association bytes"));
    expect(await readFile(second)).toEqual(Buffer.from("second association bytes"));
  }, 20000);

  it("fails closed when the Scene changed since it was read — an intervening edit is never overwritten", async () => {
    const input = path.join(fix.root, "shot-cas.png");
    await writeFile(input, encodePngRgba(1280, 720, quadrants(1280, 720)));
    const file = await sceneFileWith({}, "cas.json");
    const sceneBefore = await readFile(file);

    // Fault-injection seam (the writeScene precedent): the pre-commit
    // comparison observes bytes different from the ones the import read.
    let reads = 0;
    const tampered =
      JSON.stringify(sceneDoc({ layers: [{ ...LAYERS[0], color: "#ffffff" }] }), null, 2) + "\n";
    const result = await importReference(file, input, {
      readScene: async (f) => (reads++ === 0 ? readFile(f) : Buffer.from(tampered)),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]!.path).toBe("scene");
      expect(result.errors[0]!.message).toMatch(/changed after this import read it/);
      expect(result.errors[0]!.message).toMatch(/refuses to overwrite an intervening edit/);
      expect(result.errors[0]!.message).toMatch(/Re-run the import/);
    }
    // The real Scene bytes are untouched, and the reservation rolled back.
    expect(await readFile(file)).toEqual(sceneBefore);
    await expect(readFile(path.join(fix.projectRoot, "cas.reference.png"))).rejects.toThrow();
  }, 20000);

  it("a failed commit with a failed rollback is one composite error naming the retained contained path", async () => {
    const input = path.join(fix.root, "shot-composite.png");
    await writeFile(input, encodePngRgba(1280, 720, quadrants(1280, 720)));
    const file = await sceneFileWith({}, "composite.json");
    const sceneBefore = await readFile(file);

    const result = await importReference(file, input, {
      writeScene: () => Promise.reject(new Error("injected commit failure")),
      removeStored: () => Promise.reject(new Error("injected removal failure")),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toHaveLength(2);
      expect(result.errors[0]!.path).toBe("scene");
      expect(result.errors[0]!.message).toMatch(/injected commit failure/);
      expect(result.errors[1]!.path).toBe("reference");
      // The retained copy is identified by its contained path, with remediation.
      expect(result.errors[1]!.message).toMatch(/composite\.reference\.png/);
      expect(result.errors[1]!.message).toMatch(/Delete that file, or re-import/);
      expect(result.errors[1]!.message).toMatch(/injected removal failure/);
    }
    // The retained copy is still on disk; the Scene bytes are untouched.
    expect(
      (await readFile(path.join(fix.projectRoot, "composite.reference.png"))).length,
    ).toBeGreaterThan(0);
    expect(await readFile(file)).toEqual(sceneBefore);
  }, 20000);

  it("refuses a non-regular-file input before reading it", async () => {
    const dir = path.join(fix.root, "input-dir");
    await mkdir(dir, { recursive: true });
    const file = await sceneFileWith({}, "notregular.json");
    const sceneBefore = await readFile(file);
    const dirBefore = (await readdir(fix.projectRoot)).sort();

    const { exitCode, output } = await importRun(["reference", "import", file, dir]);
    expect(exitCode).toBe(1);
    const errors = output.errors as { path: string; message: string }[];
    expect(errors[0]!.path).toBe("file");
    expect(errors[0]!.message).toMatch(/not a regular file/);
    expect(errors[0]!.message).toMatch(/a directory/);
    expect(await readFile(file)).toEqual(sceneBefore);
    expect((await readdir(fix.projectRoot)).sort()).toEqual(dirBefore);
  }, 20000);

  it("refuses an over-limit input by size before reading it", async () => {
    const big = path.join(fix.root, "big.png");
    await writeFile(big, Buffer.alloc(MAX_ENCODED_BYTES + 1));
    const file = await sceneFileWith({}, "oversize.json");
    const sceneBefore = await readFile(file);
    const dirBefore = (await readdir(fix.projectRoot)).sort();

    const { exitCode, output } = await importRun(["reference", "import", file, big]);
    expect(exitCode).toBe(1);
    const errors = output.errors as { path: string; message: string }[];
    expect(errors[0]!.path).toBe("file");
    expect(errors[0]!.message).toMatch(/over the 64 MB import limit/);
    expect(await readFile(file)).toEqual(sceneBefore);
    expect((await readdir(fix.projectRoot)).sort()).toEqual(dirBefore);
  }, 20000);

  it("readRasterMeta returns trusted geometry for every supported format — the budget's one input", async () => {
    // PNG: crafted header (bounds-checked reads; CRCs are the decoder's job).
    const png = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
    png.write("IHDR", 12, "latin1");
    png.writeUInt32BE(2560, 16);
    png.writeUInt32BE(1440, 20);
    expect(readRasterMeta(png, "x.png")).toEqual({ format: "png", width: 2560, height: 1440 });

    // JPEG: a minimal SOF0 frame header (4608×8192, 1 component).
    const jpeg = Buffer.from([
      0xff, 0xd8, // SOI
      0xff, 0xc0, 0x00, 0x0b, 0x08, 0x12, 0x00, 0x20, 0x00, 0x01, 0x01, 0x11, 0x00,
      0xff, 0xd9, // EOI
    ]);
    expect(readRasterMeta(jpeg, "x.jpg")).toEqual({ format: "jpeg", width: 8192, height: 4608 });

    // WebP: the real extended-file bytes the bundled browser encodes for a
    // 640×360 canvas (VP8X: 4 flag bytes, then 24-bit width−1, height−1).
    const [webp] = await withRenderPage((page) =>
      page.evaluate(() => {
        const c = document.createElement("canvas");
        c.width = 640;
        c.height = 360;
        const ctx = c.getContext("2d")!;
        ctx.fillStyle = "#2080c0";
        ctx.fillRect(0, 0, 640, 360);
        return [c.toDataURL("image/webp")];
      }),
    ) as [string];
    const webpBytes = Buffer.from(webp.replace(/^data:image\/webp;base64,/, ""), "base64");
    expect(readRasterMeta(webpBytes, "x.webp")).toEqual({ format: "webp", width: 640, height: 360 });

    // Anything else is refused with a convert-locally hint — never guessed.
    expect(readRasterMeta(Buffer.from("not an image"), "x.png")).toMatch(
      /not a PNG, JPEG, or WebP image/,
    );
  }, 20000);

  it("enforces the decoded budget from trusted header metadata before rasterization", async () => {
    // PNG whose IHDR declares 20000×11250 — over the per-axis decoded budget.
    // The parser reads header bytes only, so the CRC mismatch is irrelevant:
    // the refusal fires before any decoder runs.
    const pngBytes = encodePngRgba(64, 36, quadrants(64, 36));
    pngBytes.writeUInt32BE(20000, 16);
    pngBytes.writeUInt32BE(11250, 20);
    const pngInput = path.join(fix.root, "huge-declared.png");
    await writeFile(pngInput, pngBytes);
    const pngScene = await sceneFileWith({}, "huge-png.json");
    const { exitCode, output } = await importRun(["reference", "import", pngScene, pngInput]);
    expect(exitCode).toBe(1);
    const errors = output.errors as { path: string; message: string }[];
    expect(errors[0]!.path).toBe("file");
    expect(errors[0]!.message).toMatch(/20000×11250/);
    expect(errors[0]!.message).toMatch(/per-axis decoded budget/);
    expect(
      (await readdir(fix.projectRoot)).filter((f) => f.startsWith("huge-png.reference")),
    ).toEqual([]);

    // JPEG whose SOF0 frame header declares 8192×4608 — within the per-axis
    // budget but over the decoded-pixel budget.
    const jpeg = Buffer.from([
      0xff, 0xd8, // SOI
      0xff, 0xc0, 0x00, 0x0b, 0x08, 0x12, 0x00, 0x20, 0x00, 0x01, 0x01, 0x11, 0x00, // SOF0: 4608×8192, 1 component
      0xff, 0xd9, // EOI
    ]);
    const jpegInput = path.join(fix.root, "huge-declared.jpg");
    await writeFile(jpegInput, jpeg);
    const jpegScene = await sceneFileWith({}, "huge-jpeg.json");
    const { exitCode: jCode, output: jOut } = await importRun([
      "reference",
      "import",
      jpegScene,
      jpegInput,
    ]);
    expect(jCode).toBe(1);
    const jErrors = jOut.errors as { path: string; message: string }[];
    expect(jErrors[0]!.path).toBe("file");
    expect(jErrors[0]!.message).toMatch(/8192×4608/);
    expect(jErrors[0]!.message).toMatch(/-pixel decoded budget/);
    expect(
      (await readdir(fix.projectRoot)).filter((f) => f.startsWith("huge-jpeg.reference")),
    ).toEqual([]);
  }, 20000);

  it("contention waits only to the bounded timeout, then fails with the retained lock path — no stealing", async () => {
    const file = await sceneFileWith({}, "contended.json");
    const realScene = await realpath(file);
    const lockPath = `${realScene}.lock`;
    // A foreign holder's lock, as another process would leave it.
    await writeFile(lockPath, `${JSON.stringify({ pid: 999999, token: "foreign-token" })}\n`);
    const input = path.join(fix.root, "shot-contended.png");
    await writeFile(input, encodePngRgba(1280, 720, quadrants(1280, 720)));
    const sceneBefore = await readFile(file);

    const result = await importReference(file, input, { lockTimeoutMs: 150 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]!.path).toBe("scene");
      // The failure is actionable: the retained lock path is named, and
      // operator cleanup — never automatic stealing — is the remedy.
      expect(result.errors[0]!.message).toMatch(/holds this Scene's lock/);
      expect(result.errors[0]!.message).toMatch(/contended\.json\.lock/);
      expect(result.errors[0]!.message).toMatch(/remove the retained lock file explicitly/);
    }
    // The foreign lock was not stolen, and nothing was written.
    expect(await readFile(lockPath, "utf8")).toMatch(/foreign-token/);
    expect(await readFile(file)).toEqual(sceneBefore);
    expect(
      (await readdir(fix.projectRoot)).filter((f) => f.startsWith("contended.reference")),
    ).toEqual([]);
  }, 20000);

  it("release removes only the lock its own token owns — an old holder never removes a successor's", async () => {
    const file = await sceneFileWith({}, "oldholder.json");
    const realScene = await realpath(file);
    const lockPath = `${realScene}.lock`;
    const input = path.join(fix.root, "shot-oldholder.png");
    await writeFile(input, encodePngRgba(1280, 720, quadrants(1280, 720)));

    // Simulate explicit operator cleanup handing the lock to a successor
    // while an old holder is still inside its transaction: the successor's
    // token replaces the lock file's content mid-flight.
    let reads = 0;
    const result = await importReference(file, input, {
      readScene: async (f) => {
        if (reads++ === 0)
          await writeFile(lockPath, `${JSON.stringify({ pid: 424242, token: "successor-token" })}\n`);
        return readFile(f);
      },
    });
    // The old holder's transaction completes normally.
    expect(result.ok).toBe(true);
    // Its release did NOT remove the successor's lock: the file survives,
    // still carrying the successor's token.
    const lockAfter = await readFile(lockPath, "utf8");
    expect(lockAfter).toMatch(/successor-token/);
  }, 20000);

  it("a partial stored-file write flows through the owned rollback path — nothing escapes unreported", async () => {
    const input = path.join(fix.root, "shot-partial.png");
    await writeFile(input, encodePngRgba(1280, 720, quadrants(1280, 720)));
    const file = await sceneFileWith({}, "partial.json");
    const sceneBefore = await readFile(file);

    // Injectable partial-write failure: the reserved handle receives bytes,
    // the write aborts mid-way, and the owned rollback path reports it.
    const result = await importReference(file, input, {
      writeStored: async (fh) => {
        await fh.write(Buffer.from("partial bytes"));
        throw new Error("injected mid-write failure");
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]!.path).toBe("reference");
      expect(result.errors[0]!.message).toMatch(/injected mid-write failure/);
      expect(result.errors[0]!.message).toMatch(/The previous Scene is unchanged and usable/);
    }
    // The reserved copy was rolled back; the Scene is untouched.
    await expect(readFile(path.join(fix.projectRoot, "partial.reference.png"))).rejects.toThrow();
    expect(await readFile(file)).toEqual(sceneBefore);
  }, 20000);

  it("a partial write whose rollback also fails is one composite error naming the retained path", async () => {
    const input = path.join(fix.root, "shot-partial2.png");
    await writeFile(input, encodePngRgba(1280, 720, quadrants(1280, 720)));
    const file = await sceneFileWith({}, "partial2.json");
    const sceneBefore = await readFile(file);

    const result = await importReference(file, input, {
      writeStored: async (fh) => {
        await fh.write(Buffer.from("partial bytes"));
        throw new Error("injected mid-write failure");
      },
      removeStored: () => Promise.reject(new Error("injected removal failure")),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toHaveLength(2);
      expect(result.errors[0]!.path).toBe("reference");
      expect(result.errors[0]!.message).toMatch(/injected mid-write failure/);
      expect(result.errors[1]!.path).toBe("reference");
      expect(result.errors[1]!.message).toMatch(/partial2\.reference\.png/);
      expect(result.errors[1]!.message).toMatch(/Delete that file, or re-import/);
    }
    // The retained copy is still on disk; the Scene is untouched.
    expect(
      (await readFile(path.join(fix.projectRoot, "partial2.reference.png"))).length,
    ).toBeGreaterThan(0);
    expect(await readFile(file)).toEqual(sceneBefore);
  }, 20000);

  it("init's fresh publication is a no-replace create — a post-check writer refuses instead of overwriting", async () => {
    // init's containment root is the process cwd — scope the test to the
    // project fixture and restore afterwards.
    const cwd = process.cwd();
    process.chdir(fix.projectRoot);
    try {
      const output = "fresh-init.json";
      // Two concurrent inits to one brand-new path: the existence check
      // passes for both (neither exists yet), and the atomic no-replace
      // publication decides — exactly one winner, no silent overwrite.
      const [a, b] = await Promise.all([
        cliRun(["init", "blank", "--out", output]),
        cliRun(["init", "blank", "--out", output]),
      ]);
      const codes = [a.exitCode, b.exitCode].sort();
      expect(codes[0]).toBe(0);
      expect(codes[1]).toBe(2); // the loser refuses — structured usage error
      // The winner's file is a real Scene, and the loser never left partial
      // bytes or a duplicate.
      const { exitCode } = await cliRun(["validate", path.join(fix.projectRoot, output)]);
      expect(exitCode).toBe(0);
    } finally {
      process.chdir(cwd);
    }
  }, 20000);

  it("init --force over an existing Scene participates in the same per-Scene lock", async () => {
    const cwd = process.cwd();
    process.chdir(fix.projectRoot);
    try {
      const target = "init-replace.json";
      const targetPath = await sceneFileWith({}, target);
      const sceneBefore = await readFile(targetPath);
      const realScene = await realpath(targetPath);
      const lockPath = `${realScene}.lock`;
      await writeFile(lockPath, `${JSON.stringify({ pid: 999999, token: "foreign-token" })}\n`);

      const { exitCode, output } = await cliRun(["init", "blank", "--out", target, "--force"], {
        sceneLockTimeoutMs: 150,
      });
      expect(exitCode).toBe(1);
      const errors = (output as { errors: { path: string; message: string }[] }).errors;
      expect(errors[0]!.message).toMatch(/could not be locked for replacement/);
      expect(errors[0]!.message).toMatch(/init-replace\.json\.lock/);
      expect(errors[0]!.message).toMatch(/remove the retained lock file explicitly/);
      // The foreign lock was not stolen; the Scene bytes are untouched.
      expect(await readFile(lockPath, "utf8")).toMatch(/foreign-token/);
      expect(await readFile(targetPath)).toEqual(sceneBefore);
    } finally {
      process.chdir(cwd);
    }
  }, 20000);

  it("a replacing writer cannot pass the shared lock while an import holds the compare-to-commit window", async () => {
    const input = path.join(fix.root, "shot-window.png");
    await writeFile(input, encodePngRgba(1280, 720, quadrants(1280, 720)));
    const file = await sceneFileWith({}, "window.json");
    const sceneBefore = await readFile(file);
    const realScene = await realpath(file);
    const lockPath = `${realScene}.lock`;

    // Barrier seam (test-only; production never passes writeScene): the
    // import pauses after its Scene-byte comparison, mid-commit, holding the
    // lock. A replacing `scene init --force` must not pass the lock until
    // the import commits and releases.
    let atCommit!: () => void;
    const reachedCommit = new Promise<void>((r) => (atCommit = r));
    let releaseImport!: () => void;
    const holdOpen = new Promise<void>((r) => (releaseImport = r));
    const pending = importReference(file, input, {
      writeScene: async (f, bytes) => {
        atCommit();
        await holdOpen;
        await atomicReplace(f, bytes); // the import's real commit, after the barrier
      },
    });
    await reachedCommit;

    // The writer cannot pass the shared lock while the import holds it.
    const cwd = process.cwd();
    process.chdir(fix.projectRoot);
    let init!: { exitCode: number; output: unknown };
    try {
      init = await cliRun(["init", "blank", "--out", "window.json", "--force"], {
        sceneLockTimeoutMs: 300,
      });
    } finally {
      process.chdir(cwd);
    }
    expect(init.exitCode).toBe(1);
    const errors = (init.output as { errors: { path: string; message: string }[] }).errors;
    expect(errors[0]!.message).toMatch(/could not be locked for replacement/);
    expect(errors[0]!.message).toMatch(/window\.json\.lock/);

    // The import commits and releases; the lock file is cleaned up.
    releaseImport();
    const done = await pending;
    expect(done.ok).toBe(true);
    await expect(readFile(lockPath)).rejects.toThrow();
    // Both exact outcomes: the import's association is what committed — the
    // refused writer replaced nothing — and the stored copy is intact.
    const scene = JSON.parse(await readFile(file, "utf8")) as {
      reference?: { path: string };
    };
    expect(scene.reference).toEqual({ path: "window.reference.png" });
    const stored = decodePng(await readFile(path.join(fix.projectRoot, "window.reference.png")));
    expect(stored.width).toBe(1280);
    expect(stored.height).toBe(720);
    expect(await readFile(file)).not.toEqual(sceneBefore);
    // Cleanup: no stray artifacts from the refused writer.
    expect(
      (await readdir(fix.projectRoot))
        .filter((f) => f.startsWith("window"))
        .sort(),
    ).toEqual(["window.json", "window.reference.png"]);
  }, 20000);
});