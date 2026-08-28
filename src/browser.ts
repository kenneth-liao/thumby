import { chromium, type Browser } from "playwright";

/**
 * One shared headless Chromium for all local rendering (compose + scenes).
 * Launching is lazy; closeBrowser tears it down between CLI invocations.
 *
 * The browser memoizes on globalThis rather than the module scope: bun test's
 * --isolate gives every test file its own module registry, and a module-level
 * singleton would launch one Chromium per file. One process, one browser.
 */
const shared = () => globalThis as typeof globalThis & { __thumbyBrowser?: Browser | null };

export async function getBrowser(): Promise<Browser> {
  const g = shared();
  if (!g.__thumbyBrowser) g.__thumbyBrowser = await chromium.launch();
  return g.__thumbyBrowser;
}

export async function closeBrowser(): Promise<void> {
  const g = shared();
  await g.__thumbyBrowser?.close();
  g.__thumbyBrowser = null;
}
