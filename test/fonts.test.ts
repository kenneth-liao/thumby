import { describe, it, expect } from "bun:test";
import { existsSync } from "node:fs";
import {
  BUNDLED_FACES,
  fontAssetPath,
  readFontAsset,
  fontFaceCss,
  familyResolved,
  type FontFace,
} from "../src/fonts.js";
import { chromium } from "playwright";

describe("bundled fonts", () => {
  it("every bundled face resolves to a font file on disk", () => {
    for (const face of BUNDLED_FACES.values()) {
      expect(
        existsSync(fontAssetPath(face)),
        `"${face.family}" → ${face.file}`,
      ).toBe(true);
    }
  });

  it("emits @font-face rules from local bytes (no network, no system fonts)", () => {
    const [first, second] = [...BUNDLED_FACES.values()];
    const css = fontFaceCss(first!, second!);
    const faces = css.match(/@font-face/g)!;
    expect(faces.length).toBe(2);
    expect(css).toContain(`"${first!.family}"`);
    expect(css).toContain(`font-weight: ${first!.weight}`);
    expect(css).toContain("data:font/ttf;base64,");
  });

  it("fails loud when a requested font file is missing", () => {
    const ghost: FontFace = { family: "Ghost", weight: 400, file: "ghost.ttf" };
    expect(() => readFontAsset(ghost)).toThrow(/Ghost/);
    expect(() => fontFaceCss(ghost)).toThrow(/Ghost/);
  });
});

describe("fallback rejection probe", () => {
  it("accepts a bundled family loaded via @font-face and rejects an unregistered one", async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    try {
      const face = BUNDLED_FACES.values().next().value!;
      await page.setContent(
        `<style>${fontFaceCss(face)}</style><body>x</body>`,
      );
      expect(await page.evaluate(familyResolved, face.family)).toBe(true);
      expect(await page.evaluate(familyResolved, "NoSuch Font")).toBe(false);
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
      expect(await page.evaluate(familyResolved, "Garbage")).toBe(false);
    } finally {
      await browser.close();
    }
  });
});
