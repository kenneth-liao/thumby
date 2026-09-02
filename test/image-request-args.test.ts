/**
 * The image-kind provider request shape at its one home (TEST-012 harness
 * contract, INT-2): production generation and the qualification harness must
 * build equivalent provider arguments from one constructor, so the harness can
 * never certify a call shape production no longer takes. The deliberate
 * TEST-012 preflight bypass lives in the harness, not here.
 */
import { describe, test, expect } from "bun:test";
import { buildImageRequestArgs } from "../src/generate.js";
import { MODELS } from "../src/models.js";

describe("buildImageRequestArgs", () => {
  test("gpt-image with a reference: registry id, bytes in prompt.images, explicit size", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    expect(
      buildImageRequestArgs(MODELS["gpt-image"], "the prompt", [bytes]),
    ).toEqual({
      model: "openai/gpt-image-2",
      prompt: { text: "the prompt", images: [bytes] },
      size: "1536x864",
    });
  });

  test("gpt-image without references: plain string prompt, explicit size", () => {
    const args = buildImageRequestArgs(MODELS["gpt-image"], "the prompt", []);
    expect(args).toEqual({
      model: "openai/gpt-image-2",
      prompt: "the prompt",
      size: "1536x864",
    });
  });

  test("aspectRatio-sized image models take 16:9 and never a size", () => {
    const args = buildImageRequestArgs(MODELS["flux"], "the prompt", []);
    expect(args).toEqual({
      model: "bfl/flux-2-flex",
      prompt: "the prompt",
      aspectRatio: "16:9",
    });
    expect(args.size).toBeUndefined();
  });

  test("multimodal models are unrepresentable here — generateText shape only", () => {
    expect(() => buildImageRequestArgs(MODELS["nano-2"], "the prompt", [])).toThrow(
      /generateText/,
    );
  });
});