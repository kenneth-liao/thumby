import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

let shared: Browser | null = null;
let renderCtx: BrowserContext | null = null;
let renderPage: Page | null = null;
// One mutex for every browser-backed render on the shared page. Production
// callers render sequentially, but bun test interleaves async suites in one
// process — serialization is what keeps two in-flight renders from racing
// the same page (issue #27).
let renderTail: Promise<unknown> = Promise.resolve();

function enqueueRender<T>(op: () => Promise<T>): Promise<T> {
  const run = renderTail.then(op, op);
  renderTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// One lifecycle queue for shared browser launch, close, and recovery.
// Serializing launch and shutdown as one lifecycle state guarantees that
// concurrent getBrowser calls share one launch, racing close teardowns await
// pending launches, and a close failure while connected restores the handle
// without racing or overwriting a concurrent replacement (PROD-1 on #27).
let lifecycleTail: Promise<unknown> = Promise.resolve();

function enqueueLifecycle<T>(op: () => Promise<T>): Promise<T> {
  const run = lifecycleTail.then(op, op);
  lifecycleTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function dropShared(): void {
  shared = null;
  renderCtx = null;
  renderPage = null;
}

/** Tear the shared browser down: close it if it is still alive, drop the
 *  handles either way. Serialized through the lifecycle queue.
 *
 *  The `close` parameter is a fault-injection seam for tests: production
 *  always calls the real `browser.close()`; injecting a failing close is the
 *  only honest way to prove the close-failure branch without mocking
 *  Playwright (PROD-1 follow-up on #27).
 *
 *  On a close failure while the browser may still be alive, the handles are
 *  restored — never abandoned: the live Chromium stays reclaimable by a
 *  later closeBrowser() retry, and the failure surfaces to the caller. */
export async function shutdownShared(
  close: (browser: Browser) => Promise<void> = (b) => b.close(),
): Promise<void> {
  return enqueueLifecycle(async () => {
    const browser = shared;
    const ctx = renderCtx;
    const page = renderPage;
    dropShared();
    try {
      if (browser) await close(browser);
    } catch (err) {
      // Suppress only the already-dead case — a browser that died cannot be
      // closed again, and that is the goal state. A close failure while the
      // browser may still be alive must surface: cleanup cannot silently
      // report success with a live Chromium left behind.
      if (browser?.isConnected()) {
        shared = browser;
        renderCtx = ctx;
        renderPage = page;
        throw err;
      }
    }
  });
}

/**
 * One shared headless Chromium for all local rendering (compose + scenes).
 * Launching is lazy and serialized through the lifecycle state queue; a
 * browser that died underneath us is relaunched, never handed out stale.
 * closeBrowser tears it down between CLI invocations.
 */
export async function getBrowser(): Promise<Browser> {
  return enqueueLifecycle(async () => {
    if (shared && !shared.isConnected()) dropShared();
    if (!shared) {
      shared = await chromium.launch();
    }
    return shared;
  });
}

/**
 * The one shared render page: a fresh context + page created lazily on the
 * shared browser and reused by every render, so a render costs a viewport
 * resize instead of a context create/close cycle. The churn of per-render
 * contexts is what deadlocked the suite (issue #27).
 *
 * Pages are stateless between renders — setContent replaces the document and
 * @font-face registrations are document-scoped, so nothing carries over.
 * A page or context lost mid-session (crash, close) is recreated on the next
 * call; callers never see a stale handle.
 */
async function acquireRenderPage(): Promise<Page> {
  const browser = await getBrowser(); // relaunches if the browser itself died
  if (!renderCtx || renderCtx.isClosed()) {
    renderCtx = await browser.newContext({ deviceScaleFactor: 1 });
    renderPage = await renderCtx.newPage();
  }
  // A lost page never costs the (healthy) browser or context: only the page
  // is recreated. Dropping a live browser here would leak it.
  if (!renderPage || renderPage.isClosed()) {
    renderPage = await renderCtx.newPage();
  }
  return renderPage;
}

/**
 * Run `fn` on the shared render page, serialized against every other
 * browser-backed render in the process. On a closed/crashed browser surface
 * the shared lifecycle is reclaimed so the next call relaunches cleanly; a
 * close failure while the browser may still be alive surfaces (both errors
 * preserved), never silently succeeding over a live Chromium.
 */
export async function withRenderPage<T>(fn: (page: Page) => Promise<T>): Promise<T> {
  return enqueueRender(async () => {
    const page = await acquireRenderPage();
    try {
      return await fn(page);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/closed|crashed/i.test(msg) || page.isClosed() || renderCtx?.isClosed() || !shared?.isConnected()) {
        // A browser that is merely wedged (its page died but the process is
        // alive) must be closed, not abandoned — an abandoned live browser
        // leaks a Chromium process (issue #27 cleanup contract).
        try {
          await shutdownShared();
        } catch (closeErr) {
          const cmsg = closeErr instanceof Error ? closeErr.message : String(closeErr);
          throw new Error(
            `shared browser teardown failed while reclaiming a wedged render surface: ${cmsg} — original render error: ${msg}`,
          );
        }
      }
      throw err;
    }
  });
}

export async function closeBrowser(): Promise<void> {
  await enqueueRender(async () => {
    await shutdownShared();
  });
}
