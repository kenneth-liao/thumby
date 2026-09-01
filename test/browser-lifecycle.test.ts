import { describe, it, expect } from "bun:test";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright";
import { closeBrowser, getBrowser, withRenderPage } from "../src/browser.js";
import { renderScene } from "../src/scene-render.js";
import { type Scene, type SceneLayer, type ResolvedScene } from "../src/scene.js";
import { decodePng } from "./png.js";

// --- issue #27 regression: browser lifecycle under repetition --------------
//
// Rendering used to create and close a BrowserContext (+page) per render on
// the shared browser. In one Bun process, that churn deadlocked or lost the
// browser after enough cycles — the failure tracked the cumulative number of
// contexts, not scheduling. The fix is one shared context+page per process,
// serialized, self-healing. These tests pin that contract.

/** A shape-only scene loads nothing: no assets, no fonts, pure pixels. */
const shape = (over: Record<string, unknown> = {}): SceneLayer => ({
  id: "box",
  type: "shape",
  shape: "rect",
  color: "#ff0000",
  position: { x: 100, y: 100 },
  size: { width: 200, height: 100 },
  ...over,
});

const scene = (layers: SceneLayer[]): Scene => ({
  schemaVersion: 1,
  canvas: { width: 1280, height: 720 },
  layers,
});

const resolved = (layers: SceneLayer[]): ResolvedScene => ({
  scene: scene(layers),
  assets: new Map(),
  masks: new Map(),
});

/** A text layer whose family ships nowhere — the deterministic render failure
 * (rejected at resolveFace, before the browser runs). */
const badFont = (): SceneLayer => ({
  id: "t",
  type: "text",
  text: "boom",
  font: "NoSuchFamily Anywhere",
  fontSize: 40,
  color: "#000000",
  position: { x: 100, y: 100 },
  size: { width: 400, height: 100 },
});

function chromiumProcessAlive(): boolean {
  const execPath = chromium.executablePath();
  const ps = execFileSync("ps", ["-A", "-o", "command="], { encoding: "utf8" });
  // Headless launches are chrome-headless-shell, not executablePath()'s
  // Chromium app — match either, scoped to the playwright cache so we never
  // see the user's real browser.
  return ps
    .split("\n")
    .some((l) => l.includes(execPath) || (l.includes("chrome-headless-shell") && l.includes("ms-playwright")));
}

describe("browser lifecycle (issue #27)", () => {
  it("completes 50 browser-backed renders in one process, every PNG a valid 1280×720", async () => {
    for (let i = 0; i < 50; i++) {
      const { png, width, height } = await renderScene(
        resolved([shape({ color: i % 2 ? "#ff0000" : "#00ff00" })]),
      );
      expect(width).toBe(1280);
      expect(height).toBe(720);
      const img = decodePng(png);
      expect(img.width).toBe(1280);
      expect(img.height).toBe(720);
    }
  }, 300_000);

  it("keeps an injected page caller-owned and usable across repeated renders", async () => {
    const browser = await getBrowser();
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      deviceScaleFactor: 1,
    });
    await ctx.route("**/*", (route) => route.abort());
    const page = await ctx.newPage();
    for (let i = 0; i < 3; i++) {
      await renderScene(resolved([shape()]), { page });
    }
    // The render functions neither closed nor replaced the caller's page.
    expect(await page.evaluate(() => 1 + 1)).toBe(2);
    await ctx.close();
  }, 120_000);

  it("renders with all network routes blocked", async () => {
    const browser = await getBrowser();
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      deviceScaleFactor: 1,
    });
    await ctx.route("**/*", (route) => route.abort());
    const page = await ctx.newPage();
    const { png, width, height } = await renderScene(resolved([shape()]), { page });
    expect(width).toBe(1280);
    expect(height).toBe(720);
    const img = decodePng(png);
    expect(img.width).toBe(1280);
    await ctx.close();
  }, 120_000);

  it("survives a failed render, then renders again on the same shared lifecycle", async () => {
    await expect(renderScene(resolved([badFont()]))).rejects.toThrow(/unknown font family/);
    const { png, width, height } = await renderScene(resolved([shape()]));
    expect(width).toBe(1280);
    expect(height).toBe(720);
    expect(decodePng(png).width).toBe(1280);
  }, 120_000);

  it("self-heals a lost shared page without discarding the healthy browser", async () => {
    const browser = await getBrowser();
    const first = await renderScene(resolved([shape()]));
    expect(first.width).toBe(1280);
    // Simulate the loss externally: close only the shared render page (the
    // browser and its context stay healthy). The next render must recreate
    // the page and succeed — never expose a stale handle.
    const ctx = browser.contexts()[0]!;
    for (const p of ctx.pages()) await p.close();
    const again = await renderScene(resolved([shape({ color: "#0000ff" })]));
    expect(again.width).toBe(1280);
    expect(decodePng(again.png).width).toBe(1280);
    expect(await browser.isConnected()).toBe(true);
    await closeBrowser();
    expect(chromiumProcessAlive()).toBe(false);
  }, 120_000);

  it("reclaims and relaunches the shared lifecycle when the render surface dies mid-render", async () => {
    const browser = await getBrowser();
    await renderScene(resolved([shape()]));
    // withRenderPage is the public seam into the shared page: a render whose
    // surface closes underneath it must trigger the wedge-reclaim branch.
    await expect(
      withRenderPage(async (page) => {
        await page.close();
        throw new Error("Target page, context or browser has been closed");
      }),
    ).rejects.toThrow(/Target page/);
    // The wedged browser was shut down, not abandoned with a live process.
    expect(await browser.isConnected()).toBe(false);
    // The next render relaunches cleanly.
    const again = await renderScene(resolved([shape({ color: "#00ff00" })]));
    expect(again.width).toBe(1280);
    expect(decodePng(again.png).width).toBe(1280);
    await closeBrowser();
    expect(chromiumProcessAlive()).toBe(false);
  }, 120_000);

  it("launches exactly once under concurrent getBrowser calls, and closes the launched browser under a racing close", async () => {
    await closeBrowser();
    const [a, b, c] = await Promise.all([getBrowser(), getBrowser(), getBrowser()]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    // A close racing an in-flight launch: the launched browser must be the
    // one closed, not orphaned.
    await closeBrowser();
    const launch = getBrowser();
    await closeBrowser();
    await launch;
    expect(chromiumProcessAlive()).toBe(false);
  }, 120_000);

  it("leaves no Chromium process behind after the caller closes the shared browser", async () => {
    await renderScene(resolved([shape()]));
    expect(chromiumProcessAlive()).toBe(true);
    await closeBrowser();
    expect(chromiumProcessAlive()).toBe(false);
    // The lifecycle relaunches cleanly afterwards — close is not terminal.
    const { png, width, height } = await renderScene(resolved([shape()]));
    expect(width).toBe(1280);
    expect(height).toBe(720);
    expect(decodePng(png).width).toBe(1280);
    await closeBrowser();
  }, 120_000);
});
