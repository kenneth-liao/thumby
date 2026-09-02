/**
 * The live Scene author session (#58), exercised through the real CLI
 * subprocess — the one browser-backed suite of this process.
 *
 * Pre-listen gating: `scene author <scene.json>` starts only after the full
 * Scene gate, the required-Reference gate (presence + checkReference: format,
 * dimensions, containment), and one in-memory Render. A missing or invalid
 * Reference fails before a session is ever exposed, naming the field to fix.
 *
 * Live surface: the "started" event is one-line JSON whose url carries a
 * 32-byte capability on an ephemeral loopback port — the capability exists
 * only inside session.url. Only exact-Host, token-scoped GET routes
 * (/view, /render.png, /reference.png) answer; anything else is an empty
 * 403/404/405, and there is no path-based file serving. The view is a
 * script-free CSS side-by-side + adjustable overlay under a
 * default/script/connect/object 'none' CSP with no-store/nosniff/no-referrer;
 * /reference.png serves the exact validated bytes (never reread). SIGTERM
 * drives the one shutdown path: the "closed" event, the listener released,
 * and the child Chromium reaped.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { request as httpRequest } from "node:http";
import type { Page } from "playwright";
import { getBrowser } from "../src/browser.js";
import { shutdownSession } from "../src/scene-author.js";
import { encodePngRgba } from "../src/png.js";

const execFileP = promisify(execFile);

const ROOT = path.resolve(import.meta.dir, "..");
const CLI = path.join(ROOT, "src/scene-cli.ts");

/** The session CSP, asserted byte-exact — the contract the view relies on.
 *  #60: the one same-origin script (app.js), same-origin movement fetches,
 *  and data-URI preview images are the only relaxations from the script-free
 *  #58 posture; every other directive stays 'none'. */
const CSP =
  "default-src 'none'; script-src 'self'; connect-src 'self'; object-src 'none'; " +
  "img-src 'self' data:; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

const CAPABILITY = /^[0-9a-f]{64}$/;
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

// --- fixtures --------------------------------------------------------------

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720"><rect width="1280" height="720" fill="#10233f"/></svg>`;
/** Intrinsic 200×200 source for the live fixture's cropped layer. */
const PHOTO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="#3366aa"/><circle cx="100" cy="100" r="70" fill="#ffcc00"/></svg>`;

/** Left half red, right half blue — a valid 1280×720 reference with spatial variation. */
const halfReferenceRgba = (): Buffer => {
  const rgba = Buffer.alloc(1280 * 720 * 4);
  for (let y = 0; y < 720; y++)
    for (let x = 0; x < 1280; x++) {
      const i = (y * 1280 + x) * 4;
      rgba[i] = x < 640 ? 255 : 0;
      rgba[i + 2] = x < 640 ? 0 : 255;
      rgba[i + 3] = 255;
    }
  return rgba;
};

interface Fixture {
  root: string;
  scenePath: string;
  referencePath: string;
}

/** A minimal valid Scene bundle: project-local SVG layer + a 1280×720 reference. */
async function makeFixture(
  name: string,
  override?: (scene: Record<string, unknown>) => Record<string, unknown>,
): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), `thumby-author-${name}-`));
  await writeFile(path.join(root, "bg.svg"), SVG);
  await writeFile(path.join(root, "photo.svg"), PHOTO_SVG);
  const referencePath = path.join(root, "ref.png");
  await writeFile(referencePath, encodePngRgba(1280, 720, halfReferenceRgba()));
  const scene: Record<string, unknown> = {
    schemaVersion: 1,
    canvas: { width: 1280, height: 720 },
    layers: [
      {
        id: "bg",
        type: "image",
        asset: "./bg.svg",
        position: { x: 0, y: 0 },
        size: { width: 1280, height: 720 },
      },
    ],
    reference: { path: "./ref.png" },
  };
  const scenePath = path.join(root, "scene.json");
  await writeFile(scenePath, JSON.stringify(override ? override(scene) : scene));
  return { root, scenePath, referencePath };
}

/**
 * An id exercising HTML escaping end to end — valid per the schema (a
 * non-empty unique string), but executable markup if ever interpolated
 * unescaped. Selectors must carry only generated indices.
 */
const SNEAKY_ID = 'sneaky"><svg onload=alert(1)>';

/**
 * The live session's richer Scene (#59): every layer kind the view must
 * list and select — image, auto-fit text, shape, a user-authored id needing
 * escaping, a mirrored shape, a cropped image, a scaled Group with nested
 * (one rotated) children, a plain Group with a zero-opacity child, a
 * zero-opacity Group (and its child), a zero-opacity leaf, an own-hidden
 * shape, and a Connector with an arrow. Tree order (the view's index
 * space): bg, headline, chip, sneaky, flip, portrait, card, card-plate,
 * card-tilt, tag, tag-dot, tag-fade, hush, hush-dot, faded, ghost, line.
 */
const layerInspectionScene = (scene: Record<string, unknown>): Record<string, unknown> => ({
  ...scene,
  layers: [
    { id: "bg", type: "image", asset: "./bg.svg", position: { x: 0, y: 0 }, size: { width: 1280, height: 720 } },
    {
      id: "headline",
      type: "text",
      text: "Layer inspection",
      font: "Source Sans 3",
      position: { x: 60, y: 40 },
      size: { width: 700, height: 140 },
      autoFit: { min: 24, max: 110 },
    },
    { id: "chip", type: "shape", shape: "rect", color: "#ff0044", radius: 12, position: { x: 120, y: 320 }, size: { width: 260, height: 160 } },
    { id: SNEAKY_ID, type: "shape", shape: "ellipse", color: "#22cc88", position: { x: 880, y: 420 }, size: { width: 220, height: 140 } },
    { id: "flip", type: "shape", shape: "rect", color: "#2f6fdb", position: { x: 620, y: 540 }, size: { width: 180, height: 110 }, mirror: true },
    {
      id: "portrait",
      type: "image",
      asset: "./photo.svg",
      position: { x: 1000, y: 80 },
      size: { width: 200, height: 140 },
      crop: { left: 10, top: 10, right: 10, bottom: 10 },
      fit: "cover",
    },
    {
      id: "card",
      type: "group",
      position: { x: 180, y: 120 },
      size: { width: 300, height: 170 },
      scale: 1.5,
      layers: [
        { id: "card-plate", type: "shape", shape: "rect", color: "#4455aa", position: { x: 16, y: 16 }, size: { width: 268, height: 138 } },
        { id: "card-tilt", type: "shape", shape: "rect", color: "#dd8822", position: { x: 40, y: 50 }, size: { width: 120, height: 80 }, rotation: 30 },
      ],
    },
    {
      id: "tag",
      type: "group",
      position: { x: 640, y: 180 },
      size: { width: 160, height: 90 },
      layers: [
        { id: "tag-dot", type: "shape", shape: "ellipse", color: "#d9a441", position: { x: 10, y: 10 }, size: { width: 70, height: 70 } },
        { id: "tag-fade", type: "shape", shape: "rect", color: "#7a4a9a", position: { x: 90, y: 20 }, size: { width: 60, height: 50 }, opacity: 0 },
      ],
    },
    {
      id: "hush",
      type: "group",
      position: { x: 60, y: 560 },
      size: { width: 140, height: 80 },
      opacity: 0,
      layers: [
        { id: "hush-dot", type: "shape", shape: "rect", color: "#4a7a5a", position: { x: 10, y: 10 }, size: { width: 60, height: 50 } },
      ],
    },
    { id: "faded", type: "shape", shape: "rect", color: "#aa3344", position: { x: 1060, y: 600 }, size: { width: 120, height: 70 }, opacity: 0 },
    { id: "ghost", type: "shape", shape: "rect", color: "#333333", position: { x: 400, y: 500 }, size: { width: 120, height: 80 }, visible: false },
    { id: "line", type: "connector", from: "chip", to: SNEAKY_ID, arrow: true, width: 4 },
  ],
});

// --- subprocess helpers ----------------------------------------------------

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Run the real CLI subprocess to exit (pre-listen cases never open a session). */
async function runAuthorToExit(scenePath: string, timeoutMs = 30_000): Promise<RunResult> {
  const proc = Bun.spawn(["bun", CLI, "author", scenePath], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  clearTimeout(timer);
  return { exitCode, stdout, stderr };
}

/** HTTP request with exact Host-header control (the session's auth surface). */
function rawRequest(
  port: number,
  reqPath: string,
  opts: { method?: string; host?: string } = {},
): Promise<{
  status: number;
  body: Buffer;
  headers: Record<string, string | string[] | undefined>;
}> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: reqPath,
        method: opts.method ?? "GET",
        headers: opts.host === undefined ? {} : { Host: opts.host },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks),
            headers: res.headers,
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

type JsonEvent = Record<string, unknown> & { event?: string };

/**
 * Pumps the session's stdout in the background, collecting one-line JSON
 * events as they arrive; waiters resolve on the matching event.
 */
class SessionEvents {
  readonly events: JsonEvent[] = [];
  readonly #proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  readonly #waiters: {
    test: (e: JsonEvent) => boolean;
    resolve: (e: JsonEvent) => void;
    timer: ReturnType<typeof setTimeout>;
  }[] = [];

  constructor(proc: Bun.Subprocess<"ignore", "pipe", "pipe">) {
    this.#proc = proc;
    void this.#pump();
  }

  async #pump(): Promise<void> {
    const dec = new TextDecoder();
    let buf = "";
    const reader = this.#proc.stdout.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        this.#line(buf.slice(0, i).trim());
        buf = buf.slice(i + 1);
      }
    }
    if (buf.trim()) this.#line(buf.trim());
  }

  #line(line: string): void {
    if (!line) return;
    let evt: JsonEvent;
    try {
      evt = JSON.parse(line) as JsonEvent;
    } catch {
      return;
    }
    this.events.push(evt);
    for (const w of this.#waiters.splice(0)) {
      if (w.test(evt)) {
        clearTimeout(w.timer);
        w.resolve(evt);
      } else {
        this.#waiters.push(w);
      }
    }
  }

  waitForEvent(name: string, timeoutMs = 30_000): Promise<JsonEvent> {
    const seen = this.events.find((e) => e.event === name);
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`no "${name}" event within ${timeoutMs}ms`)),
        timeoutMs,
      );
      this.#waiters.push({ test: (e) => e.event === name, resolve, timer });
    });
  }
}

// --- process-tree helpers --------------------------------------------------

async function processTable(): Promise<Map<number, number>> {
  const { stdout } = await execFileP("ps", ["-axo", "pid=,ppid="]);
  const table = new Map<number, number>();
  for (const line of stdout.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (m) table.set(Number(m[1]), Number(m[2]));
  }
  return table;
}

async function descendantPids(rootPid: number): Promise<Set<number>> {
  const table = await processTable();
  const kids = new Map<number, number[]>();
  for (const [pid, ppid] of table) {
    const list = kids.get(ppid);
    if (list) list.push(pid);
    else kids.set(ppid, [pid]);
  }
  const out = new Set<number>();
  const queue = [rootPid];
  while (queue.length) {
    for (const child of kids.get(queue.pop()!) ?? []) {
      if (!out.has(child)) {
        out.add(child);
        queue.push(child);
      }
    }
  }
  return out;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// --- pre-listen validation ---------------------------------------------------

describe("scene author — pre-listen validation", () => {
  test("a Scene with no Reference Thumbnail fails before any session, naming the field", async () => {
    const fix = await makeFixture("no-ref", (scene) => {
      const rest = { ...scene };
      delete rest.reference;
      return rest;
    });
    try {
      const { exitCode, stdout, stderr } = await runAuthorToExit(fix.scenePath);
      expect(exitCode).toBe(1);
      // One structured document on stdout — no session events were emitted.
      const doc = JSON.parse(stdout) as { ok: boolean; errors: { path: string; message: string }[] };
      expect(doc.ok).toBe(false);
      const err = doc.errors.find((e) => e.path === "reference");
      expect(err?.message).toMatch(/reference\.path/);
      expect(stdout).not.toContain('"event"');
      expect(stderr).toBe("");
    } finally {
      await rm(fix.root, { recursive: true, force: true });
    }
  }, 30_000);

  test("a reference path pointing at nothing fails pre-listen, naming reference.path", async () => {
    const fix = await makeFixture("gone-ref", (scene) => ({
      ...scene,
      reference: { path: "./missing.png" },
    }));
    try {
      const { exitCode, stdout, stderr } = await runAuthorToExit(fix.scenePath);
      expect(exitCode).toBe(1);
      const doc = JSON.parse(stdout) as { ok: boolean; errors: { path: string; message: string }[] };
      expect(doc.ok).toBe(false);
      const err = doc.errors.find((e) => e.path === "reference.path");
      expect(err?.message).toMatch(/not found/);
      expect(stdout).not.toContain('"event"');
      expect(stderr).toBe("");
    } finally {
      await rm(fix.root, { recursive: true, force: true });
    }
  }, 30_000);

  test("a reference that is not a readable PNG fails pre-listen, naming reference.path", async () => {
    const fix = await makeFixture("bad-ref", (scene) => ({
      ...scene,
      reference: { path: "./garbage.png" },
    }));
    await writeFile(path.join(fix.root, "garbage.png"), Buffer.from("not a png at all", "utf8"));
    try {
      const { exitCode, stdout, stderr } = await runAuthorToExit(fix.scenePath);
      expect(exitCode).toBe(1);
      const doc = JSON.parse(stdout) as { ok: boolean; errors: { path: string; message: string }[] };
      expect(doc.ok).toBe(false);
      const err = doc.errors.find((e) => e.path === "reference.path");
      expect(err?.message).toMatch(/not a PNG/);
      expect(stdout).not.toContain('"event"');
      expect(stderr).toBe("");
    } finally {
      await rm(fix.root, { recursive: true, force: true });
    }
  }, 30_000);
});

// --- live session ----------------------------------------------------------

describe("scene author — live session", () => {
  let fix: Fixture;
  let session: Bun.Subprocess<"ignore", "pipe", "pipe">;
  let events: SessionEvents;
  let started: { event: string; url: string };
  let url: URL;
  let token: string;
  let port: number;
  let referenceBytes: Buffer;
  let closed: Promise<JsonEvent>;

  beforeAll(async () => {
    fix = await makeFixture("live", layerInspectionScene);
    referenceBytes = await readFile(fix.referencePath);
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

  test(
    "the started event is one-line JSON: an ephemeral loopback url carrying only the capability",
    () => {
      expect(Object.keys(started).sort()).toEqual(["event", "url"]);
      expect(started.event).toBe("started");
      expect(url.protocol).toBe("http:");
      expect(url.hostname).toBe("127.0.0.1");
      expect(port).toBeGreaterThan(0);
      expect(url.pathname).toMatch(/^\/[0-9a-f]{64}\/view$/);
      expect(CAPABILITY.test(token)).toBe(true);
      // The capability exists only inside session.url — no separate token field.
      expect(JSON.stringify(started).toLowerCase()).not.toContain("token");
    },
  );

  test(
    "only the exact Host and the token-scoped GET routes answer; everything else is an empty 403/404/405",
    async () => {
      // Foreign or wrong Host → 403, empty.
      for (const host of ["evil.example", "localhost", `127.0.0.1:${port + 1}`]) {
        const res = await rawRequest(port, `/${token}/view`, { host });
        expect(res.status).toBe(403);
        expect(res.body.length).toBe(0);
      }

      // Exact Host, wrong or absent capability / unknown paths → 404, empty.
      for (const reqPath of [
        "/view",
        `/${"0".repeat(64)}/view`,
        `/${token}0/view`,
        `/${token}`,
        `/${token.slice(0, 63)}${token.charAt(63) === "a" ? "b" : "a"}/view`,
        `/${token}/render.png/`,
        `/${token}/package.json`,
        "/",
      ]) {
        const res = await rawRequest(port, reqPath);
        expect(res.status).toBe(404);
        expect(res.body.length).toBe(0);
      }

      // Non-GET on a render/reference route → 405, empty; non-POST on the
      // movement route → 405, empty.
      for (const [method, reqPath] of [
        ["POST", `/${token}/view`],
        ["PUT", `/${token}/render.png`],
        ["DELETE", `/${token}/reference.png`],
        ["GET", `/${token}/move`],
        ["PUT", `/${token}/move`],
        ["DELETE", `/${token}/move`],
      ] as const) {
        const res = await rawRequest(port, reqPath, { method });
        expect(res.status).toBe(405);
        expect(res.body.length).toBe(0);
      }
    },
    30_000,
  );

  test(
    "the GET routes serve under the strict CSP with no-store/nosniff/no-referrer",
    async () => {
      const view = await rawRequest(port, `/${token}/view`);
      expect(view.status).toBe(200);
      expect(String(view.headers["content-type"])).toContain("text/html");
      expect(view.headers["content-security-policy"]).toBe(CSP);
      expect(view.headers["cache-control"]).toBe("no-store");
      expect(view.headers["x-content-type-options"]).toBe("nosniff");
      expect(view.headers["referrer-policy"]).toBe("no-referrer");
      const html = view.body.toString("utf8");
      expect(html).toContain('src="render.png"');
      expect(html).toContain('src="reference.png"');

      for (const route of ["render.png", "reference.png"]) {
        const res = await rawRequest(port, `/${token}/${route}`);
        expect(res.status).toBe(200);
        expect(String(res.headers["content-type"])).toContain("image/png");
        expect(res.headers["content-security-policy"]).toBe(CSP);
        expect(res.headers["cache-control"]).toBe("no-store");
        expect(res.headers["x-content-type-options"]).toBe("nosniff");
        expect(res.headers["referrer-policy"]).toBe("no-referrer");
      }
    },
    30_000,
  );

  test(
    "reference.png serves the exact validated Reference bytes — never reread",
    async () => {
      const first = await rawRequest(port, `/${token}/reference.png`);
      expect(first.status).toBe(200);
      expect(Buffer.compare(first.body, referenceBytes)).toBe(0);
      // Remove the file: the session still serves the bytes it validated once.
      await rm(fix.referencePath, { force: true });
      const second = await rawRequest(port, `/${token}/reference.png`);
      expect(second.status).toBe(200);
      expect(Buffer.compare(second.body, referenceBytes)).toBe(0);
    },
    30_000,
  );

  test(
    "render.png is the one in-memory Render: identical PNG bytes on every request",
    async () => {
      const first = await rawRequest(port, `/${token}/render.png`);
      const second = await rawRequest(port, `/${token}/render.png`);
      expect(first.status).toBe(200);
      expect(first.body.length).toBeGreaterThan(0);
      expect([...first.body.subarray(0, 8)]).toEqual(PNG_MAGIC);
      expect(Buffer.compare(first.body, second.body)).toBe(0);
    },
    30_000,
  );

  test(
    "the view ships exactly one same-origin script and its overlay adjusts with pure CSS; every request stays on the session origin",
    async () => {
      const browser = await getBrowser();
      const ctx = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
        deviceScaleFactor: 1,
      });
      const origin = url.origin;
      const requested: string[] = [];
      ctx.on("request", (r) => requested.push(r.url()));
      // Any attempt to leave the loopback session fails loudly instead of loading.
      await ctx.route("**/*", (route) =>
        route.request().url().startsWith(origin) ? route.continue() : route.abort(),
      );
      const page: Page = await ctx.newPage();
      try {
        await page.goto(started.url);
        // Exactly one script — the session's own static app.js, same-origin
        // (the CSP's script-src 'self' would block anything else).
        expect(await page.locator("script").count()).toBe(1);
        expect(await page.locator("script").getAttribute("src")).toBe("app.js");

        // Side by side is a true horizontal row at this viewport: the two
        // figures share one vertical position and sit at distinct horizontal
        // positions — never a vertical stack.
        const boxes = await page.evaluate(() =>
          [...document.querySelectorAll(".side figure")].map((f) => {
            const r = f.getBoundingClientRect();
            return { top: r.top, left: r.left };
          }),
        );
        expect(boxes).toHaveLength(2);
        expect(boxes[0]!.top).toBe(boxes[1]!.top);
        expect(boxes[0]!.left).not.toBe(boxes[1]!.left);

        const side = page.locator(".side");
        const overlay = page.locator(".overlay");
        expect(await side.evaluate((el) => getComputedStyle(el).display)).not.toBe("none");
        expect(await overlay.evaluate((el) => getComputedStyle(el).display)).toBe("none");

        // Switch to the overlay through the styled (visible) label — no script.
        await page.click('label[for="mode-overlay"]');
        expect(await overlay.evaluate((el) => getComputedStyle(el).display)).not.toBe("none");
        expect(await side.evaluate((el) => getComputedStyle(el).display)).toBe("none");

        // Overlay opacity adjusts in pure CSS: default 50, then the extremes.
        const opacity = () =>
          page.locator(".overlay .render").evaluate((el) => getComputedStyle(el).opacity);
        expect(await opacity()).toBe("0.5");
        await page.click('label[for="alpha-100"]');
        expect(await opacity()).toBe("1");
        await page.click('label[for="alpha-0"]');
        expect(await opacity()).toBe("0");

        // Back to side by side.
        await page.click('label[for="mode-side"]');
        expect(await side.evaluate((el) => getComputedStyle(el).display)).not.toBe("none");

        // Every request the view made stayed on the loopback session.
        for (const req of requested) expect(req.startsWith(origin)).toBe(true);
      } finally {
        await ctx.close();
      }
    },
    60_000,
  );

  test(
    "the view lists every Layer once; selection works from listing and canvas; the Scene bytes never change",
    async () => {
      const sceneBytesBefore = await readFile(fix.scenePath);
      const browser = await getBrowser();
      const ctx = await browser.newContext({
        viewport: { width: 1440, height: 1500 },
        deviceScaleFactor: 1,
      });
      const origin = url.origin;
      await ctx.route("**/*", (route) =>
        route.request().url().startsWith(origin) ? route.continue() : route.abort(),
      );
      const page: Page = await ctx.newPage();
      try {
        await page.goto(started.url);

        // Every Layer exactly once, in render order — nested Group children,
        // mirrored, cropped, and Connector Layers included; hidden Layers
        // present but visibly disabled and non-selectable.
        const rows = await page.evaluate(() =>
          [...document.querySelectorAll(".listing .row")].map((row) => ({
            tag: row.tagName,
            hidden: row.classList.contains("hidden"),
            selectable: row.getAttribute("for") !== null,
            ariaDisabled: row.getAttribute("aria-disabled"),
            id: row.querySelector(".name")?.textContent ?? "",
            forIndex: row.getAttribute("for"),
            bounds: row.querySelector(".bounds")?.textContent ?? "",
          })),
        );
        expect(rows.map((r) => r.id)).toEqual([
          "bg", "headline", "chip", SNEAKY_ID, "flip", "portrait",
          "card", "card-plate", "card-tilt", "tag", "tag-dot", "tag-fade",
          "hush", "hush-dot", "faded", "ghost", "line",
        ]);
        expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
        // Layers that paint nothing — visible:false and opacity:0 (leaf,
        // Group, or Group child) — each appear once as visibly hidden,
        // disabled, non-selectable rows with bounds absent.
        const hidden = rows.filter((r) => r.hidden);
        expect(hidden.map((r) => r.id)).toEqual([
          "tag-fade", "hush", "hush-dot", "faded", "ghost",
        ]);
        for (const h of hidden) {
          expect(h.tag).toBe("DIV");
          expect(h.selectable).toBe(false);
          expect(h.ariaDisabled).toBe("true");
          expect(h.bounds).toBe(""); // bounds absent for a non-painted Layer
        }
        expect(rows.filter((r) => !r.hidden)).toHaveLength(12);

        // Visible Layers: one radio each (the single selection state), one
        // exact highlight box and one hit target on the canvas, indexed by
        // tree order — non-painted Layers get no radio and no canvas target.
        expect(await page.locator('input[type="radio"][name="layer"]').count()).toBe(12);
        expect(await page.locator(".canvas .hit").count()).toBe(12);
        expect(await page.locator(".canvas .box").count()).toBe(12);
        for (const i of [11, 12, 13, 14, 15]) {
          expect(await page.locator(`.canvas .hit[data-sel="${i}"]`).count()).toBe(0);
          expect(await page.locator(`.canvas .box[data-sel="${i}"]`).count()).toBe(0);
          expect(await page.locator(`input#layer-${i}`).count()).toBe(0);
        }

        // Every hit/highlight box names its stable Layer (escaped attribute;
        // selectors stay index-only — no raw id in id/for/data-sel).
        const boxIds = await page.evaluate(() =>
          [...document.querySelectorAll(".canvas .box")].map((el) => el.getAttribute("data-layer-id")),
        );
        expect(boxIds).toEqual([
          "bg", "headline", "chip", SNEAKY_ID, "flip", "portrait",
          "card", "card-plate", "card-tilt", "tag", "tag-dot", "line",
        ]);
        const offenders = await page.evaluate((ids) => {
          const bad: string[] = [];
          for (const el of document.querySelectorAll("*")) {
            for (const attr of ["id", "for", "data-sel"]) {
              const v = el.getAttribute(attr);
              if (v && ids.some((id) => v.includes(id))) bad.push(`${attr}=${v}`);
            }
          }
          return bad;
        }, rows.map((r) => r.id));
        expect(offenders).toEqual([]);

        // The user-authored id is escaped text everywhere it appears — the
        // listing and the canvas boxes — never markup.
        const servedHtml = (await rawRequest(port, `/${token}/view`)).body.toString("utf8");
        expect(servedHtml).toContain("sneaky&quot;&gt;&lt;svg onload=alert(1)&gt;");
        expect(servedHtml).not.toContain("<svg onload");
        expect(servedHtml).not.toContain('onerror');
        const viewHtml = await page.content();
        expect(viewHtml).not.toContain("<svg onload");
        expect(await page.locator("script").count()).toBe(1);
        expect(await page.locator('.listing .row[data-sel="3"] .name').textContent()).toBe(SNEAKY_ID);

        // Selection starts empty.
        const noneChecked = await page.evaluate(() =>
          [...document.querySelectorAll<HTMLInputElement>('input[name="layer"]')].every(
            (r) => !r.checked,
          ),
        );
        expect(noneChecked).toBe(true);

        // A selected box must be the exact transformed canvas-space AABB of
        // that stable Layer: its data-layer-id names the Layer and its
        // percentages invert to the exact bounds the listing reports.
        const expectSelectedBox = async (i: number, id: string) => {
          const box = page.locator(`.canvas .box[data-sel="${i}"]`);
          expect(await box.getAttribute("data-layer-id")).toBe(id);
          expect(await box.evaluate((el) => getComputedStyle(el).display)).toBe("block");
          const style = await box.getAttribute("style");
          const boundsText = await page
            .locator(`.listing .row[data-sel="${i}"] .bounds`)
            .textContent();
          const m = boundsText!.match(/^([\d.]+),([\d.]+) · ([\d.]+)×([\d.]+)$/);
          expect(m).not.toBeNull();
          const stylePct = (re: RegExp) => {
            const hit = style!.match(re);
            expect(hit).not.toBeNull();
            return Number(hit![1]);
          };
          // Percentages are bounds/1280·100 (x, width) and /720·100 (y, height)
          // rounded to 4 decimals — inverting stays within 0.01px.
          expect((stylePct(/left:([\d.]+)%/) / 100) * 1280).toBeCloseTo(Number(m![1]), 2);
          expect((stylePct(/top:([\d.]+)%/) / 100) * 720).toBeCloseTo(Number(m![2]), 2);
          expect((stylePct(/width:([\d.]+)%/) / 100) * 1280).toBeCloseTo(Number(m![3]), 2);
          expect((stylePct(/height:([\d.]+)%/) / 100) * 720).toBeCloseTo(Number(m![4]), 2);
        };
        const rowBg = (i: number) =>
          page
            .locator(`.listing .row[data-sel="${i}"]`)
            .evaluate((el) => getComputedStyle(el).backgroundColor);
        const expectOnlySelected = async (i: number) => {
          for (const other of rows.filter((r) => !r.hidden).map((r) => r.forIndex!)) {
            const idx = Number(other.replace("layer-", ""));
            expect(
              await page
                .locator(`.canvas .box[data-sel="${idx}"]`)
                .evaluate((el) => getComputedStyle(el).display),
            ).toBe(idx === i ? "block" : "none");
          }
          expect(await rowBg(i)).not.toBe("rgba(0, 0, 0, 0)");
        };

        // From the listing: the rotated child of the scaled Group (index 8).
        const tiltFor = rows.find((r) => r.id === "card-tilt")!.forIndex!;
        await page.click(`.listing label[for="${tiltFor}"]`);
        expect(await page.isChecked(`#${tiltFor}`)).toBe(true);
        await expectSelectedBox(8, "card-tilt");
        await expectOnlySelected(8);

        // From the listing: the Group child next to a zero-opacity sibling
        // (index 10) — the faded sibling neither blocks nor shadows it.
        const dotFor = rows.find((r) => r.id === "tag-dot")!.forIndex!;
        await page.click(`.listing label[for="${dotFor}"]`);
        expect(await page.isChecked(`#${dotFor}`)).toBe(true);
        await expectSelectedBox(10, "tag-dot");
        await expectOnlySelected(10);

        // From the listing: the cropped image (index 5).
        const portraitFor = rows.find((r) => r.id === "portrait")!.forIndex!;
        await page.click(`.listing label[for="${portraitFor}"]`);
        expect(await page.isChecked(`#${portraitFor}`)).toBe(true);
        await expectSelectedBox(5, "portrait");
        await expectOnlySelected(5);

        // From the canvas: the mirrored shape (index 4).
        const flipFor = rows.find((r) => r.id === "flip")!.forIndex!;
        await page.click(`.canvas .hit[for="${flipFor}"]`);
        expect(await page.isChecked(`#${flipFor}`)).toBe(true);
        await expectSelectedBox(4, "flip");
        await expectOnlySelected(4);

        // From the canvas: the adversarial-id layer (index 3) — selectable,
        // associated by its escaped stable id, and inert.
        const sneakyFor = rows.find((r) => r.id === SNEAKY_ID)!.forIndex!;
        await page.click(`.canvas .hit[for="${sneakyFor}"]`);
        expect(await page.isChecked(`#${sneakyFor}`)).toBe(true);
        await expectSelectedBox(3, SNEAKY_ID);
        await expectOnlySelected(3);

        // From the canvas: the Connector (index 16) — its box is the exact
        // painted extent the listing reports.
        const lineFor = rows.find((r) => r.id === "line")!.forIndex!;
        await page.click(`.canvas .hit[for="${lineFor}"]`);
        expect(await page.isChecked(`#${lineFor}`)).toBe(true);
        await expectSelectedBox(16, "line");
        await expectOnlySelected(16);
        // The hit target carries the symmetric minimum (centered max())
        // while the displayed box stays the exact bounds.
        const hitStyle = await page.getAttribute(`.canvas .hit[data-sel="16"]`, "style");
        expect(hitStyle).toContain("max(");
        expect(hitStyle).toContain("translate(-50%,-50%)");
        // Compositing order sets canvas priority: bg's hit (index 0) sits
        // under line's (index 16).
        const zIndexOf = (i: number) =>
          page
            .locator(`.canvas .hit[data-sel="${i}"]`)
            .evaluate((el) => Number(getComputedStyle(el).zIndex));
        expect(await zIndexOf(0)).toBeLessThan(await zIndexOf(16));

        // A fully occluded Layer — bg, beneath every later hit across the
        // whole canvas — stays listing-selectable.
        const bgFor = rows.find((r) => r.id === "bg")!.forIndex!;
        await page.click(`.listing label[for="${bgFor}"]`);
        expect(await page.isChecked(`#${bgFor}`)).toBe(true);
        await expectSelectedBox(0, "bg");

        // Opening and using selection leaves the Scene bytes unchanged.
        const sceneBytesAfter = await readFile(fix.scenePath);
        expect(Buffer.compare(sceneBytesBefore, sceneBytesAfter)).toBe(0);
      } finally {
        await ctx.close();
      }
    },
    60_000,
  );

  test(
    "SIGTERM drives the one shutdown path: closed event, listener released, child Chromium reaped",
    async () => {
      // The session holds its own browser (launched by the pre-listen render);
      // wait until it exists among the CLI's descendants, then capture the tree.
      let descendants = new Set<number>();
      let chromiumSeen = false;
      for (let i = 0; i < 80 && !chromiumSeen; i++) {
        descendants = await descendantPids(session.pid);
        for (const pid of descendants) {
          const { stdout } = await execFileP("ps", ["-o", "command=", "-p", String(pid)]).catch(
            () => ({ stdout: "" }),
          );
          if (/chrom/i.test(stdout)) {
            chromiumSeen = true;
            break;
          }
        }
        if (!chromiumSeen) await new Promise((r) => setTimeout(r, 250));
      }
      expect(chromiumSeen).toBe(true);
      expect(descendants.size).toBeGreaterThan(0);

      session.kill("SIGTERM");

      expect(await session.exited).toBe(0);

      const closedEvt = await closed;
      expect(closedEvt).toEqual({ event: "closed", ok: true });
      // Exactly two events for a live session: started, then closed.
      expect(events.events.map((e) => e.event)).toEqual(["started", "closed"]);

      // The listener is gone.
      await expect(rawRequest(port, `/${token}/view`)).rejects.toThrow();

      // Every child process — the held Chromium included — was reaped.
      for (const pid of descendants) expect(alive(pid)).toBe(false);
    },
    60_000,
  );

  afterAll(async () => {
    if (session && session.exitCode === null && session.signalCode === null) {
      session.kill("SIGTERM");
      await session.exited;
    }
    if (fix) await rm(fix.root, { recursive: true, force: true });
  });
});

// --- moving Layers with unsaved live preview (#60) -------------------------

describe("scene author — moving Layers with unsaved live preview (#60)", () => {
  /**
   * A movement-focused Scene: a top-level shape, a scaled+mirrored+rotated
   * Group with nested children (one with its own rotation, one nested Group
   * deeper), a hidden shape, and a Connector. Tree order (the view's index
   * space): bg, chip, card, card-plate, card-tilt, card-inner, dot, hush, link.
   */
  const movementScene = (scene: Record<string, unknown>): Record<string, unknown> => ({
    ...scene,
    layers: [
      { id: "bg", type: "image", asset: "./bg.svg", position: { x: 0, y: 0 }, size: { width: 1280, height: 720 } },
      { id: "chip", type: "shape", shape: "rect", color: "#22cc88", position: { x: 900, y: 120 }, size: { width: 180, height: 110 } },
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
          { id: "card-tilt", type: "shape", shape: "rect", color: "#dd4477", position: { x: 210, y: 170 }, size: { width: 90, height: 60 }, rotation: 17 },
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

  let fix: Fixture;
  let session: Bun.Subprocess<"ignore", "pipe", "pipe">;
  let events: SessionEvents;
  let started: { event: string; url: string };
  let url: URL;
  let token: string;
  let port: number;
  let closed: Promise<JsonEvent>;

  beforeAll(async () => {
    fix = await makeFixture("move", movementScene);
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
    // Awaited by the final immutability test; the collector pumps either way.
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
   * phases intentionally build on each other — every accepted movement
   * changes the session state the next phase starts from — so the phase
   * order is part of this test's contract, and revision/unsaved counts are
   * asserted exactly at every phase. No sibling test moves Layers, so this
   * scenario owns its session from the "started" event onward.
   */
  test(
    "the movement scenario: top-level and nested drags, persisted-vs-unsaved presentation, rejected movements, overlapping previews, and repeated cycles — all unsaved",
    async () => {
      const sceneBytesBefore = await readFile(fix.scenePath);
      const renderAtStart = (await rawRequest(port, `/${token}/render.png`)).body;
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
      }
      interface MoveResponse {
        rev: number;
        warnings: string[];
        layers: ResponseLayer[];
      }
      /** A movement POST from inside the page (same-origin, route-blocked ctx). */
      const postMove = async (id: string, dx: number, dy: number): Promise<MoveResponse> => {
        const res = await page.evaluate(
          async ({ id, dx, dy }) => {
            const base = location.pathname.replace(/\/view$/, "/");
            const r = await fetch(base + "move", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ id, dx, dy }),
            });
            return { status: r.status, body: await r.json() };
          },
          { id, dx, dy },
        );
        expect(res.status).toBe(200);
        return res.body as MoveResponse;
      };
      const byId = (body: MoveResponse, id: string) => {
        const l = body.layers.find((x) => x.id === id);
        expect(l).toBeDefined();
        return l!;
      };
      const centerOf = (l: ResponseLayer) => {
        expect(l.bounds).not.toBeNull();
        return { x: l.bounds!.x + l.bounds!.width / 2, y: l.bounds!.y + l.bounds!.height / 2 };
      };
      /** Raw movement POST with exact body/content-type control. */
      const postRaw = (body: string, contentType: string | null) =>
        new Promise<{ status: number; body: Buffer }>((resolve, reject) => {
          const req = httpRequest(
            {
              host: "127.0.0.1",
              port,
              path: `/${token}/move`,
              method: "POST",
              headers: contentType === null ? {} : { "content-type": contentType },
            },
            (res) => {
              const chunks: Buffer[] = [];
              res.on("data", (c: Buffer) => chunks.push(c));
              res.on("end", () =>
                resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }),
              );
            },
          );
          req.on("error", reject);
          req.end(body);
        });
      const statusText = () => page.locator("#status").textContent();
      const appliedRev = async () =>
        Number(await page.locator("#status").getAttribute("data-rev"));
      const previewSrc = () => page.locator(".canvas img").getAttribute("src");
      /** A real pointer drag on a selected canvas hit target, by displayed-px
       *  delta. The Layer is selected through the listing first — a selected
       *  Layer's hit sits above every unselected hit (the selection
       *  guarantee) — and the hit's center is asserted to be the topmost
       *  element at the intended drag point before the drag starts. */
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

      try {
        await page.goto(started.url);

        // --- phase 1: the fresh session starts clean ------------------------
        expect(await page.locator(".listing .row.modified").count()).toBe(0);
        expect(await statusText()).toBe("rev 0 · unsaved 0 · Scene file unchanged");

        // --- phase 2: dragging a selected top-level Layer -------------------
        // The chip's initial rendered box is its authored box (top-level,
        // untransformed): center (990, 175) in frame px.
        const chipBox = await boundsFromBox(page, '.canvas .box[data-sel="1"]');
        expect(chipBox.x).toBeCloseTo(900, 0);
        expect(chipBox.y).toBeCloseTo(120, 0);

        // Drag the chip by a known displayed-px delta: 80 right, 50 up.
        const displayed = (await page.locator(".canvas img").boundingBox())!.width;
        const scale = 1280 / displayed;
        await dragHit("1", 80, -50);

        // The preview swapped to a fresh canonical render, applied atomically.
        await page.waitForFunction(
          () =>
            document
              .querySelector(".canvas img")
              ?.getAttribute("src")
              ?.startsWith("data:image/png;base64,"),
          undefined,
          { timeout: 30_000 },
        );
        const frameDx = 80 * scale;
        const frameDy = -50 * scale;

        // The moved Layer's rendered bounds followed the drag in frame px.
        const chipAfter = await boundsFromBox(page, '.canvas .box[data-sel="1"]');
        expect(chipAfter.x + chipAfter.width / 2).toBeCloseTo(990 + frameDx, 0);
        expect(chipAfter.y + chipAfter.height / 2).toBeCloseTo(175 + frameDy, 0);

        // The listing row distinguishes persisted from unsaved values.
        const row = page.locator('.listing .row[data-sel="1"]');
        expect(await row.getAttribute("class")).toContain("modified");
        expect(await row.locator(".was").textContent()).toBe("was 900,120");
        expect(await row.locator(".pos").textContent()).not.toBe("900,120");

        // The status line: exactly revision 1, exactly one unsaved Layer.
        expect(await statusText()).toBe("rev 1 · unsaved 1 · Scene file unchanged");

        // render.png now serves the latest preview, not the session-start one:
        // the Scene changed, so the canonical pixels changed with it.
        const renderAfterDrag = (await rawRequest(port, `/${token}/render.png`)).body;
        expect(Buffer.compare(renderAtStart, renderAfterDrag)).not.toBe(0);

        // --- phase 3: nested drags through measured Group transforms --------
        // Independent expected-value math (test-side): the card Group's CSS
        // transform "scale(2) rotate(30deg) scaleX(-1)" composes mirror →
        // rotate → scale; its linear map turns an authored local delta into
        // the frame-px delta the drag produced. The session must invert
        // exactly this map — derived in production from the rendered DOM,
        // never from a second transform model.
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
        const cardBasis: M = mul2(
          mul2([2, 0, 0, 2], [Math.cos(deg(30)), Math.sin(deg(30)), -Math.sin(deg(30)), Math.cos(deg(30))]),
          [-1, 0, 0, 1],
        );
        const innerBasis: M = mul2(cardBasis, [1.5, 0, 0, 1.5]);

        // The nested image inside the scaled+mirrored+rotated Group: a
        // frame-px drag of (40, −20) maps to the inverse-transformed local
        // delta, and its rendered bounds center moves by exactly (40, −20).
        const respA = await postMove("card-plate", 40, -20);
        expect(respA.rev).toBe(2);
        const persisted = byId(respA, "card-plate").position!.persisted;
        expect(persisted).toEqual({ x: 16, y: 16 });
        const localA = apply2(inv2(cardBasis), 40, -20);
        const currentA = byId(respA, "card-plate").position!.current;
        expect(currentA.x).toBeCloseTo(16 + localA.x, 2);
        expect(currentA.y).toBeCloseTo(16 + localA.y, 2);

        // A second drag moves the rendered bounds by exactly the frame delta.
        const respB = await postMove("card-plate", 10, 5);
        expect(respB.rev).toBe(3);
        const centerB = centerOf(byId(respB, "card-plate"));
        const centerA = centerOf(byId(respA, "card-plate"));
        expect(centerB.x - centerA.x).toBeCloseTo(10, 0);
        expect(centerB.y - centerA.y).toBeCloseTo(5, 0);

        // A child with its own rotation (card-tilt, 17°): its own transform
        // never enters the mapping — the drag maps through the ancestors
        // only, and the rendered bounds follow the frame delta exactly.
        const respC = await postMove("card-tilt", -25, 35);
        expect(respC.rev).toBe(4);
        const tiltPersisted = byId(respC, "card-tilt").position!.persisted;
        expect(tiltPersisted).toEqual({ x: 210, y: 170 });
        const localC = apply2(inv2(cardBasis), -25, 35);
        const tiltCurrent = byId(respC, "card-tilt").position!.current;
        expect(tiltCurrent.x).toBeCloseTo(210 + localC.x, 2);
        expect(tiltCurrent.y).toBeCloseTo(170 + localC.y, 2);
        const tiltCenter = centerOf(byId(respC, "card-tilt"));
        const tiltCenterBefore = centerOf(byId(respB, "card-tilt"));
        expect(tiltCenter.x - tiltCenterBefore.x).toBeCloseTo(-25, 0);
        expect(tiltCenter.y - tiltCenterBefore.y).toBeCloseTo(35, 0);

        // A doubly-nested child (dot: card → card-inner → dot): the two
        // Groups' measured bases compose.
        const respD = await postMove("dot", 30, 12);
        expect(respD.rev).toBe(5);
        const dotPersisted = byId(respD, "dot").position!.persisted;
        expect(dotPersisted).toEqual({ x: 10, y: 10 });
        const localD = apply2(inv2(innerBasis), 30, 12);
        const dotCurrent = byId(respD, "dot").position!.current;
        expect(dotCurrent.x).toBeCloseTo(10 + localD.x, 2);
        expect(dotCurrent.y).toBeCloseTo(10 + localD.y, 2);
        const dotCenter = centerOf(byId(respD, "dot"));
        const dotCenterBefore = centerOf(byId(respC, "dot"));
        expect(dotCenter.x - dotCenterBefore.x).toBeCloseTo(30, 0);
        expect(dotCenter.y - dotCenterBefore.y).toBeCloseTo(12, 0);

        // The Group itself is top-level: identity mapping, exact integers.
        const respE = await postMove("card", -10, 5);
        expect(respE.rev).toBe(6);
        expect(byId(respE, "card").position!.current).toEqual({ x: 170, y: 145 });
        const cardCenter = centerOf(byId(respE, "card"));
        const cardCenterBefore = centerOf(byId(respD, "card"));
        expect(cardCenter.x - cardCenterBefore.x).toBeCloseTo(-10, 0);
        expect(cardCenter.y - cardCenterBefore.y).toBeCloseTo(5, 0);

        // Every accepted movement's response carries the fresh render's
        // warnings channel (safe-area and auto-fit signals ride along).
        for (const r of [respA, respB, respC, respD, respE]) {
          expect(Array.isArray(r.warnings)).toBe(true);
        }

        // --- phase 4: the view distinguishes persisted from unsaved ---------
        // Re-open the view: a fresh page renders the server's current state.
        await page.reload({ waitUntil: "load" });
        // The fixture's authored positions — the persisted home's only legal
        // values, no matter how many movements this scenario has made.
        const AUTHORED: Record<string, { x: number; y: number }> = {
          bg: { x: 0, y: 0 },
          chip: { x: 900, y: 120 },
          card: { x: 180, y: 140 },
          "card-plate": { x: 16, y: 16 },
          "card-tilt": { x: 210, y: 170 },
          "card-inner": { x: 40, y: 190 },
          dot: { x: 10, y: 10 },
        };
        const rows = page.locator(".listing .row");
        expect(await rows.count()).toBe(9);
        let movedCount = 0;
        for (let i = 0; i < 9; i++) {
          const r = rows.nth(i);
          const name = (await r.locator(".name").textContent())!;
          const cls = (await r.getAttribute("class")) ?? "";
          if (name === "link") {
            // The Connector row: selectable and bounds-bearing, never positioned.
            expect(cls.includes("modified")).toBe(false);
            expect(await r.locator(".pos").count()).toBe(0);
            expect(await r.locator(".was").count()).toBe(0);
            continue;
          }
          if (name === "hush") {
            // The hidden row: disabled, with no position facts.
            expect(cls.includes("hidden")).toBe(true);
            expect(await r.locator(".pos").count()).toBe(0);
            expect(await r.locator(".was").count()).toBe(0);
            continue;
          }
          const authored = AUTHORED[name]!;
          const pos = (await r.locator(".pos").textContent())!;
          const was = (await r.locator(".was").textContent())!;
          const isMoved = pos !== `${authored.x},${authored.y}`;
          if (isMoved) movedCount++;
          expect(cls.includes("modified")).toBe(isMoved);
          expect(was).toBe(isMoved ? `was ${authored.x},${authored.y}` : "");
        }
        // Exactly the five Layers this scenario moved are marked unsaved; the
        // persisted home never drifted from the authored values.
        expect(movedCount).toBe(5);
        expect(await statusText()).toBe("rev 6 · unsaved 5 · Scene file unchanged");
        expect(await appliedRev()).toBe(6);

        // --- phase 5: rejected movements retain the last valid preview ------
        const renderBeforeRejections = (await rawRequest(port, `/${token}/render.png`)).body;
        // Unknown id → actionable, naming the id.
        const unknown = await postRaw(JSON.stringify({ id: "nope", dx: 1, dy: 1 }), "application/json");
        expect(unknown.status).toBe(400);
        const unknownBody = JSON.parse(unknown.body.toString("utf8")) as {
          errors: { path: string; message: string }[];
        };
        expect(unknownBody.errors.length).toBeGreaterThan(0);
        expect(unknownBody.errors[0]!.message).toContain("nope");
        // A Connector: no authored position — move its targets instead.
        const connector = await postRaw(JSON.stringify({ id: "link", dx: 1, dy: 1 }), "application/json");
        expect(connector.status).toBe(400);
        expect(connector.body.toString("utf8")).toContain("no authored position");
        // A Layer that paints nothing has no draggable canvas target.
        const hiddenMove = await postRaw(JSON.stringify({ id: "hush", dx: 1, dy: 1 }), "application/json");
        expect(hiddenMove.status).toBe(400);
        expect(hiddenMove.body.toString("utf8")).toContain("paints nothing");
        // A non-numeric delta is rejected at the boundary.
        const nonNumeric = await postRaw(JSON.stringify({ id: "chip", dx: "fast", dy: 1 }), "application/json");
        expect(nonNumeric.status).toBe(400);
        expect(nonNumeric.body.toString("utf8")).toContain("finite");
        // Malformed JSON and a wrong content type are rejected with guidance.
        const malformed = await postRaw("not json{{{", "application/json");
        expect(malformed.status).toBe(400);
        expect(malformed.body.toString("utf8")).toContain("not valid JSON");
        const wrongType = await postRaw(JSON.stringify({ id: "chip", dx: 1, dy: 1 }), "text/plain");
        expect(wrongType.status).toBe(400);
        expect(wrongType.body.toString("utf8")).toContain("application/json");
        // An oversized body is refused outright.
        const oversized = await postRaw(
          JSON.stringify({ id: "chip", dx: 1, dy: 1, pad: "x".repeat(17 * 1024) }),
          "application/json",
        );
        expect(oversized.status).toBe(413);
        // Every rejection left the latest preview exactly as it was.
        expect(
          Buffer.compare((await rawRequest(port, `/${token}/render.png`)).body, renderBeforeRejections),
        ).toBe(0);
        expect(await appliedRev()).toBe(6);
        expect(await statusText()).toBe("rev 6 · unsaved 5 · Scene file unchanged");

        // One accepted movement first, so the retained-preview assertion below
        // compares data-URI bytes rather than a route reference.
        await dragHit("3", 20, 10);
        await page.waitForFunction(
          () => Number(document.getElementById("status")?.getAttribute("data-rev")) === 7,
          undefined,
          { timeout: 30_000 },
        );
        expect(await statusText()).toBe("rev 7 · unsaved 5 · Scene file unchanged");
        const imgAtRev7 = await previewSrc();
        expect(imgAtRev7).not.toBeNull();
        expect(imgAtRev7).toContain("data:image/png;base64,");

        // A movement that cannot pass the complete canonical gate fails the
        // same way: the project asset is gone, so resolution fails and the
        // candidate is discarded — the view shows the actionable error and
        // retains the last valid preview.
        const photoPath = path.join(fix.root, "photo.svg");
        const photoBytes = await readFile(photoPath);
        await rm(photoPath);
        const statusBeforeFailure = await statusText();
        await dragHit("3", 20, 10);
        await page.waitForFunction(
          (prev) => document.getElementById("status")?.textContent !== prev,
          statusBeforeFailure,
          { timeout: 30_000 },
        );
        const errorStatus = await statusText();
        expect(errorStatus).toContain("missing project asset");
        expect(errorStatus).toContain("photo.svg");
        // The last valid preview is retained byte-for-byte; no revision moved.
        expect(await previewSrc()).toBe(imgAtRev7);
        expect(await appliedRev()).toBe(7);
        // Restoring the asset makes the same drag succeed.
        await writeFile(photoPath, photoBytes);
        await dragHit("3", 20, 10);
        await page.waitForFunction(
          (prev) => document.getElementById("status")?.textContent !== prev,
          errorStatus,
          { timeout: 30_000 },
        );
        expect(await statusText()).toBe("rev 8 · unsaved 5 · Scene file unchanged");
        expect(await previewSrc()).not.toBe(imgAtRev7);

        // --- phase 6: overlapping previews never display stale state --------
        // Two real drags in quick succession with the first movement's
        // response held back: the later movement's response resolves first,
        // and the client must apply the newer revision and discard the stale
        // one — an older result can never become the newest display.
        await page.evaluate(() => {
          const w = window as unknown as {
            __origFetch?: typeof fetch;
            __moves: { rev: number; png: string }[];
          };
          w.__origFetch = window.fetch;
          w.__moves = [];
          const orig = w.__origFetch;
          let first = true;
          window.fetch = ((...args: Parameters<typeof fetch>) => {
            const p = orig!(...args);
            if (!String(args[0]).endsWith("/move")) return p;
            const delayed = first
              ? new Promise<Response>((resolve) => setTimeout(() => resolve(p), 2000))
              : p;
            first = false;
            void delayed
              .then((r) => r.clone().json())
              .then((b: { rev: number; png: string }) => w.__moves.push(b));
            return delayed;
          }) as unknown as typeof fetch;
        });
        const imgBeforeStale = await previewSrc();
        await dragHit("1", 15, 5);
        await dragHit("1", 15, 5);
        await page.waitForFunction(
          () => ((window as unknown as { __moves?: unknown[] }).__moves ?? []).length >= 2,
          undefined,
          { timeout: 30_000 },
        );
        const moves = await page.evaluate(
          () => (window as unknown as { __moves: { rev: number; png: string }[] }).__moves,
        );
        // The held-back response resolved last and was discarded: the display
        // shows exactly the newest revision.
        expect(moves).toHaveLength(2);
        expect(moves[1]!.rev).toBe(moves[0]!.rev - 1);
        expect(await appliedRev()).toBe(moves[0]!.rev);
        expect(await previewSrc()).toBe(`data:image/png;base64,${moves[0]!.png}`);
        expect(await previewSrc()).not.toBe(imgBeforeStale);
        await page.evaluate(() => {
          const w = window as unknown as { __origFetch?: typeof fetch };
          if (w.__origFetch) window.fetch = w.__origFetch;
        });

        // Rapid overlapping movements serialize strictly FIFO: revisions
        // advance one by one and each response carries the cumulative state
        // of every delta so far.
        const chipPosBefore = (await page.locator('.listing .row[data-sel="1"] .pos').textContent())!;
        const chipXBefore = Number(chipPosBefore.split(",")[0]);
        const chipYBefore = Number(chipPosBefore.split(",")[1]);
        const deltas = [10, 20, 30, 40, 50, 60];
        const burst = await Promise.all(deltas.map((d) => postMove("chip", d, 0)));
        for (let i = 0; i < burst.length; i++) {
          expect(burst[i]!.rev).toBe(moves[0]!.rev + 1 + i);
          const chip = byId(burst[i]!, "chip").position!.current;
          expect(chip.x).toBeCloseTo(
            chipXBefore + deltas.slice(0, i + 1).reduce((a, b) => a + b, 0),
            3,
          );
          expect(chip.y).toBeCloseTo(chipYBefore, 3);
        }

        // --- phase 7: repeated preview cycles --------------------------------
        // Move → fresh canonical preview, alternating top-level and nested
        // Layers across several cycles; every cycle's rendered bounds follow
        // that cycle's exact frame-px drag.
        let last = burst[burst.length - 1]!;
        const cycles: { id: string; dx: number; dy: number }[] = [
          { id: "chip", dx: 5, dy: 0 },
          { id: "card-plate", dx: 6, dy: -4 },
          { id: "chip", dx: 5, dy: 0 },
          { id: "card-plate", dx: -6, dy: 4 },
        ];
        for (const c of cycles) {
          const next = await postMove(c.id, c.dx, c.dy);
          expect(next.rev).toBe(last.rev + 1);
          const center = centerOf(byId(next, c.id));
          const centerBefore = centerOf(byId(last, c.id));
          expect(center.x - centerBefore.x).toBeCloseTo(c.dx, 0);
          expect(center.y - centerBefore.y).toBeCloseTo(c.dy, 0);
          last = next;
        }

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

// --- shutdown path (fault injection) ---------------------------------------

describe("scene author — the one shutdown path (fault injection)", () => {
  test("emits closed ok:true and exits 0 when every cleanup step succeeds", async () => {
    const events: Record<string, unknown>[] = [];
    const order: string[] = [];
    let code: number | undefined;
    await expect(
      shutdownSession({
        stopListener: () => void order.push("listener"),
        closeBrowser: async () => void order.push("browser"),
        emit: async (e) => void events.push(e),
        exit: (c) => {
          code = c;
          throw new Error(`exit ${c}`);
        },
      }),
    ).rejects.toThrow("exit 0");
    expect(order).toEqual(["listener", "browser"]);
    expect(events).toEqual([{ event: "closed", ok: true }]);
    expect(code).toBe(0);
  });

  test("attempts every resource after an earlier failure and ends with a structured terminal failure and nonzero status", async () => {
    const events: Record<string, unknown>[] = [];
    const order: string[] = [];
    let code: number | undefined;
    await expect(
      shutdownSession({
        stopListener: () => {
          order.push("listener");
          throw new Error("listener refused to stop");
        },
        closeBrowser: async () => {
          order.push("browser");
          throw new Error("browser close failed");
        },
        emit: async (e) => void events.push(e),
        exit: (c) => {
          code = c;
          throw new Error(`exit ${c}`);
        },
      }),
    ).rejects.toThrow("exit 1");
    // Both resources were attempted despite the first failure — never a
    // silent success: the terminal event names every cleanup failure and
    // the status is nonzero (ADR-0010 fail-loud).
    expect(order).toEqual(["listener", "browser"]);
    expect(events).toEqual([
      {
        event: "closed",
        ok: false,
        errors: [
          { message: "listener: listener refused to stop" },
          { message: "browser: browser close failed" },
        ],
      },
    ]);
    expect(code).toBe(1);
  });
});