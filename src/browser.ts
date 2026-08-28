import { chromium, type Browser } from "playwright";

let shared: Browser | null = null;

/**
 * One shared headless Chromium for all local rendering (compose + scenes).
 * Launching is lazy; closeBrowser tears it down between CLI invocations.
 */
export async function getBrowser(): Promise<Browser> {
  if (!shared) shared = await chromium.launch();
  return shared;
}

export async function closeBrowser(): Promise<void> {
  await shared?.close();
  shared = null;
}
