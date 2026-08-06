/**
 * Shared demo session: daemon + vite + browser lifecycle.
 */
import { startDaemonHarness } from "./daemon.mjs";
import { startDashboardVite } from "./vite.mjs";
import { openBrowser } from "./browser.mjs";

/**
 * @param {() => Promise<void>} fn
 * @param {number} ms
 */
function withTimeout(fn, ms) {
  return Promise.race([
    fn(),
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    }),
  ]).catch(() => undefined);
}

/**
 * @param {object} [opts]
 * @param {Record<string, unknown>} [opts.config]
 */
export async function openVerifySession(opts = {}) {
  const daemon = await startDaemonHarness({ config: opts.config });
  /** @type {{ url: string, close: () => Promise<void> } | null} */
  let vite = null;
  /** @type {{ browser: import('playwright-core').Browser, page: import('playwright-core').Page, close: () => Promise<void> } | null} */
  let browser = null;
  try {
    vite = await startDashboardVite({ daemonUrl: daemon.baseUrl });
    browser = await openBrowser();
  } catch (err) {
    if (browser) await browser.close().catch(() => undefined);
    if (vite) await vite.close().catch(() => undefined);
    await daemon.close().catch(() => undefined);
    throw err;
  }

  const session = {
    daemon,
    get vite() {
      return vite;
    },
    set vite(next) {
      vite = next;
    },
    get page() {
      return browser.page;
    },
    get browser() {
      return browser.browser;
    },
    get url() {
      return vite.url;
    },
    /**
     * Point the Vite proxy at a new daemon URL (reconnect path).
     * Closes the previous Vite instance.
     * @param {string} daemonUrl
     */
    async rebindVite(daemonUrl) {
      const prev = vite;
      vite = await startDashboardVite({ daemonUrl });
      if (prev) await withTimeout(() => prev.close(), 5_000);
    },
    async close() {
      if (browser) await withTimeout(() => browser.close(), 5_000);
      browser = null;
      if (vite) await withTimeout(() => vite.close(), 5_000);
      vite = null;
      await withTimeout(() => daemon.close(), 10_000);
    },
  };
  return session;
}
