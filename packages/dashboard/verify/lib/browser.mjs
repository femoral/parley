/**
 * Headless browser session (playwright-core).
 */
import { chromium } from "playwright-core";
import { resolveChromium } from "./chromium.mjs";

/**
 * Launch Chromium and open a page.
 * Uses `browser.newContext()` (required by @axe-core/playwright).
 * @returns {Promise<{ browser: import('playwright-core').Browser, context: import('playwright-core').BrowserContext, page: import('playwright-core').Page, close: () => Promise<void> }>}
 */
export async function openBrowser() {
  const executablePath = resolveChromium();
  const browser = await chromium.launch({
    executablePath,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  // axe-core/playwright requires a real BrowserContext, not browser.newPage().
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    colorScheme: "dark",
  });
  const page = await context.newPage();
  return {
    browser,
    context,
    page,
    async close() {
      await context.close().catch(() => undefined);
      await browser.close();
    },
  };
}
