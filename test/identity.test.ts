import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  LIBRARY_ROOT,
  scanLibrary,
  searchLibrary,
  contentHash,
  EMPTY_LIBRARY,
} from "../src/assets.js";
import { scanIdentityKit, parseFacets } from "../src/identity.js";

const INDEX = {
  tag_vocabulary: {
    pose: ["frontal", "profile"],
    facing: ["facing-camera", "facing-left"],
    expression: ["slight-smile", "teeth-smile", "neutral"],
    gesture: ["point-side"],
    extras: ["wide-eyes"],
  },
  common: { clothing: "charcoal crew-neck t-shirt", framing: "standing mid-shot, torso up" },
  images: [
    { file: "IMG_1505.jpg", tags: ["frontal", "facing-camera", "slight-smile"] },
    { file: "IMG_1506.jpg", tags: ["profile", "facing-left", "teeth-smile", "point-side"] },
    { file: "IMG_1507.jpg", tags: ["frontal", "facing-camera", "teeth-smile", "wide-eyes"] },
  ],
};

let root: string;

async function put(rel: string, content: string) {
  const file = path.join(root, rel);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

async function seedKit(index: unknown = INDEX, files = ["IMG_1505", "IMG_1506", "IMG_1507"]) {
  await put(
    "identity/kenny-headshots/index.json",
    typeof index === "string" ? index : JSON.stringify(index),
  );
  for (const f of files) await writeFile(path.join(root, "identity/kenny-headshots", `${f}.jpg`), `JPGBYTES-${f}`);
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "thumby-identity-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("scanIdentityKit", () => {
  it("returns an empty pool when the kit is missing, without erroring", async () => {
    expect((await scanIdentityKit(root)).present).toBe(false);
    expect((await scanIdentityKit(root)).entries).toEqual([]);
    expect((await scanIdentityKit(root)).vocabulary).toEqual({});
    expect((await scanLibrary(root)).identity.entries).toEqual([]);
  });

  it("reports a present kit even when its index lists no sources", async () => {
    await seedKit({ ...INDEX, images: [] });
    const kit = await scanIdentityKit(root);
    expect(kit.present).toBe(true);
    expect(kit.entries).toEqual([]);
  });

  it("parses the index into entries with derived facets and content hashes", async () => {
    await seedKit();
    const lib = await scanLibrary(root);
    expect(lib.identity.entries).toHaveLength(3);
    const first = lib.identity.entries[0]!;
    expect(first.meta.kind).toBe("identity");
    expect(first.meta.id).toBe("IMG_1505");
    expect(first.meta.tags).toEqual(["frontal", "facing-camera", "slight-smile"]);
    expect(first.meta.facets).toEqual({
      pose: ["frontal"],
      facing: ["facing-camera"],
      expression: ["slight-smile"],
      outfit: ["charcoal crew-neck t-shirt"],
      framing: ["standing mid-shot, torso up"],
    });
    expect(first.imagePath).toBe(path.resolve(root, "identity/kenny-headshots/IMG_1505.jpg"));
    const bytes = new Uint8Array(await readFile(first.imagePath));
    expect(first.hash).toBe(contentHash(bytes));
  });

  it("keeps the id unique across the whole library", async () => {
    await seedKit();
    await put("logos/IMG_1506/IMG_1506.svg", `<svg viewBox="0 0 1 1"/>`);
    await put(
      "logos/IMG_1506/meta.json",
      JSON.stringify({ kind: "logo", id: "IMG_1506", name: "clash", tags: [] }),
    );
    expect(scanLibrary(root)).rejects.toThrow(/duplicate asset id "IMG_1506"/);
  });

  it("fails loudly when the kit directory exists but has no readable index.json", async () => {
    await mkdir(path.join(root, "identity/kenny-headshots"), { recursive: true });
    expect(scanLibrary(root)).rejects.toThrow(/index\.json/);
    await put("identity/kenny-headshots/index.json", "{ not json");
    expect(scanLibrary(root)).rejects.toThrow(/index\.json/);
  });

  it("fails loudly when an indexed image is missing on disk", async () => {
    await seedKit(INDEX, ["IMG_1505", "IMG_1506"]);
    expect(scanLibrary(root)).rejects.toThrow(/IMG_1507\.jpg/);
  });

  it("fails loudly when a tag is outside the index vocabulary", async () => {
    await seedKit({
      ...INDEX,
      images: [{ file: "IMG_1505.jpg", tags: ["frontal", "made-up-tag"] }],
    });
    expect(scanLibrary(root)).rejects.toThrow(/made-up-tag/);
  });

  it("fails loudly when common metadata is present but malformed", async () => {
    await seedKit({ ...INDEX, common: { ...INDEX.common, clothing: 42 } });
    expect(scanLibrary(root)).rejects.toThrow(/common\.clothing/);
    await seedKit({ ...INDEX, common: { ...INDEX.common, framing: "" } });
    expect(scanLibrary(root)).rejects.toThrow(/common\.framing/);
  });

  it("treats index.json as canonical — unindexed files are ignored", async () => {
    await seedKit();
    await writeFile(path.join(root, "identity/kenny-headshots/.DS_Store"), "junk");
    await writeFile(path.join(root, "identity/kenny-headshots/IMG_9999.jpg"), "unindexed");
    const lib = await scanLibrary(root);
    expect(lib.identity.entries.map((e) => e.meta.id)).toEqual(["IMG_1505", "IMG_1506", "IMG_1507"]);
  });
});

describe("searchLibrary identity facets", () => {
  it("free-text queries match identity ids and tags like other assets", async () => {
    await seedKit();
    const lib = await scanLibrary(root);
    expect((await searchLibrary(lib, "1506")).identity.entries.map((e) => e.meta.id)).toEqual(["IMG_1506"]);
    expect((await searchLibrary(lib, "teeth-smile")).identity.entries).toHaveLength(2);
  });

  it("filters by one axis", async () => {
    await seedKit();
    const lib = await scanLibrary(root);
    const found = await searchLibrary(lib, "", { facets: parseFacets(["pose=frontal"]) });
    expect(found.identity.entries.map((e) => e.meta.id)).toEqual(["IMG_1505", "IMG_1507"]);
  });

  it("values on the same axis are alternatives (any-of)", async () => {
    await seedKit();
    const lib = await scanLibrary(root);
    const found = await searchLibrary(lib, "", { facets: parseFacets(["pose=frontal", "pose=profile"]) });
    expect(found.identity.entries).toHaveLength(3);
  });

  it("facets on different axes must all match (all-of)", async () => {
    await seedKit();
    const lib = await scanLibrary(root);
    const found = await searchLibrary(lib, "", {
      facets: parseFacets(["pose=frontal", "expression=teeth-smile"]),
    });
    expect(found.identity.entries.map((e) => e.meta.id)).toEqual(["IMG_1507"]);
  });

  it("supports the outfit and framing axes derived from the kit's common metadata", async () => {
    await seedKit();
    const lib = await scanLibrary(root);
    const outfit = await searchLibrary(lib, "", {
      facets: parseFacets(["outfit=charcoal crew-neck t-shirt"]),
    });
    expect(outfit.identity.entries).toHaveLength(3);
    const framing = await searchLibrary(lib, "", {
      facets: parseFacets(["framing=standing mid-shot, torso up"]),
    });
    expect(framing.identity.entries).toHaveLength(3);
  });

  it("combines a free-text query with facets (all-of)", async () => {
    await seedKit();
    const lib = await scanLibrary(root);
    const hit = await searchLibrary(lib, "1507", { facets: parseFacets(["pose=frontal"]) });
    expect(hit.identity.entries.map((e) => e.meta.id)).toEqual(["IMG_1507"]);
    const miss = await searchLibrary(lib, "1506", { facets: parseFacets(["pose=frontal"]) });
    expect(miss.identity.entries).toEqual([]);
  });

  it("returns an explicit empty identity pool for a valid but unsatisfied combination", async () => {
    await seedKit();
    const lib = await scanLibrary(root);
    const found = await searchLibrary(lib, "", {
      facets: parseFacets(["pose=profile", "expression=slight-smile"]),
    });
    expect(found.identity.entries).toEqual([]);
    expect(found.logos).toEqual(lib.logos);
  });

  it("rejects an unknown axis with the available vocabulary", async () => {
    await seedKit();
    const lib = await scanLibrary(root);
    expect(
      searchLibrary(lib, "", { facets: parseFacets(["gaze=facing-camera"]) }),
    ).rejects.toThrow(/unknown identity facet "gaze".*expression, extras, facing, framing, gesture, outfit, pose/s);
  });

  it("rejects an unknown value with the axis's available values", async () => {
    await seedKit();
    const lib = await scanLibrary(root);
    expect(
      searchLibrary(lib, "", { facets: parseFacets(["pose=frontall"]) }),
    ).rejects.toThrow(/unknown "pose" facet value "frontall".*frontal, profile/s);
  });

  it("returns an explicit empty result for facets against an empty identity pool", async () => {
    const found = await searchLibrary(EMPTY_LIBRARY, "", { facets: parseFacets(["pose=frontal"]) });
    expect(found.identity.entries).toEqual([]);
    expect(found.identity.present).toBe(false);
  });
});

describe("parseFacets", () => {
  it("parses axis=value terms and merges repeated axes", () => {
    expect(
      parseFacets(["pose=frontal", "pose=profile", "expression=teeth-smile"]),
    ).toEqual({
      pose: ["frontal", "profile"],
      expression: ["teeth-smile"],
    });
    expect(parseFacets(["outfit=charcoal crew-neck t-shirt"])).toEqual({
      outfit: ["charcoal crew-neck t-shirt"],
    });
    // A value's own commas and spaces survive — one term per --facets flag.
    expect(parseFacets(["framing=standing mid-shot, torso up"])).toEqual({
      framing: ["standing mid-shot, torso up"],
    });
  });

  it("rejects malformed terms instead of guessing", () => {
    expect(() => parseFacets(["pose"])).toThrow(/pose/);
    expect(() => parseFacets(["pose="])).toThrow(/pose/);
  });
});

describe("the real identity kit", () => {
  // The kit holds personal assets and is gitignored (`assets/*`) — the test
  // runs wherever the kit exists (Kenneth's clone) and skips elsewhere.
  const kitPresent = existsSync(path.join(LIBRARY_ROOT, "identity/kenny-headshots"));
  it.skipIf(!kitPresent)(
    "is well-formed and every facet present in its metadata is searchable",
    async () => {
      const lib = await scanLibrary(LIBRARY_ROOT);
      expect(lib.identity.entries.length).toBeGreaterThan(0);
      const index = JSON.parse(
        await readFile(path.join(LIBRARY_ROOT, "identity/kenny-headshots/index.json"), "utf8"),
      );
      expect(lib.identity.entries).toHaveLength(index.images.length);
      for (const [axis, values] of Object.entries(index.tag_vocabulary)) {
        for (const value of values as string[]) {
          const found = await searchLibrary(lib, "", { facets: { [axis]: [value] } });
          expect(Array.isArray(found.identity.entries)).toBe(true);
        }
      }
      // The shared outfit/framing facets from common metadata are searchable too.
      const shared = await searchLibrary(lib, "", {
        facets: {
          outfit: [index.common.clothing],
          framing: [index.common.framing],
        },
      });
      expect(shared.identity.entries).toHaveLength(index.images.length);
      // Free text finds an anchor by tag without manual paths.
      const smiling = await searchLibrary(lib, "teeth-smile");
      expect(smiling.identity.entries.length).toBeGreaterThan(0);
      for (const entry of lib.identity.entries) {
        expect(entry.hash).toMatch(/^[0-9a-f]{64}$/);
      }
    },
    30000,
  );
});
