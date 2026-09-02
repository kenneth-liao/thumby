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

/** The session CSP, asserted byte-exact — the contract the view relies on. */
const CSP =
  "default-src 'none'; script-src 'none'; connect-src 'none'; object-src 'none'; " +
  "img-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

const CAPABILITY = /^[0-9a-f]{64}$/;
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

// --- fixtures --------------------------------------------------------------

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720"><rect width="1280" height="720" fill="#10233f"/></svg>`;

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
    fix = await makeFixture("live");
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

      // Non-GET on a valid route → 405, empty.
      for (const [method, reqPath] of [
        ["POST", `/${token}/view`],
        ["PUT", `/${token}/render.png`],
        ["DELETE", `/${token}/reference.png`],
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
    "the view is script-free and its overlay adjusts with pure CSS; every request stays on the session origin",
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
        // Script-free by construction — and the CSP would have blocked it anyway.
        expect(await page.locator("script").count()).toBe(0);

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