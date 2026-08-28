import { describe, it, expect } from "bun:test";
import { existsSync } from "node:fs";
import {
  PAIRINGS,
  DEFAULT_PAIRING,
  resolvePairing,
  fontAssetPath,
  readFontAsset,
  fontFaceCss,
  familyResolvedJs,
  type FontFace,
} from "../src/fonts.js";
import { compose } from "../src/compose.js";
import { chromium } from "playwright";

describe("bundled font pairings", () => {
  it("every pairing face resolves to bundled font files on disk", () => {
    for (const [key, p] of Object.entries(PAIRINGS)) {
      for (const face of [p.display, p.sans]) {
        expect(
          existsSync(fontAssetPath(face)),
          `${key}: "${face.family}" → ${face.file}`,
        ).toBe(true);
      }
    }
  });

  it("emits @font-face rules from local bytes (no network, no system fonts)", () => {
    const p = resolvePairing(DEFAULT_PAIRING);
    const css = fontFaceCss(p.display, p.sans);
    const faces = css.match(/@font-face/g)!;
    expect(faces.length).toBe(2);
    expect(css).toContain(`"${p.display.family}"`);
    expect(css).toContain(`font-weight: ${p.display.weight}`);
    expect(css).toContain("data:font/ttf;base64,");
  });

  it("fails loud when a requested font file is missing", () => {
    const ghost: FontFace = { family: "Ghost", weight: 400, file: "ghost.ttf" };
    expect(() => readFontAsset(ghost)).toThrow(/Ghost/);
    expect(() => fontFaceCss(ghost)).toThrow(/Ghost/);
  });
});

describe("fallback rejection probe", () => {
  const isResolved = new Function(
    `return ${familyResolvedJs}`,
  )() as (family: string) => Promise<boolean>;

  it("accepts a bundled family loaded via @font-face and rejects an unregistered one", async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    try {
      const p = resolvePairing(DEFAULT_PAIRING);
      await page.setContent(
        `<style>${fontFaceCss(p.display)}</style><body>x</body>`,
      );
      expect(await page.evaluate(isResolved, p.display.family)).toBe(true);
      expect(await page.evaluate(isResolved, "NoSuch Font")).toBe(false);
    } finally {
      await browser.close();
    }
  });

  it("rejects a registered family whose bytes fail to parse", async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    try {
      // Corrupt/unparseable bundled bytes are exactly what a Linux-like env
      // with missing files degrades to — the face registers but never loads.
      await page.setContent(
        `<style>@font-face { font-family: "Garbage"; font-weight: 400;
          src: url(data:font/ttf;base64,bm90LWFmb250) format("truetype"); }</style>
          <body>x</body>`,
      );
      expect(await page.evaluate(isResolved, "Garbage")).toBe(false);
    } finally {
      await browser.close();
    }
  });
});

describe("compose with bundled fonts", () => {
  // 1x1 PNG plate — enough to drive the full render path.
  const tinyPng = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );

  function spec() {
    return {
      plate: { bytes: new Uint8Array(tinyPng), mediaType: "image/png" },
      headline: "TEST\nHEADLINE",
      eyebrow: "eyebrow",
      sub: "sub",
      type: DEFAULT_PAIRING,
      cutoutSide: "left" as const,
      cutoutScale: 0.5,
      cutoutX: 0,
      style: "scrim",
      zone: "left" as const,
      accent: "#fff",
      fill: "#fff",
      stroke: "#000",
    };
  }

  it("renders a thumbnail with the bundled faces", async () => {
    const png = await compose(spec());
    expect(png.length).toBeGreaterThan(1000);
  });
});
