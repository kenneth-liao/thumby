/**
 * The live Scene author session (#58): after the CLI's full validation gate
 * (Scene + required Reference Thumbnail) and the one in-memory Render, this
 * module holds the session — a loopback-only, capability-scoped HTTP surface
 * showing the Render and the Reference Thumbnail side by side and as an
 * adjustable overlay.
 *
 * Security posture: the server binds 127.0.0.1:0 only (loopback, ephemeral
 * port); a 32-random-byte capability exists only inside session.url — no
 * separate token field, no query parameters. Every request must carry the
 * exact generated Host header and hit one of three exact token-scoped GET
 * routes (/view, /render.png, /reference.png); anything else is an empty
 * 403/404/405. There is no path-based file serving: a wrong path can never
 * reach the filesystem.
 *
 * The view is script-free by construction — the compare-sheet pattern of
 * radio inputs driving sibling `:checked` selectors (no JavaScript slider) —
 * and is served under a CSP that forbids script, connect, objects, framing,
 * base-uri and form-action, allowing only same-origin images and inline
 * style, with no-store/nosniff/no-referrer on every response. The session
 * and its view make no remote requests: images are served from the held
 * Render bytes and the exact validated Reference bytes (checkReference read
 * the file once; the session never rereads it).
 *
 * Lifecycle: one shutdown path. SIGTERM and SIGINT run the same shutdown —
 * stop the listener, release the held browser (page, context, browser,
 * ADR-0010), and emit the one-line terminal event: successful cleanup writes
 * {"event":"closed","ok":true} and exits 0; failed cleanup writes
 * {"event":"closed","ok":false,"errors":[…]} and exits 1. A live session's
 * stdout carries exactly two one-line JSON events: "started" and "closed".
 */
import crypto, { timingSafeEqual } from "node:crypto";
import type { CheckedReference } from "./compare.js";
import { closeBrowser } from "./browser.js";
import { escapeHtml } from "./html.js";

export interface AuthorSessionInput {
  /** Scene basename — the view's title. */
  scene: string;
  /** The one in-memory Render, produced before the session listens. */
  renderPng: Buffer;
  /** The validated Reference Thumbnail (its bytes were read once upstream). */
  reference: CheckedReference;
}

/**
 * The session's process boundary — the seams the one shutdown path runs
 * through. Production wires the real listener, browser release, stdout, and
 * exit; fault-injection tests substitute deterministic failures.
 */
export interface SessionIo {
  /** Stop the listener (may be sync or async). */
  stopListener: () => unknown;
  /** Release the held browser: page, context, browser (ADR-0010). */
  closeBrowser: () => Promise<void>;
  /** Write one one-line JSON event, resolved once flushed. */
  emit: (event: Record<string, unknown>) => Promise<void>;
  /** Terminate the process. */
  exit: (code: number) => never;
}

/**
 * The one shutdown path for every exit trigger: every resource is attempted
 * even after an earlier failure, and the terminal event reports success only
 * when all cleanup succeeded — a cleanup failure is a structured terminal
 * failure event with a nonzero status, never a silent success (ADR-0010
 * fail-loud). Exposed for deterministic fault-injection coverage.
 */
export async function shutdownSession(io: SessionIo): Promise<never> {
  const failures: string[] = [];
  try {
    await Promise.resolve(io.stopListener());
  } catch (err) {
    failures.push(`listener: ${(err as Error).message}`);
  }
  try {
    await io.closeBrowser();
  } catch (err) {
    failures.push(`browser: ${(err as Error).message}`);
  }
  if (failures.length === 0) {
    await io.emit({ event: "closed", ok: true });
    io.exit(0);
  }
  await io.emit({
    event: "closed",
    ok: false,
    errors: failures.map((message) => ({ message })),
  });
  io.exit(1);
}

/**
 * A BodyInit-compatible view of exactly these bytes. Node Buffers are always
 * ArrayBuffer-backed (never SharedArrayBuffer), so the view is exact; the
 * DOM Response contract wants an ArrayBufferView, not a Node Buffer, and a
 * Buffer's backing store may extend beyond its visible range.
 */
const byteView = (bytes: Buffer): Uint8Array<ArrayBuffer> =>
  new Uint8Array(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength);

/** The session CSP: an inert document, self-hosted images, inline style only. */
const CSP =
  "default-src 'none'; script-src 'none'; connect-src 'none'; object-src 'none'; " +
  "img-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

function securityHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "content-security-policy": CSP,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    ...extra,
  };
}

/**
 * The authoring view: side by side by default, an overlay behind a mode
 * radio, opacity steps 0–100 driven by sibling `:checked` selectors — no
 * script anywhere, so the CSP's script/connect bans cost nothing.
 */
export function renderAuthorView(scene: string): string {
  const steps = Array.from({ length: 11 }, (_, i) => i * 10);
  const radios = steps
    .map((v) => `<input type="radio" name="alpha" id="alpha-${v}"${v === 50 ? " checked" : ""}>`)
    .join("");
  const labels = steps.map((v) => `<label for="alpha-${v}">${v}</label>`).join("");
  const rules = steps
    .map((v) => `#alpha-${v}:checked ~ .views .overlay .render{opacity:${v / 100}}`)
    .join("\n");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<title>scene author — ${escapeHtml(scene)}</title>
<style>
${rules}
#mode-overlay:checked ~ .views .side{display:none}
#mode-side:checked ~ .views .overlay{display:none}
#mode-side:checked ~ .controls label[for="mode-side"],
#mode-overlay:checked ~ .controls label[for="mode-overlay"],
#alpha-0:checked ~ .controls label[for="alpha-0"],#alpha-10:checked ~ .controls label[for="alpha-10"],
#alpha-20:checked ~ .controls label[for="alpha-20"],#alpha-30:checked ~ .controls label[for="alpha-30"],
#alpha-40:checked ~ .controls label[for="alpha-40"],#alpha-50:checked ~ .controls label[for="alpha-50"],
#alpha-60:checked ~ .controls label[for="alpha-60"],#alpha-70:checked ~ .controls label[for="alpha-70"],
#alpha-80:checked ~ .controls label[for="alpha-80"],#alpha-90:checked ~ .controls label[for="alpha-90"],
#alpha-100:checked ~ .controls label[for="alpha-100"]{background:#26282e;color:#e7e7ea}
body{background:#0b0b0d;color:#e7e7ea;font:14px/1.5 -apple-system,sans-serif;margin:0;padding:32px}
h1{font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:#8a8a94;font-size:15px;margin:0 0 16px}
.controls{display:flex;align-items:center;gap:6px;margin:0 0 12px;font-size:11px;color:#8a8a94}
input[type="radio"]{position:absolute;opacity:0;pointer-events:none}
.controls label{border:1px solid #26282e;border-radius:4px;padding:2px 8px;cursor:pointer}
.views .side{display:flex;gap:20px;flex-wrap:wrap;align-items:flex-start}
  .side figure{flex:1 1 480px;min-width:480px;max-width:1280px;margin:0;background:linear-gradient(160deg,#16181d,#0e1013);border:1px solid #26282e;border-radius:8px;padding:14px;display:flex;flex-direction:column;align-items:center;gap:10px}
.side img{display:block;width:100%;max-width:1280px;height:auto;border-radius:4px}
figcaption{font-size:11px;color:#8a8a94;font-family:ui-monospace,monospace;text-align:center}
.views .overlay{position:relative;width:1280px;max-width:100%;aspect-ratio:16/9;border-radius:4px;overflow:hidden;background:linear-gradient(160deg,#16181d,#0e1013)}
.overlay img{position:absolute;inset:0;width:100%;height:100%;display:block}
.overlay .render{opacity:.5}
</style></head><body>
<h1>Scene author · ${escapeHtml(scene)}</h1>
<input type="radio" name="mode" id="mode-side" checked>
<input type="radio" name="mode" id="mode-overlay">
${radios}
<div class="controls">view <label for="mode-side">side by side</label><label for="mode-overlay">overlay</label><span>opacity</span>${labels}</div>
<div class="views">
  <div class="side">
    <figure><img src="reference.png" alt="Reference Thumbnail"><figcaption>reference</figcaption></figure>
    <figure><img src="render.png" alt="Render"><figcaption>render</figcaption></figure>
  </div>
  <div class="overlay">
    <img src="reference.png" alt="Reference Thumbnail (under)">
    <img class="render" src="render.png" alt="Render (over)">
  </div>
</div>
</body></html>`;
}

/**
 * Hold the live author session. Never returns normally: the session lives
 * until SIGTERM/SIGINT drives the one shutdown path (which exits the
 * process); a failure to start the listener throws to the CLI's error
 * boundary before any "started" event exists.
 */
export async function startAuthorSession(input: AuthorSessionInput): Promise<never> {
  // 32 random capability bytes — carried only inside session.url.
  const capability = crypto.randomBytes(32);
  const token = capability.toString("hex");
  const referenceBytes = input.reference.bytes;

  const empty = (status: number) => new Response(null, { status, headers: securityHeaders() });
  const png = (bytes: Buffer) =>
    new Response(byteView(bytes), { headers: securityHeaders({ "content-type": "image/png" }) });

  const server = Bun.serve({
    // Loopback only, ephemeral port: the session never exposes an interface
    // and never races a well-known port.
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      try {
        // The exact generated Host, before anything else: a request that does
        // not carry it never reaches a route (DNS-rebinding posture).
        if (req.headers.get("host") !== `127.0.0.1:${server.port}`) return empty(403);
        if (req.method !== "GET") return empty(405);
        // The fixed-shape capability, parsed once: /<64 hex chars><suffix>.
        // The hex is compared as equal-length bytes (timing-safe, no
        // secret-bearing string equality), and only the non-secret suffix
        // reaches route dispatch — no path-based file serving.
        const match = /^\/([0-9a-f]{64})(\/.+)$/.exec(new URL(req.url).pathname);
        if (!match) return empty(404);
        const given = Buffer.from(match[1]!, "hex");
        if (given.length !== capability.length || !timingSafeEqual(given, capability))
          return empty(404);
        switch (match[2]) {
          case "/view":
            return new Response(renderAuthorView(input.scene), {
              headers: securityHeaders({ "content-type": "text/html; charset=utf-8" }),
            });
          case "/render.png":
            return png(input.renderPng);
          case "/reference.png":
            return png(referenceBytes);
          default:
            return empty(404);
        }
      } catch {
        return empty(500);
      }
    },
  });

  const url = `http://127.0.0.1:${server.port}/${token}/view`;

  // Production seams for the one shutdown path: the listener, the held
  // browser release, one-line JSON events flushed to stdout, and exit.
  const io: SessionIo = {
    stopListener: () => server.stop(true),
    closeBrowser,
    emit: (event) =>
      new Promise((resolve, reject) =>
        process.stdout.write(`${JSON.stringify(event)}\n`, (err) =>
          err ? reject(err) : resolve(),
        ),
      ),
    exit: (code) => process.exit(code),
  };

  // One shutdown path for every exit trigger; a second signal never re-enters.
  let stopping: Promise<never> | null = null;
  const once = (): Promise<never> => {
    stopping ??= shutdownSession(io);
    return stopping;
  };
  process.on("SIGTERM", () => void once());
  process.on("SIGINT", () => void once());

  await io.emit({ event: "started", url });
  return new Promise<never>(() => {});
}