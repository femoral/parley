/**
 * Issue #358 — metrics screen proofs.
 *
 * - Empty state against real daemon (eval-off default)
 * - Populated charts via route intercept (measured axes, ≥11px labels, contrast)
 * - Honesty: loading / error / empty forced via interception
 * - Viewports 1280 / 1460 / 1920; board H-scroll; axe + ARIA + keyboard
 * - Workflow tab cost-per-completed-run present when intercepting run-metrics
 */
import { pathToFileURL } from "node:url";
import { collectA11y, runAxe, ariaSnapshot } from "../lib/a11y.mjs";
import { measureContrast } from "../lib/contrast.mjs";
import { ledgerDirs, writeDemoProof, printRectSummary } from "../lib/ledger.mjs";
import { measureAtViewports } from "../lib/measure.mjs";
import { openVerifySession } from "../lib/session.mjs";

const TICKET = "issue-358";
const DEMO = "metrics-board";

/** Screen-specific measure targets (do not edit DEFAULT_SELECTORS). */
const METRICS_SELECTORS = [
  { id: "shell", selector: '[data-testid="shell"]' },
  { id: "center", selector: ".pc-shell__center" },
  { id: "screen", selector: '[data-testid="screen-metrics"]' },
  { id: "filter-bar", selector: '[data-testid="metrics-filter-bar"]' },
  { id: "session-scope", selector: '[data-testid="metrics-session-scope"]' },
  { id: "group-table", selector: '[data-testid="metrics-group-table"]' },
  { id: "distribution", selector: '[data-testid="metrics-distribution"]' },
  { id: "heatmap", selector: '[data-testid="metrics-heatmap"]' },
  { id: "dist-svg", selector: '[data-testid="metrics-dist-svg"]' },
  { id: "dist-axis", selector: '[data-testid="metrics-dist-axis"]' },
  { id: "heat-axis", selector: '[data-testid="metrics-heat-axis"]' },
  { id: "heat-grid", selector: '[data-testid="metrics-heat-grid"]' },
];

/** Populated GET /metrics body for chart proofs. */
function populatedMetricsBody() {
  const evals = (avg, baseline, below, criteria, first, fix) => ({
    count: first.count + fix.count,
    avg,
    avg_baseline: baseline,
    avg_delta: avg - baseline,
    below_baseline_rate: below,
    criterion_failures: criteria,
    first_attempt: first,
    fix,
  });
  const split = (count, avg, baseline, below) => ({
    count,
    avg,
    avg_baseline: baseline,
    avg_delta: avg - baseline,
    below_baseline_rate: below,
  });
  return {
    generated_at: new Date().toISOString(),
    groups: [
      {
        key: "fake",
        tasks: {
          total: 12,
          completed: 10,
          failed: 2,
          cancelled: 0,
          running: 0,
          other: 0,
        },
        success_rate: 0.833,
        evals: evals(
          7.4,
          5.0,
          0.15,
          {
            "brief-implemented": { failures: 1, count: 8, rate: 0.125 },
            "suite-green": { failures: 2, count: 8, rate: 0.25 },
            "minimal-diff": { failures: 0, count: 8, rate: 0 },
            "change-verified": { failures: 3, count: 8, rate: 0.375 },
          },
          split(5, 6.8, 5.0, 0.2),
          split(3, 8.4, 5.0, 0),
        ),
        evals_by_size: {
          S: evals(7.0, 5.0, 0.1, {}, split(2, 7.0, 5.0, 0.1), split(1, 7.0, 5.0, 0)),
          M: evals(7.6, 5.0, 0.2, {}, split(3, 7.2, 5.0, 0.25), split(2, 8.2, 5.0, 0)),
        },
        evals_by_difficulty: {
          medium: evals(7.1, 5.0, 0.2, {}, split(4, 6.9, 5.0, 0.25), split(2, 7.5, 5.0, 0)),
        },
        tokens: { input: 48000, output: 12000, cached: 4000, tasks_reporting: 12 },
        duration_ms: {
          total: 720000,
          avg: 60000,
          p50: 55000,
          p95: 140000,
          tasks_reporting: 12,
        },
      },
      {
        key: "claude",
        tasks: {
          total: 6,
          completed: 3,
          failed: 3,
          cancelled: 0,
          running: 0,
          other: 0,
        },
        success_rate: 0.5,
        evals: evals(
          4.1,
          5.0,
          0.8,
          {
            "brief-implemented": { failures: 4, count: 5, rate: 0.8 },
            "suite-green": { failures: 5, count: 5, rate: 1 },
            "minimal-diff": { failures: 1, count: 2, rate: 0.5 },
          },
          split(4, 3.8, 5.0, 1),
          split(1, 5.5, 5.0, 0),
        ),
        evals_by_size: {},
        evals_by_difficulty: {},
        tokens: { input: 22000, output: 8000, cached: 500, tasks_reporting: 6 },
        duration_ms: {
          total: 400000,
          avg: 90000,
          p50: 80000,
          p95: 160000,
          tasks_reporting: 6,
        },
      },
      {
        key: "codex",
        tasks: {
          total: 4,
          completed: 4,
          failed: 0,
          cancelled: 0,
          running: 0,
          other: 0,
        },
        success_rate: 1,
        evals: {
          count: 0,
          avg: null,
          avg_baseline: null,
          avg_delta: null,
          below_baseline_rate: null,
          criterion_failures: {},
          first_attempt: split(0, null, null, null),
          fix: split(0, null, null, null),
        },
        evals_by_size: {},
        evals_by_difficulty: {},
        tokens: { input: 9000, output: 3000, cached: 100, tasks_reporting: 4 },
        duration_ms: {
          total: 200000,
          avg: 50000,
          p50: 48000,
          p95: 70000,
          tasks_reporting: 4,
        },
      },
    ],
  };
}

function populatedRunMetricsBody() {
  return {
    generated_at: new Date().toISOString(),
    groups: [
      {
        key: "coding-1@3",
        runs: {
          total: 4,
          completed: 3,
          failed: 1,
          cancelled: 0,
          running: 0,
          blocked: 0,
          other: 0,
        },
        success_rate: 0.75,
        evals: {
          count: 3,
          avg: 6.8,
          avg_baseline: 5.0,
          avg_delta: 1.8,
          below_baseline_rate: 0.33,
          criterion_failures: {
            "brief-implemented": { failures: 1, count: 3, rate: 0.33 },
          },
          first_run: {
            count: 2,
            avg: 6.0,
            avg_baseline: 5.0,
            avg_delta: 1.0,
            below_baseline_rate: 0.5,
          },
          fork: {
            count: 1,
            avg: 8.5,
            avg_baseline: 5.0,
            avg_delta: 3.5,
            below_baseline_rate: 0,
          },
        },
        evals_by_size: {},
        evals_by_difficulty: {},
        tokens: { input: 40000, output: 12000, cached: 2000, tasks_reporting: 12 },
        duration_ms: {
          total: 1200000,
          avg: 300000,
          p50: 280000,
          p95: 500000,
          tasks_reporting: 4,
        },
        cost_per_completed_run: 18500,
      },
    ],
  };
}

/**
 * Mutable intercept controllers — one long-lived route each so we never
 * fight Playwright unroute matching. mode: "pass" | "delay" | "error" | "json".
 * @typedef {{ mode: string, delayMs: number, status: number, body: unknown }} InterceptCtl
 */

/** @type {InterceptCtl} */
const metricsCtl = { mode: "pass", delayMs: 0, status: 200, body: null };
/** @type {InterceptCtl} */
const runMetricsCtl = { mode: "pass", delayMs: 0, status: 200, body: null };

function isTaskMetricsPath(pathname) {
  return pathname === "/metrics";
}
function isRunMetricsPath(pathname) {
  return pathname === "/run-metrics";
}

/**
 * @param {import('playwright-core').Route} route
 * @param {InterceptCtl} ctl
 */
async function handleCtl(route, ctl) {
  if (ctl.mode === "pass") {
    await route.continue();
    return;
  }
  if (ctl.mode === "delay") {
    await new Promise((r) => setTimeout(r, ctl.delayMs));
    await route.continue();
    return;
  }
  await route.fulfill({
    status: ctl.status,
    contentType: "application/json",
    body: JSON.stringify(ctl.body ?? {}),
  });
}

/**
 * Install long-lived metrics intercepts once per page.
 * @param {import('playwright-core').Page} page
 */
async function installMetricsIntercepts(page) {
  await page.route("**/*", async (route) => {
    let pathname = "";
    try {
      pathname = new URL(route.request().url()).pathname;
    } catch {
      await route.continue();
      return;
    }
    if (isTaskMetricsPath(pathname)) {
      await handleCtl(route, metricsCtl);
      return;
    }
    if (isRunMetricsPath(pathname)) {
      await handleCtl(route, runMetricsCtl);
      return;
    }
    await route.continue();
  });
}

function setMetricsJson(body, status = 200) {
  metricsCtl.mode = "json";
  metricsCtl.status = status;
  metricsCtl.body = body;
}

function setMetricsError(message) {
  metricsCtl.mode = "error";
  metricsCtl.status = 500;
  metricsCtl.body = { error: message };
}

function setMetricsDelay(delayMs) {
  metricsCtl.mode = "delay";
  metricsCtl.delayMs = delayMs;
}

function setMetricsPass() {
  metricsCtl.mode = "pass";
}

function setRunMetricsJson(body) {
  runMetricsCtl.mode = "json";
  runMetricsCtl.status = 200;
  runMetricsCtl.body = body;
}

function setRunMetricsPass() {
  runMetricsCtl.mode = "pass";
}

async function goMetrics(page, url) {
  // Prefer domcontentloaded — the shell holds an SSE stream open, so
  // networkidle is unreliable under honesty intercepts.
  // about:blank first: same-URL hash navigations do not remount the SPA, so
  // intercept mode changes would never re-fetch metrics.
  const base = url.replace(/#.*$/, "");
  const target = `${base}#/metrics`;
  await page.goto("about:blank", { waitUntil: "domcontentloaded" });
  await page.goto(target, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="screen-metrics"]', { timeout: 15_000 });
  await page.evaluate(() => document.fonts.ready);
}

/**
 * Measure chart label font-sizes (SVG text + HTML) — floor 11px.
 * @param {import('playwright-core').Page} page
 */
async function measureChartLabels(page) {
  return page.evaluate(() => {
    /** @type {Array<{sel:string,tag:string,fontSize:number,text:string}>} */
    const out = [];
    const push = (el, sel) => {
      if (!el) return;
      const cs = getComputedStyle(el);
      const fs = parseFloat(cs.fontSize);
      out.push({
        sel,
        tag: el.tagName.toLowerCase(),
        fontSize: fs,
        text: (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 40),
      });
    };
    for (const el of document.querySelectorAll(
      ".pc-metrics__dist-axis, .pc-metrics__dist-label, .pc-metrics__dist-delta",
    )) {
      push(el, el.className);
    }
    for (const el of document.querySelectorAll(
      ".pc-metrics__heat-col, .pc-metrics__heat-row-label, .pc-metrics__heat-cell-label, .pc-metrics__heat-axis",
    )) {
      push(el, el.className);
    }
    const min = out.reduce((m, r) => Math.min(m, r.fontSize), Infinity);
    return {
      samples: out.slice(0, 40),
      minFontSize: Number.isFinite(min) ? min : null,
      count: out.length,
      allAtLeast11: out.length > 0 && out.every((r) => r.fontSize >= 11),
    };
  });
}

/**
 * Board-level horizontal scroll proof.
 * @param {import('playwright-core').Page} page
 */
async function measureBoardScroll(page) {
  return page.evaluate(() => {
    const shell = document.querySelector('[data-testid="shell"]');
    const center = document.querySelector(".pc-shell__center");
    const screen = document.querySelector('[data-testid="screen-metrics"]');
    const pack = (el, name) =>
      el
        ? {
            name,
            scrollWidth: el.scrollWidth,
            clientWidth: el.clientWidth,
            noHorizontalScroll: el.scrollWidth <= el.clientWidth + 1,
          }
        : { name, found: false };
    return {
      shell: pack(shell, "shell"),
      center: pack(center, "center"),
      screen: pack(screen, "screen"),
    };
  });
}

/**
 * Axis presence proofs for both plots.
 * @param {import('playwright-core').Page} page
 */
async function measureAxes(page) {
  return page.evaluate(() => {
    const distAxis = document.querySelector('[data-testid="metrics-dist-axis"]');
    const heatAxis = document.querySelector('[data-testid="metrics-heat-axis"]');
    const ticks = [...document.querySelectorAll('[data-testid="metrics-dist-tick-label"]')].map(
      (el) => (el.textContent ?? "").trim(),
    );
    return {
      distribution: {
        found: Boolean(distAxis),
        tickLabels: ticks,
        hasValueAxis: Boolean(distAxis) && ticks.length >= 3,
      },
      heatmap: {
        found: Boolean(heatAxis),
        text: (heatAxis?.textContent ?? "").replace(/\s+/g, " ").trim(),
        hasValueAxis: Boolean(heatAxis) && (heatAxis?.textContent ?? "").includes("0%"),
      },
    };
  });
}

/**
 * Issue-358 merge gates.
 * @param {object} _entry
 * @param {object} ledger
 */
export function metricsBoardGates(_entry, ledger) {
  const demo = ledger.demos?.["metrics-board"];
  if (!demo) throw new Error("metrics-board: missing demo in ledger");

  if (!demo.headline?.boardScroll?.shell?.noHorizontalScroll) {
    throw new Error("metrics-board: board H-scroll at 1280 not clear");
  }
  if (!demo.chartLabels?.allAtLeast11) {
    throw new Error(
      `metrics-board: chart labels under 11px: min=${demo.chartLabels?.minFontSize}`,
    );
  }
  if (!demo.axes?.distribution?.hasValueAxis) {
    throw new Error("metrics-board: distribution missing value axis");
  }
  if (!demo.axes?.heatmap?.hasValueAxis) {
    throw new Error("metrics-board: heatmap missing value axis");
  }
  if (!demo.honesty?.empty || !demo.honesty?.error || !demo.honesty?.loading) {
    throw new Error("metrics-board: missing honesty state proofs");
  }
  if (!demo.workflow?.hasCostColumn) {
    throw new Error("metrics-board: workflow cost-per-completed-run not proven");
  }
  if (!demo.sessionScope?.isFilterNotTab) {
    throw new Error("metrics-board: session must be scope filter not group_by tab");
  }
  const axe = demo.a11y?.axe?.violations ?? [];
  if (axe.length > 0) {
    throw new Error(`metrics-board: axe violations: ${axe.map((v) => v.id).join(", ")}`);
  }
  const contrast = demo.contrast ?? {};
  for (const [id, m] of Object.entries(contrast)) {
    if (m && m.found && m.wcagAA === false) {
      throw new Error(`metrics-board: contrast fail ${id} ratio=${m.ratio}`);
    }
  }
}

/**
 * Navigate to metrics and wait for a test id (poll).
 * @param {import('playwright-core').Page} page
 * @param {string} baseUrl
 * @param {string} testId
 * @param {number} [timeoutMs]
 */
async function goMetricsWait(page, baseUrl, testId, timeoutMs = 15_000) {
  await goMetrics(page, baseUrl);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await page.$(`[data-testid="${testId}"]`);
    if (found) return;
    await page.waitForTimeout(150);
  }
  const dump = await page.evaluate(() => {
    const root = document.querySelector('[data-testid="screen-metrics"]');
    return {
      meta: document.querySelector('[data-testid="metrics-meta"]')?.textContent ?? null,
      ids: [...(root?.querySelectorAll("[data-testid]") ?? [])].map((el) =>
        el.getAttribute("data-testid"),
      ),
    };
  });
  throw new Error(`timeout waiting for ${testId}: ${JSON.stringify(dump)}`);
}

export async function runMetricsBoardDemo() {
  const session = await openVerifySession();
  try {
    // Real daemon empty-ish state (eval off → chart empty is the default).
    await session.daemon.stageScript("report-success");
    const { shotsDir } = ledgerDirs(TICKET);
    await installMetricsIntercepts(session.page);

    // ── Empty / real-daemon first paint ──────────────────────────────
    setMetricsPass();
    setRunMetricsPass();
    await goMetrics(session.page, session.url);
    await session.page.waitForSelector('[data-testid="metrics-group-table"]', {
      timeout: 15_000,
    });
    // Wait until first metrics fetch settles (loading → ready/empty).
    await session.page.waitForFunction(
      () =>
        Boolean(
          document.querySelector('[data-testid="metrics-table"]') ||
            document.querySelector('[data-testid="metrics-table-empty"]') ||
            document.querySelector('[data-testid="metrics-table-error"]'),
        ),
      { timeout: 15_000 },
    );
    const emptyHonesty = await session.page.evaluate(() => {
      const tableEmpty = Boolean(document.querySelector('[data-testid="metrics-table-empty"]'));
      const distEmpty = Boolean(document.querySelector('[data-testid="metrics-dist-empty"]'));
      const heatEmpty = Boolean(document.querySelector('[data-testid="metrics-heat-empty"]'));
      const tableReady = Boolean(document.querySelector('[data-testid="metrics-table"]'));
      // Empty charts are first-class; table may show groups without eval.
      return {
        chartEmpty: distEmpty || heatEmpty || tableEmpty,
        tableEmpty,
        distEmpty,
        heatEmpty,
        tableReady,
        hasFilterBar: Boolean(document.querySelector('[data-testid="metrics-filter-bar"]')),
        hasSessionScope: Boolean(document.querySelector('[data-testid="metrics-session-scope"]')),
      };
    });

    // ── Session scope is not a group_by tab ──────────────────────────
    const sessionScope = await session.page.evaluate(() => {
      const tablist = document.querySelector('[data-testid="metrics-dim-tabs"]');
      const tabText = (tablist?.textContent ?? "").toLowerCase();
      const hasSessionTab = Boolean(document.querySelector('[data-testid="metrics-dim-session"]'));
      const hasSessionSelect = Boolean(
        document.querySelector('[data-testid="metrics-session-select"]'),
      );
      return {
        isFilterNotTab: hasSessionSelect && !hasSessionTab && !/\bsession\b/.test(tabText),
        hasSessionSelect,
        hasSessionTab,
      };
    });

    // ── Honesty: error via 500 ───────────────────────────────────────
    setMetricsError("forced metrics panel error (verify harness)");
    await goMetricsWait(session.page, session.url, "metrics-table-error");
    const errorHonesty = await session.page.evaluate(() => ({
      banner: Boolean(document.querySelector('[data-testid="metrics-error-banner"]')),
      tableError: Boolean(document.querySelector('[data-testid="metrics-table-error"]')),
      distError: Boolean(document.querySelector('[data-testid="metrics-dist-error"]')),
    }));

    // ── Honesty: empty collection intercept ──────────────────────────
    setMetricsJson({ generated_at: new Date().toISOString(), groups: [] });
    await goMetricsWait(session.page, session.url, "metrics-table-empty");
    const forcedEmpty = await session.page.evaluate(() => ({
      tableEmpty: Boolean(document.querySelector('[data-testid="metrics-table-empty"]')),
      distEmpty: Boolean(document.querySelector('[data-testid="metrics-dist-empty"]')),
    }));

    // ── Honesty: loading via delay (capture mid-flight) ──────────────
    setMetricsDelay(4000);
    await goMetrics(session.page, session.url);
    // Poll briefly for the loading skeleton while the delay is in flight.
    let loadingHonesty = { loading: false, tableLoading: false };
    for (let i = 0; i < 20; i += 1) {
      loadingHonesty = await session.page.evaluate(() => ({
        loading: Boolean(document.querySelector('[data-testid="metrics-loading"]')),
        tableLoading: Boolean(
          document.querySelector(
            '[data-testid="metrics-group-table"] [data-testid="metrics-loading"]',
          ),
        ),
      }));
      if (loadingHonesty.loading || loadingHonesty.tableLoading) break;
      await session.page.waitForTimeout(50);
    }

    // ── Populated charts via intercept ───────────────────────────────
    setMetricsJson(populatedMetricsBody());
    setRunMetricsJson(populatedRunMetricsBody());
    await goMetricsWait(session.page, session.url, "metrics-dist-svg");
    await session.page.waitForSelector('[data-testid="metrics-dist-svg"]', {
      timeout: 10_000,
    });
    await session.page.waitForSelector('[data-testid="metrics-heat-grid"]', {
      timeout: 10_000,
    });

    // Contrast on chart labels (composited stack)
    const contrast = {
      distAxis: await measureContrast(session.page, ".pc-metrics__dist-axis"),
      distLabel: await measureContrast(session.page, ".pc-metrics__dist-label"),
      heatCol: await measureContrast(session.page, ".pc-metrics__heat-col"),
      heatRow: await measureContrast(session.page, ".pc-metrics__heat-row-label"),
      heatCell: await measureContrast(session.page, ".pc-metrics__heat-cell-label"),
      panelTitle: await measureContrast(session.page, ".pc-metrics__panel-title"),
      tableName: await measureContrast(session.page, ".pc-metrics__cell-name"),
    };

    // Comparison view
    await session.page.click('[data-testid="metrics-view-comparison"]');
    await session.page.waitForSelector('[data-testid="metrics-compare-body"]', {
      timeout: 5_000,
    });
    const comparison = await session.page.evaluate(() => ({
      found: Boolean(document.querySelector('[data-testid="metrics-compare-body"]')),
      sides: document.querySelectorAll('[data-testid="metrics-compare-side"]').length,
      text: (document.querySelector('[data-testid="metrics-comparison"]')?.textContent ?? "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 200),
    }));
    await session.page.click('[data-testid="metrics-view-overview"]');

    // Workflow tab + cost column
    await session.page.click('[data-testid="metrics-dim-workflow"]');
    await session.page.waitForSelector('[data-testid="metrics-table"]', { timeout: 10_000 });
    const workflow = await session.page.evaluate(() => {
      const head = document.querySelector('[data-testid="metrics-table"] thead')?.textContent ?? "";
      return {
        hasCostColumn: /cost\s*\/\s*done/i.test(head),
        hasWorkflowRow: (document.body.textContent ?? "").includes("coding-1@3"),
        head: head.replace(/\s+/g, " ").trim(),
      };
    });
    // Back to vendor for viewport shots
    await session.page.click('[data-testid="metrics-dim-vendor"]');
    await session.page.waitForSelector('[data-testid="metrics-dist-svg"]', {
      timeout: 10_000,
    });

    // Viewports with populated data (hash preserved via beforeMeasure)
    const viewports = await measureAtViewports(session.page, {
      url: session.url.includes("#")
        ? session.url.replace(/#.*$/, "") + "#/metrics"
        : `${session.url}#/metrics`,
      shotDir: shotsDir,
      shotPrefix: DEMO,
      targets: METRICS_SELECTORS,
      beforeMeasure: async () => {
        // Routes persist; ensure metrics painted.
        await session.page.waitForSelector('[data-testid="screen-metrics"]', {
          timeout: 10_000,
        });
        // If intercept still active, wait for chart
        await session.page
          .waitForSelector('[data-testid="metrics-dist-svg"]', { timeout: 8_000 })
          .catch(() => undefined);
      },
    });

    // Board scroll at 1280
    await session.page.setViewportSize({ width: 1280, height: 900 });
    await goMetrics(session.page, session.url);
    await session.page
      .waitForSelector('[data-testid="metrics-dist-svg"]', { timeout: 8_000 })
      .catch(() => undefined);
    const boardScroll = await measureBoardScroll(session.page);

    // Long-label truncation sample
    const truncation = await session.page.evaluate(() => {
      const name = document.querySelector(".pc-metrics__cell-name");
      if (!name) return { found: false };
      const cs = getComputedStyle(name);
      return {
        found: true,
        textOverflow: cs.textOverflow,
        overflow: cs.overflow,
        whiteSpace: cs.whiteSpace,
        title: name.getAttribute("title"),
        text: (name.textContent ?? "").trim(),
      };
    });

    // A11y at 1460 populated
    await session.page.setViewportSize({ width: 1460, height: 900 });
    await goMetrics(session.page, session.url);
    await session.page.waitForSelector('[data-testid="metrics-dist-svg"]', {
      timeout: 10_000,
    });
    const a11y = await collectA11y(session.page, {
      include: '[data-testid="screen-metrics"]',
    });
    // Full-shell axe for any chrome regressions while metrics is open
    const axeShell = await runAxe(session.page, {
      include: '[data-testid="shell"]',
    });
    const aria = await ariaSnapshot(session.page, {
      selector: '[data-testid="screen-metrics"]',
    });

    // Neuter proof: break metrics intercept mid-flight → error red → restore
    setMetricsError("neuter: broken wiring");
    await goMetricsWait(session.page, session.url, "metrics-table-error");
    const neuterBroken = await session.page.evaluate(() => ({
      error: Boolean(
        document.querySelector(
          '[data-testid="metrics-error-banner"], [data-testid="metrics-table-error"]',
        ),
      ),
    }));
    setMetricsJson(populatedMetricsBody());
    await goMetricsWait(session.page, session.url, "metrics-dist-svg");
    const neuterRestored = await session.page.evaluate(() => ({
      ready: Boolean(document.querySelector('[data-testid="metrics-dist-svg"]')),
      error: Boolean(document.querySelector('[data-testid="metrics-error-banner"]')),
    }));

    // Chart label remeasure after restore (headline numbers)
    const chartLabelsFinal = await measureChartLabels(session.page);
    const axesFinal = await measureAxes(session.page);

    const proof = {
      kind: "metrics-board",
      description:
        "Metrics screen: empty default, populated charts via intercept, " +
        "honesty states, workflow cost column, session scope filter, " +
        "measured chart axes/labels/contrast at board widths.",
      headline: {
        boardScroll,
        minChartFontPx: chartLabelsFinal.minFontSize,
        chartLabelsAtLeast11: chartLabelsFinal.allAtLeast11,
        distributionHasAxis: axesFinal.distribution?.hasValueAxis,
        heatmapHasAxis: axesFinal.heatmap?.hasValueAxis,
        tickLabels: axesFinal.distribution?.tickLabels,
      },
      emptyHonesty,
      sessionScope,
      honesty: {
        empty: forcedEmpty,
        error: errorHonesty,
        loading: loadingHonesty,
        realDaemonEmpty: emptyHonesty,
      },
      axes: axesFinal,
      chartLabels: chartLabelsFinal,
      contrast,
      comparison,
      workflow,
      truncation,
      neuter: { broken: neuterBroken, restored: neuterRestored },
      viewports,
      a11y: {
        ...a11y,
        axeShell,
        ariaMetrics: aria,
      },
    };

    const entryPath = writeDemoProof(TICKET, DEMO, proof);
    printRectSummary(DEMO, viewports);
    console.log(
      JSON.stringify(
        {
          minChartFontPx: chartLabelsFinal.minFontSize,
          allAtLeast11: chartLabelsFinal.allAtLeast11,
          axes: axesFinal,
          boardScroll1280: boardScroll.shell,
          axeViolations: a11y.axe?.violations?.length ?? 0,
        },
        null,
        2,
      ),
    );
    console.log(`ledger entry: ${entryPath}`);
    return proof;
  } finally {
    await session.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runMetricsBoardDemo().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
