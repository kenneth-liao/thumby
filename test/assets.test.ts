import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  scanLibrary,
  resolveLogo,
  resolveCutout,
  searchLibrary,
} from "../src/assets.js";

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
    expect(await scanLibrary(path.join(root, "nope"))).toEqual({
      logos: [],
      plates: [],
      cutouts: [],
    });
    expect(await scanLibrary(root)).toEqual({
      logos: [],
      plates: [],
      cutouts: [],
    });
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

  it("empty query returns everything", async () => {
    const all = await searchLibrary(await scanLibrary(root), "");
    expect(all.logos).toHaveLength(2);
    expect(all.plates).toHaveLength(1);
  });
});
