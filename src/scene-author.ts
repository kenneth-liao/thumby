/**
 * The live Scene author session (#58): after the CLI's full validation gate
 * (Scene + required Reference Thumbnail) and the one in-memory Render, this
 * module holds the session — a loopback-only, capability-scoped HTTP surface
 * showing the Render and the Reference Thumbnail side by side and as an
 * adjustable overlay.
 *
 * Geometry editing (#60, #61): the session holds the authoring state in
 * memory. The gate-validated raw Scene document (authored values, pre-theme)
 * is the one mutable home; a frozen clone taken at session start is the
 * persisted home the view compares against. Every geometry input reduces to
 * the same commit: a movement drag POSTs /move (id + frame-px delta), a
 * corner-handle drag POSTs /resize (id + authored-corner handle + the frame-px
 * displacement of that corner), and the numeric panel POSTs /geometry (id +
 * the exact authored fields to set). The handler clones the current raw
 * state, applies the change (numeric edits land exactly; drag/resize deltas
 * are mapped through the renderer-measured bases from scene-render's
 * inspection pass — the ancestor basis for movement and centers, the full
 * basis including the Layer's own transform for resize), re-runs the complete
 * canonical gate (loadScene: schema, semantics, theme, resolution — local
 * asset/library rereads are accepted) and renders a fresh preview through
 * renderSceneInspection. The complete next state and its full response are
 * built before any live state is touched; only then does the commit assign
 * them, so no failure or throw can leave a half-mutated session. Every
 * rejection answers with an actionable, field-specific error and changes
 * nothing. Changes serialize strictly FIFO — one candidate validates/renders
 * at a time, revisions are monotonic, and the view applies only a newer
 * revision, so an older result can never replace a newer display.
 *
 * Explicit save (#62): the view carries a Save control that POSTs /save, and
 * a save joins the same handler-arrival FIFO queue as geometry — a save
 * arriving after earlier edits persists exactly those committed edits, and
 * later edits stay unsaved. The session holds the canonical Scene file path
 * and the exact source bytes read when it opened. The save transaction
 * (saveSessionScene) re-runs the ordinary loadScene gate on the raw authored
 * candidate, serializes ONLY that raw document (pretty JSON + newline — never
 * theme-resolved defaults, render measurements, handles/bases, or other
 * derived Render state), then — under the per-Scene filesystem lock from
 * reference-import.ts, taken on the Scene's REAL path so aliases contend and
 * a symlink is replaced at its target rather than itself — re-reads the
 * target and refuses unless the exact bytes still equal the session's
 * expected source bytes (hashes appear only as message diagnostics; the
 * comparison is byte equality). Publication goes through the existing
 * atomicReplace helper. Every failure — gate, lock, read, comparison, write —
 * answers with an actionable error, writes nothing, leaves the previous Scene
 * usable, and never reports success. Only after a successful replacement does
 * the session advance its expected source bytes, set persistedRaw to the
 * saved raw document, bump the monotonic revision, and return view facts that
 * reset the unsaved markers to zero: future edits become unsaved against the
 * new baseline, and the next save compares against the just-written bytes.
 * Exiting or losing the session without saving leaves the Scene file
 * byte-identical.
 *
 * Security posture: the server binds 127.0.0.1:0 only (loopback, ephemeral
 * port); a 32-random-byte capability exists only inside session.url — no
 * separate token field, no query parameters. Every request must carry the
 * exact generated Host header and hit one exact token-scoped route
 * (/view, /render.png, /reference.png, /app.js as GET; /move, /resize,
 * /geometry, /save as POST); anything else is an empty 403/404/405. There is
 * no path-based file serving: a wrong path can never reach the filesystem. The
 * view's one script is this session's own static /app.js — no inline script,
 * no eval, no remote origin anywhere; geometry and save requests are
 * same-origin fetches with an application/json content-type and a bounded
 * body. The
 * session and its view make no remote requests: images are served from the
 * held preview bytes and the exact validated Reference bytes (checkReference
 * read the file once; the session never rereads it), and preview renders
 * compose from asset bytes already resolved in memory.
 *
 * Lifecycle: one shutdown path. SIGTERM and SIGINT run the same shutdown —
 * stop the listener, release the held browser (page, context, browser,
 * ADR-0010), and emit the one-line terminal event: successful cleanup writes
 * {"event":"closed","ok":true} and exits 0; failed cleanup writes
 * {"event":"closed","ok":false,"errors":[…]} and exits 1. A live session's
 * stdout carries exactly two one-line JSON events: "started" and "closed".
 */
import crypto, { timingSafeEqual } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import type { CheckedReference } from "./compare.js";
import type { Library } from "./assets.js";
import { contentHash } from "./assets.js";
import { acquireSceneLock, atomicReplace } from "./reference-import.js";
import type {
  Basis,
  LayerBox,
  LayerCorners,
  RenderedLayer,
  VisibleRenderedLayer,
} from "./scene-render.js";
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

/** Authored size facts for the persisted-vs-unsaved presentation (#61). */
export interface ViewSize {
  /** The size the loaded Scene file authored — frozen at session start. */
  persisted: { width: number; height: number };
  /** The current in-session authored size — the one mutable home. */
  current: { width: number; height: number };
}

/** The measured authored-corner handle anchors, frame px (#61). */
export type ViewHandles = LayerCorners;

/**
 * The outbound view facts: exactly what the client consumes — the Layer's
 * identity, its render facts, and the view's geometry fields. Renderer-only
 * measurements (the linear bases and the raw corner readings behind
 * `handles`) stay in server state and are never serialized; the handle
 * coordinates appear exactly once. A hidden Layer carries no geometry facts
 * and never bounds (a hidden Layer with bounds is unrepresentable).
 */
export interface HiddenViewLayer {
  id: string;
  type: SceneLayer["type"];
  visible: false;
  bounds: null;
  /** The coordinate space the Layer's authored values would live in (#61). */
  space: string;
  /** Why geometry editing is read-only, naming the absent authored fields (#61). */
  geometryNote?: string;
}

/** The visible Layer's view facts (#60, #61). */
export interface VisibleViewLayer {
  id: string;
  type: SceneLayer["type"];
  visible: true;
  bounds: LayerBox;
  position?: ViewPosition;
  size?: ViewSize;
  /** The coordinate space the authored values live in — canvas px, or the parent Group's local px (#61). */
  space: string;
  /** The DOM-measured authored-corner handle anchors (#61). Present only when the Layer has both authored fields. */
  handles?: ViewHandles;
  /** Why geometry editing is read-only for this Layer, naming the absent authored fields (#61). */
  geometryNote?: string;
}

export type ViewLayer = HiddenViewLayer | VisibleViewLayer;

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
  /**
   * The canonical Scene file path exactly as the session opened it — the
   * save transaction's lock and replacement resolution starts here, on the
   * file's REAL target.
   */
  sceneFile: string;
  /**
   * The exact source bytes read when the session opened — the save's
   * stale-write comparison baseline, advanced only by a successful save.
   */
  sourceBytes: Buffer;
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
  /** The canonical Scene file path — the save transaction's target. */
  sceneFile: string;
  /**
   * The exact bytes the session expects on disk — the source bytes it opened
   * with, advanced to the just-written bytes by each successful save.
   */
  expectedSource: Buffer;
  /** Whether a save has ever replaced the Scene file in this session. */
  hasSaved: boolean;
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

/** The client script for the one interactive view (#60, #61): pointer drags on
 * the canvas hit targets POST one movement per completed drag, corner-handle
 * drags POST one resize, and every response is applied atomically — preview
 * bytes, hit/highlight/handle geometry, listing rows, and the status line
 * move together, and only a newer revision ever replaces the display. This is
 * a static string: no scene data, no user input, nothing interpolated. */
const CLIENT_SCRIPT = `(() => {
  "use strict";
  const base = location.pathname.replace(/\\/view$/, "/");
  const status = document.getElementById("status");
  const warnings = document.getElementById("warnings");
  const img = document.querySelector(".canvas img");
  if (!status || !img) return;
  let applied = Number(status.dataset.rev ?? "0");
  let issued = 0;
  // The saved fact (#62) boots from the server-rendered status: whether a
  // save has ever replaced the Scene file in this session.
  let saved = status.dataset.saved === "1";
  const pct = (v, b) => Number((v / b) * 100).toFixed(4) + "%";

  const changed = (p) =>
    p.persisted.x !== p.current.x || p.persisted.y !== p.current.y;
  const sizeChanged = (s) =>
    s.persisted.width !== s.current.width || s.persisted.height !== s.current.height;
  const unsavedCount = (layers) =>
    layers.filter((l) => (l.position && changed(l.position)) || (l.size && sizeChanged(l.size))).length;

  const setRow = (i, l) => {
    const row = document.querySelector('.listing .row[data-sel="' + i + '"]');
    if (!row) return;
    // Bounds update for every rendered Layer before the position guard: a
    // Connector has no authored position, but its geometry still follows its
    // targets. The modified class follows either authored field (#61).
    if (l.bounds) {
      const bounds = row.querySelector(".bounds");
      if (bounds)
        bounds.textContent =
          l.bounds.x + "," + l.bounds.y + " · " + l.bounds.width + "×" + l.bounds.height;
    }
    const moved = (l.position && changed(l.position)) || (l.size && sizeChanged(l.size));
    row.classList.toggle("modified", moved);
    if (!l.position) return;
    const pos = row.querySelector(".pos");
    const was = row.querySelector(".was");
    if (pos) pos.textContent = l.position.current.x + "," + l.position.current.y;
    if (was)
      was.textContent = changed(l.position)
        ? "was " + l.position.persisted.x + "," + l.position.persisted.y
        : "";
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
      // Resize handles re-anchor to the freshly measured transformed corners
      // of the Layer's own box — never the painted AABB (#61).
      if (l.handles) {
        const keys = ["nw", "ne", "se", "sw"];
        for (const k of keys) {
          const h = document.querySelector(
            '.canvas .handle[data-sel="' + i + '"][data-handle="' + k + '"]',
          );
          if (h) {
            h.style.left = pct(l.handles[k].x, 1280);
            h.style.top = pct(l.handles[k].y, 720);
          }
        }
      }
      setRow(i, l);
      // The numeric form follows the same geometry state: every accepted
      // response advances each field's data-accepted baseline and rewrites
      // the persisted-diff marker and the modified class (#61). A field is
      // locally dirty exactly when its typed value has drifted from its
      // baseline — one authoritative DOM representation, no separate edit
      // home — and a locally dirty, in-progress value is never overwritten
      // by another request's acceptance; only the field's own accepted
      // request converges value and baseline (#74).
      const form = document.querySelector('.geometry .geom[data-sel="' + i + '"]');
      if (form) {
        for (const inp of form.querySelectorAll("input[data-field]")) {
          const f = inp.dataset.field;
          const v =
            f === "x" || f === "y"
              ? l.position
                ? l.position.current[f]
                : null
              : l.size
                ? l.size.current[f]
                : null;
          if (v === null || v === undefined) continue;
          const dirty = inp.value !== inp.dataset.accepted;
          inp.dataset.accepted = String(v);
          if (!dirty) inp.value = inp.dataset.accepted;
        }
        const posMoved = l.position && changed(l.position);
        const sizeMoved = l.size && sizeChanged(l.size);
        const was = form.querySelector(".geom-was");
        if (was) {
          const parts = [];
          if (posMoved)
            parts.push("pos was " + l.position.persisted.x + "," + l.position.persisted.y);
          if (sizeMoved)
            parts.push(
              "size was " + l.size.persisted.width + "×" + l.size.persisted.height,
            );
          was.textContent = parts.join(" · ");
        }
        form.classList.toggle("modified", Boolean(posMoved || sizeMoved));
      }
    });
    if (warnings) warnings.textContent = body.warnings.join(" · ");
    // The applied revision stays accurate even when a newer outcome owns the
    // status text.
    status.dataset.rev = String(body.rev);
    // The saved fact is state, not status text: any applied save response
    // makes the session saved, whatever newer request owns the status line
    // right now (#62).
    if (body.saved) saved = true;
    status.dataset.saved = saved ? "1" : "0";
    // The status text belongs to the newest request's outcome only: a delayed
    // older success applies its state without hiding a newer error.
    if (current)
      status.textContent =
        "rev " + body.rev + " · unsaved " + unsavedCount(body.layers) + " · " +
        (saved ? "Scene file saved" : "Scene file unchanged");
  };

  const showError = (body, current) => {
    // Only the client's current request may write the status line: a delayed
    // older failure must never overwrite a newer outcome.
    if (!current) return;
    const messages = (body && body.errors ? body.errors : []).map((e) => e.message);
    status.textContent = messages.length ? messages.join(" · ") : "geometry change rejected";
    // Revision, preview bytes, geometry, and rows stay untouched: the last
    // valid preview remains on display.
  };

  /** One response outcome, shared by every geometry poster: a rejection
   * writes the status line only while its request is the client's current
   * one (and lets the caller restore its own inputs first); an acceptance
   * applies only a newer revision. */
  const settle = async (res, seq, onReject) => {
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (!res.ok) {
      // Only the client's current request may restore form state or write
      // the status line: a stale rejection must never overwrite a newer
      // request's pending or accepted form input.
      if (onReject) onReject(seq === issued);
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

  // The one field-restore home (#61, #74): a rejected or unreachable request
  // puts its own field back to its last accepted value — other fields' local,
  // in-progress edits are never touched, and neither is a newer unsubmitted
  // edit of the same field (the request's captured edit generation must still
  // be current).
  const restoreField = (inp) => {
    inp.value = inp.dataset.accepted;
  };

  // The one unreachable-session fallback text, shared by every geometry
  // poster — the same request/apply/error path serves move, resize, and
  // numeric edits (#61).
  const unreachable = "geometry request failed — the session is unreachable";

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
      if (seq === issued) status.textContent = unreachable;
      return;
    }
    await settle(res, seq);
  };

  // One completed corner drag: the frame-px displacement of the grabbed
  // authored corner. The session maps it through the measured bases (#61).
  const resize = async (id, handle, dx, dy) => {
    const seq = ++issued;
    let res;
    try {
      res = await fetch(base + "resize", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: id, handle: handle, dx: dx, dy: dy }),
      });
    } catch {
      if (seq === issued) status.textContent = unreachable;
      return;
    }
    await settle(res, seq);
  };

  // One exact numeric geometry edit: one field of one form. The request
  // captures the field's edit generation (data-edit, bumped on every input);
  // a current rejection or network failure restores the field's last accepted
  // value only while that captured generation is still current — a newer
  // unsubmitted edit of the same field is never clobbered, while the
  // unreachable failure itself is always surfaced for a current request
  // (#61, #74).
  const geometry = async (form, inp, value) => {
    const gen = inp.dataset.edit;
    const seq = ++issued;
    let res;
    try {
      res = await fetch(base + "geometry", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: form.dataset.layerId,
          set: { [inp.dataset.field]: value },
        }),
      });
    } catch {
      // Status ownership and restore are separate: a globally current request
      // always surfaces the unreachable failure, while the field restores
      // only when its captured edit generation is still current (#74 RE-1).
      if (seq === issued) status.textContent = unreachable;
      if (seq === issued && inp.dataset.edit === gen) restoreField(inp);
      return;
    }
    await settle(res, seq, (current) => {
      if (current && inp.dataset.edit === gen) restoreField(inp);
    });
  };

  // One drag lifecycle for every canvas gesture target (#61): hits move a
  // Layer, handles resize it. A gesture counts only once the pointer passes
  // the 3px threshold; pointerup commits it and pointercancel aborts it —
  // both tear every gesture listener down, so a finished or aborted gesture
  // can never leave a listener behind.
  const bindDrag = (el, onDelta) => {
    el.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      const startX = e.clientX;
      const startY = e.clientY;
      let dragging = false;
      const onMove = (ev) => {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) >= 3) dragging = true;
      };
      const finish = (ev, commit) => {
        el.removeEventListener("pointermove", onMove);
        el.removeEventListener("pointerup", onUp);
        el.removeEventListener("pointercancel", onCancel);
        if (!commit || !dragging) return;
        const scale = 1280 / img.getBoundingClientRect().width;
        onDelta((ev.clientX - startX) * scale, (ev.clientY - startY) * scale);
      };
      const onUp = (ev) => finish(ev, true);
      const onCancel = () => finish(null, false);
      el.addEventListener("pointermove", onMove);
      el.addEventListener("pointerup", onUp, { once: true });
      el.addEventListener("pointercancel", onCancel, { once: true });
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        // A synthetic pointer has no capturable id; dispatch reaches the
        // listeners directly.
      }
    });
  };

  for (const hit of document.querySelectorAll(".canvas .hit")) {
    // A plain click on a hit selects: the label's native radio selection
    // applies; only a real drag moves.
    bindDrag(hit, (dx, dy) => void move(hit.dataset.layerId, dx, dy));
  }

  for (const handle of document.querySelectorAll(".canvas .handle")) {
    // A plain click on a handle changes nothing; only a real drag resizes.
    bindDrag(handle, (dx, dy) =>
      void resize(handle.dataset.layerId, handle.dataset.handle, dx, dy),
    );
  }

  // One explicit save (#62): the Save control POSTs an empty JSON body to the
  // token-scoped /save route through the same discipline as geometry — a
  // monotonic client order, "saving…" while in flight, the status line owned
  // by the newest request's outcome, and an applied save response resetting
  // the unsaved markers against the new persisted baseline.
  const saveUnreachable = "save request failed — the session is unreachable";
  const save = async () => {
    const seq = ++issued;
    status.textContent = "saving…";
    let res;
    try {
      res = await fetch(base + "save", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
    } catch {
      if (seq === issued) status.textContent = saveUnreachable;
      return;
    }
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (!res.ok) {
      // Only the client's current request may write the status line: a
      // delayed older failure must never overwrite a newer outcome.
      if (seq === issued) {
        const messages = (body && body.errors ? body.errors : []).map((e) => e.message);
        status.textContent = messages.length ? messages.join(" · ") : "save rejected";
      }
      return;
    }
    if (body && body.rev > applied) {
      apply(body, seq === issued);
      applied = body.rev;
    }
  };
  const saveButton = document.getElementById("save");
  if (saveButton) saveButton.addEventListener("click", () => void save());

  // Numeric geometry edits (#61): a field's change event (Enter or blur)
  // commits exactly that field's value — one input, one exact authored
  // value. Other still-dirty fields are never swept into the request, and an
  // unparseable value never reaches the session — it restores in place.
  for (const form of document.querySelectorAll(".geometry .geom")) {
    if (!form.dataset.layerId) continue; // a read-only note has no fields
    const submit = (inp) => {
      if (inp.value === inp.dataset.accepted) return;
      const v = Number(inp.value);
      if (inp.value.trim() === "" || !Number.isFinite(v)) {
        inp.value = inp.dataset.accepted;
        return;
      }
      void geometry(form, inp, v);
    };
    for (const inp of form.querySelectorAll("input[data-field]")) {
      // The field's edit generation lives on the input itself and bumps on
      // every input event — programmatic baseline updates never fire one, so
      // the generation counts user edits only (#74).
      inp.addEventListener("input", () => {
        inp.dataset.edit = String(Number(inp.dataset.edit ?? "0") + 1);
      });
      inp.addEventListener("change", () => void submit(inp));
    }
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
 * Unsaved movement state (#60, #61): the status line names the revision and
 * the unsaved-Layer count (position or size); each positioned row reports its
 * current authored position and, once it differs from the persisted Scene
 * values, a "was" marker and the modified class. The one script (app.js)
 * applies each geometry response atomically and never lets an older revision
 * win. The Save control (#62) sits in the status bar: clicking it POSTs /save
 * and the status line reports saving/saved — the persisted-vs-unsaved
 * presentation resets when a save replaces the Scene file.
 */
export function renderAuthorView(
  scene: string,
  layers: ViewLayer[],
  meta: { rev: number; warnings: string[]; saved: boolean },
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
  // order on their inline style. The selected Layer's resize handles rise one
  // step above the selected hit (#61).
  const selectedHitZ = layers.length + 1;
  const selectionRules = layers
    .map((l, i) =>
      l.visible
        ? `#layer-${i}:checked ~ .views .box[data-sel="${i}"]{display:block}\n` +
          `#layer-${i}:checked ~ .views .hit[data-sel="${i}"]{outline:2px solid #ffd166;z-index:${selectedHitZ}!important}\n` +
          `#layer-${i}:checked ~ .views .handle[data-sel="${i}"]{display:block;z-index:${selectedHitZ + 1}}\n` +
          `#layer-${i}:checked ~ .listing .row[data-sel="${i}"]{background:#26282e;box-shadow:inset 2px 0 0 #ffd166}\n` +
          `#layer-${i}:checked ~ .geometry .geom[data-sel="${i}"]{display:flex}`
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
  // Resize handles (#61): four per visible Layer that has both authored
  // position and size, anchored at the DOM-measured transformed authored
  // corners — never the painted AABB. Hidden until the Layer is selected; the
  // view script posts one resize per completed corner drag.
  const HANDLE_KEYS = ["nw", "ne", "se", "sw"] as const;
  const handles = layers
    .map((l, i) => {
      // Geometry fields only exist on a visible Layer's view facts.
      if (!l.visible || !l.handles) return "";
      const anchors = l.handles;
      return HANDLE_KEYS.map((k) => {
        const c = anchors[k];
        return (
          `<span class="handle" data-sel="${i}" data-handle="${k}" data-layer-id="${escapeHtml(l.id)}" ` +
          `style="left:${pctOf(c.x, 1280)};top:${pctOf(c.y, 720)}"></span>`
        );
      }).join("");
    })
    .join("");
  // The listing: every layer exactly once, in render order. Visible rows are
  // labels for the same radios; hidden rows are disabled divs with bounds
  // absent — visibly hidden, never selectable. Positioned rows carry their
  // current authored position plus a "was" marker once it differs from the
  // persisted Scene values (#60); the view script updates both per response.
  const boundsText = (b: { x: number; y: number; width: number; height: number }) =>
    `${b.x},${b.y} · ${b.width}×${b.height}`;
  const sizeMoved = (l: ViewLayer) => {
    const v = l.visible ? l : null;
    return Boolean(
      v?.size &&
        (v.size.persisted.width !== v.size.current.width ||
          v.size.persisted.height !== v.size.current.height),
    );
  };
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
      const moved =
        l.position.persisted.x !== l.position.current.x ||
        l.position.persisted.y !== l.position.current.y ||
        sizeMoved(l);
      const was = l.position.persisted.x !== l.position.current.x ||
        l.position.persisted.y !== l.position.current.y
        ? `<span class="was">was ${fmtPos(l.position.persisted)}</span>`
        : `<span class="was"></span>`;
      return `<label class="row${moved ? " modified" : ""}" for="layer-${i}" data-sel="${i}">${head}` +
        `${was}<span class="pos">${fmtPos(l.position.current)}</span>` +
        `<span class="bounds">${boundsText(l.bounds)}</span></label>`;
    })
    .join("\n");
  // Unsaved = any Layer whose authored position or size differs from the
  // persisted Scene values — one geometry state counts both (#61).
  const unsaved = layers.filter((l) => {
    const v = l.visible ? l : null;
    return Boolean(
      (v?.position &&
        (v.position.persisted.x !== v.position.current.x ||
          v.position.persisted.y !== v.position.current.y)) ||
        sizeMoved(l),
    );
  }).length;

  // The geometry panel (#61): one entry per visible Layer — a numeric form
  // for the authored fields it carries (x/y need position, width/height
  // need size), or a read-only note naming the absent fields (a Connector's
  // note adds its target-derivation reason). Hidden Layers have no entry:
  // they are not selectable. Each input's data-accepted attribute is the DOM
  // home of its last accepted value, rendered initially and rewritten by the
  // view script on every accepted response — rejection restores from it.
  const geomLabel = (field: string) =>
    field === "x" ? "x" : field === "y" ? "y" : field === "width" ? "w" : "h";
  const geomInput = (field: string, value: number) =>
    `<label>${geomLabel(field)} ` +
    `<input data-field="${field}" type="number" step="any" value="${value}" data-accepted="${value}"></label>`;
  const geomEntries = layers
    .map((l, i) => {
      if (!l.visible) return "";
      const fields = [
        ...(l.position ? ["x", "y"] : []),
        ...(l.size ? ["width", "height"] : []),
      ];
      const space = `<span class="space">${escapeHtml(l.space ?? "")}</span>`;
      const note = l.geometryNote
        ? `<span class="geom-note">${escapeHtml(l.geometryNote)}</span>`
        : "";
      if (fields.length === 0)
        return `<div class="geom note" data-sel="${i}" data-layer-id="${escapeHtml(l.id)}">` +
          `${space}<span class="geom-was"></span>${note}</div>`;
      const controls = fields
        .map((f) =>
          geomInput(
            f,
            f === "x"
              ? l.position!.current.x
              : f === "y"
                ? l.position!.current.y
                : f === "width"
                  ? l.size!.current.width
                  : l.size!.current.height,
          ),
        )
        .join("");
      return `<div class="geom" data-sel="${i}" data-layer-id="${escapeHtml(l.id)}">` +
        `${space}${controls}<span class="geom-was"></span>${note}</div>`;
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
.statusbar{display:flex;align-items:baseline;gap:16px;margin:0 0 12px;font:12px/1.6 ui-monospace,monospace}
.statusbar #save{border:1px solid #26282e;border-radius:4px;background:#101216;color:#e7e7ea;font:inherit;padding:2px 14px;cursor:pointer}
.statusbar #save:hover{border-color:#ffd166;color:#ffd166}
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
.geometry{width:1280px;max-width:100%;margin:0 0 16px;border:1px solid #26282e;border-radius:8px;background:#101216;padding:4px 0}
.geom{display:none;align-items:baseline;gap:12px;padding:4px 12px;font:12px/1.7 ui-monospace,monospace;flex-wrap:wrap}
.geom label{display:flex;align-items:baseline;gap:4px;color:#8a8a94}
.geom input{width:10ch;background:#0b0b0d;border:1px solid #26282e;border-radius:4px;color:#e7e7ea;font:inherit;padding:1px 6px}
.geom.modified input{border-color:#ffd166}
.geom .space{color:#7fb0ff;min-width:16ch}
.geom .geom-was{color:#c96f6f;font-style:italic}
.geom .geom-note{color:#8a8a94;font-style:italic}
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
.canvas .handle{position:absolute;display:none;width:9px;height:9px;transform:translate(-50%,-50%);border:1px solid #0b0b0d;background:#ffd166;border-radius:2px;pointer-events:auto;cursor:nwse-resize}
.canvas .handle[data-handle="ne"],.canvas .handle[data-handle="sw"]{cursor:nesw-resize}
</style></head><body>
<h1>Scene author · ${escapeHtml(scene)}</h1>
<input type="radio" name="mode" id="mode-side" checked>
<input type="radio" name="mode" id="mode-overlay">
${radios}
${layerRadios}
<div class="statusbar"><button id="save" type="button">save</button><span id="status" data-rev="${meta.rev}" data-saved="${meta.saved ? "1" : "0"}">rev ${meta.rev} · unsaved ${unsaved} · ${meta.saved ? "Scene file saved" : "Scene file unchanged"}</span><span id="warnings">${escapeHtml(meta.warnings.join(" · "))}</span></div>
<div class="controls">view <label for="mode-side">side by side</label><label for="mode-overlay">overlay</label><span>opacity</span>${labels}</div>
<div class="listing">${rows}</div>
<div class="geometry">${geomEntries}</div>
<div class="views">
  <div class="side">
    <figure><img src="reference.png" alt="Reference Thumbnail"><figcaption>reference</figcaption></figure>
    <figure><div class="canvas"><img src="render.png" alt="Render">${hits}${boxes}${handles}</div><figcaption>render — click a layer to select it, drag it to move it, drag a corner to resize it</figcaption></figure>
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

/** A geometry body limit generous for {id,…} requests and bounded against abuse. */
const GEOMETRY_BODY_LIMIT = 16 * 1024;

type BodyRead = { ok: true; text: string } | { ok: false; status: 400 | 413; message: string };

/**
 * Read a geometry request body with the byte budget enforced while streaming.
 * A trustworthy Content-Length over the limit refuses before any body byte is
 * read; a missing, unparseable, or lying header cannot smuggle an oversized
 * body past the streamed byte count either. The limit counts bytes, so a
 * multibyte body is refused on its encoded size, not its character count.
 */
const readJsonBody = async (req: Request): Promise<BodyRead> => {
  const declared = req.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (Number.isInteger(length) && length >= 0 && length > GEOMETRY_BODY_LIMIT)
      return { ok: false, status: 413, message: `request body exceeds ${GEOMETRY_BODY_LIMIT} bytes` };
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
      return { ok: false, status: 400, message: "request body could not be read" };
    }
    total += value.byteLength;
    if (total > GEOMETRY_BODY_LIMIT) {
      void reader.cancel().catch(() => {});
      return { ok: false, status: 413, message: `request body exceeds ${GEOMETRY_BODY_LIMIT} bytes` };
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
 * Parse a movement body at the boundary: a JSON object carrying exactly the
 * stable Layer id and finite frame-px deltas — unknown fields rejected,
 * never ignored (#61).
 */
function parseMovement(text: string): Movement | SceneError[] {
  const b = parseJsonObject(text, ["id", "dx", "dy"]);
  if (Array.isArray(b)) return b;
  if (typeof b.id !== "string" || b.id.length === 0)
    return [{ path: "id", message: "movement needs the Layer's stable id as a non-empty string" }];
  if (
    typeof b.dx !== "number" ||
    !Number.isFinite(b.dx) ||
    typeof b.dy !== "number" ||
    !Number.isFinite(b.dy)
  )
    return [{ path: "dx,dy", message: "movement needs finite frame-px deltas as numbers for both dx and dy" }];
  return { id: b.id, dx: b.dx, dy: b.dy };
}

/**
 * Find a Layer anywhere in the scene tree by its stable id, with its
 * field-specific path (e.g. `layers[2].layers[0]`) for actionable errors and
 * the id of the Group that contains it (null at top level — the coordinate
 * space the view labels, #61).
 */
function findLayer(
  layers: SceneLayer[],
  id: string,
  path = "layers",
  parentId: string | null = null,
): { layer: SceneLayer; path: string; parentId: string | null } | undefined {
  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i]!;
    const here = `${path}[${i}]`;
    if (layer.id === id) return { layer, path: here, parentId };
    if (layer.type === "group") {
      const found = findLayer(layer.layers, id, `${here}.layers`, layer.id);
      if (found) return found;
    }
  }
  return undefined;
}

/**
 * The authored geometry a Layer carries, read once for both the presentation
 * facts and the mutation target: which of position/size exist. Connectors
 * carry neither; every other Layer type requires both (the schema enforces
 * it) — the capability shape keeps every consumer from ever assuming a type.
 */
function authoredGeometry(tree: SceneLayer): {
  position?: { x: number; y: number };
  size?: { width: number; height: number };
} {
  if (tree.type === "connector") return {};
  return { position: tree.position, size: tree.size };
}

/**
 * The one read-only explanation, shared by the view and every server
 * backstop (#61): which authored fields are absent, and — for a Connector —
 * why: its geometry derives from its targets.
 */
function geometryNote(tree: SceneLayer, absent: string[]): string {
  const fields = absent.length === 1 ? absent[0]! : `${absent[0]} or ${absent[1]}`;
  const reason =
    tree.type === "connector"
      ? " — a Connector's geometry derives from its \"from\"/\"to\" target Layers; move those instead"
      : "";
  return `layer "${tree.id}" has no authored ${fields}${reason}`;
}

/**
 * The view's Layer facts: the render pass's own layers plus, for every Layer
 * with authored geometry, the persisted-vs-unsaved pairs (position and size,
 * independently), the coordinate space the authored values live in, the
 * DOM-measured corner anchors for visible fully-capable Layers, and the
 * read-only note for Layers missing an authored field. Persisted facts come
 * only from the frozen clone of the loaded Scene; current facts only from
 * the mutable home — one home per fact, never a fallback between them.
 */
function viewLayers(state: SessionState): ViewLayer[] {
  return state.layers.map((l) => {
    const persisted = findLayer(state.persistedRaw.layers, l.id);
    const current = findLayer(state.raw.layers, l.id);
    if (!persisted || !current)
      throw new Error(`layer "${l.id}" is missing from the session Scene trees`);
    const persistedGeo = authoredGeometry(persisted.layer);
    const currentGeo = authoredGeometry(current.layer);
    // The two trees must agree on what the Layer can author — no edit ever
    // adds or removes an authored field, so a divergence is a contract bug.
    if (!!persistedGeo.position !== !!currentGeo.position || !!persistedGeo.size !== !!currentGeo.size)
      throw new Error(`layer "${l.id}" has different authored geometry in the persisted and current Scene trees`);
    const space = current.parentId ? `${current.parentId} local px` : "canvas px";
    const absent = [
      ...(currentGeo.position ? [] : ["position"]),
      ...(currentGeo.size ? [] : ["size"]),
    ];
    if (!l.visible) {
      const hidden: HiddenViewLayer = { id: l.id, type: l.type, visible: false, bounds: null, space };
      if (absent.length > 0) hidden.geometryNote = geometryNote(current.layer, absent);
      return hidden;
    }
    const out: VisibleViewLayer = { id: l.id, type: l.type, visible: true, bounds: l.bounds, space };
    if (currentGeo.position && persistedGeo.position)
      out.position = { persisted: persistedGeo.position, current: currentGeo.position };
    if (currentGeo.size && persistedGeo.size)
      out.size = { persisted: persistedGeo.size, current: currentGeo.size };
    if (absent.length > 0) {
      out.geometryNote = geometryNote(current.layer, absent);
      return out;
    }
    // A fully capable visible Layer carries the DOM-measured corner anchors
    // once — the bases stay behind in the session's rendered state.
    if (!l.corners) throw new Error(`layer "${l.id}" paints but has no measured corner points`);
    out.handles = l.corners;
    return out;
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
/** The shared unknown-id rejection: every geometry route names the id. */
function unknownLayerError(id: string): { status: number; body: Record<string, unknown> } {
  return {
    status: 400,
    body: {
      errors: [
        {
          path: "id",
          message: `unknown layer id "${id}" — select a Layer from the listing or the canvas; every Layer in the scene tree is addressable by its stable id`,
        },
      ],
    },
  };
}

/** The shared read-only rejection: the addressed Layer lacks authored geometry. */
function geometryReadonlyError(
  tree: SceneLayer,
  path: string,
  absent: string[],
): { status: number; body: Record<string, unknown> } {
  return {
    status: 400,
    body: { errors: [{ path, message: geometryNote(tree, absent) }] },
  };
}

/** The shared no-canvas-target rejection: the addressed Layer paints nothing. */
function paintsNothingError(
  id: string,
  path: string,
): { status: number; body: Record<string, unknown> } {
  return {
    status: 400,
    body: {
      errors: [
        {
          path,
          message: `layer "${id}" paints nothing in the current preview (hidden or fully transparent) — it has no draggable canvas target`,
        },
      ],
    },
  };
}

/** The shared degenerate-transform rejection: a basis with no inverse. */
function degenerateError(id: string, path: string): { status: number; body: Record<string, unknown> } {
  return {
    status: 400,
    body: {
      errors: [
        {
          path,
          message: `layer "${id}" sits under a degenerate Group transform — its geometry cannot follow a drag`,
        },
      ],
    },
  };
}

/**
 * The one candidate-commit path (#61): every geometry change — movement,
 * resize, numeric edit — arrives here as a fully-mutated candidate raw
 * document. The complete canonical gate (schema, semantics, theme,
 * resolution — ordinary Scene changes, DEC-022; local asset/library rereads
 * accepted) and the canonical validation + render path run — never a
 * CSS-only approximation — and only after both succeed does any session
 * state change. Any rejection leaves the raw state, revision, preview
 * bytes, and layers exactly as they were.
 */
async function commitCandidate(
  state: SessionState,
  candidate: Scene,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const loaded = await loadScene(state.projectRoot, state.library, candidate);
  if (!loaded.ok) return { status: 400, body: { errors: loaded.errors } };
  const fresh = await renderSceneInspection(loaded.resolved);
  // The complete next state and its full response are built against the
  // prospective state before any live state is touched: viewLayers runs on
  // the candidate's view, so a contract failure throws while nothing has
  // changed, and no work follows the commit — the assignment below is the
  // last statement before the response leaves.
  const next: SessionState = {
    ...state,
    raw: candidate,
    rev: state.rev + 1,
    png: fresh.png,
    layers: fresh.layers,
    warnings: fresh.warnings,
  };
  const body = {
    rev: next.rev,
    png: next.png.toString("base64"),
    warnings: next.warnings,
    layers: viewLayers(next),
  };
  // Commit: five synchronous assignments, nothing awaited or thrown after.
  state.raw = next.raw;
  state.rev = next.rev;
  state.png = next.png;
  state.layers = next.layers;
  state.warnings = next.warnings;
  return { status: 200, body };
}

/**
 * One movement, candidate-first: clone the current raw state, apply the
 * delta (top-level: identity; nested: the inverse of the Layer's measured
 * ancestor basis), and commit through the one candidate-commit path.
 */
async function applyMovement(
  state: SessionState,
  req: Movement,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const found = findLayer(state.raw.layers, req.id);
  if (!found) return unknownLayerError(req.id);
  const { layer, path } = found;
  const geo = authoredGeometry(layer);
  if (!geo.position) return geometryReadonlyError(layer, path, ["position"]);
  const rendered = state.layers.find((l) => l.id === req.id);
  if (!rendered || !rendered.visible) return paintsNothingError(req.id, path);
  const inverse = invertBasis((rendered as VisibleRenderedLayer).basis);
  if (!inverse) return degenerateError(req.id, path);
  const local = applyBasis(inverse, req.dx, req.dy);
  const candidate = structuredClone(state.raw);
  const target = authoredGeometry(findLayer(candidate.layers, req.id)!.layer).position!;
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
  return commitCandidate(state, candidate);
}

/** One completed handle drag: the addressed Layer's stable id, which authored
 * corner was grabbed, and the frame-px displacement of that corner. */
interface ResizeRequest {
  id: string;
  handle: "nw" | "ne" | "se" | "sw";
  dx: number;
  dy: number;
}

/** The signed box-axis each authored-corner handle drags: (+1,+1) is se. */
const HANDLE_SIGNS = {
  nw: [-1, -1],
  ne: [1, -1],
  se: [1, 1],
  sw: [-1, 1],
} as const;

/**
 * Parse a JSON body at the boundary into a plain object carrying exactly the
 * expected fields: unknown fields are rejected, never ignored, and missing
 * ones are named — a typo can never silently change a request's meaning.
 */
function parseJsonObject(
  text: string,
  fields: readonly string[],
): Record<string, unknown> | SceneError[] {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return [{ path: "body", message: "the request body is not valid JSON" }];
  }
  if (typeof body !== "object" || body === null || Array.isArray(body))
    return [{ path: "body", message: "the request body must be a JSON object" }];
  const b = body as Record<string, unknown>;
  const unknown = Object.keys(b).filter((k) => !fields.includes(k));
  if (unknown.length)
    return [
      {
        path: "body",
        message: `unexpected field(s) ${unknown.map((k) => `"${k}"`).join(", ")} — expected exactly ${fields.map((k) => `"${k}"`).join(", ")}`,
      },
    ];
  const missing = fields.filter((k) => !Object.hasOwn(b, k));
  if (missing.length)
    return [
      {
        path: "body",
        message: `missing field(s) ${missing.map((k) => `"${k}"`).join(", ")} — expected exactly ${fields.map((k) => `"${k}"`).join(", ")}`,
      },
    ];
  return b;
}

/**
 * Parse a resize body at the boundary: a JSON object carrying exactly the
 * stable Layer id, one authored-corner handle, and finite frame-px deltas.
 */
function parseResize(text: string): ResizeRequest | SceneError[] {
  const b = parseJsonObject(text, ["id", "handle", "dx", "dy"]);
  if (Array.isArray(b)) return b;
  if (typeof b.id !== "string" || b.id.length === 0)
    return [{ path: "id", message: "resize needs the Layer's stable id as a non-empty string" }];
  if (typeof b.handle !== "string" || !Object.hasOwn(HANDLE_SIGNS, b.handle))
    return [{ path: "handle", message: `resize needs a corner handle: one of "nw", "ne", "se", "sw"` }];
  if (
    typeof b.dx !== "number" ||
    !Number.isFinite(b.dx) ||
    typeof b.dy !== "number" ||
    !Number.isFinite(b.dy)
  )
    return [{ path: "dx,dy", message: "resize needs finite frame-px deltas as numbers for both dx and dy" }];
  return { id: b.id, handle: b.handle as ResizeRequest["handle"], dx: b.dx, dy: b.dy };
}

/** The geometry fields a resize request would write, as their Scene paths. */
const resizeFieldPaths = (path: string) => ({
  x: `${path}.position.x`,
  y: `${path}.position.y`,
  width: `${path}.size.width`,
  height: `${path}.size.height`,
});

/**
 * One completed handle drag, candidate-first (#61). The drag displaces the
 * grabbed authored corner by (dx, dy) frame px while the opposite transformed
 * authored corner stays exactly fixed: the size delta is the drag mapped
 * through the measured full basis F (the Layer's own box axes — exact for any
 * rotation, mirror, and scale), the center moves by P⁻¹·d/2 through the
 * measured ancestor basis P, and position follows as Δposition = P⁻¹·d/2 −
 * Δsize/2. Only a singular basis or a non-finite/non-positive result is
 * rejected; a valid rotation — including ±45° — never is.
 */
async function applyResize(
  state: SessionState,
  req: ResizeRequest,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const found = findLayer(state.raw.layers, req.id);
  if (!found) return unknownLayerError(req.id);
  const { layer, path } = found;
  const geo = authoredGeometry(layer);
  const absent = [!geo.position && "position", !geo.size && "size"].filter(
    (v): v is string => Boolean(v),
  );
  if (absent.length > 0) return geometryReadonlyError(layer, path, absent);
  const rendered = state.layers.find((l) => l.id === req.id);
  if (!rendered || !rendered.visible) return paintsNothingError(req.id, path);
  const visible = rendered as VisibleRenderedLayer;
  const fullInverse = invertBasis(visible.fullBasis);
  if (!fullInverse) return degenerateError(req.id, path);
  const ancestorInverse = invertBasis(visible.basis);
  if (!ancestorInverse) return degenerateError(req.id, path);
  const [sx, sy] = HANDLE_SIGNS[req.handle];
  // The frame drag expressed in the Layer's own box axes — the signed size
  // delta, with the handle's corner choosing which axis grows.
  const drag = applyBasis(fullInverse, req.dx, req.dy);
  const dw = sx * drag.x;
  const dh = sy * drag.y;
  // The transformed box center moves by half the grabbed corner's frame
  // displacement (the opposite corner is fixed): back through the ancestors.
  const center = applyBasis(ancestorInverse, req.dx / 2, req.dy / 2);
  const candidate = structuredClone(state.raw);
  const targetGeo = authoredGeometry(findLayer(candidate.layers, req.id)!.layer);
  const pos = targetGeo.position!;
  const size = targetGeo.size!;
  const next = {
    x: pos.x + center.x - dw / 2,
    y: pos.y + center.y - dh / 2,
    width: size.width + dw,
    height: size.height + dh,
  };
  const fieldPaths = resizeFieldPaths(path);
  const finite = (v: number) => Number.isFinite(v);
  if (!finite(next.x) || !finite(next.y) || !finite(next.width) || !finite(next.height))
    return {
      status: 400,
      body: {
        errors: [
          {
            path: !finite(next.width)
              ? fieldPaths.width
              : !finite(next.height)
                ? fieldPaths.height
                : `${path}.position`,
            message: `resizing layer "${req.id}" from the "${req.handle}" handle by (${req.dx}, ${req.dy}) frame px would leave its geometry at position (${next.x}, ${next.y}) and size ${next.width}×${next.height} — outside the finite canvas coordinate space`,
          },
        ],
      },
    };
  if (next.width <= 0 || next.height <= 0)
    return {
      status: 400,
      body: {
        errors: [
          {
            path: next.width <= 0 ? fieldPaths.width : fieldPaths.height,
            message: `resizing layer "${req.id}" from the "${req.handle}" handle by (${req.dx}, ${req.dy}) frame px would leave its size at ${next.width}×${next.height} — width and height must stay positive`,
          },
        ],
      },
    };
  const target = findLayer(candidate.layers, req.id)!.layer as Extract<
    SceneLayer,
    { position: { x: number; y: number }; size: { width: number; height: number } }
  >;
  target.position = { x: n(next.x), y: n(next.y) };
  target.size = { width: n(next.width), height: n(next.height) };
  return commitCandidate(state, candidate);
}

/** One exact numeric geometry edit: the addressed Layer's stable id and the
 * authored fields to replace — at least one of x/y/width/height. */
interface GeometrySetRequest {
  id: string;
  set: { x?: number; y?: number; width?: number; height?: number };
}

const GEOMETRY_FIELDS = ["x", "y", "width", "height"] as const;

/**
 * Parse a numeric geometry body at the boundary: a JSON object carrying
 * exactly the stable Layer id and a "set" object with at least one of the
 * four authored fields, every value a finite number.
 */
function parseGeometry(text: string): GeometrySetRequest | SceneError[] {
  const b = parseJsonObject(text, ["id", "set"]);
  if (Array.isArray(b)) return b;
  if (typeof b.id !== "string" || b.id.length === 0)
    return [{ path: "id", message: "the geometry edit needs the Layer's stable id as a non-empty string" }];
  const rawSet = b.set;
  if (typeof rawSet !== "object" || rawSet === null || Array.isArray(rawSet))
    return [
      {
        path: "set",
        message: "the geometry edit needs a \"set\" object with at least one of x, y, width, height",
      },
    ];
  const s = rawSet as Record<string, unknown>;
  const unknown = Object.keys(s).filter(
    (k) => !(GEOMETRY_FIELDS as readonly string[]).includes(k),
  );
  if (unknown.length)
    return [
      {
        path: "set",
        message: `unexpected set field(s) ${unknown.map((k) => `"${k}"`).join(", ")} — set accepts only x, y, width, height`,
      },
    ];
  if (Object.keys(s).length === 0)
    return [{ path: "set", message: "the geometry edit needs at least one of x, y, width, height" }];
  const set: GeometrySetRequest["set"] = {};
  for (const k of GEOMETRY_FIELDS) {
    const v = s[k];
    if (v === undefined) continue;
    if (typeof v !== "number" || !Number.isFinite(v))
      return [{ path: `set.${k}`, message: `set.${k} must be a finite number` }];
    set[k] = v;
  }
  return { id: b.id, set };
}

/**
 * One exact numeric geometry edit, candidate-first (#61): the requested
 * authored fields are replaced exactly — in the coordinate space they live
 * in (canvas px top-level, the parent Group's local px nested). Per-field
 * capability: editing x/y needs an authored position, width/height an
 * authored size; a Layer missing either is read-only for exactly that field.
 * The size floor (positive, finite) and position finiteness are enforced at
 * this boundary before the one candidate-commit path runs.
 */
async function applyGeometrySet(
  state: SessionState,
  req: GeometrySetRequest,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const found = findLayer(state.raw.layers, req.id);
  if (!found) return unknownLayerError(req.id);
  const { layer, path } = found;
  const geo = authoredGeometry(layer);
  const wantsPosition = req.set.x !== undefined || req.set.y !== undefined;
  const wantsSize = req.set.width !== undefined || req.set.height !== undefined;
  const absent = [
    ...(!geo.position && wantsPosition ? ["position"] : []),
    ...(!geo.size && wantsSize ? ["size"] : []),
  ];
  if (absent.length > 0) return geometryReadonlyError(layer, path, absent);
  const rendered = state.layers.find((l) => l.id === req.id);
  if (!rendered || !rendered.visible) return paintsNothingError(req.id, path);
  const candidate = structuredClone(state.raw);
  const targetGeo = authoredGeometry(findLayer(candidate.layers, req.id)!.layer);
  // Numeric edits apply the submitted numbers exactly — no gesture rounding:
  // the panel is the exactness control (#61).
  if (req.set.x !== undefined) targetGeo.position!.x = req.set.x;
  if (req.set.y !== undefined) targetGeo.position!.y = req.set.y;
  if (req.set.width !== undefined) targetGeo.size!.width = req.set.width;
  if (req.set.height !== undefined) targetGeo.size!.height = req.set.height;
  const fieldPaths = resizeFieldPaths(path);
  // Boundary backstop: every authored value must land in its schema domain —
  // sizes positive and finite, positions finite (off-canvas is legitimate).
  const sizeChecks: [number, string, string][] = [
    [targetGeo.size!.width, fieldPaths.width, "width"],
    [targetGeo.size!.height, fieldPaths.height, "height"],
  ];
  for (const [value, fieldPath, name] of sizeChecks)
    if (!Number.isFinite(value) || value <= 0)
      return {
        status: 400,
        body: {
          errors: [
            {
              path: fieldPath,
              message: `layer "${req.id}" would have ${name} ${value} — width and height must be positive finite numbers`,
            },
          ],
        },
      };
  const positionChecks: [number, string][] = [
    [targetGeo.position!.x, fieldPaths.x],
    [targetGeo.position!.y, fieldPaths.y],
  ];
  for (const [value, fieldPath] of positionChecks)
    if (!Number.isFinite(value))
      return {
        status: 400,
        body: {
          errors: [
            {
              path: fieldPath,
              message: `layer "${req.id}" would have position ${value} — position must be a finite number`,
            },
          ],
        },
      };
  return commitCandidate(state, candidate);
}

// --- explicit save (#62) -----------------------------------------------------

/** The result of one save transaction: the written bytes on success — the
 * session's new expected source — or a structured, actionable refusal. */
export type SaveOutcome =
  | { ok: true; bytes: Buffer }
  | { ok: false; status: number; errors: SceneError[] };

export interface SaveInput {
  /** The Scene file path exactly as the session opened it. */
  sceneFile: string;
  /** The exact bytes the session believes are on disk — advanced by each save. */
  expectedSource: Buffer;
  /** The raw authored candidate to persist — never theme-resolved state. */
  candidate: Scene;
  /** Project root for the ordinary loadScene gate. */
  projectRoot: string;
  /** Library provider for the ordinary loadScene gate. */
  library: () => Promise<Library>;
  /**
   * Fault-injection seam for the atomic replace (the writeScene precedent):
   * production always publishes through the real atomicReplace. Injecting a
   * failing write is the honest way to prove the failure branch — the
   * previous Scene stays usable and success is never reported — without
   * racing a real filesystem fault, which cannot be safely induced.
   */
  writeScene?: (file: string, bytes: Buffer) => Promise<void>;
  /**
   * How long the save waits for a contended Scene lock before refusing. Same
   * bounded, no-stealing discipline as reference import. Default: 30s.
   */
  lockTimeoutMs?: number;
}

/**
 * One save transaction (#62), in order:
 *
 *   1. the complete raw authored candidate passes the ordinary loadScene
 *      gate (schema, semantics, theme, resolution — local asset/library
 *      rereads accepted) — a field-specific failure refuses before anything
 *      is touched,
 *   2. serialize ONLY that raw document — pretty JSON + a trailing newline;
 *      theme-resolved defaults, render measurements, handles/bases, and every
 *      other derived Render state are never present, because the candidate is
 *      the session's mutable raw home, not a resolved copy,
 *   3. acquire the per-Scene filesystem lock on the Scene's REAL path — every
 *      alias of one Scene file contends on one lock, and a symlink is
 *      replaced at its target rather than accidentally rewritten as a plain
 *      file — then re-read the target and refuse unless its exact bytes still
 *      equal the session's expected source bytes (the comparison is byte
 *      equality; hashes appear only as message diagnostics),
 *   4. publish through the existing atomicReplace helper — an interrupted
 *      write never leaves partial bytes at the target.
 *
 * Every refusal names the offending field, writes nothing, leaves the
 * previous Scene usable, and never reports success.
 */
export async function saveSessionScene(input: SaveInput): Promise<SaveOutcome> {
  const refuse = (status: number, path: string, message: string): SaveOutcome => ({
    ok: false,
    status,
    errors: [{ path, message }],
  });

  // 1 — the ordinary gate on the complete candidate. loadScene clones the
  // document before applying theme defaults, so the session's raw home is
  // validated at save time and never mutated. A failure refuses the save
  // with the gate's field-specific errors and changes nothing.
  const gate = await loadScene(input.projectRoot, input.library, input.candidate);
  if (!gate.ok) return { ok: false, status: 400, errors: gate.errors };

  // 2 — exactly the raw authored document, pretty-printed with a trailing
  // newline. Nothing derived ever enters the file.
  const bytes = Buffer.from(JSON.stringify(input.candidate, null, 2) + "\n", "utf8");

  // 3 — the lock and the replacement both target the Scene's REAL path.
  let real: string;
  try {
    real = await realpath(input.sceneFile);
  } catch (err) {
    return refuse(
      500,
      "scene",
      `cannot locate the Scene file "${input.sceneFile}": ${(err as Error).message} — ` +
        `the save wrote nothing and the session continues`,
    );
  }
  let releaseLock: () => Promise<void>;
  try {
    const lock = await acquireSceneLock(`${real}.lock`, { timeoutMs: input.lockTimeoutMs });
    releaseLock = lock.release;
  } catch (err) {
    return refuse(
      500,
      "scene",
      `the Scene could not be locked for this save: ${(err as Error).message} — ` +
        `the save wrote nothing and the session continues`,
    );
  }
  try {
    // Under the lock, the target must still be the exact bytes the session
    // opened with: an intervening edit fails closed instead of being
    // overwritten. Byte equality is the fact; hashes are diagnostics only.
    let current: Buffer;
    try {
      current = await readFile(real);
    } catch (err) {
      return refuse(
        500,
        "scene",
        `the Scene file could not be re-read before commit: ${(err as Error).message} — ` +
          `the save fails closed and wrote nothing`,
      );
    }
    if (!current.equals(input.expectedSource))
      return refuse(
        409,
        "scene",
        `the Scene file changed after this session opened (${contentHash(input.expectedSource).slice(0, 12)}… → ` +
          `${contentHash(current).slice(0, 12)}…) — the save refuses to overwrite an intervening edit. ` +
          `Nothing was written and the on-disk Scene is unchanged and usable. ` +
          `Close this session, review the current Scene, and open a new authoring session on it.`,
      );

    // 4 — publish atomically. A write failure is actionable: the previous
    // Scene is byte-identical and usable, and success is never reported.
    try {
      if (input.writeScene) await input.writeScene(real, bytes);
      else await atomicReplace(real, bytes);
    } catch (err) {
      return refuse(
        500,
        "scene",
        `the saved Scene could not be written: ${(err as Error).message}. ` +
          `The previous Scene is unchanged and usable — fix the problem and save again.`,
      );
    }
    return { ok: true, bytes };
  } finally {
    await releaseLock();
  }
}

/** A save body carries nothing: exactly an empty JSON object. */
function parseSave(text: string): Record<string, unknown> | SceneError[] {
  return parseJsonObject(text, []);
}

/**
 * One explicit save (#62), candidate-first: the prospective success state and
 * its full response are built and validated BEFORE any disk write —
 * persistedRaw becomes the saved document, so viewLayers proves the post-save
 * view (unsaved markers reset to zero) while nothing has been written. The
 * transaction then runs through the one save path. Any failure returns an
 * actionable error and changes nothing; only a successful replacement commits
 * the new baseline — expected source bytes, persistedRaw, revision, and the
 * saved fact — after which later edits are unsaved against it.
 */
async function applySave(state: SessionState): Promise<{ status: number; body: Record<string, unknown> }> {
  const next: SessionState = {
    ...state,
    persistedRaw: structuredClone(state.raw),
    rev: state.rev + 1,
  };
  let body: Record<string, unknown>;
  try {
    body = {
      rev: next.rev,
      png: next.png.toString("base64"),
      warnings: next.warnings,
      layers: viewLayers(next),
      saved: true,
    };
  } catch (err) {
    return {
      status: 500,
      body: { errors: [{ path: "save", message: (err as Error).message }] },
    };
  }
  let result: SaveOutcome;
  try {
    result = await saveSessionScene({
      sceneFile: state.sceneFile,
      expectedSource: state.expectedSource,
      candidate: state.raw,
      projectRoot: state.projectRoot,
      library: state.library,
    });
  } catch (err) {
    // The transaction internalizes its failures; an unexpected throw is a
    // safety net that still names the save, changes nothing, and never
    // reports success.
    return {
      status: 500,
      body: { errors: [{ path: "save", message: (err as Error).message }] },
    };
  }
  if (!result.ok) return { status: result.status, body: { errors: result.errors } };
  // Commit after successful publication only: four synchronous assignments,
  // nothing awaited or thrown after.
  state.persistedRaw = next.persistedRaw;
  state.rev = next.rev;
  state.expectedSource = result.bytes;
  state.hasSaved = true;
  return { status: 200, body };
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
    sceneFile: input.sceneFile,
    expectedSource: input.sourceBytes,
    hasSaved: false,
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

  /**
   * One POST pipeline shared by every mutating route (#61, #62): the exact
   * application/json media type, the streamed byte budget, strict boundary
   * parsing, and arrival-order serialization — then the route's own apply.
   * Arrival order is commit order: the pipeline enqueues at handler arrival —
   * before the first body read — so a slowly streamed earlier request can
   * never commit after a later complete one, and a save arriving after
   * earlier edits persists exactly those committed edits.
   */
  const jsonMutatePost = <P>(
    req: Request,
    parse: (text: string) => P | SceneError[],
    apply: (parsed: P) => Promise<{ status: number; body: Record<string, unknown> }>,
  ): Promise<Response> => {
    if (!isApplicationJson(req.headers.get("content-type")))
      return Promise.resolve(
        json(400, {
          errors: [{ path: "content-type", message: "POST requests must send application/json" }],
        }),
      );
    return serialize(async () => {
      const body = await readJsonBody(req);
      if (!body.ok)
        return json(body.status, { errors: [{ path: "body", message: body.message }] });
      const parsed = parse(body.text);
      if (Array.isArray(parsed)) return json(400, { errors: parsed });
      try {
        const result = await apply(parsed);
        return json(result.status, result.body);
      } catch (err) {
        // A render failure changes nothing — the raw state, revision, and
        // last valid preview stand — and the error is actionable.
        return json(500, { errors: [{ path: "render", message: (err as Error).message }] });
      }
    });
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
              renderAuthorView(input.scene, viewLayers(state), {
                rev: state.rev,
                warnings: state.warnings,
                saved: state.hasSaved,
              }),
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
          case "/move":
            if (req.method !== "POST") return empty(405);
            return jsonMutatePost(req, parseMovement, (parsed) => applyMovement(state, parsed));
          case "/resize":
            if (req.method !== "POST") return empty(405);
            return jsonMutatePost(req, parseResize, (parsed) => applyResize(state, parsed));
          case "/geometry":
            if (req.method !== "POST") return empty(405);
            return jsonMutatePost(req, parseGeometry, (parsed) => applyGeometrySet(state, parsed));
          case "/save":
            if (req.method !== "POST") return empty(405);
            return jsonMutatePost(req, parseSave, () => applySave(state));
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