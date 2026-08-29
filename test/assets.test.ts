import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  scanLibrary,
  resolveLogo,
  resolveCutout,
  searchLibrary,
  resolveAsset,
  parseAssetRef,
  contentHash,
  writeObjectAsset,
  writePlateAsset,
} from "../src/assets.js";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

let root: string;

async function put(rel: string, content: string) {
  const file = path.join(root, rel);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "thumby-assets-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function seedLogo(id: string, opts?: { svg?: boolean; extra?: string }) {
  const ext = opts?.svg === false ? "png" : "svg";
  await put(
    `logos/${id}/${id}.${ext}`,
    opts?.svg === false ? "PNGBYTES" : `<svg viewBox="0 0 1 1"/>`,
  );
  await put(
    `logos/${id}/meta.json`,
    JSON.stringify({
      kind: "logo",
      id,
      name: id.toUpperCase(),
      tags: ["ai"],
      ...(opts?.extra ? JSON.parse(opts.extra) : {}),
    }),
  );
}

describe("scanLibrary", () => {
  it("returns empty on a missing or empty library without erroring", async () => {
    const empty = {
      logos: [],
      plates: [],
      cutouts: [],
      objects: [],
      identity: { present: false, entries: [], vocabulary: {} },
    };
    expect(await scanLibrary(path.join(root, "nope"))).toEqual(empty);
    expect(await scanLibrary(root)).toEqual(empty);
  });

  it("finds logos and derives the image path", async () => {
    await seedLogo("openai");
    const lib = await scanLibrary(root);
    expect(lib.logos).toHaveLength(1);
    expect(lib.logos[0]!.meta.id).toBe("openai");
    expect(lib.logos[0]!.imagePath).toBe(path.resolve(root, "logos/openai/openai.svg"));
    expect(lib.logos[0]!.kind).toBe("svg");
  });

  it("sees through aliases to an id (alias is not stored separately)", async () => {
    await seedLogo("openai", { extra: '{ "aliases": ["chatgpt", "gpt"] }' });
    const lib = await scanLibrary(root);
    expect(await resolveLogo(lib, "chatgpt")).toEqual({
      ...lib.logos[0],
    });
  });

  it("fails fast on duplicate ids across entries", async () => {
    await seedLogo("openai");
    await put(
      `plates/openai/meta.json`,
      JSON.stringify({ kind: "plate", id: "openai" }),
    );
    await put(`plates/openai/plate.png`, "PNGBYTES");
    await expect(scanLibrary(root)).rejects.toThrow(/duplicate/i);
  });

  it("fails fast when an entry has no image file", async () => {
    await put(
      `logos/claude/meta.json`,
      JSON.stringify({ kind: "logo", id: "claude", name: "Claude", tags: [] }),
    );
    await expect(scanLibrary(root)).rejects.toThrow(/no image|missing/i);
  });

  it("fails fast when meta kind is unknown", async () => {
    await put(
      `logos/weird/meta.json`,
      JSON.stringify({ kind: "gif", id: "weird" }),
    );
    await put(`logos/weird/weird.svg`, "<svg/>");
    await expect(scanLibrary(root)).rejects.toThrow();
  });

  it("passes the plate record with provenance fields intact", async () => {
    await put(
      `plates/neon-terminal/meta.json`,
      JSON.stringify({
        kind: "plate",
        id: "neon-terminal",
        name: "Neon Terminal",
        tags: ["neon", "dark"],
        subject: "a burnt-out developer at a glowing terminal",
        model: "gpt-image-2",
      }),
    );
    await put(`plates/neon-terminal/plate.png`, "PNGBYTES");
    const lib = await scanLibrary(root);
    expect(lib.plates[0]!.meta.id).toBe("neon-terminal");
    expect(lib.plates[0]!.imagePath).toBe(path.resolve(root, "plates/neon-terminal/plate.png"));
    expect(lib.plates[0]!.meta.subject).toContain("burnt-out");
  });

  it("scans a cutout with role tags and approval", async () => {
    await put(
      `cutouts/deadpan/meta.json`,
      JSON.stringify({
        kind: "cutout",
        id: "deadpan",
        name: "Deadpan",
        tags: ["deadpan", "chest-up"],
        approval: "trial",
        derivedFrom: "/somewhere/approved/original.png",
      }),
    );
    await put(`cutouts/deadpan/cutout.png`, "PNGBYTES");
    const lib = await scanLibrary(root);
    expect(lib.cutouts).toHaveLength(1);
    expect(lib.cutouts[0]!.meta.id).toBe("deadpan");
    expect(lib.cutouts[0]!.kind).toBe("raster");
    expect(lib.cutouts[0]!.meta.approval).toBe("trial");
  });

  it("scans an object asset with its matting provenance", async () => {
    await put(
      `objects/lamp/meta.json`,
      JSON.stringify({
        kind: "object",
        id: "lamp",
        name: "Desk Lamp",
        tags: ["lamp"],
        subject: "a retro desk lamp",
        model: "gpt-image",
        matting: "true-alpha",
      }),
    );
    await put(`objects/lamp/object.png`, "PNGBYTES");
    const lib = await scanLibrary(root);
    expect(lib.objects).toHaveLength(1);
    expect(lib.objects[0]!.meta.id).toBe("lamp");
    expect(lib.objects[0]!.meta.kind).toBe("object");
    expect(lib.objects[0]!.imagePath).toBe(path.resolve(root, "objects/lamp/object.png"));
  });
});

describe("writeObjectAsset", () => {
  const meta = {
    kind: "object" as const,
    id: "lamp",
    name: "Desk Lamp",
    tags: ["lamp"],
    matting: "true-alpha" as const,
  };

  it("writes the object image and meta exclusively", async () => {
    const imagePath = await writeObjectAsset(root, "lamp", new TextEncoder().encode("PNGBYTES"), meta);
    expect(imagePath).toBe(path.resolve(root, "objects/lamp/object.png"));
    const lib = await scanLibrary(root);
    expect(lib.objects[0]!.meta).toEqual(meta);
    expect(lib.objects[0]!.hash).toBe(sha("PNGBYTES"));
  });

  it("never overwrites an existing asset of any kind", async () => {
    await writeObjectAsset(root, "lamp", new TextEncoder().encode("FIRST"), meta);
    await put(`logos/lamp/lamp.svg`, "<svg/>");
    await put(`logos/lamp/meta.json`, JSON.stringify({ kind: "logo", id: "lamp", tags: [] }));
    await expect(
      writeObjectAsset(root, "lamp", new TextEncoder().encode("SECOND"), meta),
    ).rejects.toThrow(/already exists/i);
    // Remove the conflicting logo fixture — the library itself forbids the
    // cross-kind duplicate — then confirm the first adoption's bytes stand.
    await rm(path.join(root, "logos/lamp"), { recursive: true });
    const lib = await scanLibrary(root);
    expect(lib.objects[0]!.hash).toBe(sha("FIRST"));
  });

  it("rejects an invalid asset id", async () => {
    expect(() => writeObjectAsset(root, "Bad_Id", new TextEncoder().encode("x"), meta)).toThrow(
      /asset id/i,
    );
  });

  it("gives concurrent cross-kind adoptions of one id exactly one winner (atomic reservation)", async () => {
    const results = await Promise.allSettled([
      // The object meta's id must match its directory ("clash") — a mismatched
      // id would trip the scanner when this branch wins the race, making the
      // test flaky on which adoption wins rather than on the reservation.
      writeObjectAsset(root, "clash", new TextEncoder().encode("OBJ"), { ...meta, id: "clash" }),
      writePlateAsset(root, "clash", new TextEncoder().encode("PLATE"), {
        kind: "plate",
        id: "clash",
        name: "Clash",
        tags: [],
      }),
    ]);
    const winners = results.filter((r) => r.status === "fulfilled");
    expect(winners).toHaveLength(1);
    // The library holds one asset for the id — never a plate AND an object.
    const lib = await scanLibrary(root);
    expect([...lib.plates, ...lib.objects]).toHaveLength(1);
  });
});

describe("searchLibrary", () => {
  beforeEach(async () => {
    await seedLogo("openai", { extra: '{ "aliases": ["chatgpt"] }' });
    await seedLogo("gemini");
    await put(
      `plates/neon-terminal/meta.json`,
      JSON.stringify({
        kind: "plate",
        id: "neon-terminal",
        name: "Neon Terminal",
        tags: ["neon", "dark"],
      }),
    );
    await put(`plates/neon-terminal/plate.png`, "PNGBYTES");
  });

  it("matches by id substring, tag, name, and alias in one query", async () => {
    expect((await searchLibrary(await scanLibrary(root), "openai")).logos).toHaveLength(1);
    expect((await searchLibrary(await scanLibrary(root), "chatgpt")).logos).toHaveLength(1);
    expect((await searchLibrary(await scanLibrary(root), "neon")).plates).toHaveLength(1);
    expect((await searchLibrary(await scanLibrary(root), "zzz")).logos).toHaveLength(0);
  });

  it("matches cutouts by role tag", async () => {
    await put(
      `cutouts/deadpan/meta.json`,
      JSON.stringify({
        kind: "cutout",
        id: "deadpan",
        name: "Deadpan",
        tags: ["deadpan", "chest-up"],
        approval: "trial",
      }),
    );
    await put(`cutouts/deadpan/cutout.png`, "PNGBYTES");
    const lib = await scanLibrary(root);
    expect((await searchLibrary(lib, "deadpan")).cutouts).toHaveLength(1);
    expect((await searchLibrary(lib, "zzz")).cutouts).toHaveLength(0);
    expect(resolveCutout(lib, "deadpan").meta.id).toBe("deadpan");
    expect(() => resolveCutout(lib, "nope")).toThrow(/Unknown cutout/);
  });

  it("matches objects by id, name, and tag", async () => {
    await put(`objects/lamp/object.png`, "PNGBYTES");
    await put(
      `objects/lamp/meta.json`,
      JSON.stringify({
        kind: "object",
        id: "lamp",
        name: "Desk Lamp",
        tags: ["retro"],
        matting: "true-alpha",
      }),
    );
    const lib = await scanLibrary(root);
    expect((await searchLibrary(lib, "lamp")).objects).toHaveLength(1);
    expect((await searchLibrary(lib, "retro")).objects).toHaveLength(1);
    expect((await searchLibrary(lib, "desk")).objects).toHaveLength(1);
    expect((await searchLibrary(lib, "zzz")).objects).toHaveLength(0);
  });

  it("empty query returns everything", async () => {
    const all = await searchLibrary(await scanLibrary(root), "");
    expect(all.logos).toHaveLength(2);
    expect(all.plates).toHaveLength(1);
  });
});

describe("parseAssetRef", () => {
  it("classifies a bare id as library scope", () => {
    expect(parseAssetRef("openai")).toEqual({ scope: "library", id: "openai" });
  });

  it("classifies an explicit library: prefix", () => {
    expect(parseAssetRef("library:openai")).toEqual({ scope: "library", id: "openai" });
    expect(parseAssetRef("library:openai@" + sha("x"))).toEqual({
      scope: "library",
      id: "openai",
      hash: sha("x"),
    });
  });

  it("splits an @<hash> suffix off a library id", () => {
    const h = sha("x");
    expect(parseAssetRef(`openai@${h}`)).toEqual({ scope: "library", id: "openai", hash: h });
    expect(parseAssetRef(`openai@${h.slice(0, 12)}`).hash).toBe(h.slice(0, 12));
  });

  it("classifies separator and dot paths as project scope", () => {
    expect(parseAssetRef("media/hook.png")).toEqual({ scope: "project", path: "media/hook.png" });
    expect(parseAssetRef("./media/hook.png")).toEqual({ scope: "project", path: "./media/hook.png" });
    expect(parseAssetRef("../elsewhere/hook.png")).toEqual({
      scope: "project",
      path: "../elsewhere/hook.png",
    });
    expect(parseAssetRef("media\\hook.png")).toEqual({ scope: "project", path: "media\\hook.png" });
  });

  it("splits a hex @<hash> off a project path but keeps non-hex @ in the path", () => {
    const h = sha("x");
    expect(parseAssetRef(`media/hook.png@${h.slice(0, 10)}`)).toEqual({
      scope: "project",
      path: "media/hook.png",
      hash: h.slice(0, 10),
    });
    expect(parseAssetRef("media/we@ird.png")).toEqual({ scope: "project", path: "media/we@ird.png" });
  });

  it("rejects a malformed hash suffix with an actionable error", () => {
    expect(() => parseAssetRef("openai@xyz")).toThrow(/invalid content hash/);
    expect(() => parseAssetRef("openai@")).toThrow(/invalid content hash/);
    expect(() => parseAssetRef("openai@" + "a".repeat(65))).toThrow(/invalid content hash/);
  });

  it("rejects empty references", () => {
    expect(() => parseAssetRef("  ")).toThrow(/empty/);
  });
});

describe("contentHash", () => {
  it("is the sha-256 of the exact bytes", () => {
    expect(contentHash(new TextEncoder().encode("PNGBYTES"))).toBe(sha("PNGBYTES"));
    expect(contentHash(new TextEncoder().encode("other"))).not.toBe(sha("PNGBYTES"));
  });
});

describe("resolveAsset", () => {
  it("resolves a library asset by id with its content identity", async () => {
    await seedLogo("openai");
    const asset = await resolveAsset(root, await scanLibrary(root), "openai");
    expect(asset.scope).toBe("library");
    expect(asset.id).toBe("openai");
    expect(asset.kind).toBe("logo");
    expect(asset.hash).toBe(sha("<svg viewBox=\"0 0 1 1\"/>"));
    expect(asset.mediaType).toBe("image/svg+xml");
    expect(new TextDecoder().decode(asset.bytes)).toContain("<svg");
  });

  it("resolves a library logo through an alias", async () => {
    await seedLogo("openai", { extra: '{ "aliases": ["chatgpt"] }' });
    const asset = await resolveAsset(root, await scanLibrary(root), "chatgpt");
    expect(asset.id).toBe("openai");
  });

  it("resolves a library plate by id with png media type", async () => {
    await put("plates/neon/plate.png", "PNGBYTES");
    await put("plates/neon/meta.json", JSON.stringify({ kind: "plate", id: "neon", tags: [] }));
    const asset = await resolveAsset(root, await scanLibrary(root), "neon");
    expect(asset.kind).toBe("plate");
    expect(asset.mediaType).toBe("image/png");
    expect(asset.hash).toBe(sha("PNGBYTES"));
  });

  it("resolves an object asset through the one contract, kind-constrained or not", async () => {
    await put("objects/lamp/object.png", "PNGBYTES");
    await put(
      "objects/lamp/meta.json",
      JSON.stringify({ kind: "object", id: "lamp", tags: [], matting: "true-alpha" }),
    );
    const lib = await scanLibrary(root);
    const generic = await resolveAsset(root, lib, "lamp");
    expect(generic.kind).toBe("object");
    expect(generic.mediaType).toBe("image/png");
    const constrained = await resolveAsset(root, lib, "lamp", { kind: "object" });
    expect(constrained.kind).toBe("object");
  });

  it("pins exact content with a full or prefix hash", async () => {
    await seedLogo("openai");
    const lib = await scanLibrary(root);
    const h = lib.logos[0]!.hash;
    expect((await resolveAsset(root, lib, `openai@${h}`)).hash).toBe(h);
    expect((await resolveAsset(root, lib, `library:openai@${h.slice(0, 8)}`)).hash).toBe(h);
  });

  it("fails loudly with the actual hash when pinned content has changed", async () => {
    await seedLogo("openai");
    const lib = await scanLibrary(root);
    await put("logos/openai/openai.svg", "<svg viewBox=\"0 0 2 2\"/>");
    const err = await resolveAsset(root, lib, `openai@${sha("<svg viewBox=\"0 0 1 1\"/>").slice(0, 12)}`).then(
      () => null,
      (e: Error) => e,
    );
    expect(err!.message).toMatch(/content mismatch/);
    expect(err!.message).toContain(sha("<svg viewBox=\"0 0 2 2\"/>"));
    expect(err!.message).toMatch(/re-?pin/i);
  });

  it("lists available ids when a library asset is unknown", async () => {
    await seedLogo("openai");
    const err = await resolveAsset(root, await scanLibrary(root), "nope").then(
      () => null,
      (e: Error) => e,
    );
    expect(err!.message).toMatch(/unknown library asset "nope"/);
    expect(err!.message).toContain("openai");
  });

  it("resolves a project-local reference relative to the project root", async () => {
    await mkdir(path.join(root, "media"), { recursive: true });
    await writeFile(path.join(root, "media/hook.png"), "PNGBYTES");
    const asset = await resolveAsset(root, await scanLibrary(root), "media/hook.png");
    expect(asset.scope).toBe("project");
    expect(asset.path).toBe("media/hook.png");
    expect(asset.hash).toBe(sha("PNGBYTES"));
    expect(asset.mediaType).toBe("image/png");
  });

  it("still resolves a project containing relative/exact refs after relocation", async () => {
    await mkdir(path.join(root, "media"), { recursive: true });
    await writeFile(path.join(root, "media/hook.png"), "PNGBYTES");
    const before = await resolveAsset(root, await scanLibrary(root), "media/hook.png@" + sha("PNGBYTES"));
    const moved = path.join(path.dirname(root), "relocated-" + path.basename(root));
    await rename(root, moved);
    const after = await resolveAsset(moved, await scanLibrary(moved), "media/hook.png@" + sha("PNGBYTES"));
    expect(after.hash).toBe(before.hash);
    expect(after.scope).toBe("project");
  });

  it("fails with an actionable error when project content is missing", async () => {
    const err = await resolveAsset(root, await scanLibrary(root), "media/gone.png").then(
      () => null,
      (e: Error) => e,
    );
    expect(err!.message).toMatch(/missing project asset "media\/gone\.png"/);
    expect(err!.message).toContain(path.join(root, "media/gone.png"));
  });

  it("pins exact bytes for project-local references too", async () => {
    await mkdir(path.join(root, "media"), { recursive: true });
    await writeFile(path.join(root, "media/hook.png"), "PNGBYTES");
    const ref = "media/hook.png@" + sha("DIFFERENT").slice(0, 12);
    await expect(resolveAsset(root, await scanLibrary(root), ref)).rejects.toThrow(/content mismatch/);
  });

  it("maps media types by extension", async () => {
    await seedLogo("openai");
    await put("logos/webp/logo.webp", "WEBPBYTES");
    await put("logos/webp/meta.json", JSON.stringify({ kind: "logo", id: "webp", tags: [] }));
    await put("logos/jpgy/logo.jpg", "JPGBYTES");
    await put("logos/jpgy/meta.json", JSON.stringify({ kind: "logo", id: "jpgy", tags: [] }));
    const lib = await scanLibrary(root);
    expect((await resolveAsset(root, lib, "webp")).mediaType).toBe("image/webp");
    expect((await resolveAsset(root, lib, "jpgy")).mediaType).toBe("image/jpeg");
  });

  it("fails scan on malformed metadata with the offending file named", async () => {
    await put("logos/bad/logo.png", "PNGBYTES");
    await put("logos/bad/meta.json", JSON.stringify({ kind: "logo", id: "bad", tags: "not-an-array" }));
    await expect(scanLibrary(root)).rejects.toThrow(/logos\/bad\/meta\.json: tags/);
  });

  it("constrains library resolution to the requested kind", async () => {
    await seedLogo("openai", { extra: '{ "aliases": ["chatgpt"] }' });
    await put("cutouts/deadpan/cutout.png", "PNGBYTES");
    await put(
      "cutouts/deadpan/meta.json",
      JSON.stringify({ kind: "cutout", id: "deadpan", tags: [], approval: "trial" }),
    );
    const lib = await scanLibrary(root);

    const cutout = await resolveAsset(root, lib, "deadpan", { kind: "cutout" });
    expect(cutout.kind).toBe("cutout");

    // A logo id in a cutout slot fails loudly, naming only the cutout pool.
    const err = await resolveAsset(root, lib, "openai", { kind: "cutout" }).then(
      () => null,
      (e: Error) => e,
    );
    expect(err!.message).toMatch(/unknown library cutout "openai"/);
    expect(err!.message).toContain("deadpan");
    expect(err!.message).toContain("project-relative path");

    // An explicit logo kind still matches by id, name, or alias.
    expect((await resolveAsset(root, lib, "chatgpt", { kind: "logo" })).kind).toBe("logo");
    expect((await resolveAsset(root, lib, "OPENAI", { kind: "logo" })).kind).toBe("logo");
  });
});
