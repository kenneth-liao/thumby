/**
 * The Reference load-once contract at the generation boundary (CRAFT-1, #56
 * review): loadVerifiedRefs resolves each Reference's path exactly once at
 * its boundary — hash-verifying those bytes against the recorded identity —
 * and the same verified bytes go to every candidate. Per-candidate path
 * reads would re-resolve the reference and could send drifted bytes to later
 * candidates under one recorded identity.
 *
 * The regression is deterministic without any filesystem or provider mock:
 * the test reference's `path` is a controlled getter that returns the
 * original file on first access and a decoy file (different bytes) on every
 * later access. Load-once code touches it once; per-candidate reads fail on
 * the access count and on the bytes they receive.
 */
import { describe, test, expect, mock } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** What the model actually received, per generateImage call. */
let providerCalls: { images: Uint8Array[] }[] = [];
mock.module("ai", () => ({
  generateImage: async (opts: { prompt: string | { text: string; images: Uint8Array[] } }) => {
    providerCalls.push({
      images: typeof opts.prompt === "string" ? [] : (opts.prompt.images ?? []),
    });
    return {
      images: [{ base64: Buffer.from(`candidate-${providerCalls.length}`).toString("base64") }],
      warnings: [],
    };
  },
  generateText: async () => {
    throw new Error("the default plate path calls generateImage, not generateText");
  },
}));

import { generatePlates, type TypedRefInput } from "../src/generate.js";

describe("Reference load-once contract (CRAFT-1)", () => {
  test("count=3 resolves the Reference path once and every provider call gets the original verified bytes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "thumby-ref-read-once-"));
    try {
      const originalPath = path.join(root, "original.png");
      const decoyPath = path.join(root, "decoy.png");
      const originalBytes = Buffer.from("original-reference-bytes");
      const tamperedBytes = Buffer.from("tampered-after-first-read");
      await writeFile(originalPath, originalBytes);
      await writeFile(decoyPath, tamperedBytes);

      // A reference whose path re-resolves to different bytes on every access
      // after the first: only a loader that resolves `path` exactly once can
      // keep every candidate under the recorded identity.
      let pathAccesses = 0;
      const driftingRef: TypedRefInput = {
        role: "edit",
        contentHash: sha256(originalBytes),
        get path() {
          pathAccesses++;
          return pathAccesses === 1 ? originalPath : decoyPath;
        },
      };

      const result = await generatePlates({
        subject: "simplified ui",
        model: "gpt-image",
        zone: "left",
        refs: [driftingRef],
        count: 3,
      });

      expect(result.plates).toHaveLength(3);
      expect(providerCalls).toHaveLength(3);
      // The path was resolved exactly once — at the loader's boundary.
      expect(pathAccesses).toBe(1);
      // Every candidate carried the same original verified bytes.
      const received = new Set(providerCalls.map((c) => sha256(c.images[0]!)));
      expect(received.size).toBe(1);
      expect(received.has(sha256(originalBytes))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});