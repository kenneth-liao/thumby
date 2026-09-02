/**
 * The TEST-012 harness publication boundary (PROD-1): evidence leaves the box
 * through exactly one serializer — every string passes credential redaction
 * for each supported Gateway auth source, then a length cap; warnings and
 * errors pass strict field whitelists. These tests plant secrets and stray
 * fields and prove the boundary removes them. No network, no spend.
 */
import { describe, test, expect } from "bun:test";
import path from "node:path";
import {
  publishableWarning,
  publishableError,
  publishedJson,
} from "../scripts/qualify-reference.js";

describe("publishedJson — the one publication boundary", () => {
  test("redacts a planted AI_GATEWAY_API_KEY value at any depth", () => {
    const key = "gw-key-abc123";
    process.env.AI_GATEWAY_API_KEY = key;
    try {
      const out = publishedJson({ a: { b: [`x ${key} y`] } });
      expect(out).not.toContain(key);
      expect(out).toContain("<redacted>");
    } finally {
      delete process.env.AI_GATEWAY_API_KEY;
    }
  });

  test("redacts a planted OIDC token — the other supported credential source", () => {
    const token = "oidc-token-xyz789";
    process.env.VERCEL_OIDC_TOKEN = token;
    try {
      const out = publishedJson({ note: `auth via ${token} failed` });
      expect(out).not.toContain(token);
      expect(out).toContain("<redacted>");
    } finally {
      delete process.env.VERCEL_OIDC_TOKEN;
    }
  });

  test("caps every string at 2000 characters", () => {
    const out = publishedJson({ long: "x".repeat(5000) });
    expect(out.length).toBeLessThan(2200);
    expect(JSON.parse(out).long.length).toBe(2000);
  });
});

describe("publishableWarning — strict field whitelist", () => {
  test("keeps the known warning fields", () => {
    expect(
      publishableWarning({ type: "unsupported", feature: "size", details: "ignored" }),
    ).toEqual({ type: "unsupported", feature: "size", details: "ignored" });
  });

  test("drops unknown fields and non-string values", () => {
    const out = publishableWarning({
      type: "other",
      secretEcho: "internal-request-abc",
      nested: { hidden: true },
      count: 3,
      message: "kept",
    });
    expect(out).toEqual({ type: "other", message: "kept" });
  });
});

describe("publishableError — status/type/ids/body whitelist", () => {
  test("keeps attribution fields and whitelists the error body", () => {
    const out = publishableError({
      name: "GatewayInvalidRequestError",
      type: "invalid_request_error",
      statusCode: 400,
      generationId: "gen_01ABC",
      message: "rejected the reference image",
      response: {
        error: { message: "bad image", type: "invalid_request_error", code: "ref_rejected" },
        requestEcho: { prompt: "must not leave the box" },
      },
    });
    expect(out).toEqual({
      name: "GatewayInvalidRequestError",
      type: "invalid_request_error",
      statusCode: 400,
      generationId: "gen_01ABC",
      message: "rejected the reference image",
      errorBody: { message: "bad image", type: "invalid_request_error", code: "ref_rejected" },
    });
  });

  test("a plain Error yields only its name and message", () => {
    const out = publishableError(new Error("boom"));
    expect(out).toEqual({ name: "Error", message: "boom" });
  });
});

describe("CLI fatal boundary (PROD-1 re-review)", () => {
  test("an unreadable absolute Reference path exits path-free: no local path, no credentials, no stack, capped lines", () => {
    const secretPath = "/nonexistent/qual-ref-probe-3f2a/ref.png";
    const keyPlant = "gw-key-plant-9d41c";
    const oidcPlant = "oidc-plant-7b2e0";
    const proc = Bun.spawnSync({
      cmd: [
        "bun",
        path.resolve(import.meta.dir, "../scripts/qualify-reference.ts"),
        "gpt-image",
        secretPath,
      ],
      env: { ...process.env, AI_GATEWAY_API_KEY: keyPlant, VERCEL_OIDC_TOKEN: oidcPlant },
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(proc.exitCode).toBe(1);
    const stderr = proc.stderr.toString();
    expect(stderr.trim().length).toBeGreaterThan(0);
    expect(stderr).not.toContain(secretPath); // no local filesystem layout
    expect(stderr).not.toContain(keyPlant); // no credential material
    expect(stderr).not.toContain(oidcPlant);
    expect(stderr).not.toContain("at "); // no stack frames
    for (const line of stderr.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(2100); // the length cap holds at the CLI boundary
    }
  });
});