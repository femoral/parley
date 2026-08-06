/**
 * Issue #354 — find combobox honesty states via route interception.
 * Forces loading / error / no-match on GET /sessions?q= and captures proofs.
 *
 * Uses a single route handler with a mutable mode flag so we never call
 * route.continue() after unroute (Playwright "Route is already handled").
 */
import { pathToFileURL } from "node:url";
import path from "node:path";
import { ledgerDirs, writeDemoProof } from "../lib/ledger.mjs";
import { measureElement } from "../lib/measure.mjs";
import { openVerifySession } from "../lib/session.mjs";

const TICKET = "issue-354";
const DEMO = "find-honesty";

/**
 * @param {import('playwright-core').Page} page
 * @param {string} query
 */
async function typeFind(page, query) {
  const input = page.locator('[data-testid="find-input"]');
  await input.click();
  await input.fill("");
  await input.type(query, { delay: 15 });
}

/**
 * @param {import('playwright-core').Page} page
 * @param {string} shotDir
 * @param {string} name
 */
async function captureState(page, shotDir, name) {
  const file = `find-${name}.png`;
  await page.screenshot({
    path: path.join(shotDir, file),
    fullPage: false,
  });
  const combobox = await measureElement(page, '[data-testid="find-combobox"]');
  const popup = await measureElement(page, '[data-testid="find-popup"]');
  const status = await page.locator('[data-testid="find-combobox"]').getAttribute("data-status");
  const aria = await page.evaluate(() => {
    const input = document.querySelector('[data-testid="find-input"]');
    if (!input) return null;
    return {
      role: input.getAttribute("role"),
      ariaExpanded: input.getAttribute("aria-expanded"),
      ariaActivedescendant: input.getAttribute("aria-activedescendant"),
    };
  });
  return {
    name,
    status,
    screenshot: `shots/${file}`,
    combobox,
    popup,
    aria,
  };
}

export async function runFindHonestyDemo() {
  const session = await openVerifySession();
  try {
    const { taskId } = await session.daemon.stageScript("report-success");
    await session.daemon.waitTask(taskId);

    const { shotsDir } = ledgerDirs(TICKET);
    await session.page.setViewportSize({ width: 1460, height: 900 });
    await session.page.goto(session.url, { waitUntil: "networkidle" });
    await session.page.waitForSelector('[data-testid="find-input"]');

    /** @type {"pass" | "delay" | "error" | "empty"} */
    let mode = "pass";

    await session.page.route("**/sessions**", async (route) => {
      try {
        if (mode === "delay") {
          await new Promise((r) => setTimeout(r, 3_000));
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ sessions: [] }),
          });
          return;
        }
        if (mode === "error") {
          await route.fulfill({
            status: 500,
            contentType: "application/json",
            body: JSON.stringify({ error: "forced sessions error (verify harness)" }),
          });
          return;
        }
        if (mode === "empty") {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ sessions: [] }),
          });
          return;
        }
        await route.continue();
      } catch {
        /* route may be disposed if page navigates */
      }
    });

    /** @type {Record<string, object>} */
    const states = {};

    // ── loading: hang /sessions long enough to paint loading ──────────
    mode = "delay";
    await typeFind(session.page, "loadtest");
    // Debounce 200ms + render; capture before the 3s fulfill.
    await session.page.waitForSelector('[data-testid="find-loading"]', { timeout: 1500 });
    states.loading = await captureState(session.page, shotsDir, "loading");
    // Let the delayed fulfill settle so the next mode switch is clean.
    await session.page.waitForTimeout(3200);

    // ── error: 500 on /sessions ───────────────────────────────────────
    mode = "error";
    await typeFind(session.page, "errtest-zzzz");
    await session.page.waitForSelector('[data-testid="find-error"]', { timeout: 3000 });
    await session.page.waitForTimeout(100);
    states.error = await captureState(session.page, shotsDir, "error");

    // ── no-match: empty sessions + no local task hit ──────────────────
    mode = "empty";
    await typeFind(session.page, "zzz-no-match-xyz-999");
    await session.page.waitForSelector('[data-testid="find-empty"]', { timeout: 3000 });
    await session.page.waitForTimeout(100);
    states.noMatch = await captureState(session.page, shotsDir, "no-match");

    // ── results path (happy) — local task id prefix ───────────────────
    mode = "empty"; // sessions empty; task hits still local
    await typeFind(session.page, taskId.slice(0, Math.min(4, taskId.length)));
    await session.page.waitForTimeout(400);
    await session.page.locator('[data-testid="find-input"]').press("ArrowDown");
    await session.page.waitForTimeout(100);
    states.results = await captureState(session.page, shotsDir, "results");

    const proof = {
      kind: "find-honesty",
      description:
        "Find combobox honesty: loading (delay), error (500), no-match (empty sessions), " +
        "results — forced via route interception on /sessions.",
      daemon: { taskId, port: session.daemon.port },
      states,
    };
    const entryPath = writeDemoProof(TICKET, DEMO, proof);
    console.log(`ledger entry: ${entryPath}`);
    console.log(
      "find states:",
      Object.fromEntries(
        Object.entries(states).map(([k, v]) => [k, /** @type {{status?:string}} */ (v).status]),
      ),
    );
    return proof;
  } finally {
    await session.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runFindHonestyDemo().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
