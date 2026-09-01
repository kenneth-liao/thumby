# ADR-0010: One shared render page per process, serialized and self-healing

- Status: Accepted (from ticket #27)
- Context: every browser-backed render (`compose`, `renderScene`,
  `renderGuidelines`, `renderContactSheet`) used to create and close a fresh
  `BrowserContext` + page per call on the shared Chromium. In one Bun process
  that churn deadlocked or lost the browser after enough cycles — test suites
  hung intermittently, tracking cumulative browser work rather than any
  specific test. Root causes measured in #27: Bun 1.3.14's CDP-pipe defect
  (oven-sh/bun #15679 — a `net.Socket` stuck in `connecting` stalls
  parent→child writes on `--remote-debugging-pipe`; on macOS a drain callback
  usually flushes it, which is why the failure is intermittent, not a hard
  hang; fixed in Bun 1.4.0) interacting with per-render context lifecycle
  churn, which also made borderline tests (a ~4.8 s garbage-font fetch,
  4–8 s CLI renders against a 5 s default timeout) flake.

## Decision

All render paths run on **one shared context + one shared page per process**
(`withRenderPage` in `src/browser.ts`), created lazily on the shared browser:

- **A render costs a viewport resize, not a context cycle.** `setContent`
  replaces the document and `@font-face` registrations are document-scoped, so
  the page carries no state between renders.
- **Renders are serialized process-wide** through one promise-chain mutex.
  Production callers render sequentially; the mutex makes that invariant
  load-bearing (bun test interleaves async suites in one process, so two
  in-flight renders must never race the same page).
- **The lifecycle self-heals.** A browser that died underneath us is
  relaunched by `getBrowser()`; a lost page or context is recreated without
  discarding a healthy browser; a wedged browser surface detected mid-render
  (closed/crashed error, dead page/context) is shut down, never abandoned
  while its process still runs, which would leak Chromium. If the close
  itself fails while the process is still alive, the handles are restored so
  a later `closeBrowser()` retry reclaims the live Chromium, and the failure
  surfaces — cleanup never silently succeeds over a live child.
- **Injected pages are caller-owned.** `renderScene(resolved, { page })` uses
  the caller's page as-is — never closed, replaced, or serialized — so route-
  blocked offline proofs and custom contexts remain possible.
- **`closeBrowser()` stays the one teardown path**: queue-safe, closes page →
  context → browser, leaves no Chromium process behind.
- **Toolchain requirement: Bun ≥ 1.4.0** for the single-process topology.
  On Bun 1.3.14 the bare `bun test` hang (upstream #15679) persists; the
  supported `bun run test` per-file isolate loop is green on both.

Rejected alternative: per-render contexts with retry-on-loss. It keeps the
churn that exposes the upstream pipe bug and its own fd-handling fragility
(oven-sh/bun #34785 family), and does not meet the 10/10 single-process
criterion. Rendering itself is unchanged: text stays local CSS (ADR-0001),
pixels and layout are bit-identical (the full pixel-test suite passes).
