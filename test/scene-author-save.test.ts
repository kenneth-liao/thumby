/**
 * The Scene author session's explicit save (#62), exercised through the real
 * CLI subprocess and a real browser — one browser-backed suite (TEST-003,
 * TEST-005, TEST-008, TEST-017).
 *
 * Save is the session's only Scene-writing route: an empty token-scoped POST
 * /save that joins the same handler-arrival FIFO queue as geometry. The
 * transaction re-runs the ordinary loadScene gate on the raw authored
 * candidate, serializes only that raw document (pretty JSON + newline), and —
 * under the per-Scene filesystem lock on the Scene's REAL path — refuses
 * unless the target's exact bytes still equal the source bytes the session
 * opened with, then publishes atomically. Every refusal is actionable and
 * writes nothing; only a successful replacement advances the baseline.
 *
 * The scenario builds phases on one live session: every accepted edit commits
 * through the one canonical candidate path, so each phase starts from the
 * previous phase's committed state, and revision/unsaved counts are asserted
 * exactly at every phase. The save-with-theme fixture pins `midnight`, so the
 * theme-resolved defaults (text tracking/shadows, image fit, shape radius)
 * exist only in the resolved render state — a save that persisted anything
 * but the authored document would fail the exact deep-equality checks.
 *
 * The write-failure branch cannot be safely induced through a real filesystem
 * fault, so it runs in-process through the save transaction's fault-injection
 * seam (the reference-import writeScene precedent) with a real control run —
 * production always uses the real lock/read/atomic-replace path.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { request as httpRequest } from "node:http";
import type { Page } from "playwright";
import { getBrowser } from "../src/browser.js";
import { contentHash, LIBRARY_ROOT, scanLibrary } from "../src/assets.js";
import { acquireSceneLock } from "../src/reference-import.js";
import { saveSessionScene } from "../src/scene-author.js";
import type { Scene } from "../src/scene.js";
import { run as cliRun, rerenderManifest } from "../src/scene-cli.js";
import { getTheme, themeRevision } from "../src/themes.js";
import {
  CLI,
  type Fixture,
  type JsonEvent,
  makeFixture,
  rawRequest,
  ROOT,
  SessionEvents,
} from "./author-helpers.js";

// --- fixture -----------------------------------------------------------------

const theme = getTheme("midnight");

/**
 * The save-focused Scene, pinned to the midnight theme: a full-canvas raster,
 * a shape, and a text Layer. The theme fills unset text/shape/image style
 * properties in the RESOLVED document only — the raw authored document stays
 * exactly as written, which is what a save must persist.
 */
const saveScene = (scene: Record<string, unknown>): Record<string, unknown> => ({
  ...scene,
  theme: { name: "midnight", revision: themeRevision(theme) },
  layers: [
    { id: "bg", type: "image", asset: "./bg.svg", position: { x: 0, y: 0 }, size: { width: 1280, height: 720 } },
    { id: "chip", type: "shape", shape: "rect", color: "#22cc88", position: { x: 900, y: 120 }, size: { width: 180, height: 110 } },
    { id: "headline", type: "text", text: "Save me", font: "Source Sans 3", fontSize: 64, color: "#ffffff", position: { x: 140, y: 80 }, size: { width: 420, height: 120 } },
  ],
});

/** Key order mirrors the fixture's written document (theme lands last). */
const expectedSavedDoc = (chipPos: { x: number; y: number }): Record<string, unknown> => ({
  schemaVersion: 1,
  canvas: { width: 1280, height: 720 },
  layers: [
    { id: "bg", type: "image", asset: "./bg.svg", position: { x: 0, y: 0 }, size: { width: 1280, height: 720 } },
    { id: "chip", type: "shape", shape: "rect", color: "#22cc88", position: chipPos, size: { width: 180, height: 110 } },
    { id: "headline", type: "text", text: "Save me", font: "Source Sans 3", fontSize: 64, color: "#ffffff", position: { x: 140, y: 80 }, size: { width: 420, height: 120 } },
  ],
  reference: { path: "./ref.png" },
  theme: { name: "midnight", revision: themeRevision(theme) },
});

/** The exact bytes a save must produce: the authored document, pretty, + newline. */
const expectedSavedBytes = (chipPos: { x: number; y: number }): Buffer =>
  Buffer.from(JSON.stringify(expectedSavedDoc(chipPos), null, 2) + "\n", "utf8");

// --- session-surface helpers (one home per suite) -----------------------------

/** Raw POST with exact route/body/content-type control, bypassing the page. */
const postRaw = (
  port: number,
  token: string,
  route: string,
  body: string | null,
  contentType: string | null,
): Promise<{ status: number; body: Buffer }> =>
  new Promise((resolve, reject) => {
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
    req.end(body ?? undefined);
  });

interface JsonBody {
  errors?: { path: string; message: string }[];
  rev?: number;
  saved?: boolean;
  warnings?: string[];
}

const parseJson = (body: Buffer): JsonBody => JSON.parse(body.toString("utf8")) as JsonBody;

// --- the live session ---------------------------------------------------------

describe("scene author — explicit save (#62)", () => {
  let fix: Fixture;
  let session: Bun.Subprocess<"ignore", "pipe", "pipe">;
  let events: SessionEvents;
  let started: { event: string; url: string };
  let url: URL;
  let token: string;
  let port: number;
  let closed: Promise<JsonEvent>;
  /** The chip's authored x as committed by the phases so far. */
  let chipX = 900;
  const chipPos = () => ({ x: chipX, y: 96 });

  beforeAll(async () => {
    fix = await makeFixture("save", saveScene);
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
    // Awaited by the shutdown test; the collector pumps either way.
    closed = events.waitForEvent("closed", 120_000);
  }, 180_000);

  afterAll(async () => {
    if (session && session.exitCode === null && session.signalCode === null) {
      session.kill("SIGTERM");
      await session.exited;
    }
    if (fix) await rm(fix.root, { recursive: true, force: true });
  });

  test(
    "the save route is capability-scoped POST-only, and an untouched session never writes",
    async () => {
      const bytesBefore = await readFile(fix.scenePath);
      // GET on the save route → 405, empty.
      const get = await rawRequest(port, `/${token}/save`);
      expect(get.status).toBe(405);
      expect(get.body.length).toBe(0);
      // A wrong capability → 404, empty — the route never leaks its existence.
      const wrongToken = await rawRequest(port, `/${"0".repeat(64)}/save`, { method: "POST" });
      expect(wrongToken.status).toBe(404);
      expect(wrongToken.body.length).toBe(0);
      // A missing content-type is refused at the boundary with its field named.
      const noType = await postRaw(port, token, "save", "{}", null);
      expect(noType.status).toBe(400);
      expect(parseJson(noType.body).errors?.[0]?.path).toBe("content-type");
      // A non-JSON body is refused.
      const badJson = await postRaw(port, token, "save", "not json", "application/json");
      expect(badJson.status).toBe(400);
      expect(parseJson(badJson.body).errors?.[0]?.message).toMatch(/not valid JSON/);
      // A carry-payload body is refused: a save carries nothing.
      const payload = await postRaw(port, token, "save", '{"x":1}', "application/json");
      expect(payload.status).toBe(400);
      expect(parseJson(payload.body).errors?.[0]?.message).toMatch(/unexpected field/);
      // Nothing above wrote the Scene.
      expect(Buffer.compare(await readFile(fix.scenePath), bytesBefore)).toBe(0);
    },
    30_000,
  );

  test(
    "the view carries the Save control and the unsaved presentation",
    async () => {
      const browser = await getBrowser();
      const ctx = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
        deviceScaleFactor: 1,
      });
      await ctx.route("**/*", (route) =>
        route.request().url().startsWith(url.origin) ? route.continue() : route.abort(),
      );
      const page: Page = await ctx.newPage();
      try {
        await page.goto(started.url);
        const status = page.locator("#status");
        expect(await status.textContent()).toBe("rev 0 · unsaved 0 · Scene file unchanged");
        expect(await status.getAttribute("data-rev")).toBe("0");
        expect(await status.getAttribute("data-saved")).toBe("0");
        // Exactly one Save control, enabled and visible in the status bar.
        expect(await page.locator("#save").count()).toBe(1);
        expect(await page.locator("#save").isEnabled()).toBe(true);
        expect(await page.locator(".statusbar #save").count()).toBe(1);
        expect(await page.locator(".listing .row.modified").count()).toBe(0);
      } finally {
        await ctx.close();
      }
    },
    60_000,
  );

  test(
    "the save scenario: numeric edits stay unsaved, the Save control saves exactly the authored document, and later edits become unsaved against the new baseline",
    async () => {
      const bytesAtStart = await readFile(fix.scenePath);
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
      const statusText = () => page.locator("#status").textContent();
      const row = page.locator('.listing .row[data-sel="1"]');
      /** A numeric geometry edit through the view's own form flow (the
       * exactness control): fill, blur, wait for the applied revision. */
      const editField = async (field: string, value: string, rev: number) => {
        const inp = page.locator(`.geometry .geom[data-sel="1"] input[data-field="${field}"]`);
        await inp.fill(value);
        await inp.blur();
        await page.waitForFunction(
          (rev) => Number(document.getElementById("status")?.getAttribute("data-rev")) === rev,
          rev,
          { timeout: 30_000 },
        );
      };

      try {
        await page.goto(started.url);
        expect(await statusText()).toBe("rev 0 · unsaved 0 · Scene file unchanged");

        // --- phase A: two exact numeric edits commit as revisions, unsaved ---
        await row.click();
        await editField("x", "936", 1);
        await editField("y", "96", 2);
        chipX = 936;
        expect(await statusText()).toBe("rev 2 · unsaved 1 · Scene file unchanged");
        expect(await row.getAttribute("class")).toContain("modified");
        expect(await row.locator(".was").textContent()).toBe("was 900,120");
        expect(await row.locator(".pos").textContent()).toBe("936,96");
        // No interaction wrote the Scene.
        expect(Buffer.compare(await readFile(fix.scenePath), bytesAtStart)).toBe(0);

        // --- phase B: the Save control saves through the gate, and the
        // unsaved markers reset against the saved baseline -------------------
        // Hold the /save request in the page router so the "saving…" state is
        // observable deterministically, then release it.
        let releaseSave: (() => void) | undefined;
        const gate = new Promise<void>((r) => {
          releaseSave = r;
        });
        await ctx.route("**/save", async (route) => {
          await gate;
          await route.continue();
        });
        const saveResponsePromise = page.waitForResponse(
          (r) => r.url().endsWith("/save") && r.request().method() === "POST",
        );
        await page.locator("#save").click();
        expect(await statusText()).toBe("saving…");
        releaseSave!();
        const saveRes = await saveResponsePromise;
        await ctx.unroute("**/save");
        expect(saveRes.status()).toBe(200);
        expect(saveRes.request().postData()).toBe("{}");
        const saveBody = (await saveRes.json()) as {
          rev: number;
          saved: boolean;
          layers: { id: string; position?: { persisted: { x: number; y: number }; current: { x: number; y: number } } }[];
        };
        expect(saveBody.rev).toBe(3);
        expect(saveBody.saved).toBe(true);
        const chipView = saveBody.layers.find((l) => l.id === "chip");
        expect(chipView?.position).toEqual({ persisted: chipPos(), current: chipPos() });
        // The applied view: saved, no modified rows, no "was" markers.
        await page.waitForFunction(
          () => document.getElementById("status")?.textContent === "rev 3 · unsaved 0 · Scene file saved",
          undefined,
          { timeout: 30_000 },
        );
        expect(await page.locator("#status").getAttribute("data-saved")).toBe("1");
        expect(await page.locator(".listing .row.modified").count()).toBe(0);
        expect(await row.locator(".was").textContent()).toBe("");

        // The file is exactly the authored document — pretty JSON + newline,
        // with nothing theme-resolved or derived added anywhere.
        const savedBytes = await readFile(fix.scenePath);
        expect(Buffer.compare(savedBytes, expectedSavedBytes(chipPos()))).toBe(0);
        // The lock was released: no lock file remains beside the Scene.
        expect((await readdir(fix.root)).filter((f) => f.endsWith(".lock"))).toEqual([]);

        // --- phase C: a later edit is unsaved against the saved baseline ----
        await editField("x", "950", 4);
        chipX = 950;
        expect(await statusText()).toBe("rev 4 · unsaved 1 · Scene file saved");
        expect(await row.locator(".was").textContent()).toBe("was 936,96");
        expect(await row.locator(".pos").textContent()).toBe("950,96");

        // --- phase D: the next save compares against the just-written bytes —
        // a stale-baseline bug would refuse this save instead of succeeding --
        const second = await postRaw(port, token, "save", "{}", "application/json");
        expect(second.status).toBe(200);
        const secondBody = parseJson(second.body);
        expect(secondBody.rev).toBe(5);
        expect(secondBody.saved).toBe(true);
        expect(Buffer.compare(await readFile(fix.scenePath), expectedSavedBytes(chipPos()))).toBe(0);

        // Every request the page made stayed on the loopback session.
        for (const req of requested) expect(req.startsWith(origin)).toBe(true);
      } finally {
        await ctx.close();
      }
    },
    300_000,
  );

  test(
    "a save arriving after an earlier edit persists exactly that committed edit; a later edit stays unsaved",
    async () => {
      // Fire the geometry request, then — after its handler has certainly
      // arrived (the pipeline enqueues before the first body read) — fire the
      // save. Arrival order is commit order, so the save must persist the
      // geometry edit and the file must land exactly on the edited document.
      const geometryPromise = postRaw(
        port,
        token,
        "geometry",
        JSON.stringify({ id: "chip", set: { x: 970 } }),
        "application/json",
      );
      await new Promise((r) => setTimeout(r, 20));
      const savePromise = postRaw(port, token, "save", "{}", "application/json");
      const [geometryRes, saveRes] = await Promise.all([geometryPromise, savePromise]);
      expect(geometryRes.status).toBe(200);
      expect(parseJson(geometryRes.body).rev).toBe(6);
      expect(saveRes.status).toBe(200);
      const saveBody = parseJson(saveRes.body);
      expect(saveBody.rev).toBe(7);
      expect(saveBody.saved).toBe(true);
      chipX = 970;
      expect(Buffer.compare(await readFile(fix.scenePath), expectedSavedBytes(chipPos()))).toBe(0);

      // A later edit stays unsaved: the file keeps the saved baseline.
      const later = await postRaw(
        port,
        token,
        "geometry",
        JSON.stringify({ id: "chip", set: { x: 980 } }),
        "application/json",
      );
      expect(later.status).toBe(200);
      expect(parseJson(later.body).rev).toBe(8);
      chipX = 980;
      expect(Buffer.compare(await readFile(fix.scenePath), expectedSavedBytes({ x: 970, y: 96 }))).toBe(0);
      const view = await rawRequest(port, `/${token}/view`);
      expect(view.body.toString("utf8")).toContain("rev 8 · unsaved 1 · Scene file saved");

      // Saving again persists the later edit against the just-written bytes.
      const third = await postRaw(port, token, "save", "{}", "application/json");
      expect(third.status).toBe(200);
      expect(parseJson(third.body).rev).toBe(9);
      expect(Buffer.compare(await readFile(fix.scenePath), expectedSavedBytes(chipPos()))).toBe(0);
    },
    60_000,
  );

  test(
    "a validation failure refuses with the field named, the original bytes unchanged, and the session recovers",
    async () => {
      const before = await readFile(fix.scenePath);
      // The gate re-reads project assets at save time: deleting one makes the
      // complete candidate fail resolution with a field-specific error.
      const bgPath = path.join(fix.root, "bg.svg");
      const bgOriginal = await readFile(bgPath);
      await rm(bgPath);
      const failed = await postRaw(port, token, "save", "{}", "application/json");
      expect(failed.status).toBe(400);
      const err = parseJson(failed.body).errors?.find((e) => e.path === "layers[0].asset");
      expect(err?.message).toMatch(/missing project asset/);
      // The original bytes are unchanged and the session state stands.
      expect(Buffer.compare(await readFile(fix.scenePath), before)).toBe(0);
      const view = await rawRequest(port, `/${token}/view`);
      expect(view.body.toString("utf8")).toContain("rev 9 · unsaved 0 · Scene file saved");

      // Fixing the problem makes the very next save succeed: a failure never
      // poisons the session.
      await writeFile(bgPath, bgOriginal);
      const recovered = await postRaw(port, token, "save", "{}", "application/json");
      expect(recovered.status).toBe(200);
      expect(parseJson(recovered.body).rev).toBe(10);
      expect(Buffer.compare(await readFile(fix.scenePath), expectedSavedBytes(chipPos()))).toBe(0);
    },
    60_000,
  );

  test(
    "a stale on-disk edit is refused, never overwritten, twice",
    async () => {
      // An external writer replaces the Scene after the session opened.
      const external = structuredClone(expectedSavedDoc(chipPos()));
      (external.layers as Record<string, unknown>[])[1]!.position = { x: 500, y: 120 };
      await writeFile(fix.scenePath, JSON.stringify(external));
      const externalBytes = await readFile(fix.scenePath);

      const refused = await postRaw(port, token, "save", "{}", "application/json");
      expect(refused.status).toBe(409);
      const err = parseJson(refused.body).errors?.[0];
      expect(err?.path).toBe("scene");
      expect(err?.message).toMatch(/changed after this session opened/);
      expect(err?.message).toMatch(/refuses to overwrite/);
      // The external edit is intact — the save never overwrote it.
      expect(Buffer.compare(await readFile(fix.scenePath), externalBytes)).toBe(0);
      // The session advanced nothing: a second save refuses identically.
      const again = await postRaw(port, token, "save", "{}", "application/json");
      expect(again.status).toBe(409);
      expect(parseJson(again.body).errors?.[0]?.path).toBe("scene");
      const view = await rawRequest(port, `/${token}/view`);
      expect(view.body.toString("utf8")).toContain("rev 10 · unsaved 0 · Scene file saved");
    },
    60_000,
  );

  test(
    "lock, re-read, and location failures refuse without writing",
    async () => {
      const atStart = await readFile(fix.scenePath);

      // A locked-out Scene (the fixture directory made read-only) refuses at
      // the lock with the lock path named, writing nothing.
      await chmod(fix.root, 0o555);
      try {
        const lockedOut = await postRaw(port, token, "save", "{}", "application/json");
        expect(lockedOut.status).toBe(500);
        expect(parseJson(lockedOut.body).errors?.[0]?.path).toBe("scene");
        expect(parseJson(lockedOut.body).errors?.[0]?.message).toMatch(/could not be locked/);
      } finally {
        await chmod(fix.root, 0o755);
      }
      expect(Buffer.compare(await readFile(fix.scenePath), atStart)).toBe(0);

      // An unreadable Scene file fails the under-lock re-read closed: a real
      // external corruption (the file swapped for a directory) passes the
      // realpath lookup but cannot be read.
      await rm(fix.scenePath);
      await mkdir(fix.scenePath);
      try {
        const unreadable = await postRaw(port, token, "save", "{}", "application/json");
        expect(unreadable.status).toBe(500);
        expect(parseJson(unreadable.body).errors?.[0]?.message).toMatch(/could not be re-read/);
      } finally {
        await rm(fix.scenePath, { recursive: true });
      }
      // A vanished Scene file cannot be located: the save writes nothing.
      const missing = await postRaw(port, token, "save", "{}", "application/json");
      expect(missing.status).toBe(500);
      expect(parseJson(missing.body).errors?.[0]?.message).toMatch(/cannot locate the Scene file/);
      // Restore the saved Scene for the render/relocation proof below.
      await writeFile(fix.scenePath, expectedSavedBytes(chipPos()));
      expect(Buffer.compare(await readFile(fix.scenePath), expectedSavedBytes(chipPos()))).toBe(0);
    },
    60_000,
  );

  test(
    "the saved Scene renders normally and rerenders offline, pixel-identical, after the bundle is relocated",
    async () => {
      const savedBytes = await readFile(fix.scenePath);
      expect(JSON.parse(savedBytes.toString("utf8"))).toEqual(expectedSavedDoc(chipPos()));

      // Copies live outside the bundle: a directory must never be copied into
      // itself. The session keeps running — it holds no handle on the file.
      const workDir = await mkdtemp(path.join(tmpdir(), "thumby-save-render-"));
      try {
        const bundle = path.join(workDir, "bundle");
        await cp(fix.root, bundle, { recursive: true });
        const render = await cliRun(["render", path.join(bundle, "scene.json")]);
        expect(render.exitCode).toBe(0);
        const out = render.output as { ok: boolean; output: string; manifest: string };
        expect(out.ok).toBe(true);
        const originalPng = await readFile(out.output);
        // The manifest records the saved Scene's byte identity.
        const manifest = JSON.parse(await readFile(out.manifest, "utf8")) as {
          scene: { sha256: string };
        };
        expect(manifest.scene.sha256).toBe(contentHash(savedBytes));

        // Relocate the whole bundle, delete the recorded output, and rerender
        // from the manifest with every network route aborted: the pixels come
        // back byte-identical.
        const relocated = path.join(workDir, "relocated");
        await cp(bundle, relocated, { recursive: true });
        const reproducedPath = path.join(
          relocated,
          path.relative(bundle, out.output),
        );
        await rm(reproducedPath);
        const browser = await getBrowser();
        const ctx = await browser.newContext();
        await ctx.route("**/*", (route) => route.abort());
        const page: Page = await ctx.newPage();
        const rerender = await rerenderManifest(
          path.join(relocated, path.relative(bundle, out.manifest)),
          { page },
        );
        await ctx.close();
        expect(rerender.exitCode).toBe(0);
        expect(Buffer.compare(await readFile(reproducedPath), originalPng)).toBe(0);
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    },
    120_000,
  );

  test(
    "SIGTERM drives the one shutdown path after saves and failures",
    async () => {
      session.kill("SIGTERM");
      expect(await session.exited).toBe(0);
      expect(await closed).toEqual({ event: "closed", ok: true });
      expect(events.events.map((e) => e.event)).toEqual(["started", "closed"]);
    },
    60_000,
  );
});

// --- in-process transaction tests (no browser) -------------------------------

describe("scene author — save transaction internals (#62)", () => {
  const library = () => scanLibrary(LIBRARY_ROOT);

  test(
    "the lock and the replacement both target the Scene's REAL path, so a symlink alias survives and contends on one lock",
    async () => {
      const fix = await makeFixture("save-symlink", saveScene);
      try {
        const realPath = path.join(fix.root, "real-scene.json");
        await rename(fix.scenePath, realPath);
        await symlink("real-scene.json", fix.scenePath);
        const bytes = await readFile(fix.scenePath); // reads through the alias
        const originalDoc = JSON.parse(bytes.toString("utf8")) as Scene;
        const candidate = structuredClone(originalDoc);
        const chip = candidate.layers[1] as unknown as { position: { x: number; y: number } };
        chip.position = { x: 700, y: 140 };

        // Holding the REAL target's lock stops a save opened through the
        // alias — the lock path it waits on is the real target's.
        const held = await acquireSceneLock(`${realPath}.lock`);
        try {
          const refused = await saveSessionScene({
            sceneFile: fix.scenePath,
            expectedSource: bytes,
            candidate,
            projectRoot: fix.root,
            library,
            lockTimeoutMs: 150,
          });
          expect(refused.ok).toBe(false);
          if (!refused.ok) {
            expect(refused.status).toBe(500);
            expect(refused.errors[0]?.message).toContain("real-scene.json.lock");
          }
        } finally {
          await held.release();
        }

        // With the lock free, the save replaces the REAL file; the alias is
        // still a symlink and reads back exactly the saved bytes.
        const saved = await saveSessionScene({
          sceneFile: fix.scenePath,
          expectedSource: bytes,
          candidate,
          projectRoot: fix.root,
          library,
        });
        expect(saved.ok).toBe(true);
        const st = await lstat(fix.scenePath);
        expect(st.isSymbolicLink()).toBe(true);
        expect((await readFile(realPath)).equals(saved.ok ? saved.bytes : Buffer.alloc(0))).toBe(true);
        expect(Buffer.compare(await readFile(fix.scenePath), saved.ok ? saved.bytes : Buffer.alloc(0))).toBe(0);
        const realDoc = JSON.parse((await readFile(realPath)).toString("utf8")) as {
          layers: { position: { x: number; y: number } }[];
        };
        expect(realDoc.layers[1]!.position).toEqual({ x: 700, y: 140 });
      } finally {
        await rm(fix.root, { recursive: true, force: true });
      }
    },
    60_000,
  );

  test(
    "a failing atomic replace refuses, leaves the prior Scene usable, and never reports success — while the same save without the seam succeeds",
    async () => {
      const fix = await makeFixture("save-write-fail", saveScene);
      try {
        const originalBytes = await readFile(fix.scenePath);
        const originalDoc = JSON.parse(originalBytes.toString("utf8")) as Scene;
        const candidate = structuredClone(originalDoc);
        const chip = candidate.layers[1] as unknown as { position: { x: number; y: number } };
        chip.position = { x: 700, y: 140 };

        // Control: the identical save through the REAL lock/read/replace path
        // succeeds — the seam below is the only fault, so the failure test
        // cannot pass for the wrong reason.
        const control = await saveSessionScene({
          sceneFile: fix.scenePath,
          expectedSource: originalBytes,
          candidate,
          projectRoot: fix.root,
          library: () => scanLibrary(LIBRARY_ROOT),
        });
        expect(control.ok).toBe(true);
        const written = control.ok ? control.bytes : Buffer.alloc(0);
        expect((await readFile(fix.scenePath)).equals(written)).toBe(true);

        // Fault injection: the same save with a failing publish refuses and
        // the prior Scene stays byte-identical and usable.
        const failing = await saveSessionScene({
          sceneFile: fix.scenePath,
          expectedSource: written,
          candidate,
          projectRoot: fix.root,
          library: () => scanLibrary(LIBRARY_ROOT),
          writeScene: () => Promise.reject(new Error("injected write failure")),
        });
        expect(failing.ok).toBe(false);
        if (!failing.ok) {
          expect(failing.status).toBe(500);
          expect(failing.errors[0]!.path).toBe("scene");
          expect(failing.errors[0]!.message).toMatch(/could not be written/);
          expect(failing.errors[0]!.message).toMatch(/previous Scene is unchanged and usable/);
        }
        expect((await readFile(fix.scenePath)).equals(written)).toBe(true);
        // No temp residue and no retained lock: the transaction cleaned up.
        const files = await readdir(fix.root);
        expect(
          files.filter((f) => f.startsWith("scene.json.tmp-") || f === "scene.json.lock"),
        ).toEqual([]);
      } finally {
        await rm(fix.root, { recursive: true, force: true });
      }
    },
    60_000,
  );
});