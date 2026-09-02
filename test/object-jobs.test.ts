import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  runObjectJob,
  rerunObjectJob,
  loadJob,
  listJobs,
  adoptCandidate,
  validateObjectSubject,
  type ObjectGenerator,
  type ObjectJobRequest,
} from "../src/jobs.js";
import { composeMatte, type MatteEngine } from "../src/matte.js";
import { scanLibrary, writePlateAsset } from "../src/assets.js";
import { loadScene } from "../src/scene.js";
import { buildManifest, readManifest } from "../src/manifest.js";
import { encodePng } from "./png.js";

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

let root: string;
let jobRoot: string;
let libraryRoot: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "thumby-object-jobs-"));
  jobRoot = path.join(root, "jobs");
  libraryRoot = path.join(root, "library");
  await mkdir(libraryRoot, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** True-alpha PNG: a 4×4 opaque red subject in a 16×16 transparent frame. */
const ALPHA_PNG = encodePng(16, 16, (x, y) =>
  x < 4 && y < 4 ? [255, 0, 0, 255] : [0, 0, 0, 0],
);

/** The measured reality: an opaque candidate whose backdrop is painted pixels. */
const OPAQUE_PNG = encodePng(
  16,
  16,
  (x, y) => (x < 8 && y < 8 ? [230, 120, 80, 255] : [20, 90, 200, 255]),
  { colorType: 2 },
);

/** The segmentation mask the matting engine predicts for it. */
const MASK_PNG = encodePng(
  16,
  16,
  (x, y) => (x < 8 && y < 8 ? [255, 255, 255, 255] : [0, 0, 0, 255]),
  { colorType: 2 },
);

let genCounter = 0;
const fakeGen: ObjectGenerator = async (req) => ({
  candidates: Array.from({ length: req.count }, () => ({
    // Distinct bytes per candidate; the suffix after IEND is ignored by the
    // PNG parser but gives every candidate its own content identity.
    bytes: Buffer.concat([ALPHA_PNG, Buffer.from(`-${genCounter++}`)]),
    mediaType: "image/png",
  })),
  warnings: [],
  fullPrompt: `OBJECT<${req.subject}>`,
});

const opaqueGen: ObjectGenerator = async (req) => ({
  candidates: [
    { bytes: Buffer.concat([OPAQUE_PNG, Buffer.from(`-${genCounter++}`)]), mediaType: "image/png" },
  ],
  warnings: [],
  fullPrompt: `OBJECT<${req.subject}>`,
});

/** The matting seam under test: a predicted mask applied by the real composer. */
const fakeMatte: MatteEngine = async ({ bytes, label }) => ({
  bytes: composeMatte(bytes, MASK_PNG, label),
  engine: "test/segmentation",
});

const baseRequest = (): ObjectJobRequest => ({
  kind: "object",
  subject: "a retro desk lamp",
  model: "gpt-image",
  count: 2,
  refs: [],
});

describe("validateObjectSubject", () => {
  test("accepts ordinary isolated objects", () => {
    expect(() => validateObjectSubject("a retro desk lamp")).not.toThrow();
    expect(() => validateObjectSubject("a floating terminal window")).not.toThrow();
    expect(() => validateObjectSubject("a potted monstera")).not.toThrow();
  });

  test("rejects official logos as targets", () => {
    expect(() => validateObjectSubject("the OpenAI logo")).toThrow(/logo/i);
    expect(() => validateObjectSubject("Anthropic wordmark")).toThrow(/logo|text/i);
  });

  test("rejects final text as a target", () => {
    expect(() => validateObjectSubject("a headline that says SALE")).toThrow(/text|logo|render/i);
    expect(() => validateObjectSubject("the word FREE in bold letters")).toThrow(/text|logo|render/i);
  });
});

describe("runObjectJob", () => {
  test("creates an object job record with the same run contract as plates", async () => {
    const job = await runObjectJob(jobRoot, "obj-lamp", baseRequest(), fakeGen, fakeMatte);

    expect(job.kind).toBe("object");
    expect(job.request).toEqual(baseRequest());
    expect(job.runs).toHaveLength(1);
    const run = job.runs[0]!;
    expect(run.fullPrompt).toBe("OBJECT<a retro desk lamp>");
    expect(run.model).toBe("openai/gpt-image-2");
    expect(run.candidates).toHaveLength(2);
    for (const cand of run.candidates) {
      const stored = await readFile(path.join(jobRoot, "obj-lamp", cand.file));
      expect(sha256(stored)).toBe(cand.contentHash);
    }
    expect(await loadJob(jobRoot, "obj-lamp")).toEqual(job);
  });

  test("refuses a logo or text subject before any generation call", async () => {
    let calls = 0;
    const spy: ObjectGenerator = async (req) => {
      calls++;
      return fakeGen(req);
    };
    await expect(
      runObjectJob(jobRoot, "obj-logo", { ...baseRequest(), subject: "the OpenAI logo" }, spy, fakeMatte),
    ).rejects.toThrow(/logo|text/i);
    expect(calls).toBe(0);
  });

  test("refuses to create over an existing job id", async () => {
    await runObjectJob(jobRoot, "obj-dup", baseRequest(), fakeGen, fakeMatte);
    await expect(
      runObjectJob(jobRoot, "obj-dup", baseRequest(), fakeGen, fakeMatte),
    ).rejects.toThrow(/rerun|already exists/i);
  });

  test("mattes every opaque object candidate — the model's opaque output becomes adoptable", async () => {
    const job = await runObjectJob(jobRoot, "obj-matted", baseRequest(), opaqueGen, fakeMatte);
    expect(job.runs).toHaveLength(1);
    for (const cand of job.runs[0]!.candidates) {
      expect(cand.matte).toBeDefined();
      expect(cand.matte!.engine).toBe("test/segmentation");
      expect(cand.matte!.file.startsWith("mattes/")).toBe(true);
      // The recorded matte is on disk under its own content identity.
      const bytes = await readFile(path.join(jobRoot, "obj-matted", cand.matte!.file));
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(cand.matte!.contentHash);
      // The matte differs from the raw candidate — isolation changed the bytes.
      expect(cand.contentHash).not.toBe(cand.matte!.contentHash);
    }
  });

  test("keeps a native-alpha object candidate as-is — no inference", async () => {
    let engineCalls = 0;
    const spyMatte: MatteEngine = async (input) => {
      engineCalls++;
      return fakeMatte(input);
    };
    const job = await runObjectJob(jobRoot, "obj-native", baseRequest(), fakeGen, spyMatte);
    const cand = job.runs[0]!.candidates[0]!;
    expect(engineCalls).toBe(0);
    expect(cand.matte!.engine).toBe("native-alpha");
    expect(cand.matte!.contentHash).toBe(cand.contentHash);
  });

  test("a failed object matte is recorded as a warning, not a discard", async () => {
    const brokenMatte: MatteEngine = async () => {
      throw new Error("segmenter unavailable");
    };
    const job = await runObjectJob(jobRoot, "obj-nomatte", { ...baseRequest(), count: 1 }, opaqueGen, brokenMatte);
    const cand = job.runs[0]!.candidates[0]!;
    expect(cand.matte).toBeUndefined();
    expect(job.runs[0]!.warnings.join("\n")).toMatch(/matte:.*could not be isolated/i);
  });

  test("rerun mattes its fresh candidates under the same contract", async () => {
    await runObjectJob(jobRoot, "obj-rerun-matte", { ...baseRequest(), count: 1 }, opaqueGen, fakeMatte);
    const second = await rerunObjectJob(jobRoot, "obj-rerun-matte", opaqueGen, fakeMatte);
    expect(second.runs).toHaveLength(2);
    for (const cand of second.runs[1]!.candidates) {
      expect(cand.matte).toBeDefined();
      expect(cand.matte!.engine).toBe("test/segmentation");
    }
  });

  test("preflights the matting engine before any paid generation", async () => {
    const notReady: MatteEngine = Object.assign(
      (input: { bytes: Uint8Array; label: string }) => fakeMatte(input),
      { preflight: async () => { throw new Error("weights missing — fetch them first"); } },
    );
    let calls = 0;
    const spy: ObjectGenerator = async (req) => {
      calls++;
      return opaqueGen(req);
    };
    await expect(
      runObjectJob(jobRoot, "obj-preflight", baseRequest(), spy, notReady),
    ).rejects.toThrow(/weights missing/);
    expect(calls).toBe(0);
  });
});

describe("rerunObjectJob", () => {
  test("appends a run under the lineage without touching prior candidates", async () => {
    const first = await runObjectJob(jobRoot, "obj-lineage", baseRequest(), fakeGen, fakeMatte);
    const second = await rerunObjectJob(jobRoot, "obj-lineage", fakeGen, fakeMatte);
    expect(second.runs).toHaveLength(2);
    expect(second.runs[0]).toEqual(first.runs[0]);
    const hashes = second.runs.flatMap((r) => r.candidates.map((c) => c.contentHash));
    expect(new Set(hashes).size).toBe(4);
  });
});

describe("adoptCandidate for object jobs", () => {
  test("adopts a true-alpha candidate as an Object Asset with provenance", async () => {
    const job = await runObjectJob(jobRoot, "obj-adopt", baseRequest(), fakeGen, fakeMatte);
    const cand = job.runs[0]!.candidates[0]!;

    const result = await adoptCandidate(jobRoot, "obj-adopt", cand.contentHash, "lamp", {
      libraryRoot,
      name: "Desk Lamp",
      tags: ["retro"],
    });

    expect(result.adoptedFrom).toBe(`job:obj-adopt#${cand.contentHash}`);
    const lib = await scanLibrary(libraryRoot);
    const asset = lib.objects.find((o) => o.meta.id === "lamp")!;
    expect(asset).toBeDefined();
    expect(asset.hash).toBe(cand.contentHash);
    expect(asset.meta.kind).toBe("object");
    if (asset.meta.kind === "object") {
      expect(asset.meta.matting).toBe("true-alpha");
      expect(asset.meta.subject).toBe("a retro desk lamp");
      expect(asset.meta.model).toBe("openai/gpt-image-2");
    }
    expect(result.imagePath).toBe(asset.imagePath);
  });

  test("adopts a matted candidate's matte — verified true alpha enters the library", async () => {
    const job = await runObjectJob(jobRoot, "obj-adopt-matte", { ...baseRequest(), count: 1 }, opaqueGen, fakeMatte);
    const cand = job.runs[0]!.candidates[0]!;

    const result = await adoptCandidate(jobRoot, "obj-adopt-matte", cand.contentHash, "tile", {
      libraryRoot,
      name: "Hook Tile",
      tags: ["hook-scene"],
    });

    // The asset's identity is the matte's — the isolated form is what ships.
    expect(result.contentHash).toBe(cand.matte!.contentHash);
    expect(result.adoptedFrom).toBe(`job:obj-adopt-matte#${cand.contentHash}`);
    const lib = await scanLibrary(libraryRoot);
    const asset = lib.objects.find((o) => o.meta.id === "tile")!;
    expect(asset.hash).toBe(cand.matte!.contentHash);
    expect(asset.meta.kind).toBe("object");
    if (asset.meta.kind === "object") {
      expect(asset.meta.matting).toBe("true-alpha");
      expect(asset.meta.matteEngine).toBe("test/segmentation");
      expect(asset.meta.subject).toBe("a retro desk lamp");
      expect(asset.meta.model).toBe("openai/gpt-image-2");
    }
    expect(result.imagePath).toBe(asset.imagePath);
  });

  test("refuses an opaque candidate with no matte — chroma-key color distance cannot qualify", async () => {
    const brokenMatte: MatteEngine = async () => {
      throw new Error("segmenter unavailable");
    };
    await runObjectJob(jobRoot, "obj-opaque", { ...baseRequest(), count: 1 }, opaqueGen, brokenMatte);
    const job = await loadJob(jobRoot, "obj-opaque");
    const hash = job.runs[0]!.candidates[0]!.contentHash;

    await expect(
      adoptCandidate(jobRoot, "obj-opaque", hash, "opaque-lamp", { libraryRoot }),
    ).rejects.toThrow(/matte|chroma-key|alpha/i);
    // Nothing entered the library.
    const lib = await scanLibrary(libraryRoot);
    expect(lib.objects).toHaveLength(0);
  });

  test("refuses a non-PNG candidate outright", async () => {
    const jpegGen: ObjectGenerator = async () => ({
      candidates: [{ bytes: Buffer.from("jpeg bytes"), mediaType: "image/jpeg" }],
      warnings: [],
      fullPrompt: "p",
    });
    await runObjectJob(jobRoot, "obj-jpeg", { ...baseRequest(), count: 1 }, jpegGen, fakeMatte);
    const job = await loadJob(jobRoot, "obj-jpeg");
    const hash = job.runs[0]!.candidates[0]!.contentHash;
    await expect(
      adoptCandidate(jobRoot, "obj-jpeg", hash, "jpeg-lamp", { libraryRoot }),
    ).rejects.toThrow(/PNG|alpha|matte/i);
  });

  test("never overwrites an existing asset", async () => {
    await runObjectJob(jobRoot, "obj-overwrite", baseRequest(), fakeGen, fakeMatte);
    const job = await loadJob(jobRoot, "obj-overwrite");
    const [a, b] = job.runs[0]!.candidates;
    await adoptCandidate(jobRoot, "obj-overwrite", a!.contentHash, "taken", { libraryRoot });
    await expect(
      adoptCandidate(jobRoot, "obj-overwrite", b!.contentHash, "taken", { libraryRoot }),
    ).rejects.toThrow(/already exists/i);
  });
});

describe("loadJob record integrity", () => {
  test("refuses a record whose kind contradicts its request kind — one discriminant or none", async () => {
    await runObjectJob(jobRoot, "obj-contradiction", baseRequest(), fakeGen, fakeMatte);
    const file = path.join(jobRoot, "obj-contradiction", "job.json");
    const tampered = JSON.parse(await readFile(file, "utf8"));
    tampered.kind = "plate"; // claims the plate contract while carrying an object request
    await writeFile(file, JSON.stringify(tampered, null, 2));
    // Both dispatch paths go through loadJob — neither can run the contradiction.
    await expect(loadJob(jobRoot, "obj-contradiction")).rejects.toThrow(/contradictory/i);
    await expect(adoptCandidate(jobRoot, "obj-contradiction", "0", "steal", { libraryRoot })).rejects.toThrow(
      /contradictory/i,
    );
  });

  test("writes object jobs as schemaVersion 4 under the role-aware prompt contract", async () => {
    await runObjectJob(jobRoot, "obj-v4", baseRequest(), fakeGen, fakeMatte);
    const objRecord = JSON.parse(await readFile(path.join(jobRoot, "obj-v4", "job.json"), "utf8"));
    expect(objRecord.schemaVersion).toBe(4);
  });

  test("a legacy v2 object record reruns into the role-aware contract — re-persisted as v4 with the new lineage", async () => {
    await runObjectJob(jobRoot, "obj-legacy-v2", baseRequest(), fakeGen, fakeMatte);
    const file = path.join(jobRoot, "obj-legacy-v2", "job.json");
    const rec = JSON.parse(await readFile(file, "utf8"));
    rec.schemaVersion = 2; // what a pre-role-aware binary wrote
    await writeFile(file, JSON.stringify(rec, null, 2) + "\n");

    // Pure legacy read: the record loads as v2 before any new lineage.
    expect((await loadJob(jobRoot, "obj-legacy-v2")).schemaVersion).toBe(2);

    const rerun = await rerunObjectJob(jobRoot, "obj-legacy-v2", fakeGen, fakeMatte);
    expect(rerun.runs).toHaveLength(2);
    // Role-aware lineage re-persists the record as v4 with the lineage.
    const record = JSON.parse(await readFile(file, "utf8"));
    expect(record.schemaVersion).toBe(4);

    // The upgraded record loads and adoption takes the matted-candidate path.
    await loadJob(jobRoot, "obj-legacy-v2");
    const hash = record.runs[0]!.candidates[0]!.contentHash;
    const out = await adoptCandidate(jobRoot, "obj-legacy-v2", hash, "legacy-object", { libraryRoot });
    expect(out.adoptedFrom).toBe(`job:obj-legacy-v2#${hash}`);
  });

  test("a failed rerun leaves a legacy v2 object record untouched — still rollback-readable as v2", async () => {
    await runObjectJob(jobRoot, "obj-legacy-fail", baseRequest(), fakeGen, fakeMatte);
    const file = path.join(jobRoot, "obj-legacy-fail", "job.json");
    const rec = JSON.parse(await readFile(file, "utf8"));
    rec.schemaVersion = 2;
    await writeFile(file, JSON.stringify(rec, null, 2) + "\n");
    const failingGen: ObjectGenerator = async () => {
      throw new Error("provider down");
    };
    await expect(rerunObjectJob(jobRoot, "obj-legacy-fail", failingGen, fakeMatte)).rejects.toThrow(/provider down/);
    const record = JSON.parse(await readFile(file, "utf8"));
    expect(record.schemaVersion).toBe(2);
    expect(record.runs).toHaveLength(1);
  });

  test("refuses a v3 record claiming kind object — an older binary would misread it", async () => {
    await runObjectJob(jobRoot, "obj-forged-v3", baseRequest(), fakeGen, fakeMatte);
    const file = path.join(jobRoot, "obj-forged-v3", "job.json");
    const rec = JSON.parse(await readFile(file, "utf8"));
    rec.schemaVersion = 3; // the creator version — an older binary would accept (3, object)
    await writeFile(file, JSON.stringify(rec, null, 2) + "\n");
    await expect(loadJob(jobRoot, "obj-forged-v3")).rejects.toThrow(/schemaVersion 3/);
  });

  test("rejects a v1 record claiming kind object — v1 is plate-only, the rollback boundary", async () => {
    await runObjectJob(jobRoot, "obj-forged-v1", baseRequest(), fakeGen, fakeMatte);
    const file = path.join(jobRoot, "obj-forged-v1", "job.json");
    const rec = JSON.parse(await readFile(file, "utf8"));
    rec.schemaVersion = 1; // what a 0.15.1-era plate-only record would carry
    await writeFile(file, JSON.stringify(rec, null, 2));
    await expect(loadJob(jobRoot, "obj-forged-v1")).rejects.toThrow(/schemaVersion 1.*plate-only/i);
    await expect(adoptCandidate(jobRoot, "obj-forged-v1", "0", "no-gate", { libraryRoot })).rejects.toThrow(
      /plate-only/i,
    );
  });

  test("adopts a candidate mislabeled image/jpeg as a PNG object — verified bytes are the truth", async () => {
    const mislabeled: ObjectGenerator = async () => ({
      candidates: [{ bytes: ALPHA_PNG, mediaType: "image/jpeg" }],
      warnings: [],
      fullPrompt: "p",
    });
    await runObjectJob(jobRoot, "obj-mislabeled", { ...baseRequest(), count: 1 }, mislabeled, fakeMatte);
    const job = await loadJob(jobRoot, "obj-mislabeled");
    const hash = job.runs[0]!.candidates[0]!.contentHash;
    const result = await adoptCandidate(jobRoot, "obj-mislabeled", hash, "lamp", { libraryRoot });
    // The alpha gate proved the bytes are PNG, so the asset is object.png —
    // not object.jpg — and downstream resolution reports image/png.
    expect(result.imagePath.endsWith(path.join("lamp", "object.png"))).toBe(true);
    const lib = await scanLibrary(libraryRoot);
    expect(lib.objects[0]!.imagePath).toBe(result.imagePath);
  });
});

describe("listJobs with object jobs", () => {
  test("summarizes both kinds from one jobs root", async () => {
    await runObjectJob(jobRoot, "obj-a", { ...baseRequest(), count: 1 }, fakeGen, fakeMatte);
    const jobs = await listJobs(jobRoot);
    const a = jobs.find((j) => j.jobId === "obj-a")!;
    expect(a.kind).toBe("object");
    expect(a.subject).toBe("a retro desk lamp");
    expect(a.candidates).toBe(1);
  });
});

describe("an adopted Object Asset in a Scene", () => {
  test("loads as an Image layer behind and in front of other layers, movable and hideable", async () => {
    await runObjectJob(jobRoot, "obj-scene", baseRequest(), fakeGen, fakeMatte);
    const job = await loadJob(jobRoot, "obj-scene");
    await adoptCandidate(jobRoot, "obj-scene", job.runs[0]!.candidates[0]!.contentHash, "lamp", {
      libraryRoot,
    });
    // A backdrop plate for the object to sit over.
    await writePlateAsset(libraryRoot, "plate-a", new TextEncoder().encode("PLATE"), {
      kind: "plate", id: "plate-a", name: "Plate A", tags: [],
    });

    // Array order is compositing order: the object layer sits behind the text
    // layer and in front of the plate — both placements resolve the same
    // library bytes, and moving/resizing/hiding are scene fields on the layer,
    // so none of it touches the plate or any other layer's bytes.
    const scene = {
      schemaVersion: 1,
      canvas: { width: 1280, height: 720 },
      layers: [
        { id: "plate", type: "image", asset: "library:plate-a",
          position: { x: 0, y: 0 }, size: { width: 1280, height: 720 } },
        { id: "lamp", type: "image", asset: "library:lamp",
          position: { x: 500, y: 300 }, size: { width: 280, height: 280 } },
        { id: "headline", type: "text", text: "NEW LAMP", font: "Anton", fontSize: 80,
          position: { x: 100, y: 100 }, size: { width: 600, height: 120 } },
      ],
    };
    const lib = await scanLibrary(libraryRoot);
    const loaded = await loadScene(libraryRoot, async () => lib, scene);
    if (!loaded.ok) throw new Error(`scene failed to load: ${JSON.stringify(loaded.errors)}`);
    const lamp = loaded.resolved.assets.get("lamp")!;
    expect(lamp.kind).toBe("object");
    expect(lamp.id).toBe("lamp");
    // The same asset bytes serve a second, independently transformed layer —
    // no regeneration of anything.
    const hidden = structuredClone(scene);
    (hidden.layers[1] as { visible?: boolean }).visible = false;
    (hidden.layers[1] as { position: { x: number } }).position.x = 900;
    const again = await loadScene(libraryRoot, async () => lib, hidden);
    expect(again.ok).toBe(true);
  });

  test("records the object kind in a Render manifest that verifies on read", async () => {
    await runObjectJob(jobRoot, "obj-manifest", baseRequest(), fakeGen, fakeMatte);
    const job = await loadJob(jobRoot, "obj-manifest");
    await adoptCandidate(jobRoot, "obj-manifest", job.runs[0]!.candidates[0]!.contentHash, "lamp", {
      libraryRoot,
    });
    await writePlateAsset(libraryRoot, "plate-a", new TextEncoder().encode("PLATE"), {
      kind: "plate", id: "plate-a", name: "Plate A", tags: [],
    });
    const scene = {
      schemaVersion: 1,
      canvas: { width: 1280, height: 720 },
      layers: [
        { id: "lamp", type: "image", asset: "library:lamp",
          position: { x: 500, y: 300 }, size: { width: 280, height: 280 } },
      ],
    };
    const lib = await scanLibrary(libraryRoot);
    const loaded = await loadScene(libraryRoot, async () => lib, scene);
    if (!loaded.ok) throw new Error("scene failed to load");

    const manifestDir = path.join(root, "out");
    await mkdir(manifestDir, { recursive: true });
    const png = encodePng(1280, 720, () => [10, 10, 10, 255]);
    const manifest = buildManifest({
      manifestDir,
      sceneFile: path.join(libraryRoot, "scene.json"),
      sceneSha256: "a".repeat(64),
      variant: [],
      outputs: [{
        output: path.join(manifestDir, "scene.png"),
        width: 1280, height: 720, png, warnings: [],
        resolved: loaded.resolved,
      }],
    });
    // The recorded identity survives the manifest's strict read validation —
    // an object render must rerender, not fail its own record.
    const readResult = await readManifest(
      path.join(manifestDir, "scene.manifest.json"),
      Buffer.from(JSON.stringify(manifest)),
    );
    if (!readResult.ok) throw new Error(`manifest failed its own read: ${JSON.stringify(readResult.errors)}`);
    const lamp = readResult.manifest.outputs[0]!.assets.find((a) => a.id === "lamp")!;
    expect(lamp.kind).toBe("object");
  });
});
