import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm, cp, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { contentHash, resolveAsset, scanLibrary, type Library } from "../src/assets.js";
import { loadScene, type Scene, type SceneLayer } from "../src/scene.js";
import { buildManifest, readManifest, MANIFEST_VERSION } from "../src/manifest.js";
import { run as cliRun, rerenderManifest } from "../src/scene-cli.js";

// --- fixtures -------------------------------------------------------------

const RED_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="#ff0000"/></svg>`;
const GREEN_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="#00ff00"/></svg>`;
const BLUE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="#0000ff"/></svg>`;

interface Fix {
  root: string;
  projectRoot: string;
  lib: Library;
  sceneFile: string;
  /** The scene bytes as written — the manifest's scene.sha256 must match. */
  sceneBytes: Buffer;
}

let fix: Fix;

beforeAll(async () => {
  const root = await mkdtemp(path.join(tmpdir(), "thumby-manifest-"));
  const projectRoot = path.join(root, "project");
  const libRoot = path.join(root, "library");
  // Provenance fields a manifest must never copy.
  await mkdir(path.join(libRoot, "plates", "demo-plate"), { recursive: true });
  await writeFile(
    path.join(libRoot, "plates", "demo-plate", "meta.json"),
    JSON.stringify({
      kind: "plate",
      id: "demo-plate",
      name: "Demo Plate",
      tags: ["secret-tag"],
      subject: "Kenneth",
      fullPrompt: "TOP-SECRET-PROMPT",
      model: "image-model-1",
      adoptedFrom: "run-123",
    }),
  );
  await writeFile(path.join(libRoot, "plates", "demo-plate", "demo-plate.svg"), RED_SVG);
  await mkdir(projectRoot, { recursive: true });
  await writeFile(path.join(projectRoot, "red.svg"), RED_SVG);
  await writeFile(path.join(projectRoot, "blue.svg"), BLUE_SVG);
  const scene = {
    schemaVersion: 1,
    canvas: { width: 1280, height: 720 },
    layers: [
      {
        id: "bg",
        type: "image",
        asset: "./red.svg",
        position: { x: 0, y: 0 },
        size: { width: 1280, height: 720 },
      },
      {
        id: "title",
        type: "text",
        text: "Huge",
        font: "Anton",
        autoFit: { min: 300, max: 500 },
        position: { x: 40, y: 40 },
        size: { width: 200, height: 40 },
      },
    ] as SceneLayer[],
    variants: {
      blue: { changes: [{ layer: "bg", set: { asset: "./blue.svg" } }] },
      shifted: { changes: [{ layer: "bg", set: { position: { x: 40, y: 0 } } }] },
    },
  };
  const sceneFile = path.join(projectRoot, "show.json");
  const sceneBytes = Buffer.from(JSON.stringify(scene, null, 2) + "\n", "utf8");
  await writeFile(sceneFile, sceneBytes);
  fix = {
    root,
    projectRoot,
    lib: await scanLibrary(libRoot),
    sceneFile,
    sceneBytes,
  };
});

afterAll(async () => {
  await rm(fix.root, { recursive: true, force: true });
});

const outPath = (...p: string[]) => path.join(fix.projectRoot, "out", ...p);

/** Load through the real gate and assert success — returns the resolved scene. */
async function loadResolved(raw: unknown) {
  const result = await loadScene(fix.projectRoot, async () => fix.lib, raw);
  if (!result.ok) throw new Error(`fixture scene failed to load: ${JSON.stringify(result.errors)}`);
  return result.resolved;
}

// --- the manifest shape (unit — no browser) -----------------------------------

describe("manifest shape — build and strict read", () => {
  it("records scene identity, variant, tool version, outputs, and asset identities", async () => {
    const manifestDir = path.join(fix.projectRoot, "out");
    const manifest = buildManifest({
      manifestDir,
      sceneFile: fix.sceneFile,
      sceneSha256: contentHash(fix.sceneBytes),
      variant: ["blue"],
      outputs: [
        {
          output: path.join(manifestDir, "show.blue.png"),
          width: 1280,
          height: 720,
          warnings: ["auto-fit could not fit layer"],
          png: Buffer.from("png-bytes"),
          resolved: await loadResolved({
              schemaVersion: 1,
              canvas: { width: 1280, height: 720 },
              layers: [
                {
                  id: "bg",
                  type: "image",
                  asset: "demo-plate",
                  position: { x: 0, y: 0 },
                  size: { width: 1280, height: 720 },
                },
              ],
            }),
        },
      ],
    });
    expect(manifest.manifestVersion).toBe(MANIFEST_VERSION);
    expect(manifest.tool.name).toBe("thumby");
    expect(manifest.tool.version).toBe(
      (JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version,
    );
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.scene.path).toBe("../show.json");
    expect(manifest.scene.sha256).toBe(contentHash(fix.sceneBytes));
    expect(manifest.variant).toEqual(["blue"]);
    expect(manifest.outputs[0]!.output).toBe("show.blue.png");
    expect(manifest.outputs[0]!.sha256).toBe(contentHash(Buffer.from("png-bytes")));
    expect(manifest.outputs[0]!.warnings).toEqual(["auto-fit could not fit layer"]);
    // Library asset identity: exact bytes, no provenance.
    const entry = manifest.outputs[0]!.assets.find((a) => a.layer === "bg")!;
    expect(entry.scope).toBe("library");
    expect(entry.id).toBe("demo-plate");
    expect(entry.kind).toBe("plate");
    expect(entry.hash).toBe(contentHash(Buffer.from(RED_SVG, "utf8")));
    expect(entry.mediaType).toBe("image/svg+xml");
  });

  it("never duplicates canonical Asset provenance into the manifest", async () => {
    const manifest = buildManifest({
      manifestDir: path.join(fix.projectRoot, "out"),
      sceneFile: fix.sceneFile,
      sceneSha256: contentHash(fix.sceneBytes),
      variant: [],
      outputs: [
        {
          output: path.join(fix.projectRoot, "out", "show.png"),
          width: 1280,
          height: 720,
          warnings: [],
          png: Buffer.alloc(8),
          resolved: await loadResolved({
              schemaVersion: 1,
              canvas: { width: 1280, height: 720 },
              layers: [
                {
                  id: "bg",
                  type: "image",
                  asset: "demo-plate",
                  position: { x: 0, y: 0 },
                  size: { width: 1280, height: 720 },
                },
              ],
            }),
        },
      ],
    });
    const entry = manifest.outputs[0]!.assets[0]!;
    // Identity fields only — provenance (subject, prompt, model, adoption) has
    // one canonical home on the Asset, never copied into the manifest.
    expect(Object.keys(entry).sort()).toEqual(["hash", "id", "kind", "layer", "mediaType", "scope"]);
    const text = JSON.stringify(manifest);
    for (const secret of ["TOP-SECRET-PROMPT", "image-model-1", "run-123", "Kenneth", "secret-tag"])
      expect(text).not.toContain(secret);
  });

  it("readManifest rejects malformed manifests with field-specific errors", async () => {
    const bad = await readManifest("/tmp/does-not-matter.json", Buffer.from(JSON.stringify({
      manifestVersion: 1,
      tool: { name: "thumby", version: "0.13.0" },
      schemaVersion: 1,
      scene: { path: "../show.json", sha256: "nothex" },
      variant: [],
      outputs: [{ output: "/abs/path.png", width: 0, sha256: "abc", warnings: "nope", assets: [] }],
      surprise: true,
    })));
    expect(bad.ok).toBe(false);
    const paths = (bad as { ok: false; errors: { path: string }[] }).errors.map((e) => e.path);
    expect(paths).toContain("scene.sha256");
    expect(paths).toContain("outputs[0].output");
    expect(paths).toContain("outputs[0].width");
    expect(paths).toContain("outputs[0].sha256");
    expect(paths).toContain("outputs[0].warnings");
    expect(paths).toContain("surprise");
  });

  it("readManifest rejects an unsupported manifest version", async () => {
    const bad = await readManifest("/tmp/x.json", Buffer.from(JSON.stringify({
      manifestVersion: 99,
      tool: { name: "thumby", version: "0.13.0" },
      schemaVersion: 1,
      scene: { path: "../s.json", sha256: "a".repeat(64) },
      variant: [],
      outputs: [],
    })));
    expect(bad.ok).toBe(false);
    const [err] = (bad as { ok: false; errors: { path: string; message: string }[] }).errors;
    expect(err!.path).toBe("manifestVersion");
    expect(err!.message).toMatch(/manifestVersion 99/);
  });

  it("readManifest round-trips what buildManifest wrote", async () => {
    const manifest = buildManifest({
      manifestDir: fix.projectRoot,
      sceneFile: fix.sceneFile,
      sceneSha256: contentHash(fix.sceneBytes),
      variant: [],
      outputs: [
        {
          output: path.join(fix.projectRoot, "out", "show.png"),
          width: 1280,
          height: 720,
          warnings: [],
          png: Buffer.alloc(8),
          resolved: await loadResolved({
              schemaVersion: 1,
              canvas: { width: 1280, height: 720 },
              layers: [],
            }),
        },
      ],
    });
    const read = await readManifest("/tmp/x.manifest.json", Buffer.from(JSON.stringify(manifest)));
    expect(read.ok).toBe(true);
    expect((read as { ok: true; manifest: unknown }).manifest).toEqual(manifest);
  });
});

// --- render writes manifests (CLI, browser-backed) ------------------------------

describe("scene render — every render writes its manifest", () => {
  it("the base render writes <scene>.manifest.json beside the PNG", async () => {
    const { exitCode, output } = await cliRun(["render", fix.sceneFile]);
    expect(exitCode).toBe(0);
    const manifestFile = outPath("show.manifest.json");
    expect(existsSync(manifestFile)).toBe(true);
    expect((output as { manifest: string }).manifest).toBe(manifestFile);
    const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
    expect(manifest.manifestVersion).toBe(1);
    expect(manifest.scene.path).toBe("../show.json");
    expect(manifest.scene.sha256).toBe(contentHash(fix.sceneBytes));
    expect(manifest.variant).toEqual([]);
    expect(manifest.outputs).toHaveLength(1);
    const o = manifest.outputs[0];
    expect(o.output).toBe("show.png");
    expect(o.width).toBe(1280);
    expect(o.height).toBe(720);
    expect(o.sha256).toBe(contentHash(await readFile(outPath("show.png"))));
    // The auto-fit floor layer could not fit — the warning is recorded, not silent.
    expect(o.warnings.length).toBeGreaterThan(0);
    expect(o.warnings[0]).toMatch(/auto-fit could not fit layer "title"/);
    expect(o.assets).toEqual([
      {
        layer: "bg",
        scope: "project",
        path: "red.svg",
        hash: contentHash(Buffer.from(RED_SVG, "utf8")),
        mediaType: "image/svg+xml",
      },
    ]);
    // Portable: nothing in the manifest names the machine's directories, and
    // recorded paths are `/`-separated relative paths.
    expect(JSON.stringify(manifest)).not.toContain(fix.root);
    for (const p of [manifest.scene.path, ...manifest.outputs.map((o: { output: string }) => o.output)])
      expect(p).not.toMatch(/[\\:]|^\/|^[A-Za-z]:/);
  });

  it("a single-variant render writes <scene>.<variant>.manifest.json", async () => {
    const { exitCode } = await cliRun(["render", fix.sceneFile, "--variant", "blue"]);
    expect(exitCode).toBe(0);
    const manifest = JSON.parse(await readFile(outPath("show.blue.manifest.json"), "utf8"));
    expect(manifest.variant).toEqual(["blue"]);
    expect(manifest.outputs[0]!.output).toBe("show.blue.png");
    expect(manifest.outputs[0]!.assets[0]!.hash).toBe(contentHash(Buffer.from(BLUE_SVG, "utf8")));
  });

  it("a batch render writes one manifest covering every output and the contact sheet", async () => {
    const { exitCode, output } = await cliRun(["render", fix.sceneFile, "--variant", "blue,shifted"]);
    expect(exitCode).toBe(0);
    const manifestFile = outPath("show.variants.manifest.json");
    expect(existsSync(manifestFile)).toBe(true);
    const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
    expect(manifest.variant).toEqual(["blue", "shifted"]);
    expect(manifest.outputs.map((o: { output: string }) => o.output)).toEqual([
      "show.blue.png",
      "show.shifted.png",
    ]);
    expect(manifest.contact.output).toBe("show.contact.png");
    expect(manifest.contact.sha256).toBe(contentHash(await readFile(outPath("show.contact.png"))));
    expect((output as { manifest: string }).manifest).toBe(manifestFile);
  });
});

// --- manifest-backed rerender ----------------------------------------------------

describe("scene rerender — manifest-backed, portable, fail-loud", () => {
  /** A fresh project copy the test may relocate or damage. */
  async function copiedProject(tag: string): Promise<string> {
    const dest = path.join(fix.root, tag);
    await cp(fix.projectRoot, dest, { recursive: true });
    return dest;
  }

  async function movedProject(): Promise<{ manifestFile: string; outDir: string }> {
    const moved = path.join(fix.root, `relocated-${Date.now()}`);
    await cp(fix.projectRoot, moved, { recursive: true });
    return { manifestFile: path.join(moved, "out", "show.manifest.json"), outDir: path.join(moved, "out") };
  }

  it("rerenders the recorded outputs to their recorded paths", async () => {
    const { manifestFile, outDir } = await movedProject();
    await rm(path.join(outDir, "show.png"));
    const { exitCode, output } = await rerenderManifest(manifestFile);
    expect(exitCode).toBe(0);
    const out = output as { outputs: { output: string; width: number }[]; variant: string[] };
    expect(out.variant).toEqual([]);
    expect(out.outputs).toHaveLength(1);
    expect(out.outputs[0]!.width).toBe(1280);
    expect(existsSync(path.join(outDir, "show.png"))).toBe(true);
  }, 20000);

  it("moving the project directory does not invalidate the rerender", async () => {
    const { manifestFile, outDir } = await movedProject();
    // The manifest still names ../show.json — relocation moved it too.
    const { exitCode } = await rerenderManifest(manifestFile);
    expect(exitCode).toBe(0);
    expect(existsSync(path.join(outDir, "show.png"))).toBe(true);
  }, 20000);

  it("rerenders with every network route aborted", async () => {
    const { manifestFile } = await movedProject();
    const { chromium } = await import("playwright");
    const browser = await chromium.launch();
    try {
      const ctx = await browser.newContext();
      await ctx.route("**/*", (route) => route.abort());
      const page = await ctx.newPage();
      const { exitCode } = await rerenderManifest(manifestFile, { page });
      expect(exitCode).toBe(0);
    } finally {
      await browser.close();
    }
  }, 20000);

  it("a missing asset input fails instead of silently rerendering", async () => {
    const dest = await copiedProject("missing-asset");
    await rm(path.join(dest, "red.svg"));
    const { exitCode, output } = await rerenderManifest(path.join(dest, "out", "show.manifest.json"));
    expect(exitCode).toBe(1);
    const errors = (output as { errors: { path: string; message: string }[] }).errors;
    expect(errors[0]!.path).toBe("layers[0].asset");
    expect(errors[0]!.message).toMatch(/missing project asset/);
  }, 20000);

  it("a drifted unpinned asset fails identity verification instead of resolving newer content", async () => {
    const dest = await copiedProject("drifted-asset");
    await writeFile(path.join(dest, "red.svg"), GREEN_SVG);
    const { exitCode, output } = await rerenderManifest(path.join(dest, "out", "show.manifest.json"));
    expect(exitCode).toBe(1);
    const errors = (output as { errors: { path: string; message: string }[] }).errors;
    expect(errors[0]!.path).toBe("outputs[0].assets[0].hash");
    expect(errors[0]!.message).toMatch(/identity mismatch/);
    expect(errors[0]!.message).toMatch(/re-render/i);
  }, 20000);

  it("an edited scene file fails the manifest's scene identity check", async () => {
    const dest = await copiedProject("edited-scene");
    const scene = JSON.parse(await readFile(path.join(dest, "show.json"), "utf8"));
    (scene.layers[0] as { position: { x: number } }).position.x = 5;
    await writeFile(path.join(dest, "show.json"), JSON.stringify(scene, null, 2));
    const { exitCode, output } = await rerenderManifest(path.join(dest, "out", "show.manifest.json"));
    expect(exitCode).toBe(1);
    const errors = (output as { errors: { path: string; message: string }[] }).errors;
    expect(errors[0]!.path).toBe("scene.sha256");
    expect(errors[0]!.message).toMatch(/changed since/i);
  }, 20000);

  it("a deleted scene file fails with the manifest field path", async () => {
    const dest = await copiedProject("deleted-scene");
    await rm(path.join(dest, "show.json"));
    const { exitCode, output } = await rerenderManifest(path.join(dest, "out", "show.manifest.json"));
    expect(exitCode).toBe(1);
    const errors = (output as { errors: { path: string; message: string }[] }).errors;
    expect(errors[0]!.path).toBe("scene.path");
  }, 20000);

  it("a recorded output escaping the scene directory fails containment and writes nothing", async () => {
    const dest = await copiedProject("escape-output");
    const manifestFile = path.join(dest, "out", "show.manifest.json");
    const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
    manifest.outputs[0]!.output = "../../outside.png";
    await writeFile(manifestFile, JSON.stringify(manifest));
    const escapeTarget = path.resolve(dest, "out", "../../outside.png");
    const { exitCode, output } = await rerenderManifest(manifestFile);
    expect(exitCode).toBe(1);
    const errors = (output as { errors: { path: string; message: string }[] }).errors;
    expect(errors[0]!.path).toBe("outputs[0].output");
    expect(errors[0]!.message).toMatch(/escapes the scene's directory/);
    expect(existsSync(escapeTarget)).toBe(false);
  }, 20000);

  it("a corrupt manifest fails with field-specific errors, exit 1", async () => {
    const dest = await copiedProject("corrupt-manifest");
    const manifestFile = path.join(dest, "out", "show.manifest.json");
    const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
    manifest.outputs[0]!.sha256 = "zzz";
    await writeFile(manifestFile, JSON.stringify(manifest));
    const { exitCode, output } = await rerenderManifest(manifestFile);
    expect(exitCode).toBe(1);
    const errors = (output as { errors: { path: string }[] }).errors;
    expect(errors[0]!.path).toBe("outputs[0].sha256");
  }, 20000);

  it("rerenders a batch manifest including the contact sheet", async () => {
    await cliRun(["render", fix.sceneFile, "--variant", "blue,shifted"]);
    const moved = path.join(fix.root, `relocated-batch-${Date.now()}`);
    await cp(fix.projectRoot, moved, { recursive: true });
    const { exitCode, output } = await rerenderManifest(
      path.join(moved, "out", "show.variants.manifest.json"),
    );
    expect(exitCode).toBe(0);
    const out = output as { outputs: unknown[]; contact: { output: string }; variant: string[] };
    expect(out.variant).toEqual(["blue", "shifted"]);
    expect(out.outputs).toHaveLength(2);
    expect(existsSync(path.join(moved, "out", "show.contact.png"))).toBe(true);
  }, 30000);

  it("rename() relocation survives — the manifest carries no absolute state", async () => {
    const dest = path.join(fix.root, "renamed-away");
    await cp(fix.projectRoot, dest, { recursive: true });
    // Simulate a true mv: render in place, rename the whole directory.
    await rename(dest, path.join(fix.root, "renamed-back"));
    const { exitCode } = await rerenderManifest(
      path.join(fix.root, "renamed-back", "out", "show.manifest.json"),
    );
    expect(exitCode).toBe(0);
  }, 20000);
});
