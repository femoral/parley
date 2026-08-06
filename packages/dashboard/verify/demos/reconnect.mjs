/**
 * Demo 3 — real offline → stale → reconnect against the placeholder shell.
 *
 * Actually stops and restarts the daemon (no UI state pin). Measures what
 * the shell shows today at each phase; richer connection honesty lands later.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ledgerDirs, writeDemoProof, printRectSummary } from "../lib/ledger.mjs";
import { measureSelectors, VIEWPORTS } from "../lib/measure.mjs";
import { openVerifySession } from "../lib/session.mjs";

const TICKET = "issue-353";
const DEMO = "reconnect";

/**
 * @param {import('playwright-core').Page} page
 * @param {string} url
 * @param {string} shotDir
 * @param {string} phase
 */
async function measurePhase(page, url, shotDir, phase) {
  /** @type {Array<object>} */
  const viewports = [];
  for (const vp of VIEWPORTS) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    // Prefer reload so an open document re-requests; goto covers first paint.
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 10_000 });
    } catch {
      // Offline: navigation may still load the static Vite app; API fails later.
      await page.goto(url, { waitUntil: "commit", timeout: 10_000 }).catch(() => undefined);
    }
    await page.waitForSelector('[data-testid="shell"]', { timeout: 15_000 }).catch(() => undefined);
    await page.evaluate(() => document.fonts?.ready).catch(() => undefined);

    // Probe daemon reachability from the page (proxied /health).
    // Short abort — when the daemon is dead Vite's proxy can stall.
    const health = await page.evaluate(async () => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 800);
      try {
        const r = await fetch("/health", { signal: ctrl.signal });
        return { ok: r.ok, status: r.status };
      } catch (err) {
        return { ok: false, status: 0, error: String(err?.name || err) };
      } finally {
        clearTimeout(timer);
      }
    });

    const elements = await measureSelectors(page);
    const file = `${DEMO}-${phase}-${vp.name}.png`;
    const abs = path.join(shotDir, file);
    await page.screenshot({ path: abs, fullPage: false }).catch(() => undefined);
    viewports.push({
      name: vp.name,
      width: vp.width,
      height: vp.height,
      screenshot: path.join("shots", file).split(path.sep).join("/"),
      health,
      elements,
    });
  }
  return viewports;
}

export async function runReconnectDemo() {
  const session = await openVerifySession();
  try {
    // Seed a completed task so "recovered" has something on the wire.
    const { taskId } = await session.daemon.stageScript("report-success");
    await session.daemon.waitTask(taskId);

    const { shotsDir } = ledgerDirs(TICKET);
    fs.mkdirSync(shotsDir, { recursive: true });

    // Phase: online (baseline before kill)
    const online = await measurePhase(session.page, session.url, shotsDir, "online");

    // Phase: offline — actually stop the daemon.
    await session.daemon.kill();
    // Vite proxy target is dead; /health should fail from the browser.
    const offline = await measurePhase(session.page, session.url, shotsDir, "offline");

    // Brief pause so "stale" is a distinct sample window (shell has no
    // stale band yet — we still record the phase for the ledger contract).
    await new Promise((r) => setTimeout(r, 300));
    const stale = await measurePhase(session.page, session.url, shotsDir, "stale");

    // Phase: reconnect — restart real daemon (new ephemeral port), then
    // rebind Vite so the proxy targets the live hub again.
    await session.daemon.restart();
    await session.rebindVite(session.daemon.baseUrl);
    const recovered = await measurePhase(
      session.page,
      session.url,
      shotsDir,
      "recovered",
    );

    // Wire check post-reconnect.
    const healthRes = await fetch(`${session.daemon.baseUrl}/health`);
    const healthOk = healthRes.ok;

    const proof = {
      kind: "reconnect",
      description:
        "Real daemon kill → offline/stale browser samples → daemon restart + vite rebind → recovered. " +
        "Shell is still scaffold (status shows '— scaffold'); measurements are honest.",
      phases: {
        online: { viewports: online },
        offline: { viewports: offline },
        stale: { viewports: stale },
        recovered: { viewports: recovered },
      },
      daemon: {
        taskId,
        healthOkAfterRecover: healthOk,
      },
      // Flat viewports for the final recovered phase (primary board proof)
      // plus offline mid-width for comparison in the report.
      viewports: recovered,
      offlineSample: offline.find((v) => v.name === "1460") ?? offline[0],
      onlineSample: online.find((v) => v.name === "1460") ?? online[0],
    };

    const entryPath = writeDemoProof(TICKET, DEMO, proof);
    printRectSummary(`${DEMO}/recovered`, recovered);
    printRectSummary(`${DEMO}/offline`, offline);
    console.log(`ledger entry: ${entryPath}`);
    return proof;
  } finally {
    await session.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runReconnectDemo().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
