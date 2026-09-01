import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

let shared: Browser | null = null;
let renderCtx: BrowserContext | null = null;
let renderPage: Page | null = null;

// One mutex for every browser-backed render on the shared page. Production
// callers render sequentially, but bun test interleaves async suites in one
// process — serialization is what keeps two in-flight renders from racing
// the same page (issue #27).
let tail: Promise<unknown> = Promise.resolve();

function enqueue<T>(op: () => Promise<T>): Promise<T> {
  const run = tail.then(op);
  tail = run.then(
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
 *  handles either way. Serialized callers only — never enqueue this. */
async function shutdownShared(): Promise<void> {
  const browser = shared;
  dropShared();
  try {
    await browser?.close();
  } catch {
    // A browser that already died cannot be closed again — that is the
    // goal state, not a failure.
  }
}

/**
 * One shared headless Chromium for all local rendering (compose + scenes).
 * Launching is lazy; a browser that died underneath us is relaunched, never
 * handed out stale. closeBrowser tears it down between CLI invocations.
 */
export async function getBrowser(): Promise<Browser> {
  if (shared && !shared.isConnected()) dropShared();
  if (!shared) shared = await chromium.launch();
  return shared;
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
  await getBrowser(); // relaunches if the browser itself died
  if (!renderCtx || renderCtx.isClosed()) {
    renderCtx = await shared!.newContext({ deviceScaleFactor: 1 });
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
 * the shared handles are dropped so the next call relaunches cleanly.
 */
export async function withRenderPage<T>(fn: (page: Page) => Promise<T>): Promise<T> {
  return enqueue(async () => {
    const page = await acquireRenderPage();
    try {
      return await fn(page);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/closed|crashed/i.test(msg) || page.isClosed() || renderCtx?.isClosed() || !shared?.isConnected()) {
        // A browser that is merely wedged (its page died but the process is
        // alive) must be closed, not abandoned — an abandoned live browser
        // leaks a Chromium process (issue #27 cleanup contract).
        await shutdownShared();
      }
      throw err;
    }
  });
}

export async function closeBrowser(): Promise<void> {
  await enqueue(shutdownShared);
}
