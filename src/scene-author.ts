/**
 * The live Scene author session (#58): after the CLI's full validation gate
 * (Scene + required Reference Thumbnail) and the one in-memory Render, this
 * module holds the session — a loopback-only, capability-scoped HTTP surface
 * showing the Render and the Reference Thumbnail side by side and as an
 * adjustable overlay.
 *
 * Moving Layers (#60): the session holds the authoring state in memory. The
 * gate-validated raw Scene document (authored values, pre-theme) is the one
 * mutable home; a frozen clone taken at session start is the persisted home
 * the view compares against. Each completed drag POSTs one movement — the
 * stable Layer id plus a frame-px delta. The handler clones the current raw
 * state, applies the delta (identity at top level; the inverse of the
 * measured local→frame basis from scene-render's inspection pass for nested
 * Layers), re-runs the complete canonical gate (loadScene: schema,
 * semantics, theme, resolution — local asset/library rereads are accepted)
 * and renders a fresh preview through renderSceneInspection. Only after both
 * validation and render succeed do the candidate raw state, its preview,
 * and the new revision become current; every failure answers with an
 * actionable, field-specific error and changes nothing. Movements serialize
 * strictly FIFO — one candidate validates/renders at a time, revisions are
 * monotonic, and the view applies only a newer revision, so an older result
 * can never replace a newer display. No route writes anything: exiting or
 * losing the session without saving leaves the Scene file byte-identical.
 *
 * Security posture: the server binds 127.0.0.1:0 only (loopback, ephemeral
 * port); a 32-random-byte capability exists only inside session.url — no
 * separate token field, no query parameters. Every request must carry the
 * exact generated Host header and hit one exact token-scoped route
 * (/view, /render.png, /reference.png, /app.js as GET; /move as POST);
 * anything else is an empty 403/404/405. There is no path-based file
 * serving: a wrong path can never reach the filesystem. The view's one
 * script is this session's own static /app.js — no inline script, no eval,
 * no remote origin anywhere; movement requests are same-origin fetches with
 * an application/json content-type and a bounded body. The session and its
 * view make no remote requests: images are served from the held preview
 * bytes and the exact validated Reference bytes (checkReference read the
 * file once; the session never rereads it), and preview renders compose
 * from asset bytes already resolved in memory.
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
import type { Library } from "./assets.js";
import type { Basis, RenderedLayer, VisibleRenderedLayer } from "./scene-render.js";
import { renderSceneInspection } from "./scene-render.js";
import { loadScene, type Scene, type SceneError, type SceneLayer } from "./scene.js";
import { n } from "./scene-geometry.js";
import { closeBrowser } from "./browser.js";
import { escapeHtml } from "./html.js";

/**
 * The measured 2×2 linear map re-exported for the movement math: the session
 * inverts only this measured basis (never scene transform math of its own,
 * DEC-007).
 */
export type { Basis } from "./scene-render.js";

/** Authored position facts for the persisted-vs-unsaved presentation (#60). */
export interface ViewPosition {
  /** The position the loaded Scene file authored — frozen at session start. */
  persisted: { x: number; y: number };
  /** The current in-session authored position — the one mutable home. */
  current: { x: number; y: number };
}

/**
 * A rendered Layer plus, for every Layer with an authored position, the
 * persisted-vs-unsaved position facts the view presents (#60). Connectors
 * have no authored position; hidden Layers keep their position facts (they
 * cannot be moved, but their rows still report the authored values).
 */
export type ViewLayer = RenderedLayer & { position?: ViewPosition };

export interface AuthorSessionInput {
  /** Scene basename — the view's title. */
  scene: string;
  /**
   * The gate-validated raw Scene document — authored values, pre-theme. The
   * session clones it into the one mutable home and, separately, into the
   * frozen persisted home; the caller's copy is never touched. Theme-resolved
   * defaults are never persisted: movements edit and re-validate raw state.
   */
  raw: Scene;
  /** Project root for the complete canonical gate each movement re-runs. */
  projectRoot: string;
  /** Library provider for the complete canonical gate each movement re-runs. */
  library: () => Promise<Library>;
  /**
   * The one in-memory Render, produced before the session listens — the
   * revision-0 preview. A session never serves a Render it has not already
   * produced (and a failed render never opens one).
   */
  preview: { png: Buffer; layers: RenderedLayer[]; warnings: string[] };
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
 * The live authoring state (#60). `raw` is the one mutable home — it changes
 * only when an accepted movement commits. `persistedRaw` is frozen forever:
 * the loaded Scene file's authored values, the comparison target for the
 * persisted-vs-unsaved presentation. `rev` is the single ordering fact.
 */
interface SessionState {
  persistedRaw: Scene;
  raw: Scene;
  rev: number;
  png: Buffer;
  layers: RenderedLayer[];
  warnings: string[];
  /** Project root + library provider for the complete canonical gate. */
  projectRoot: string;
  library: () => Promise<Library>;
}

/** A BodyInit-compatible view of exactly these bytes. Node Buffers are always
 * ArrayBuffer-backed (never SharedArrayBuffer), so the view is exact; the
 * DOM Response contract wants an ArrayBufferView, not a Node Buffer, and a
 * Buffer's backing store may extend beyond its visible range. */
const byteView = (bytes: Buffer): Uint8Array<ArrayBuffer> =>
  new Uint8Array(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength);

/** The session CSP: self-hosted script, self-hosted fetches, data-URI preview
 * images, inline style only — no remote origin of any kind. */
const CSP =
  "default-src 'none'; script-src 'self'; connect-src 'self'; object-src 'none'; " +
  "img-src 'self' data:; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

function securityHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "content-security-policy": CSP,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    ...extra,
  };
}

/** The client script for the one interactive view (#60): pointer drags on the
 * canvas hit targets POST one movement per completed drag, and every response
 * is applied atomically — preview bytes, hit/highlight geometry, listing
 * rows, and the status line move together, and only a newer revision ever
 * replaces the display. This is a static string: no scene data, no user
 * input, nothing interpolated. */
const CLIENT_SCRIPT = `(() => {
  "use strict";
  const base = location.pathname.replace(/\\/view$/, "/");
  const status = document.getElementById("status");
  const warnings = document.getElementById("warnings");
  const img = document.querySelector(".canvas img");
  if (!status || !img) return;
  let applied = Number(status.dataset.rev ?? "0");
  let issued = 0;
  const pct = (v, b) => Number((v / b) * 100).toFixed(4) + "%";

  const changed = (p) =>
    p.persisted.x !== p.current.x || p.persisted.y !== p.current.y;
  const unsavedCount = (layers) => layers.filter((l) => l.position && changed(l.position)).length;

  const setRow = (i, l) => {
    const row = document.querySelector('.listing .row[data-sel="' + i + '"]');
    if (!row) return;
    // Bounds update for every rendered Layer before the position guard: a
    // Connector has no authored position, but its geometry still follows its
    // targets.
    if (l.bounds) {
      const bounds = row.querySelector(".bounds");
      if (bounds)
        bounds.textContent =
          l.bounds.x + "," + l.bounds.y + " · " + l.bounds.width + "×" + l.bounds.height;
    }
    if (!l.position) return;
    const pos = row.querySelector(".pos");
    const was = row.querySelector(".was");
    const moved = changed(l.position);
    if (pos) pos.textContent = l.position.current.x + "," + l.position.current.y;
    if (was)
      was.textContent = moved
        ? "was " + l.position.persisted.x + "," + l.position.persisted.y
        : "";
    row.classList.toggle("modified", moved);
  };

  const apply = (body, current) => {
    const dataUri = "data:image/png;base64," + body.png;
    img.src = dataUri;
    const overlayRender = document.querySelector(".overlay .render");
    if (overlayRender) overlayRender.src = dataUri;
    body.layers.forEach((l, i) => {
      const box = document.querySelector('.canvas .box[data-sel="' + i + '"]');
      const hit = document.querySelector('.canvas .hit[data-sel="' + i + '"]');
      if (l.bounds && box) {
        box.style.left = pct(l.bounds.x, 1280);
        box.style.top = pct(l.bounds.y, 720);
        box.style.width = pct(l.bounds.width, 1280);
        box.style.height = pct(l.bounds.height, 720);
      }
      if (l.bounds && hit) {
        hit.style.left = pct(l.bounds.x + l.bounds.width / 2, 1280);
        hit.style.top = pct(l.bounds.y + l.bounds.height / 2, 720);
        hit.style.width = "max(" + pct(l.bounds.width, 1280) + ",14px)";
        hit.style.height = "max(" + pct(l.bounds.height, 720) + ",14px)";
      }
      setRow(i, l);
    });
    if (warnings) warnings.textContent = body.warnings.join(" · ");
    // The applied revision stays accurate even when a newer outcome owns the
    // status text.
    status.dataset.rev = String(body.rev);
    // The status text belongs to the newest request's outcome only: a delayed
    // older success applies its state without hiding a newer error.
    if (current)
      status.textContent =
        "rev " + body.rev + " · unsaved " + unsavedCount(body.layers) + " · Scene file unchanged";
  };

  const showError = (body, current) => {
    // Only the client's current request may write the status line: a delayed
    // older failure must never overwrite a newer outcome.
    if (!current) return;
    const messages = (body && body.errors ? body.errors : []).map((e) => e.message);
    status.textContent = messages.length ? messages.join(" · ") : "movement rejected";
    // Revision, preview bytes, geometry, and rows stay untouched: the last
    // valid preview remains on display.
  };

  const move = async (id, dx, dy) => {
    // Monotonic client order: each request knows whether a newer one has
    // been issued by the time it resolves.
    const seq = ++issued;
    let res;
    try {
      res = await fetch(base + "move", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: id, dx: dx, dy: dy }),
      });
    } catch {
      if (seq === issued)
        status.textContent = "movement failed — the session is unreachable";
      return;
    }
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (!res.ok) {
      showError(body, seq === issued);
      return;
    }
    // Responses resolve in completion order; only a newer revision may ever
    // replace the display, so an older result cannot become the newest state.
    if (body && body.rev > applied) {
      apply(body, seq === issued);
      applied = body.rev;
    }
  };

  for (const hit of document.querySelectorAll(".canvas .hit")) {
    hit.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      const startX = e.clientX;
      const startY = e.clientY;
      let dragging = false;
      const onMove = (ev) => {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) >= 3) dragging = true;
      };
      const onUp = (ev) => {
        hit.removeEventListener("pointermove", onMove);
        if (!dragging) return; // a plain click: the label's native selection applies
        const scale = 1280 / img.getBoundingClientRect().width;
        void move(hit.dataset.layerId, (ev.clientX - startX) * scale, (ev.clientY - startY) * scale);
      };
      hit.addEventListener("pointermove", onMove);
      hit.addEventListener("pointerup", onUp, { once: true });
      try {
        hit.setPointerCapture(e.pointerId);
      } catch {
        // A synthetic pointer has no capturable id; dispatch reaches the
        // listeners directly.
      }
    });
  }
})();`;

/**
 * The authoring view: side by side by default, an overlay behind a mode
 * radio, opacity steps 0–100 driven by sibling `:checked` selectors.
 *
 * Layer inspection (#59): every resolved Layer is listed exactly once in
 * render order — nested Group children and Connectors included. Visible
 * layers get a generated-index radio (one script-free radio group is the
 * single selection state), an exact hit/highlight box over the render, and a
 * selectable listing row; layers that paint nothing — hidden or exactly
 * opacity: 0, on themselves or an ancestor Group — appear once as disabled,
 * non-selectable rows with bounds absent and no canvas target. Raw layer ids
 * never enter selectors or generated control attributes (id, for, data-sel —
 * generated tree indices only); escaped ids appear solely as inert
 * data-layer-id association attributes on the hit/highlight boxes and as
 * escaped listing text.
 *
 * Unsaved movement state (#60): the status line names the revision and the
 * unsaved-Layer count; each positioned row reports its current authored
 * position and, once it differs from the persisted Scene values, a "was"
 * marker and the modified class. The one script (app.js) applies each
 * movement response atomically and never lets an older revision win.
 */
export function renderAuthorView(
  scene: string,
  layers: ViewLayer[],
  meta: { rev: number; warnings: string[] },
): string {
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
  const fmtPos = (p: { x: number; y: number }) => `${p.x},${p.y}`;
  // One radio per VISIBLE layer, keyed by generated tree index — the single
  // selection state both the canvas and the listing drive. Hidden layers get
  // none: no radio, no canvas target, nothing to select.
  const layerRadios = layers
    .map((l, i) => (l.visible ? `<input type="radio" name="layer" id="layer-${i}">` : ""))
    .join("");
  // Generated selection rules — indexed, never id-bearing. The selected
  // Layer's hit rises above every unselected hit (a Connector's painted-AABB
  // target included): once a Layer is selected, dragging it must land on it,
  // wherever its box sits relative to later Layers (#60). The priority is
  // derived from this render's own layer count — strictly above the maximum
  // compositing-order hit index (1 + count − 1) — never a fixed constant a
  // large layer count could outrank. Unselected hits keep the compositing
  // order on their inline style.
  const selectedHitZ = layers.length + 1;
  const selectionRules = layers
    .map((l, i) =>
      l.visible
        ? `#layer-${i}:checked ~ .views .box[data-sel="${i}"]{display:block}\n` +
          `#layer-${i}:checked ~ .views .hit[data-sel="${i}"]{outline:2px solid #ffd166;z-index:${selectedHitZ}!important}\n` +
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
  // absent — visibly hidden, never selectable. Positioned rows carry their
  // current authored position plus a "was" marker once it differs from the
  // persisted Scene values (#60); the view script updates both per response.
  const boundsText = (b: { x: number; y: number; width: number; height: number }) =>
    `${b.x},${b.y} · ${b.width}×${b.height}`;
  const rows = layers
    .map((l, i) => {
      const head = `<span class="idx">${i}</span><span class="type">${l.type}</span>` +
        `<span class="name">${escapeHtml(l.id)}</span>`;
      if (!l.visible)
        return `<div class="row hidden" data-sel="${i}" aria-disabled="true">${head}` +
          `<span class="state">hidden</span></div>`;
      if (!l.position)
        return `<label class="row" for="layer-${i}" data-sel="${i}">${head}` +
          `<span class="bounds">${boundsText(l.bounds)}</span></label>`;
      const moved = l.position.persisted.x !== l.position.current.x ||
        l.position.persisted.y !== l.position.current.y;
      const was = moved ? `<span class="was">was ${fmtPos(l.position.persisted)}</span>` : `<span class="was"></span>`;
      return `<label class="row${moved ? " modified" : ""}" for="layer-${i}" data-sel="${i}">${head}` +
        `${was}<span class="pos">${fmtPos(l.position.current)}</span>` +
        `<span class="bounds">${boundsText(l.bounds)}</span></label>`;
    })
    .join("\n");
  const unsaved = layers.filter(
    (l) =>
      l.position &&
      (l.position.persisted.x !== l.position.current.x ||
        l.position.persisted.y !== l.position.current.y),
  ).length;

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
.statusbar{display:flex;align-items:baseline;gap:16px;margin:0 0 12px;font:12px/1.6 ui-monospace,monospace}
.statusbar #status{color:#ffd166}
.statusbar #warnings{color:#8a8a94;overflow-wrap:anywhere}
.controls{display:flex;align-items:center;gap:6px;margin:0 0 12px;font-size:11px;color:#8a8a94}
input[type="radio"]{position:absolute;opacity:0;pointer-events:none}
.controls label{border:1px solid #26282e;border-radius:4px;padding:2px 8px;cursor:pointer}
.listing{width:1280px;max-width:100%;margin:0 0 16px;border:1px solid #26282e;border-radius:8px;overflow:hidden;background:#101216}
.listing .row{display:flex;align-items:baseline;gap:12px;padding:4px 12px;font:12px/1.7 ui-monospace,monospace;margin:0}
.listing label.row{cursor:pointer}
.listing .row .idx{color:#5a5a62;min-width:2ch;text-align:right}
.listing .row .type{color:#7fb0ff;min-width:9ch}
.listing .row .name{color:#e7e7ea;overflow-wrap:anywhere}
.listing .row .was{color:#c96f6f;font-style:italic}
.listing .row .pos{color:#e7e7ea;min-width:12ch}
.listing .row .bounds{color:#8a8a94;margin-left:auto;white-space:nowrap}
.listing .row.modified .pos{color:#ffd166}
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
<div class="statusbar"><span id="status" data-rev="${meta.rev}">rev ${meta.rev} · unsaved ${unsaved} · Scene file unchanged</span><span id="warnings">${escapeHtml(meta.warnings.join(" · "))}</span></div>
<div class="controls">view <label for="mode-side">side by side</label><label for="mode-overlay">overlay</label><span>opacity</span>${labels}</div>
<div class="listing">${rows}</div>
<div class="views">
  <div class="side">
    <figure><img src="reference.png" alt="Reference Thumbnail"><figcaption>reference</figcaption></figure>
    <figure><div class="canvas"><img src="render.png" alt="Render">${hits}${boxes}</div><figcaption>render — click a layer to select it, drag it to move it</figcaption></figure>
  </div>
  <div class="overlay">
    <img src="reference.png" alt="Reference Thumbnail (under)">
    <img class="render" src="render.png" alt="Render (over)">
  </div>
</div>
<script src="app.js"></script>
</body></html>`;
}

// --- movements (#60) ---------------------------------------------------------

/** A movement body limit generous for {id,dx,dy} and bounded against abuse. */
const MOVEMENT_BODY_LIMIT = 16 * 1024;

type BodyRead = { ok: true; text: string } | { ok: false; status: 400 | 413; message: string };

/**
 * Read a movement body with the byte budget enforced while streaming. A
 * trustworthy Content-Length over the limit refuses before any body byte is
 * read; a missing, unparseable, or lying header cannot smuggle an oversized
 * body past the streamed byte count either. The limit counts bytes, so a
 * multibyte body is refused on its encoded size, not its character count.
 */
const readMovementBody = async (req: Request): Promise<BodyRead> => {
  const declared = req.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (Number.isInteger(length) && length >= 0 && length > MOVEMENT_BODY_LIMIT)
      return { ok: false, status: 413, message: `movement body exceeds ${MOVEMENT_BODY_LIMIT} bytes` };
  }
  if (!req.body) return { ok: true, text: "" };
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    let value: Uint8Array;
    try {
      const chunk = await reader.read();
      if (chunk.done) break;
      value = chunk.value;
    } catch {
      return { ok: false, status: 400, message: "movement body could not be read" };
    }
    total += value.byteLength;
    if (total > MOVEMENT_BODY_LIMIT) {
      void reader.cancel().catch(() => {});
      return { ok: false, status: 413, message: `movement body exceeds ${MOVEMENT_BODY_LIMIT} bytes` };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  return { ok: true, text: new TextDecoder().decode(bytes) };
};

/** One completed drag: the addressed Layer's stable id and frame-px delta. */
interface Movement {
  id: string;
  dx: number;
  dy: number;
}

/**
 * The exact media type of a Content-Type header, case-insensitively:
 * application/json with any parameters is accepted; a prefix or suffix match
 * is not — application/jsonp and other -suffixed types are rejected.
 */
const isApplicationJson = (contentType: string | null): boolean =>
  contentType !== null && contentType.split(";", 1)[0]!.trim().toLowerCase() === "application/json";

/**
 * Parse a movement body at the boundary: a JSON object carrying the stable
 * Layer id and finite frame-px deltas. Everything else is a structured,
 * actionable rejection.
 */
function parseMovement(text: string): Movement | SceneError[] {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return [{ path: "body", message: "movement body is not valid JSON" }];
  }
  if (typeof body !== "object" || body === null)
    return [{ path: "body", message: "movement body must be a JSON object" }];
  const b = body as Record<string, unknown>;
  if (typeof b.id !== "string" || b.id.length === 0)
    return [{ path: "id", message: "movement needs the Layer's stable id as a non-empty string" }];
  if (typeof b.dx !== "number" || !Number.isFinite(b.dx) || typeof b.dy !== "number" || !Number.isFinite(b.dy))
    return [{ path: "dx,dy", message: "movement needs finite frame-px deltas as numbers for both dx and dy" }];
  return { id: b.id, dx: b.dx, dy: b.dy };
}

/**
 * Find a Layer anywhere in the scene tree by its stable id, with its
 * field-specific path (e.g. `layers[2].layers[0]`) for actionable errors.
 */
function findLayer(
  layers: SceneLayer[],
  id: string,
  path = "layers",
): { layer: SceneLayer; path: string } | undefined {
  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i]!;
    const here = `${path}[${i}]`;
    if (layer.id === id) return { layer, path: here };
    if (layer.type === "group") {
      const found = findLayer(layer.layers, id, `${here}.layers`);
      if (found) return found;
    }
  }
  return undefined;
}

/**
 * The authored position of a positioned Layer. Connectors have no authored
 * position — reaching one here is a contract bug, never a silent default.
 * One helper for both the read side (persisted/current presentation facts)
 * and the write side (the mutation target): a Connector can never reach
 * either site, because the movement boundary rejects it first.
 */
function positionedPosition(tree: SceneLayer, id: string): { x: number; y: number } {
  if (tree.type === "connector")
    throw new Error(`layer "${id}" is a Connector — it has no authored position`);
  return tree.position;
}

/**
 * The view's Layer facts: the render pass's own layers plus, for every
 * Layer with an authored position, the persisted-vs-unsaved position pair.
 * Persisted positions come only from the frozen clone of the loaded Scene;
 * current positions only from the mutable home — one home per fact, never a
 * fallback between them.
 */
function viewLayers(state: SessionState): ViewLayer[] {
  return state.layers.map((l) => {
    if (l.type === "connector") return l;
    const persisted = findLayer(state.persistedRaw.layers, l.id);
    const current = findLayer(state.raw.layers, l.id);
    if (!persisted || !current)
      throw new Error(`layer "${l.id}" is missing from the session Scene trees`);
    return {
      ...l,
      position: {
        persisted: positionedPosition(persisted.layer, l.id),
        current: positionedPosition(current.layer, l.id),
      },
    };
  });
}

/**
 * Invert the measured 2×2 local→frame basis: the frame-px drag delta maps
 * back to the Layer's own coordinate space. A singular (zero-determinant)
 * basis — a degenerate Group transform — has no inverse and is rejected.
 */
function invertBasis({ a, b, c, d }: Basis): Basis | null {
  const det = a * d - b * c;
  // Scale-relative conditioning: a matrix is invertible when its determinant
  // is large relative to its own magnitude — any valid positive Group scale
  // (det = s² > 0, however small) passes, while a genuinely singular,
  // near-singular, or non-finite transform does not. An absolute cutoff
  // would falsely reject small or nested positive scales.
  const scale = Math.max(Math.abs(a), Math.abs(b), Math.abs(c), Math.abs(d));
  if (!Number.isFinite(det) || scale === 0 || !(Math.abs(det) > 1e-9 * scale * scale))
    return null;
  return { a: d / det, b: -b / det, c: -c / det, d: a / det };
}

/** Apply a 2×2 linear map (row-major) to a delta. */
function applyBasis({ a, b, c, d }: Basis, dx: number, dy: number): { x: number; y: number } {
  return { x: a * dx + c * dy, y: b * dx + d * dy };
}

/**
 * One movement, candidate-first: clone the current raw state, apply the
 * delta (top-level: identity; nested: the inverse of the Layer's measured
 * basis), re-run the complete canonical gate and the canonical inspection
 * render — and commit only after both succeed. Any rejection leaves the
 * raw state, revision, preview bytes, and layers exactly as they were.
 */
async function applyMovement(
  state: SessionState,
  req: Movement,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const found = findLayer(state.raw.layers, req.id);
  if (!found)
    return {
      status: 400,
      body: {
        errors: [
          {
            path: "id",
            message: `unknown layer id "${req.id}" — select a Layer from the listing or the canvas; every Layer in the scene tree is addressable by its stable id`,
          },
        ],
      },
    };
  const { layer, path } = found;
  if (layer.type === "connector")
    return {
      status: 400,
      body: {
        errors: [
          {
            path,
            message: `layer "${req.id}" is a Connector — it has no authored position of its own; move its "from"/"to" target Layers instead`,
          },
        ],
      },
    };
  const rendered = state.layers.find((l) => l.id === req.id);
  if (!rendered || !rendered.visible)
    return {
      status: 400,
      body: {
        errors: [
          {
            path,
            message: `layer "${req.id}" paints nothing in the current preview (hidden or fully transparent) — it has no draggable canvas target`,
          },
        ],
      },
    };
  const inverse = invertBasis((rendered as VisibleRenderedLayer).basis);
  if (!inverse)
    return {
      status: 400,
      body: {
        errors: [
          {
            path,
            message: `layer "${req.id}" sits under a degenerate Group transform — its position cannot follow a drag`,
          },
        ],
      },
    };
  const local = applyBasis(inverse, req.dx, req.dy);
  const candidate = structuredClone(state.raw);
  const target = positionedPosition(findLayer(candidate.layers, req.id)!.layer, req.id);
  const nextX = target.x + local.x;
  const nextY = target.y + local.y;
  if (!Number.isFinite(nextX) || !Number.isFinite(nextY))
    return {
      status: 400,
      body: {
        errors: [
          {
            path: `${path}.position`,
            message: `moving layer "${req.id}" by (${req.dx}, ${req.dy}) frame px would leave its position at (${nextX}, ${nextY}) — outside the finite canvas coordinate space`,
          },
        ],
      },
    };
  target.x = n(nextX);
  target.y = n(nextY);
  // The complete canonical gate: schema, semantics, theme, resolution —
  // ordinary Scene changes (DEC-022); local asset/library rereads accepted.
  const loaded = await loadScene(state.projectRoot, state.library, candidate);
  if (!loaded.ok) return { status: 400, body: { errors: loaded.errors } };
  // The canonical validation + render path — never a CSS-only approximation.
  const fresh = await renderSceneInspection(loaded.resolved);
  // Commit: only here does any state change.
  state.raw = candidate;
  state.rev += 1;
  state.png = fresh.png;
  state.layers = fresh.layers;
  state.warnings = fresh.warnings;
  return {
    status: 200,
    body: { rev: state.rev, png: state.png.toString("base64"), warnings: state.warnings, layers: viewLayers(state) },
  };
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

  // The session state: the raw document cloned into the one mutable home and
  // into the frozen persisted home; revision 0 is the pre-listen preview.
  const state: SessionState = {
    persistedRaw: structuredClone(input.raw),
    raw: structuredClone(input.raw),
    rev: 0,
    png: input.preview.png,
    layers: input.preview.layers,
    warnings: input.preview.warnings,
    projectRoot: input.projectRoot,
    library: input.library,
  };

  const empty = (status: number) => new Response(null, { status, headers: securityHeaders() });
  const pngResponse = (bytes: Buffer) =>
    new Response(byteView(bytes), { headers: securityHeaders({ "content-type": "image/png" }) });
  const json = (status: number, body: Record<string, unknown>) =>
    new Response(JSON.stringify(body), {
      status,
      headers: securityHeaders({ "content-type": "application/json" }),
    });

  // FIFO serialization for movements: each candidate validates and renders
  // strictly in enqueue order, one render at a time (the render page itself
  // is process-wide serialized — ADR-0010). Responses carry the monotonic
  // revision they committed; the view applies only newer ones.
  let queue: Promise<unknown> = Promise.resolve();
  const serialize = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task, task);
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

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
            if (req.method !== "GET") return empty(405);
            return new Response(
              renderAuthorView(input.scene, viewLayers(state), { rev: state.rev, warnings: state.warnings }),
              { headers: securityHeaders({ "content-type": "text/html; charset=utf-8" }) },
            );
          case "/render.png":
            if (req.method !== "GET") return empty(405);
            return pngResponse(state.png);
          case "/reference.png":
            if (req.method !== "GET") return empty(405);
            return pngResponse(referenceBytes);
          case "/app.js":
            if (req.method !== "GET") return empty(405);
            return new Response(CLIENT_SCRIPT, {
              headers: securityHeaders({ "content-type": "text/javascript; charset=utf-8" }),
            });
          case "/move": {
            if (req.method !== "POST") return empty(405);
            if (!isApplicationJson(req.headers.get("content-type")))
              return json(400, {
                errors: [{ path: "content-type", message: "movement requests must send application/json" }],
              });
            // Arrival order is commit order: the whole read/parse/apply
            // pipeline enqueues at handler arrival — before the first body
            // read — so a slowly streamed earlier request can never commit
            // after a later complete one.
            try {
              const result = await serialize(
                async (): Promise<{ status: number; body: Record<string, unknown> }> => {
                  const body = await readMovementBody(req);
                  if (!body.ok)
                    return {
                      status: body.status,
                      body: { errors: [{ path: "body", message: body.message }] },
                    };
                  const parsed = parseMovement(body.text);
                  if (Array.isArray(parsed)) return { status: 400, body: { errors: parsed } };
                  return applyMovement(state, parsed);
                },
              );
              return json(result.status, result.body);
            } catch (err) {
              // A render failure changes nothing — the raw state, revision,
              // and last valid preview stand — and the error is actionable.
              return json(500, {
                errors: [{ path: "render", message: (err as Error).message }],
              });
            }
          }
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