/**
 * The multimodal (generateText) provider contract for typed References
 * (INT-2, #56 review, TEST-010): the recorded effective prompt is exactly the
 * text part of every provider call, and the reference images ride the message
 * in declared role order with the exact verified bytes — one verified load
 * feeding every candidate. The image-kind call shape is covered by
 * ui-reference-prompt.test.ts and reference-read-once.test.ts; this file pins
 * the multimodal branch of the same contract.
 *
 * The AI SDK seam is mocked (injected generation only — no spend).
 */
import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** What the model actually received, per generateText call. */
let textCalls: { model: string; messages: unknown[] }[] = [];
mock.module("ai", () => ({
  generateText: async (opts: { model: string; messages: unknown[] }) => {
    textCalls.push({ model: opts.model, messages: opts.messages });
    return {
      files: [
        { mediaType: "image/png", uint8Array: Buffer.from(`multimodal-candidate-${textCalls.length}`) },
      ],
      warnings: [],
    };
  },
  generateImage: async () => {
    throw new Error("the multimodal path calls generateText, not generateImage");
  },
}));

import { generatePlates, generateObjects } from "../src/generate.js";

let root: string;
let editPath: string;
let editBytes: Buffer;
let stylePath: string;
let styleBytes: Buffer;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "thumby-multimodal-ref-"));
  editPath = path.join(root, "vscode-screenshot.png");
  editBytes = Buffer.from("multimodal-edit-reference-bytes");
  await writeFile(editPath, editBytes);
  stylePath = path.join(root, "palette.png");
  styleBytes = Buffer.from("multimodal-style-reference-bytes");
  await writeFile(stylePath, styleBytes);
  textCalls = [];
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("the multimodal generateText branch carries typed References intact (INT-2)", () => {
  test("plate: recorded prompt equals the sent text; references arrive in declared order with exact bytes", async () => {
    const result = await generatePlates({
      subject: "simplified code editor interface",
      model: "nano-2",
      zone: "left",
      refs: [
        { role: "edit", path: editPath, contentHash: sha256(editBytes) },
        { role: "style", path: stylePath, contentHash: sha256(styleBytes) },
      ],
      count: 2,
    });

    // One provider call per candidate — the same verified bytes each time.
    expect(textCalls).toHaveLength(2);
    expect(result.plates).toHaveLength(2);

    // The recorded fullPrompt is exactly the text the model received, and it
    // role-assigns the references in declared order.
    expect(result.fullPrompt).toMatch(/image 1 — edit/);
    expect(result.fullPrompt).toMatch(/image 2 — style/);
    expect(result.fullPrompt).not.toContain(editPath);
    expect(result.fullPrompt).not.toContain(stylePath);

    for (const call of textCalls) {
      expect(call.model).toBe("google/gemini-3.1-flash-image");
      expect(call.messages).toHaveLength(1);
      const message = call.messages[0] as { role: string; content: { type: string; text?: string; image?: Uint8Array }[] };
      expect(message.role).toBe("user");
      // Recorded/effective prompt equality: the text part IS the fullPrompt.
      expect(message.content[0]).toEqual({ type: "text", text: result.fullPrompt });
      // Reference image order and exact bytes: edit first, style second.
      expect(message.content[1]?.type).toBe("image");
      expect(sha256(message.content[1]!.image!)).toBe(sha256(editBytes));
      expect(message.content[2]?.type).toBe("image");
      expect(sha256(message.content[2]!.image!)).toBe(sha256(styleBytes));
      expect(message.content).toHaveLength(3);
    }
    // Every candidate received byte-identical references (load-once).
    const first = JSON.stringify(textCalls[0]);
    const second = JSON.stringify(textCalls[1]);
    expect(second).toBe(first);
  });

  test("objects: same contract — the UI-panel permit and isolation bans ride the recorded prompt", async () => {
    const result = await generateObjects({
      subject: "simplified music player panel",
      model: "nano-2",
      refs: [{ role: "edit", path: editPath, contentHash: sha256(editBytes) }],
      count: 1,
    });

    expect(textCalls).toHaveLength(1);
    const message = textCalls[0]!.messages[0] as {
      role: string;
      content: { type: string; text?: string; image?: Uint8Array }[];
    };
    expect(message.role).toBe("user");
    expect(message.content[0]).toEqual({ type: "text", text: result.fullPrompt });
    expect(message.content[1]?.type).toBe("image");
    expect(sha256(message.content[1]!.image!)).toBe(sha256(editBytes));
    expect(message.content).toHaveLength(2);

    expect(result.fullPrompt).toMatch(/image 1 — edit/);
    expect(result.fullPrompt).not.toMatch(/no ui/i);
    expect(result.fullPrompt).toMatch(/no text/i);
    expect(result.fullPrompt).toMatch(/no logos?/i);
  });
});