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
import type { RenderedLayer } from "./scene-render.js";
import { closeBrowser } from "./browser.js";
import { escapeHtml } from "./html.js";

export interface AuthorSessionInput {
  /** Scene basename — the view's title. */
  scene: string;
  /** The one in-memory Render, produced before the session listens. */
  renderPng: Buffer;
  /** The validated Reference Thumbnail (its bytes were read once upstream). */
  reference: CheckedReference;
  /**
   * The canonical inspection of the same render pass (#59): every resolved
   * Layer once, in tree order, with browser-measured bounds. Read-only
   * session data — selection highlights these bounds and never writes.
   */
  layers: RenderedLayer[];
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
 *
 * Layer inspection (#59): every resolved Layer is listed exactly once in
 * render order — nested Group children and Connectors included. Visible
 * layers get a generated-index radio (one script-free radio group is the
 * single selection state), an exact hit/highlight box over the render, and a
 * selectable listing row; hidden layers appear once as disabled,
 * non-selectable rows with bounds absent and no canvas target. Selectors use
 * only the generated tree index — a raw layer id never enters an attribute —
 * and ids render as escaped text.
 */
export function renderAuthorView(scene: string, layers: RenderedLayer[]): string {
  const steps = Array.from({ length: 11 }, (_, i) => i * 10);
  const radios = steps
    .map((v) => `<input type="radio" name="alpha" id="alpha-${v}"${v === 50 ? " checked" : ""}>`)
    .join("");
  const labels = steps.map((v) => `<label for="alpha-${v}">${v}</label>`).join("");
  const rules = steps
    .map((v) => `#alpha-${v}:checked ~ .views .overlay .render{opacity:${v / 100}}`)
    .join("\n");

  // Frame-px bounds → canvas-box percentages. The canvas is exactly 1280×720
  // (the Scene contract, the same fixed geometry the overlay view assumes).
  const pctOf = (v: number, base: number) => `${Number(((v / base) * 100).toFixed(4))}%`;
  // One radio per VISIBLE layer, keyed by generated tree index — the single
  // selection state both the canvas and the listing drive. Hidden layers get
  // none: no radio, no canvas target, nothing to select.
  const layerRadios = layers
    .map((l, i) => (l.visible ? `<input type="radio" name="layer" id="layer-${i}">` : ""))
    .join("");
  // Generated selection rules — indexed, never id-bearing.
  const selectionRules = layers
    .map((l, i) =>
      l.visible
        ? `#layer-${i}:checked ~ .views .box[data-sel="${i}"]{display:block}\n` +
          `#layer-${i}:checked ~ .views .hit[data-sel="${i}"]{outline:2px solid #ffd166}\n` +
          `#layer-${i}:checked ~ .listing .row[data-sel="${i}"]{background:#26282e;box-shadow:inset 2px 0 0 #ffd166}`
        : "",
    )
    .filter(Boolean)
    .join("\n");
  // Canvas hit targets, one per visible layer, stacked in compositing order —
  // later layers sit above earlier ones. Each carries its stable Layer id
  // (escaped — text only, never a selector). Positioned at the bounds'
  // center with a symmetric 14px minimum, so small layers stay clickable;
  // the displayed highlight stays exact (the separate .box below).
  const hits = layers
    .map((l, i) => {
      if (!l.visible) return "";
      const b = l.bounds;
      return (
        `<label class="hit" for="layer-${i}" data-sel="${i}" data-layer-id="${escapeHtml(l.id)}" style="` +
        `left:${pctOf(b.x + b.width / 2, 1280)};top:${pctOf(b.y + b.height / 2, 720)};` +
        `width:max(${pctOf(b.width, 1280)},14px);height:max(${pctOf(b.height, 720)},14px);` +
        `transform:translate(-50%,-50%);z-index:${1 + i}"></label>`
      );
    })
    .join("");
  // Highlight boxes: the exact transformed canvas-space AABB of the selected
  // layer — never the min-target geometry. pointer-events:none keeps every
  // click flowing to the hit targets beneath.
  const boxes = layers
    .map((l, i) => {
      if (!l.visible) return "";
      const b = l.bounds;
      return (
        `<div class="box" data-sel="${i}" data-layer-id="${escapeHtml(l.id)}" style="left:${pctOf(b.x, 1280)};top:${pctOf(b.y, 720)};` +
        `width:${pctOf(b.width, 1280)};height:${pctOf(b.height, 720)};z-index:${200 + i}"></div>`
      );
    })
    .join("");
  // The listing: every layer exactly once, in render order. Visible rows are
  // labels for the same radios; hidden rows are disabled divs with bounds
  // absent — visibly hidden, never selectable. The visible/hidden branch is
  // the RenderedLayer union's discriminant: a visible row always has bounds,
  // a hidden row never does.
  const boundsText = (b: { x: number; y: number; width: number; height: number }) =>
    `${b.x},${b.y} · ${b.width}×${b.height}`;
  const rows = layers
    .map((l, i) => {
      const head = `<span class="idx">${i}</span><span class="type">${l.type}</span>` +
        `<span class="name">${escapeHtml(l.id)}</span>`;
      if (!l.visible)
        return `<div class="row hidden" data-sel="${i}" aria-disabled="true">${head}` +
          `<span class="state">hidden</span></div>`;
      return `<label class="row" for="layer-${i}" data-sel="${i}">${head}` +
        `<span class="bounds">${boundsText(l.bounds)}</span></label>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<title>scene author — ${escapeHtml(scene)}</title>
<style>
${rules}
${selectionRules}
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
.listing{width:1280px;max-width:100%;margin:0 0 16px;border:1px solid #26282e;border-radius:8px;overflow:hidden;background:#101216}
.listing .row{display:flex;align-items:baseline;gap:12px;padding:4px 12px;font:12px/1.7 ui-monospace,monospace;margin:0}
.listing label.row{cursor:pointer}
.listing .row .idx{color:#5a5a62;min-width:2ch;text-align:right}
.listing .row .type{color:#7fb0ff;min-width:9ch}
.listing .row .name{color:#e7e7ea;overflow-wrap:anywhere}
.listing .row .bounds{color:#8a8a94;margin-left:auto;white-space:nowrap}
.listing .row.hidden{color:#6a6a72;opacity:.55;cursor:default}
.listing .row.hidden .type{color:#6a6a72}
.listing .row.hidden .state{color:#c96f6f;margin-left:auto;font-style:italic}
.views .side{display:flex;gap:20px;flex-wrap:wrap;align-items:flex-start}
  .side figure{flex:1 1 480px;min-width:480px;max-width:1280px;margin:0;background:linear-gradient(160deg,#16181d,#0e1013);border:1px solid #26282e;border-radius:8px;padding:14px;display:flex;flex-direction:column;align-items:center;gap:10px}
.side img{display:block;width:100%;max-width:1280px;height:auto;border-radius:4px}
figcaption{font-size:11px;color:#8a8a94;font-family:ui-monospace,monospace;text-align:center}
.views .overlay{position:relative;width:1280px;max-width:100%;aspect-ratio:16/9;border-radius:4px;overflow:hidden;background:linear-gradient(160deg,#16181d,#0e1013)}
.overlay img{position:absolute;inset:0;width:100%;height:100%;display:block}
.overlay .render{opacity:.5}
.canvas{position:relative;width:100%;max-width:1280px;aspect-ratio:16/9}
.canvas img{position:absolute;inset:0;width:100%;height:100%;display:block;border-radius:4px}
.canvas .hit{position:absolute;display:block;cursor:pointer;border-radius:2px}
.canvas .hit:hover{outline:1px dashed rgba(255,209,102,.55)}
.canvas .box{position:absolute;display:none;outline:2px solid #ffd166;outline-offset:-1px;pointer-events:none;border-radius:2px}
</style></head><body>
<h1>Scene author · ${escapeHtml(scene)}</h1>
<input type="radio" name="mode" id="mode-side" checked>
<input type="radio" name="mode" id="mode-overlay">
${radios}
${layerRadios}
<div class="controls">view <label for="mode-side">side by side</label><label for="mode-overlay">overlay</label><span>opacity</span>${labels}</div>
<div class="listing">${rows}</div>
<div class="views">
  <div class="side">
    <figure><img src="reference.png" alt="Reference Thumbnail"><figcaption>reference</figcaption></figure>
    <figure><div class="canvas"><img src="render.png" alt="Render">${hits}${boxes}</div><figcaption>render — click a layer to select it</figcaption></figure>
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
            return new Response(renderAuthorView(input.scene, input.layers), {
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