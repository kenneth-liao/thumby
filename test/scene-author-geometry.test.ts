/**
 * The live Scene author session's geometry editing (#61): resize handles and
 * exact numeric position/size controls, exercised through the real CLI
 * subprocess and a real browser — one browser-backed suite (TEST-003).
 *
 * The scenario builds phases on one live session: every accepted change
 * commits through the one canonical candidate path (loadScene gate →
 * renderSceneInspection → atomic state mutation), so each phase starts from
 * the previous phase's committed state. Nothing is ever saved: the Scene
 * file's bytes are compared at the end.
 *
 * Geometry facts under test (DEC-007): resize maps frame-px handle drags
 * through the renderer-measured linear bases — the ancestor basis P (already
 * proven by movement) and the full basis F including the Layer's own
 * transform — so a corner drag keeps the opposite transformed authored corner
 * exactly fixed, for any rotation, mirror, and scale. Handle positions come
 * from corners measured directly in the render DOM, never inferred from a
 * painted AABB.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { readFile, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import type { Page } from "playwright";
import { getBrowser } from "../src/browser.js";
import {
  CLI,
  makeFixture,
  ROOT,
  SessionEvents,
  type Fixture,
  type JsonEvent,
} from "./author-helpers.js";

// --- independent test-side basis math ---------------------------------------

const deg = (d: number) => (d * Math.PI) / 180;
type M = [number, number, number, number]; // row-major [a,b,c,d]: frame = [[a,c],[b,d]]·local
const mul2 = (m: M, x: M): M => [
  m[0] * x[0] + m[2] * x[1], m[1] * x[0] + m[3] * x[1],
  m[0] * x[2] + m[2] * x[3], m[1] * x[2] + m[3] * x[3],
];
const inv2 = (m: M): M => {
  const det = m[0] * m[3] - m[1] * m[2];
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det];
};
const apply2 = (m: M, dx: number, dy: number) => ({
  x: m[0] * dx + m[2] * dy,
  y: m[1] * dx + m[3] * dy,
});
/** CSS rotate(θ): clockwise on screen (y-down). */
const rotM = (d: number): M => [Math.cos(deg(d)), Math.sin(deg(d)), -Math.sin(deg(d)), Math.cos(deg(d))];
/** The card Group's composed basis — CSS "scale(2) rotate(30deg) scaleX(-1)"
 *  applies mirror → rotate → scale to its children's local coordinates. */
const cardBasis: M = mul2(mul2([2, 0, 0, 2], rotM(30)), [-1, 0, 0, 1]);

/**
 * The geometry-editing Scene: a top-level raster Layer (the tracer target),
 * a top-level shape, fixed-size text, a scaled+mirrored+rotated Group with a
 * nested image, an own-rotated (45°) shape, and a doubly-nested leaf — plus
 * a hidden Layer and a Connector. Tree order (the view's index space):
 * bg, photo, chip, headline, card, card-plate, card-tilt, card-inner, dot,
 * hush, link.
 */
const geometryScene = (scene: Record<string, unknown>): Record<string, unknown> => ({
  ...scene,
  layers: [
    { id: "bg", type: "image", asset: "./bg.svg", position: { x: 0, y: 0 }, size: { width: 1280, height: 720 } },
    { id: "photo", type: "image", asset: "./photo.svg", position: { x: 700, y: 300 }, size: { width: 320, height: 240 } },
    { id: "chip", type: "shape", shape: "rect", color: "#22cc88", position: { x: 140, y: 560 }, size: { width: 180, height: 110 } },
    {
      id: "headline",
      type: "text",
      text: "Geometry",
      font: "Source Sans 3",
      fontSize: 64,
      color: "#ffffff",
      position: { x: 140, y: 80 },
      size: { width: 420, height: 120 },
    },
    {
      id: "card",
      type: "group",
      position: { x: 180, y: 140 },
      size: { width: 360, height: 260 },
      scale: 2,
      mirror: true,
      rotation: 30,
      layers: [
        { id: "card-plate", type: "image", asset: "./photo.svg", position: { x: 16, y: 16 }, size: { width: 140, height: 100 } },
        { id: "card-tilt", type: "shape", shape: "rect", color: "#dd4477", position: { x: 210, y: 170 }, size: { width: 90, height: 60 }, rotation: 45 },
        {
          id: "card-inner",
          type: "group",
          position: { x: 40, y: 190 },
          size: { width: 120, height: 60 },
          scale: 1.5,
          layers: [
            { id: "dot", type: "shape", shape: "ellipse", color: "#ffcc00", position: { x: 10, y: 10 }, size: { width: 40, height: 30 } },
          ],
        },
      ],
    },
    { id: "hush", type: "shape", shape: "rect", color: "#555577", position: { x: 640, y: 600 }, size: { width: 100, height: 60 }, visible: false },
    { id: "link", type: "connector", from: "chip", to: "card", arrow: true },
  ],
});

describe("scene author — resize handles and numeric geometry (#61)", () => {
  let fix: Fixture;
  let session: Bun.Subprocess<"ignore", "pipe", "pipe">;
  let events: SessionEvents;
  let started: { event: string; url: string };
  let url: URL;
  let token: string;
  let port: number;
  let closed: Promise<JsonEvent>;

  beforeAll(async () => {
    fix = await makeFixture("geometry", geometryScene);
    session = Bun.spawn(["bun", CLI, "author", fix.scenePath], {
      cwd: ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    events = new SessionEvents(session);
    const evt = await events.waitForEvent("started", 120_000);
    started = evt as { event: string; url: string };
    url = new URL(started.url);
    port = Number(url.port);
    token = url.pathname.split("/").filter(Boolean)[0] ?? "";
    // Awaited by the final immutability phase; the collector pumps either way.
    closed = events.waitForEvent("closed", 120_000);
  }, 180_000);

  afterAll(async () => {
    if (session && session.exitCode === null && session.signalCode === null) {
      session.kill("SIGTERM");
      await session.exited;
    }
    if (fix) await rm(fix.root, { recursive: true, force: true });
  });

  /** In-page bounds of a canvas hit/highlight element, inverted from its style. */
  const boundsFromBox = async (page: Page, sel: string) => {
    const style = await page.locator(sel).getAttribute("style");
    const pct = (re: RegExp) => {
      const hit = style!.match(re);
      expect(hit).not.toBeNull();
      return Number(hit![1]);
    };
    return {
      // The server emits "left:X%" inline; after the view script rewrites a
      // box, CSSOM serializes "left: X%" — allow both.
      x: (pct(/left:\s*([\d.-]+)%/) / 100) * 1280,
      y: (pct(/top:\s*([\d.-]+)%/) / 100) * 720,
      width: (pct(/width:\s*([\d.-]+)%/) / 100) * 1280,
      height: (pct(/height:\s*([\d.-]+)%/) / 100) * 720,
    };
  };

  /**
   * One explicitly sequential end-to-end scenario on one live session. The
   * phases intentionally build on each other — every accepted change commits
   * through the one canonical path and the next phase starts from it — so the
   * phase order is part of this test's contract, and revision/unsaved counts
   * are asserted exactly at every phase. No sibling test edits geometry, so
   * this scenario owns its session from the "started" event onward.
   */
  test(
    "the geometry scenario: handle resize, numeric edits, and movement stay synchronized — all unsaved",
    async () => {
      const sceneBytesBefore = await readFile(fix.scenePath);
      const browser = await getBrowser();
      const ctx = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
        deviceScaleFactor: 1,
      });
      const origin = url.origin;
      const requested: string[] = [];
      ctx.on("request", (r) => requested.push(r.url()));
      await ctx.route("**/*", (route) =>
        route.request().url().startsWith(origin) ? route.continue() : route.abort(),
      );
      const page: Page = await ctx.newPage();
      interface ResponseLayer {
        id: string;
        visible: boolean;
        bounds: { x: number; y: number; width: number; height: number } | null;
        position?: { persisted: { x: number; y: number }; current: { x: number; y: number } };
        size?: { persisted: { width: number; height: number }; current: { width: number; height: number } };
        handles?: Record<"nw" | "ne" | "se" | "sw", { x: number; y: number }>;
        space?: string;
        geometryNote?: string;
      }
      interface GeometryResponse {
        rev: number;
        warnings: string[];
        layers: ResponseLayer[];
      }
      const byId = (body: GeometryResponse, id: string) => {
        const l = body.layers.find((x) => x.id === id);
        expect(l).toBeDefined();
        return l!;
      };
      const statusText = () => page.locator("#status").textContent();
      const appliedRev = async () =>
        Number(await page.locator("#status").getAttribute("data-rev"));
      const previewSrc = () => page.locator(".canvas img").getAttribute("src");
      /** A real pointer drag on a selected canvas hit target, by displayed-px
       *  delta. The Layer is selected through the listing first — a selected
       *  Layer's hit sits above every unselected hit — and the hit's center
       *  is asserted to be the topmost element at the drag point first. */
      const dragHit = async (sel: string, dxPx: number, dyPx: number) => {
        await page.locator(`.listing .row[data-sel="${sel}"]`).click();
        const point = await page.evaluate((sel: string) => {
          const el = document.querySelector(`.canvas .hit[data-sel="${sel}"]`);
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        }, sel);
        expect(point).not.toBeNull();
        const topmost = await page.evaluate(
          ({ x, y }: { x: number; y: number }) =>
            document.elementFromPoint(x, y)?.getAttribute("data-sel") ?? null,
          point!,
        );
        expect(topmost).toBe(sel);
        await page.mouse.move(point!.x, point!.y);
        await page.mouse.down();
        await page.mouse.move(point!.x + dxPx, point!.y + dyPx, { steps: 4 });
        await page.mouse.up();
      };
      /** Select a listing row (the single selection state). */
      const selectRow = (sel: string) => page.locator(`.listing .row[data-sel="${sel}"]`).click();
      /** A handle's canvas-px anchor, read back from its live inline style. */
      const handlePos = async (sel: string, handle: string) => {
        const style = await page
          .locator(`.canvas .handle[data-sel="${sel}"][data-handle="${handle}"]`)
          .getAttribute("style");
        const pct = (re: RegExp) => Number(re.exec(style!)![1]);
        return {
          x: (pct(/left:\s*([\d.-]+)%/) / 100) * 1280,
          y: (pct(/top:\s*([\d.-]+)%/) / 100) * 720,
        };
      };
      /** A real UI handle gesture (the view's own drag lifecycle), paired
       *  with the exact JSON response it produced, resolved only after the
       *  view has applied that response — request, canonical commit, and UI
       *  synchronization in one gesture. The frame-px delta equals the
       *  displayed-px drag scaled by the canvas factor. */
      const dragHandle = async (
        sel: string,
        handle: string,
        dxPx: number,
        dyPx: number,
      ): Promise<{ body: GeometryResponse; frameDx: number; frameDy: number }> => {
        const point = await page.evaluate(
          ({ sel, handle }: { sel: string; handle: string }) => {
            const el = document.querySelector(
              `.canvas .handle[data-sel="${sel}"][data-handle="${handle}"]`,
            );
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
          },
          { sel, handle },
        );
        expect(point).not.toBeNull();
        const topmost = await page.evaluate(
          ({ x, y }: { x: number; y: number }) =>
            document.elementFromPoint(x, y)?.getAttribute("data-handle") ?? null,
          point!,
        );
        expect(topmost).toBe(handle);
        const [response] = await Promise.all([
          page.waitForResponse(
            (r) => r.url().endsWith("/resize") && r.request().method() === "POST",
          ),
          (async () => {
            await page.mouse.move(point!.x, point!.y);
            await page.mouse.down();
            await page.mouse.move(point!.x + dxPx, point!.y + dyPx, { steps: 4 });
            await page.mouse.up();
          })(),
        ]);
        expect(response.status()).toBe(200);
        const body = (await response.json()) as GeometryResponse;
        // Applied before any DOM reread: the view's own apply() closure has
        // re-anchored every handle from this response.
        await page.waitForFunction(
          (rev) => Number(document.getElementById("status")?.getAttribute("data-rev")) === rev,
          body.rev,
          { timeout: 30_000 },
        );
        // The same canvas factor the view's gesture handler used.
        const displayedNow = (await page.locator(".canvas img").boundingBox())!.width;
        const frameScale = 1280 / displayedNow;
        return { body, frameDx: dxPx * frameScale, frameDy: dyPx * frameScale };
      };

      /** A raw POST with exact body/content-type control, bypassing the page. */
      const postRaw = (route: string, body: string, contentType: string | null) =>
        new Promise<{ status: number; body: Buffer }>((resolve, reject) => {
          const headers: Record<string, string> = { connection: "close" };
          if (contentType !== null) headers["content-type"] = contentType;
          const req = httpRequest(
            {
              host: "127.0.0.1",
              port,
              path: `/${token}/${route}`,
              method: "POST",
              headers,
            },
            (res) => {
              const chunks: Buffer[] = [];
              res.on("data", (c: Buffer) => chunks.push(c));
              res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
            },
          );
          req.on("error", reject);
          req.end(body);
        });

      try {
        await page.goto(started.url);
        // The displayed-canvas → frame-px scale factor, measured once: every
        // displayed-px gesture in this scenario maps through it.
        const displayed = (await page.locator(".canvas img").boundingBox())!.width;
        const scale = 1280 / displayed;

        // --- phase 1: the fresh session starts clean ------------------------
        expect(await page.locator(".listing .row.modified").count()).toBe(0);
        expect(await statusText()).toBe("rev 0 · unsaved 0 · Scene file unchanged");

        // --- phase 2: SE-handle resize on a top-level raster Layer ----------
        // Selecting the photo shows its four authored-corner handles; the
        // trace drags the SE handle by a known displayed-px delta.
        await page.locator('.listing .row[data-sel="1"]').click();
        expect(await page.locator('.canvas .handle[data-sel="1"]').count()).toBe(4);
        const seHandle = page.locator('.canvas .handle[data-sel="1"][data-handle="se"]');
        expect(await seHandle.evaluate((el) => getComputedStyle(el).display)).toBe("block");
        // The handle sits at the Layer's measured transformed SE corner —
        // for this untransformed top-level Layer, its authored box corner.
        const handlePoint = await page.evaluate(() => {
          const el = document.querySelector<HTMLElement>('.canvas .handle[data-sel="1"][data-handle="se"]');
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        });
        expect(handlePoint).not.toBeNull();
        const topmost = await page.evaluate(
          ({ x, y }: { x: number; y: number }) =>
            document.elementFromPoint(x, y)?.getAttribute("data-handle") ?? null,
          handlePoint!,
        );
        expect(topmost).toBe("se");
        await page.mouse.move(handlePoint!.x, handlePoint!.y);
        await page.mouse.down();
        await page.mouse.move(handlePoint!.x + 60, handlePoint!.y + 40, { steps: 4 });
        await page.mouse.up();
        await page.waitForFunction(
          () => Number(document.getElementById("status")?.getAttribute("data-rev")) === 1,
          undefined,
          { timeout: 30_000 },
        );
        const frameDx = 60 * scale;
        const frameDy = 40 * scale;
        // The SE edge followed the drag; the NW corner (the anchor) stayed.
        const photoAfter = await boundsFromBox(page, '.canvas .box[data-sel="1"]');
        expect(photoAfter.x).toBeCloseTo(700, 0);
        expect(photoAfter.y).toBeCloseTo(300, 0);
        expect(photoAfter.width).toBeCloseTo(320 + frameDx, 0);
        expect(photoAfter.height).toBeCloseTo(240 + frameDy, 0);
        // The authored size changed by exactly the frame delta; position did
        // not move. (Response facts, asserted via the DOM below.)
        expect(await statusText()).toBe("rev 1 · unsaved 1 · Scene file unchanged");
        // The preview swapped to a fresh canonical render, applied atomically.
        expect(await previewSrc()).toContain("data:image/png;base64,");

        // --- phase 3: numeric edits on the text Layer -----------------------
        await page.locator('.listing .row[data-sel="3"]').click();
        const form = page.locator('.geometry .geom[data-sel="3"]');
        expect(await form.count()).toBe(1);
        expect(await form.locator(".space").textContent()).toBe("canvas px");
        expect(await form.locator("input[data-field]").count()).toBe(4);
        // The exact authored defaults, rendered into the form.
        expect(await form.locator('input[data-field="x"]').inputValue()).toBe("140");
        expect(await form.locator('input[data-field="y"]').inputValue()).toBe("80");
        expect(await form.locator('input[data-field="width"]').inputValue()).toBe("420");
        expect(await form.locator('input[data-field="height"]').inputValue()).toBe("120");
        // Typing an exact width commits it as the authored value: fill sets
        // the value, blur (or Enter) commits the change event the form listens
        // for — a real user's flow.
        const widthInput = form.locator('input[data-field="width"]');
        await widthInput.fill("520");
        await widthInput.blur();
        await page.waitForFunction(
          () => Number(document.getElementById("status")?.getAttribute("data-rev")) === 2,
          undefined,
          { timeout: 30_000 },
        );
        // The form's accepted value followed the response (numeric edits
        // update their own fields).
        expect(await form.locator('input[data-field="width"]').inputValue()).toBe("520");
        expect(
          await form.locator('input[data-field="width"]').getAttribute("data-accepted"),
        ).toBe("520");
        // …and the listing and handles followed the same geometry state.
        const headlineBounds = (await page
          .locator('.listing .row[data-sel="3"] .bounds')
          .textContent())!;
        expect(headlineBounds).toContain("520×");
        const seLeft = await page
          .locator('.canvas .handle[data-sel="3"][data-handle="se"]')
          .evaluate((el) => el.style.left);
        expect(Number.parseFloat(seLeft)).toBeCloseTo((660 / 1280) * 100, 1);
        // The height commits the same way.
        const heightInput = form.locator('input[data-field="height"]');
        await heightInput.fill("160");
        await heightInput.blur();
        await page.waitForFunction(
          () => Number(document.getElementById("status")?.getAttribute("data-rev")) === 3,
          undefined,
          { timeout: 30_000 },
        );
        expect(await form.locator('input[data-field="height"]').inputValue()).toBe("160");
        expect(await statusText()).toBe("rev 3 · unsaved 2 · Scene file unchanged");

        // --- phase 4: all three methods read one geometry state ------------
        // The photo's numeric form shows exactly what the phase-2 HANDLE drag
        // authored: resize handles update the numeric fields.
        await page.locator('.listing .row[data-sel="1"]').click();
        const photoForm = page.locator('.geometry .geom[data-sel="1"]');
        expect(await photoForm.locator(".space").textContent()).toBe("canvas px");
        const photoW = Number(await photoForm.locator('input[data-field="width"]').inputValue());
        const photoH = Number(await photoForm.locator('input[data-field="height"]').inputValue());
        expect(photoW).toBeCloseTo(320 + frameDx, 1);
        expect(photoH).toBeCloseTo(240 + frameDy, 1);
        const photoX = Number(await photoForm.locator('input[data-field="x"]').inputValue());
        const photoY = Number(await photoForm.locator('input[data-field="y"]').inputValue());
        expect(photoX).toBeCloseTo(700, 1);
        expect(photoY).toBeCloseTo(300, 1);
        // A subsequent ordinary movement preserves the authored size while
        // updating the position fields and the listing.
        await dragHit("1", 20, 10);
        await page.waitForFunction(
          () => Number(document.getElementById("status")?.getAttribute("data-rev")) === 4,
          undefined,
          { timeout: 30_000 },
        );
        const moveDx = 20 * scale;
        const moveDy = 10 * scale;
        const posX = Number(await photoForm.locator('input[data-field="x"]').inputValue());
        const posY = Number(await photoForm.locator('input[data-field="y"]').inputValue());
        expect(posX).toBeCloseTo(700 + moveDx, 1);
        expect(posY).toBeCloseTo(300 + moveDy, 1);
        expect(Number(await photoForm.locator('input[data-field="width"]').inputValue())).toBeCloseTo(320 + frameDx, 1);
        expect(Number(await photoForm.locator('input[data-field="height"]').inputValue())).toBeCloseTo(240 + frameDy, 1);
        const photoRow = page.locator('.listing .row[data-sel="1"]');
        expect((await photoRow.locator(".pos").textContent())!).toBe(
          `${Number((700 + moveDx).toFixed(4))},${Number((300 + moveDy).toFixed(4))}`,
        );
        expect((await photoRow.getAttribute("class"))!).toContain("modified");
        expect(await statusText()).toBe("rev 4 · unsaved 2 · Scene file unchanged");

        // --- phase 5: nested and own-rotated resize, exact, through the UI --
        // Expected authored values come from independently composed bases.
        // Corner anchoring is read from the DOM handles only after the view
        // has applied each response — never from a manually replayed apply.

        // The nested image inside the scaled+mirrored+rotated Group: no own
        // transform, so F = P. An SE drag d maps to size delta F⁻¹·d and
        // position delta P⁻¹·d/2 − Δsize/2; the transformed NW corner stays
        // fixed and the SE corner moves by exactly d.
        await selectRow("5");
        const preNW = await handlePos("5", "nw");
        const preSE = await handlePos("5", "se");
        const dragA = await dragHandle("5", "se", 40, -20);
        expect(dragA.body.rev).toBe(5);
        const eA = apply2(inv2(cardBasis), dragA.frameDx, dragA.frameDy);
        const dPosA = apply2(inv2(cardBasis), dragA.frameDx / 2, dragA.frameDy / 2);
        const plateSize = byId(dragA.body, "card-plate").size!;
        expect(plateSize.persisted).toEqual({ width: 140, height: 100 });
        expect(plateSize.current.width).toBeCloseTo(140 + eA.x, 1);
        expect(plateSize.current.height).toBeCloseTo(100 + eA.y, 1);
        const platePos = byId(dragA.body, "card-plate").position!;
        expect(platePos.current.x).toBeCloseTo(16 + dPosA.x - eA.x / 2, 1);
        expect(platePos.current.y).toBeCloseTo(16 + dPosA.y - eA.y / 2, 1);
        // The DOM-measured corners after the applied response: opposite corner
        // anchored exactly, grabbed corner moved by exactly the frame drag.
        const postNW = await handlePos("5", "nw");
        const postSE = await handlePos("5", "se");
        expect(postNW.x).toBeCloseTo(preNW.x, 1);
        expect(postNW.y).toBeCloseTo(preNW.y, 1);
        expect(postSE.x).toBeCloseTo(preSE.x + dragA.frameDx, 1);
        expect(postSE.y).toBeCloseTo(preSE.y + dragA.frameDy, 1);
        // The response's measured corners agree with the re-anchored handles.
        expect(byId(dragA.body, "card-plate").handles!.nw.x).toBeCloseTo(postNW.x, 1);
        expect(byId(dragA.body, "card-plate").handles!.se.y).toBeCloseTo(postSE.y, 1);

        // The own-rotated (45°) shape: F = P·R(45) composes its own rotation
        // with the Group basis — exact, no rejection, no AABB model.
        const tiltF: M = mul2(cardBasis, rotM(45));
        await selectRow("6");
        const preTiltNW = await handlePos("6", "nw");
        const preTiltSE = await handlePos("6", "se");
        const dragB = await dragHandle("6", "se", 30, 24);
        expect(dragB.body.rev).toBe(6);
        const eB = apply2(inv2(tiltF), dragB.frameDx, dragB.frameDy);
        const dPosB = apply2(inv2(cardBasis), dragB.frameDx / 2, dragB.frameDy / 2);
        const tiltSize = byId(dragB.body, "card-tilt").size!;
        expect(tiltSize.current.width).toBeCloseTo(90 + eB.x, 1);
        expect(tiltSize.current.height).toBeCloseTo(60 + eB.y, 1);
        const tiltPos = byId(dragB.body, "card-tilt").position!;
        expect(tiltPos.current.x).toBeCloseTo(210 + dPosB.x - eB.x / 2, 1);
        expect(tiltPos.current.y).toBeCloseTo(170 + dPosB.y - eB.y / 2, 1);
        const postTiltNW = await handlePos("6", "nw");
        const postTiltSE = await handlePos("6", "se");
        expect(postTiltNW.x).toBeCloseTo(preTiltNW.x, 1);
        expect(postTiltNW.y).toBeCloseTo(preTiltNW.y, 1);
        expect(postTiltSE.x).toBeCloseTo(preTiltSE.x + dragB.frameDx, 1);
        expect(postTiltSE.y).toBeCloseTo(preTiltSE.y + dragB.frameDy, 1);

        // The nested coordinate space is labeled, and a numeric edit on the
        // doubly-nested leaf writes exact parent-local values (no frame
        // mapping): numeric semantics are authored-space semantics.
        await selectRow("8");
        const dotForm = page.locator('.geometry .geom[data-sel="8"]');
        expect(await dotForm.locator(".space").textContent()).toBe("card-inner local px");
        const dotW = dotForm.locator('input[data-field="width"]');
        await dotW.fill("55");
        await dotW.blur();
        await page.waitForFunction(
          () => Number(document.getElementById("status")?.getAttribute("data-rev")) === 7,
          undefined,
          { timeout: 30_000 },
        );
        expect(await dotW.inputValue()).toBe("55");
        // photo (position+size), headline (size), card-plate (position+size),
        // card-tilt (position+size), dot (size) — five unsaved Layers.
        expect(await statusText()).toBe("rev 7 · unsaved 5 · Scene file unchanged");

        // --- phase 6: invalid geometry never replaces the last valid preview
        const previewAtRev7 = await previewSrc();
        // (a) A typed zero width: rejected, named field-specifically, the form
        // restored from its data-accepted home, preview byte-identical.
        await selectRow("3");
        const headlineForm = page.locator('.geometry .geom[data-sel="3"]');
        const hW = headlineForm.locator('input[data-field="width"]');
        await hW.fill("0");
        await hW.blur();
        await page.waitForFunction(
          (prev) => document.getElementById("status")?.textContent !== prev,
          await statusText(),
          { timeout: 30_000 },
        );
        expect(await statusText()).toContain("width");
        expect(await statusText()).toContain("positive");
        expect(await hW.inputValue()).toBe("520");
        expect(await hW.getAttribute("data-accepted")).toBe("520");
        expect(await previewSrc()).toBe(previewAtRev7);
        expect(await appliedRev()).toBe(7);
        // (b) A negative height over the raw boundary: same retention.
        const negative = await postRaw("geometry", JSON.stringify({ id: "headline", set: { height: -5 } }), "application/json");
        expect(negative.status).toBe(400);
        expect(negative.body.toString("utf8")).toContain("size.height");
        // (c) A non-finite value smuggled through raw JSON (1e999 parses to
        // Infinity): rejected at the boundary as non-finite.
        const nonFinite = await postRaw("geometry", '{"id":"headline","set":{"width":1e999}}', "application/json");
        expect(nonFinite.status).toBe(400);
        expect(nonFinite.body.toString("utf8")).toContain("finite");
        // (d) Strict shapes: unknown fields, an empty set, an unknown handle.
        const unknownKey = await postRaw("geometry", JSON.stringify({ id: "headline", set: { width: 10 }, extra: 1 }), "application/json");
        expect(unknownKey.status).toBe(400);
        expect(unknownKey.body.toString("utf8")).toContain("unexpected field");
        const emptySet = await postRaw("geometry", JSON.stringify({ id: "headline", set: {} }), "application/json");
        expect(emptySet.status).toBe(400);
        const unknownHandle = await postRaw("resize", JSON.stringify({ id: "photo", handle: "center", dx: 1, dy: 1 }), "application/json");
        expect(unknownHandle.status).toBe(400);
        expect(unknownHandle.body.toString("utf8")).toContain("corner handle");
        const wrongType = await postRaw("geometry", JSON.stringify({ id: "headline", set: { width: 10 } }), "text/plain");
        expect(wrongType.status).toBe(400);
        expect(wrongType.body.toString("utf8")).toContain("application/json");
        const oversized = await postRaw("geometry", JSON.stringify({ id: "headline", set: { width: 10 }, pad: "x".repeat(17 * 1024) }), "application/json");
        expect(oversized.status).toBe(413);
        // (e) A handle drag that would collapse the size below zero: the
        // NW corner dragged far past the opposite edge. The rejection is
        // field-specific; the preview and revision stand.
        await selectRow("1");
        const negPoint = await page.evaluate(() => {
          const el = document.querySelector('.canvas .handle[data-sel="1"][data-handle="nw"]');
          const r = el!.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        });
        const [negResponse] = await Promise.all([
          page.waitForResponse((r) => r.url().endsWith("/resize") && r.request().method() === "POST"),
          (async () => {
            await page.mouse.move(negPoint.x, negPoint.y);
            await page.mouse.down();
            await page.mouse.move(negPoint.x + 2000, negPoint.y + 2000, { steps: 4 });
            await page.mouse.up();
          })(),
        ]);
        expect(negResponse.status()).toBe(400);
        const negBody = (await negResponse.json()) as { errors: { path: string; message: string }[] };
        expect(negBody.errors[0]!.path).toContain("size.width");
        expect(await previewSrc()).toBe(previewAtRev7);
        expect(await appliedRev()).toBe(7);
        expect(await statusText()).toContain("positive");

        // --- phase 7: a Connector is read-only, with the reason --------------
        await selectRow("10");
        expect(await page.locator('.canvas .handle[data-sel="10"]').count()).toBe(0);
        const linkPanel = page.locator('.geometry .geom[data-sel="10"]');
        expect(await linkPanel.count()).toBe(1);
        const linkNote = (await linkPanel.locator(".geom-note").textContent())!;
        expect(linkNote).toContain("no authored position or size");
        expect(linkNote).toContain("target Layers");
        const linkResize = await postRaw("resize", JSON.stringify({ id: "link", handle: "se", dx: 1, dy: 1 }), "application/json");
        expect(linkResize.status).toBe(400);
        expect(linkResize.body.toString("utf8")).toContain("no authored position or size");
        const linkGeometry = await postRaw("geometry", JSON.stringify({ id: "link", set: { x: 5 } }), "application/json");
        expect(linkGeometry.status).toBe(400);
        // The numeric backstop names exactly the field this edit needs.
        expect(linkGeometry.body.toString("utf8")).toContain("no authored position");
        const linkGeometrySize = await postRaw("geometry", JSON.stringify({ id: "link", set: { width: 5 } }), "application/json");
        expect(linkGeometrySize.status).toBe(400);
        expect(linkGeometrySize.body.toString("utf8")).toContain("no authored size");

        // --- phase 8: nothing was ever saved ---------------------------------
        const sceneBytesAfter = await readFile(fix.scenePath);
        expect(Buffer.compare(sceneBytesBefore, sceneBytesAfter)).toBe(0);
        // Every request the page made stayed on the loopback session.
        for (const req of requested) expect(req.startsWith(origin)).toBe(true);
      } finally {
        await ctx.close();
      }
    },
    300_000,
  );
});