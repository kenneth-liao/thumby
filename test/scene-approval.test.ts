/**
 * Creator Asset approval enforcement (REQ-018, #17).
 *
 * A trial Creator Asset (a library Cutout with approval: "trial") can become
 * approved only through the explicit `approveCutout` operation, normal/final
 * rendering rejects a Scene referencing one with a layer-specific error, and
 * an explicit experimental override renders it while clearly marking the
 * output non-final.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { approveCutout, contentHash, scanLibrary, type Library } from "../src/assets.js";
import { loadScene, type LoadResult, type Scene, type SceneLayer } from "../src/scene.js";
import { renderScene } from "../src/scene-render.js";
import { run as cliRun } from "../src/scene-cli.js";
import { buildManifest, readManifest, writeManifest } from "../src/manifest.js";
import { encodePng } from "./png.js";

const CUTOUT_PNG = encodePng(8, 8, () => [200, 10, 10, 255]);

// --- fixtures --------------------------------------------------------------

interface Fix {
  root: string;
  projectRoot: string;
  libRoot: string;
  lib: Library;
}

let fix: Fix;

beforeAll(async () => {
  const root = await mkdtemp(path.join(tmpdir(), "thumby-approval-"));
  const libRoot = path.join(root, "library");
  const projectRoot = path.join(root, "project");
  await mkdir(projectRoot, { recursive: true });
  // A project-local plate — the gate never fires for project-scope assets.
  await writeFile(
    path.join(projectRoot, "bg.svg"),
    `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="#ffffff"/></svg>`,
  );
  const writeCutout = async (id: string, approval: "trial" | "approved") => {
    const dir = path.join(libRoot, "cutouts", id);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "cutout.png"), CUTOUT_PNG);
    await writeFile(
      path.join(dir, "meta.json"),
      JSON.stringify({
        kind: "cutout",
        id,
        name: id,
        tags: ["pointing"],
        approval,
        ...(approval === "approved" ? { source: "https://example.test/kit" } : {}),
      }),
    );
  };
  await writeCutout("creator-trial", "trial");
  await writeCutout("creator-trial-2", "trial");
  await writeCutout("creator-approved", "approved");
  fix = { root, projectRoot, libRoot, lib: await scanLibrary(libRoot) };
});

afterAll(async () => {
  await rm(fix.root, { recursive: true, force: true });
});

// --- helpers ----------------------------------------------------------------

const creatorLayer = (asset: string, over: Record<string, unknown> = {}): SceneLayer =>
  ({
    id: "creator",
    type: "image",
    asset,
    position: { x: 400, y: 200 },
    size: { width: 480, height: 480 },
    ...over,
  }) as SceneLayer;

const plateLayer = (): SceneLayer =>
  ({
    id: "plate",
    type: "image",
    asset: "./bg.svg",
    position: { x: 0, y: 0 },
    size: { width: 1280, height: 720 },
  }) as SceneLayer;

const scene = (layers: SceneLayer[]): Scene => ({
  schemaVersion: 1,
  canvas: { width: 1280, height: 720 },
  layers,
});

async function load(
  raw: unknown,
  opts?: { allowTrialCreator?: boolean },
): Promise<Extract<LoadResult, { ok: true }>> {
  const result = await loadScene(fix.projectRoot, async () => fix.lib, raw, opts);
  expect(result.ok).toBe(true);
  return result as Extract<LoadResult, { ok: true }>;
}

async function loadErrors(
  raw: unknown,
  opts?: { allowTrialCreator?: boolean },
): Promise<{ path: string; message: string }[]> {
  const result = await loadScene(fix.projectRoot, async () => fix.lib, raw, opts);
  expect(result.ok).toBe(false);
  return (result as { ok: false; errors: { path: string; message: string }[] }).errors;
}

// --- the render gate ---------------------------------------------------------

describe("trial Creator Asset render gate", () => {
  it("rejects a scene referencing a trial Creator Asset with a layer-specific error", async () => {
    const errors = await loadErrors(scene([plateLayer(), creatorLayer("creator-trial")]));
    expect(errors).toHaveLength(1);
    expect(errors[0]!.path).toBe("layers[1].asset");
    expect(errors[0]!.message).toMatch(/creator-trial/);
    expect(errors[0]!.message).toMatch(/trial/i);
  });

  it("rejects inside groups too, at the nested layer path", async () => {
    const errors = await loadErrors(
      scene([
        {
          id: "card",
          type: "group",
          position: { x: 0, y: 0 },
          size: { width: 100, height: 100 },
          layers: [creatorLayer("creator-trial")],
        } as unknown as SceneLayer,
      ]),
    );
    expect(errors[0]!.path).toBe("layers[0].layers[0].asset");
  });

  it("loads a scene referencing an approved Creator Asset", async () => {
    const { resolved } = await load(scene([creatorLayer("creator-approved")]));
    expect(resolved.assets.get("creator")!.id).toBe("creator-approved");
    expect(resolved.assets.get("creator")!.approval).toBe("approved");
  });

  it("surfaces the approval state on the resolution — one home, no re-scan", async () => {
    const { resolved } = await load(scene([plateLayer(), creatorLayer("creator-trial")]), {
      allowTrialCreator: true,
    });
    expect(resolved.assets.get("creator")!.approval).toBe("trial");
    expect(resolved.assets.get("plate")!.approval).toBeUndefined();
  });

  it("the experimental override permits trial rendering", async () => {
    const { resolved } = await load(scene([creatorLayer("creator-trial")]), {
      allowTrialCreator: true,
    });
    expect(resolved.assets.get("creator")!.id).toBe("creator-trial");
  });

  it("the gate never fires for non-cutout library assets", async () => {
    // A plate with no approval field renders normally — the gate keys on the
    // cutout kind's approval state, nothing else.
    await load(scene([plateLayer()]));
  });
});

// --- the approval operation ---------------------------------------------------

describe("approveCutout", () => {
  it("records the approver decision on the trial asset", async () => {
    const dir = path.join(fix.libRoot, "cutouts", "creator-trial");
    const before = await readFile(path.join(dir, "cutout.png"));
    const meta = await approveCutout(fix.libRoot, "creator-trial", {
      approvedBy: "Human Reviewer",
      approvedAt: "2026-02-14T10:00:00.000Z",
      approvalNote: "likeness verified against anchors",
    });
    expect(meta.approval).toBe("approved");
    expect(meta.approvedBy).toBe("Human Reviewer");
    expect(meta.approvedAt).toBe("2026-02-14T10:00:00.000Z");
    expect(meta.approvalNote).toBe("likeness verified against anchors");
    // Immutable identity: the bytes — and so the content hash — never change.
    const after = await readFile(path.join(dir, "cutout.png"));
    expect(contentHash(after)).toBe(contentHash(before));
    const reread = JSON.parse(await readFile(path.join(dir, "meta.json"), "utf8"));
    expect(reread.approval).toBe("approved");
    // The approved asset now passes the gate without any override — a fresh
    // scan, because the recorded decision lives on the meta the scan reads.
    fix.lib = await scanLibrary(fix.libRoot);
    await load(scene([creatorLayer("creator-trial")]));
  });

  it("refuses an unknown asset id", async () => {
    await expect(
      approveCutout(fix.libRoot, "nobody", {
        approvedBy: "Human Reviewer",
        approvedAt: "2026-02-14T10:00:00.000Z",
      }),
    ).rejects.toThrow(/nobody/);
  });

  it("refuses a non-cutout asset", async () => {
    const dir = path.join(fix.libRoot, "plates", "not-a-cutout");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "plate.png"), CUTOUT_PNG);
    await writeFile(
      path.join(dir, "meta.json"),
      JSON.stringify({ kind: "plate", id: "not-a-cutout", name: "x", tags: [] }),
    );
    fix.lib = await scanLibrary(fix.libRoot);
    await expect(
      approveCutout(fix.libRoot, "not-a-cutout", {
        approvedBy: "Human Reviewer",
        approvedAt: "2026-02-14T10:00:00.000Z",
      }),
    ).rejects.toThrow(/plate|not a Creator Asset|cutout/i);
  });

  it("refuses an already-approved asset instead of silently re-deciding", async () => {
    const dir = path.join(fix.libRoot, "cutouts", "creator-approved");
    const before = JSON.parse(await readFile(path.join(dir, "meta.json"), "utf8"));
    await expect(
      approveCutout(fix.libRoot, "creator-approved", {
        approvedBy: "Someone Else",
        approvedAt: "2026-02-15T10:00:00.000Z",
      }),
    ).rejects.toThrow(/already approved/);
    const after = JSON.parse(await readFile(path.join(dir, "meta.json"), "utf8"));
    expect(after).toEqual(before);
  });

  it("rejects a decision without an approver", async () => {
    await expect(
      approveCutout(fix.libRoot, "creator-trial-2", { approvedBy: "", approvedAt: "2026-02-14T10:00:00.000Z" }),
    ).rejects.toThrow(/approver/i);
  });

  it("approving one candidate leaves unrelated assets untouched", async () => {
    const other = path.join(fix.libRoot, "cutouts", "creator-trial-2", "meta.json");
    const before = await readFile(other, "utf8");
    const dir = path.join(fix.libRoot, "cutouts", "candidate-c");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "cutout.png"), CUTOUT_PNG);
    await writeFile(
      path.join(dir, "meta.json"),
      JSON.stringify({ kind: "cutout", id: "candidate-c", name: "x", tags: [], approval: "trial" }),
    );
    await approveCutout(fix.libRoot, "candidate-c", {
      approvedBy: "Human Reviewer",
      approvedAt: "2026-02-14T11:00:00.000Z",
    });
    // The sibling candidate is untouched — approval selects one identity.
    expect(await readFile(other, "utf8")).toBe(before);
  });
});

// --- swapping an approved pose/outfit -----------------------------------------

describe("swapping an approved pose/outfit", () => {
  it("changes only the Creator layer's asset reference and renders offline", async () => {
    const writeApproved = async (id: string) => {
      const dir = path.join(fix.libRoot, "cutouts", id);
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, "cutout.png"), CUTOUT_PNG);
      await writeFile(
        path.join(dir, "meta.json"),
        JSON.stringify({
          kind: "cutout",
          id,
          name: id,
          tags: [],
          approval: "approved",
          source: "https://example.test/kit",
        }),
      );
    };
    await writeApproved("pose-a");
    await writeApproved("pose-b");
    fix.lib = await scanLibrary(fix.libRoot);

    const before = scene([plateLayer(), creatorLayer("pose-a")]);
    const after = scene([plateLayer(), creatorLayer("pose-b")]);
    const a = await load(before);
    const b = await load(after);
    // One field differs; the plate layer and its resolution are untouched.
    expect(b.resolved.assets.get("creator")!.id).toBe("pose-b");
    expect(b.resolved.assets.get("plate")!.hash).toBe(a.resolved.assets.get("plate")!.hash);
    const renderedA = await renderScene(a.resolved);
    const renderedB = await renderScene(b.resolved);
    expect(renderedA.width).toBe(1280);
    expect(renderedB.width).toBe(1280);
  }, 20000);
});

// --- the CLI surface -----------------------------------------------------------

describe("scene cli approval enforcement", () => {
  const sceneFile = async (name: string, layers: SceneLayer[]): Promise<string> => {
    const file = path.join(fix.projectRoot, name);
    await writeFile(file, JSON.stringify(scene(layers)));
    return file;
  };

  /** CLI runs read the fixture library through the run() deps seam. */
  const cli = (args: string[]) => cliRun(args, { libraryRoot: fix.libRoot });

  it("validate rejects a trial Creator Asset reference", async () => {
    const file = await sceneFile("trial.json", [creatorLayer("creator-trial-2")]);
    const { exitCode, output } = await cli(["validate", file]);
    expect(exitCode).toBe(1);
    const errors = (output as { errors: { path: string; message: string }[] }).errors;
    expect(errors[0]!.path).toBe("layers[0].asset");
    expect(errors[0]!.message).toMatch(/creator-trial-2/);
  });

  it("validate accepts an approved Creator Asset reference", async () => {
    const file = await sceneFile("approved.json", [creatorLayer("creator-approved")]);
    const { exitCode, output } = await cli(["validate", file]);
    expect(exitCode).toBe(0);
    expect(output).toMatchObject({ ok: true });
  });

  it("render refuses a trial Creator Asset with the layer-specific error", async () => {
    const file = await sceneFile("render-trial.json", [creatorLayer("creator-trial-2")]);
    const { exitCode, output } = await cli(["render", file]);
    expect(exitCode).toBe(1);
    const errors = (output as { errors: { path: string; message: string }[] }).errors;
    expect(errors[0]!.path).toBe("layers[0].asset");
    expect(errors[0]!.message).toMatch(/creator-trial-2/);
  }, 20000);

  it("--experimental renders a trial Creator Asset, marked non-final", async () => {
    const file = await sceneFile("experimental.json", [creatorLayer("creator-trial-2")]);
    const { exitCode, output } = await cli(["render", file, "--experimental"]);
    expect(exitCode).toBe(0);
    const out = output as {
      ok: boolean;
      output: string;
      experimental?: boolean;
      warnings: string[];
    };
    // Clearly marked: the result names the override, the default output name
    // carries .trial, and a warning says the Render is not final.
    expect(out.experimental).toBe(true);
    expect(out.output).toMatch(/experimental\.trial\.png$/);
    expect(out.warnings.join("\n")).toMatch(/non-final/i);
    expect(out.warnings.join("\n")).toMatch(/creator-trial-2/);
    const bytes = await readFile(out.output);
    expect(bytes.readUInt32BE(16)).toBe(1280);
    // The manifest records the non-final render.
    const manifestFile = out.output.replace(/\.png$/, ".manifest.json");
    const read = await readManifest(manifestFile);
    expect(read.ok).toBe(true);
    expect((read as { manifest: { experimental?: boolean } }).manifest.experimental).toBe(true);
  }, 20000);

  it("--experimental on an all-approved scene writes no undefined warning and rerenders", async () => {
    // The override keys its non-final warning off actual trial usage — a
    // scene with only approved assets must not grow a null warnings entry,
    // which the strict manifest reader would reject at rerender.
    const file = await sceneFile("exp-approved.json", [creatorLayer("creator-approved")]);
    const { exitCode, output } = await cli(["render", file, "--experimental"]);
    expect(exitCode).toBe(0);
    const out = output as { output: string; manifest: string; warnings: string[] };
    expect(out.warnings.join("")).not.toMatch(/NON-FINAL/);
    const read = await readManifest(out.manifest);
    expect(read.ok).toBe(true);
    const { exitCode: code2 } = await cli(["rerender", out.manifest]);
    expect(code2).toBe(0);
  }, 40000);

  it("a plain render's manifest is not marked experimental", async () => {
    const file = await sceneFile("plain.json", [creatorLayer("creator-approved")]);
    const { exitCode, output } = await cli(["render", file]);
    expect(exitCode).toBe(0);
    const out = output as { output: string; experimental?: boolean };
    expect(out.experimental).toBeUndefined();
    const read = await readManifest(out.output.replace(/\.png$/, ".manifest.json"));
    expect(read.ok).toBe(true);
    expect((read as { manifest: { experimental?: boolean } }).manifest.experimental).toBeUndefined();
  }, 20000);

  it("rerender honors a recorded experimental manifest without the flag", async () => {
    const file = await sceneFile("rerender-trial.json", [creatorLayer("creator-trial-2")]);
    const { exitCode, output } = await cli(["render", file, "--experimental"]);
    expect(exitCode).toBe(0);
    const out = output as { output: string; manifest: string };
    const { exitCode: code2, output: out2 } = await cli(["rerender", out.manifest]);
    expect(code2).toBe(0);
    // The non-final marker survives the rerender: the result echoes
    // experimental and the rewritten output's warnings carry NON-FINAL.
    expect(out2).toMatchObject({ ok: true, experimental: true });
    const rerun = out2 as { outputs: { warnings: string[] }[] };
    expect(rerun.outputs[0]!.warnings.join(" ")).toMatch(/NON-FINAL/);
    const bytes = await readFile(out.output);
    expect(bytes.readUInt32BE(16)).toBe(1280);
  }, 40000);

  it("rerender rejects a scene whose trial reference has no recorded override", async () => {
    // Hand-build a manifest without experimental, whose scene references a
    // trial cutout — rerender must fail at the same gate, not publish it.
    const file = await sceneFile("forged.json", [creatorLayer("creator-trial-2")]);
    const forged = path.join(fix.projectRoot, "forged.manifest.json");
    await writeManifest(
      forged,
      buildManifest({
        manifestDir: fix.projectRoot,
        sceneFile: file,
        sceneSha256: contentHash(await readFile(file)),
        variant: [],
        outputs: [
          {
            output: path.join(fix.projectRoot, "forged.png"),
            width: 1280,
            height: 720,
            warnings: [],
            png: Buffer.from("not a render"),
            resolved: (await load(scene([creatorLayer("creator-trial-2")]), { allowTrialCreator: true }))
              .resolved,
          },
        ],
      }),
    );
    const { exitCode, output } = await cli(["rerender", forged]);
    expect(exitCode).toBe(1);
    const errors = (output as { errors: { path: string; message: string }[] }).errors;
    expect(errors[0]!.message).toMatch(/creator-trial-2/);
  }, 20000);
});
