/**
 * Honesty-state forcing — no test hooks in shipped code.
 *
 * Per-panel error / delay / empty: Playwright route interception on daemon
 * API paths the console will consume (proxied same-origin in dev).
 * Offline → stale → reconnect: actually stop/restart the daemon (see demos).
 */

/**
 * Intercept a daemon HTTP route and force a failure response.
 * @param {import('playwright-core').Page} page
 * @param {object} opts
 * @param {string | RegExp} [opts.url] default matches /tasks list
 * @param {number} [opts.status]
 * @param {unknown} [opts.body]
 * @param {number} [opts.delayMs] artificial latency before the error body
 */
export async function interceptError(page, opts = {}) {
  const {
    url = "**/tasks",
    status = 500,
    body = { error: "forced panel error (verify harness)" },
    delayMs = 0,
  } = opts;

  await page.route(url, async (route) => {
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    await route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
}

/**
 * Intercept and fulfill with an empty collection (empty-state path).
 * @param {import('playwright-core').Page} page
 * @param {string | RegExp} [url]
 */
export async function interceptEmpty(page, url = "**/tasks") {
  await page.route(url, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ tasks: [] }),
    });
  });
}

/**
 * Delay a route without changing the upstream response (loading-state path).
 * @param {import('playwright-core').Page} page
 * @param {object} opts
 * @param {string | RegExp} [opts.url]
 * @param {number} [opts.delayMs]
 */
export async function interceptDelay(page, opts = {}) {
  const { url = "**/tasks", delayMs = 2_000 } = opts;
  await page.route(url, async (route) => {
    await new Promise((r) => setTimeout(r, delayMs));
    await route.continue();
  });
}

/**
 * Drop all matching routes so subsequent navigations hit the real daemon again.
 * @param {import('playwright-core').Page} page
 * @param {string | RegExp} [url]
 */
export async function clearIntercepts(page, url = "**/tasks") {
  await page.unroute(url);
}
