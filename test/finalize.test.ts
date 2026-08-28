import { describe, it, expect } from "bun:test";
import { deflateSync } from "node:zlib";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { finalizeRender, OUTPUT_LIMIT } from "../src/finalize.js";
import { run as cliRun } from "../src/scene-cli.js";

// --- PNG fixture helpers ----------------------------------------------------
// A minimal PNG writer (filter 0 rows) so tests can synthesize exact inputs,
// plus the tiny IHDR reader assertions use to check output geometry.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

interface PngOpts {
  width: number;
  height: number;
  /** Per-pixel RGBA in row-major order. */
  pixels?: (x: number, y: number) => [number, number, number, number];
  bitDepth?: number;
  colorType?: number;
}

function makePng(o: PngOpts): Buffer {
  const depth = o.bitDepth ?? 8;
  const ctype = o.colorType ?? 6;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(o.width, 0);
  ihdr.writeUInt32BE(o.height, 4);
  ihdr[8] = depth;
  ihdr[9] = ctype;
  const channels = ctype === 6 ? 4 : ctype === 2 ? 3 : 1;
  const raw = Buffer.alloc(o.height * (1 + o.width * channels));
  if (o.pixels && depth === 8) {
    for (let y = 0; y < o.height; y++) {
      const row = y * (1 + o.width * channels);
      raw[row] = 0;
      for (let x = 0; x < o.width; x++) {
        const [r, g, b, a] = o.pixels(x, y);
        const at = row + 1 + x * channels;
        if (ctype === 6) {
          raw[at] = r;
          raw[at + 1] = g;
          raw[at + 2] = b;
          raw[at + 3] = a;
        } else if (ctype === 2) {
          raw[at] = r;
          raw[at + 1] = g;
          raw[at + 2] = b;
        }
      }
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

/** Deterministic mulberry32 sequence — the same seed is the same busy thumbnail. */
function noisePixel(seed: number): () => [number, number, number, number] {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    const v = (t ^ (t >>> 14)) >>> 0;
    return [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, 0xff];
  };
}

function ihdrOf(png: Buffer): { width: number; height: number; bitDepth: number; colorType: number } {
  return {
    width: png.readUInt32BE(16),
    height: png.readUInt32BE(20),
    bitDepth: png[24]!,
    colorType: png[25]!,
  };
}

/** Rewrite the IHDR bit depth with a valid CRC — the depth check must fire before anything else rejects it. */
function withBitDepth(png: Buffer, depth: number): Buffer {
  const out = Buffer.from(png);
  out[24] = depth;
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(out.subarray(12, 29)));
  crc.copy(out, 29);
  return out;
}

const BUSY = (w = 1280, h = 720) => makePng({ width: w, height: h, pixels: noisePixel(0x5eed) });

// --- unit: the finalization contract ----------------------------------------

describe("finalizeRender", () => {
  it("accepts a render at or below the limit without any recompression", () => {
    const small = makePng({
      width: 64,
      height: 64,
      pixels: (x, y) => [(x * 4) % 256, (y * 4) % 256, 128, 255],
    });
    const r = finalizeRender(small);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.png.equals(small)).toBe(true);
    expect(r.optimization).toBeUndefined();
  });

  it("optimizes an oversized opaque render below the limit at exact 1280×720", () => {
    const r = finalizeRender(BUSY());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.png.length).toBeLessThanOrEqual(OUTPUT_LIMIT);
    const ihdr = ihdrOf(r.png);
    expect(ihdr.width).toBe(1280);
    expect(ihdr.height).toBe(720);
    expect(r.optimization?.stage).toBe("quantized");
    expect(r.optimization?.bytesBefore).toBeGreaterThan(OUTPUT_LIMIT);
    expect(r.optimization?.bytesAfter).toBe(r.png.length);
  });

  it("drops a fully opaque alpha channel losslessly when that alone reaches compliance", () => {
    // Opaque 512×512 noise: the incompressible alpha plane is a quarter of the
    // data, so dropping it lands under the injected 850 KB limit while the
    // original stays over it — the lossless stage alone must suffice.
    // (Measured margins: RGBA ≈ 897 KB, RGB re-encode ≈ 787 KB.)
    const r = finalizeRender(BUSY(512, 512), { limit: 850_000 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.optimization?.stage).toBe("lossless");
    expect(ihdrOf(r.png).colorType).toBe(2);
    expect(ihdrOf(r.png).width).toBe(512);
    expect(ihdrOf(r.png).height).toBe(512);
    expect(r.png.length).toBeLessThanOrEqual(900_000);
  });

  it("is deterministic — identical input, identical output bytes", () => {
    const busy = BUSY();
    const a = finalizeRender(busy);
    const b = finalizeRender(busy);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(b.png.equals(a.png)).toBe(true);
    expect(b.optimization).toEqual(a.optimization);
  });

  it("fails with the observed size and an actionable explanation when compliance is impossible", () => {
    const r = finalizeRender(BUSY(), { limit: 10 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const message = r.errors[0]!.message;
    expect(message).toMatch(/\d[\d,]* bytes/);
    expect(message).toContain("limit is 10 bytes");
    expect(message).toMatch(/reduce|simplif/i);
  });

  it("fails loudly on semi-transparent input palette optimization cannot preserve", () => {
    const noise = noisePixel(0xa11ce);
    const translucent = makePng({
      width: 1280,
      height: 720,
      pixels: () => {
        const [r, g, b] = noise();
        return [r, g, b, 128];
      },
    });
    expect(translucent.length).toBeGreaterThan(OUTPUT_LIMIT);
    const r = finalizeRender(translucent);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]!.message).toMatch(/transparen/i);
  });

  it("fails loudly naming the defect on an oversized malformed PNG", () => {
    // Compliant bytes pass through uninspected by design — inspection only
    // happens when the limit forces an optimization pass.
    const bad = Buffer.concat([Buffer.from("not a png at all"), Buffer.alloc(OUTPUT_LIMIT + 1)]);
    const r = finalizeRender(bad);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]!.message).toMatch(/png/i);
    const r2 = finalizeRender(withBitDepth(BUSY(), 16));
    expect(r2.ok).toBe(false);
    if (r2.ok) return;
    expect(r2.errors[0]!.message).toMatch(/bit depth/i);
  });
});

// --- CLI seam: real renders through the scene pipeline ------------------------
//
// A quantized 1280×720 frame is mathematically bounded under the limit
// (indexed scanlines ≤ 921,600 bytes plus chunk overhead), so the CLI-level
// failure path is unreachable for real scenes — the injected-limit unit tests
// above own AC 4. Here: the two reachable paths on representative outputs.

describe("scene render finalization", () => {
  let root = "";

  const withProject = async (fn: (dir: string) => Promise<void>) => {
    root = await mkdtemp(path.join(tmpdir(), "thumby-finalize-"));
    try {
      await fn(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  };

  it("a simple render passes through under the limit and a busy render is optimized, rerender included", async () => {
    await withProject(async (dir) => {
      // Simple: one flat shape layer — a representative light thumbnail.
      const simple = path.join(dir, "simple.json");
      await writeFile(
        simple,
        JSON.stringify({
          schemaVersion: 1,
          canvas: { width: 1280, height: 720 },
          layers: [
            {
              id: "bg",
              type: "shape",
              shape: "rect",
              color: "#204060",
              position: { x: 0, y: 0 },
              size: { width: 1280, height: 720 },
            },
          ],
        }),
      );
      const s = await cliRun(["render", simple]);
      expect(s.exitCode).toBe(0);
      const sOut = s.output as { ok: boolean; bytes: number; optimization?: unknown };
      expect(sOut.ok).toBe(true);
      expect(sOut.bytes).toBeLessThanOrEqual(OUTPUT_LIMIT);
      expect(sOut.optimization).toBeUndefined();

      // Busy: full-canvas incompressible noise asset — exceeds the limit raw.
      const noise = BUSY();
      expect(noise.length).toBeGreaterThan(OUTPUT_LIMIT);
      await writeFile(path.join(dir, "noise.png"), noise);
      const busy = path.join(dir, "busy.json");
      await writeFile(
        busy,
        JSON.stringify({
          schemaVersion: 1,
          canvas: { width: 1280, height: 720 },
          layers: [
            {
              id: "bg",
              type: "image",
              asset: "./noise.png",
              position: { x: 0, y: 0 },
              size: { width: 1280, height: 720 },
            },
          ],
        }),
      );
      const b = await cliRun(["render", busy]);
      expect(b.exitCode).toBe(0);
      const bOut = b.output as {
        ok: boolean;
        bytes: number;
        width: number;
        height: number;
        optimization?: { stage: string; bytesBefore: number; bytesAfter: number };
        manifest: string;
      };
      expect(bOut.ok).toBe(true);
      expect(bOut.width).toBe(1280);
      expect(bOut.height).toBe(720);
      expect(bOut.bytes).toBeLessThanOrEqual(OUTPUT_LIMIT);
      expect(bOut.optimization?.stage).toBe("quantized");
      expect(bOut.optimization?.bytesBefore).toBeGreaterThan(OUTPUT_LIMIT);

      // The manifest records the optimization, and a manifest-backed rerender
      // re-finalizes to compliant bytes again.
      const rr = await cliRun(["rerender", bOut.manifest]);
      expect(rr.exitCode).toBe(0);
      const rrOut = rr.output as { ok: boolean; outputs: { bytes: number; optimization?: { stage: string } }[] };
      expect(rrOut.ok).toBe(true);
      expect(rrOut.outputs[0]!.bytes).toBeLessThanOrEqual(OUTPUT_LIMIT);
      expect(rrOut.outputs[0]!.optimization?.stage).toBe("quantized");
    });
  });

  it("a variant batch finalizes every output", async () => {
    await withProject(async (dir) => {
      await writeFile(path.join(dir, "noise.png"), BUSY());
      const scene = path.join(dir, "show.json");
      await writeFile(
        scene,
        JSON.stringify({
          schemaVersion: 1,
          canvas: { width: 1280, height: 720 },
          layers: [
            {
              id: "bg",
              type: "image",
              asset: "./noise.png",
              position: { x: 0, y: 0 },
              size: { width: 1280, height: 720 },
            },
          ],
          variants: {
            shift: { changes: [{ layer: "bg", set: { position: { x: 10, y: 0 } } }] },
          },
        }),
      );
      const r = await cliRun(["render", scene, "--variant", "shift"]);
      expect(r.exitCode).toBe(0);
      const out = r.output as { ok: boolean; outputs: { bytes: number; optimization?: { stage: string } }[] };
      expect(out.ok).toBe(true);
      expect(out.outputs).toHaveLength(1);
      expect(out.outputs[0]!.bytes).toBeLessThanOrEqual(OUTPUT_LIMIT);
      expect(out.outputs[0]!.optimization?.stage).toBe("quantized");
    });
  });
});
