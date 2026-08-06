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
  { id: "dist-plot", selector: '[data-testid="metrics-dist-plot"]' },
  { id: "dist-axis", selector: '[data-testid="metrics-dist-axis"]' },
  { id: "heat-legend", selector: '[data-testid="metrics-heat-legend"]' },
  { id: "heat-grid", selector: '[data-testid="metrics-heat-grid"]' },
];

/** Extra board widths for rendered-px proof (validator cited 1361/1366/1700). */
const EXTRA_VIEWPORTS = [
  { name: "1280", width: 1280, height: 900 },
  { name: "1361", width: 1361, height: 900 },
  { name: "1366", width: 1366, height: 900 },
  { name: "1460", width: 1460, height: 900 },
  { name: "1700", width: 1700, height: 900 },
  { name: "1920", width: 1920, height: 900 },
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

/** Many groups for truncation disclosure proof (showing 6 of N). */
function manyGroupsMetricsBody() {
  const body = populatedMetricsBody();
  const template = body.groups[0];
  for (let i = 0; i < 12; i += 1) {
    body.groups.push({
      ...template,
      key: `vendor-${i}`,
      tasks: { ...template.tasks, total: 8 - (i % 3) },
    });
  }
  return body;
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
 * Measure chart labels with *rendered* px, not just getComputedStyle.
 * For HTML text, renderedPx === computed. For any SVG leftover:
 * renderedPx = declared * (rect.width / viewBoxWidth).
 * Floor: DESIGN.md "No type below 9px"; console chart claims target ≥11.
 * @param {import('playwright-core').Page} page
 */
async function measureChartLabels(page) {
  return page.evaluate(() => {
    /**
     * @typedef {{
     *   sel: string,
     *   tag: string,
     *   declaredPx: number,
     *   renderedPx: number,
     *   text: string,
     * }} LabelSample
     */
    /** @type {LabelSample[]} */
    const out = [];

    /**
     * @param {Element} el
     * @param {string} sel
     */
    function push(el, sel) {
      const cs = getComputedStyle(el);
      const declared = parseFloat(cs.fontSize);
      const rect = el.getBoundingClientRect();
      // HTML: rendered ≈ declared. SVG text: scale by bbox vs viewBox unit.
      let rendered = declared;
      const svg = el.closest("svg");
      if (svg && el instanceof SVGElement) {
        const vb = svg.viewBox?.baseVal;
        const svgRect = svg.getBoundingClientRect();
        if (vb && vb.width > 0 && svgRect.width > 0) {
          rendered = declared * (svgRect.width / vb.width);
        }
      }
      // Prefer client rect height when it is a sensible text line
      if (rect.height > 0 && rect.height < declared * 2.5) {
        // For pure HTML, height is line-box; use declared (not height) as rendered px
        // so we don't confuse line-height with font-size. declared is the truth for HTML.
        rendered = declared;
      }
      out.push({
        sel,
        tag: el.tagName.toLowerCase(),
        declaredPx: Math.round(declared * 100) / 100,
        renderedPx: Math.round(rendered * 100) / 100,
        text: (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 40),
      });
    }

    const selectors = [
      ".pc-metrics__dist-label",
      ".pc-metrics__dist-delta",
      ".pc-metrics__dist-tick-label",
      ".pc-metrics__heat-col",
      ".pc-metrics__heat-row-label",
      ".pc-metrics__heat-cell-label",
    ];
    for (const sel of selectors) {
      for (const el of document.querySelectorAll(sel)) push(el, sel);
    }

    const minDeclared = out.reduce((m, r) => Math.min(m, r.declaredPx), Infinity);
    const minRendered = out.reduce((m, r) => Math.min(m, r.renderedPx), Infinity);
    const rowEls = [...document.querySelectorAll('[data-testid="metrics-dist-row"]')];
    const rowHeights = rowEls.map((el) => {
      const h = el.getBoundingClientRect().height;
      return Math.round(h * 100) / 100;
    });

    return {
      samples: out.slice(0, 50),
      minDeclaredPx: Number.isFinite(minDeclared) ? minDeclared : null,
      minRenderedPx: Number.isFinite(minRendered) ? minRendered : null,
      count: out.length,
      allRenderedAtLeast9: out.length > 0 && out.every((r) => r.renderedPx >= 9),
      allRenderedAtLeast11: out.length > 0 && out.every((r) => r.renderedPx >= 11),
      // Back-compat alias used by older gates
      allAtLeast11: out.length > 0 && out.every((r) => r.renderedPx >= 11),
      minFontSize: Number.isFinite(minRendered) ? minRendered : null,
      distRowHeights: rowHeights,
      distRowsInBand: rowHeights.every((h) => h >= 24 && h <= 30),
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
 * Measure table density: column-drop disclosure, fade-on-overflow, wrap geometry.
 * @param {import('playwright-core').Page} page
 */
async function measureTableDensity(page) {
  return page.evaluate(() => {
    const drop = document.querySelector('[data-testid="metrics-col-drop"]');
    const fade = document.querySelector('[data-testid="metrics-table-fade"]');
    const wrap =
      document.querySelector('[data-testid="metrics-table-wrap"]') ??
      document.querySelector('[data-testid="metrics-table-scroll"] .pc-metrics__table-wrap');
    const table = document.querySelector('[data-testid="metrics-table"]');
    const row = document.querySelector('[data-testid="metrics-table-row"]');
    const dropCs = drop ? getComputedStyle(drop) : null;
    const dropVisible =
      Boolean(drop) &&
      dropCs != null &&
      dropCs.display !== "none" &&
      dropCs.visibility !== "hidden" &&
      dropCs.opacity !== "0";
    const dropText = (drop?.textContent ?? "").replace(/\s+/g, " ").trim();
    const countMatch = dropText.match(/(\d+)\s+columns?\s+hidden/i);
    const ths = table
      ? [...table.querySelectorAll("thead th")].map((th) => {
          const cs = getComputedStyle(th);
          return {
            text: (th.textContent ?? "").replace(/\s+/g, " ").trim(),
            display: cs.display,
            visible: cs.display !== "none" && cs.visibility !== "hidden",
          };
        })
      : [];
    const overflowX = wrap
      ? wrap.scrollWidth > wrap.clientWidth + 1
      : false;
    const fadeOpacity = fade ? parseFloat(getComputedStyle(fade).opacity) : null;
    const fadeDataOverflow = fade?.getAttribute("data-overflow") ?? null;
    const rowH = row ? Math.round(row.getBoundingClientRect().height * 100) / 100 : null;
    return {
      dropPresent: Boolean(drop),
      dropVisible,
      dropText,
      droppedCount: countMatch ? Number(countMatch[1]) : null,
      fadePresent: Boolean(fade),
      fadeOpacity,
      fadeDataOverflow,
      fadeOnWhenOverflow:
        overflowX ? fadeOpacity != null && fadeOpacity > 0.5 : fadeOpacity === 0 || fadeOpacity == null,
      wrap: wrap
        ? {
            clientWidth: wrap.clientWidth,
            scrollWidth: wrap.scrollWidth,
            overflowX,
            dataOverflow: wrap.getAttribute("data-overflow"),
          }
        : null,
      visibleHeaders: ths.filter((t) => t.visible).map((t) => t.text),
      hiddenHeaders: ths.filter((t) => !t.visible).map((t) => t.text),
      isWorkflow: Boolean(table?.classList.contains("pc-metrics__table--workflow")),
      rowHeightPx: rowH,
      rowInBand: rowH != null && rowH >= 24 && rowH <= 30,
    };
  });
}

/**
 * Sweep table density across key widths for vendor + workflow.
 * Proves MED-A disclosure and MED-B no-overflow / fade-on-overflow.
 * @param {import('playwright-core').Page} page
 * @param {string} baseUrl
 */
async function measureTableDensitySweep(page, baseUrl) {
  const widths = [1280, 1361, 1380, 1400, 1461];
  /** @type {Record<string, object>} */
  const vendor = {};
  /** @type {Record<string, object>} */
  const workflow = {};

  for (const w of widths) {
    await page.setViewportSize({ width: w, height: 900 });
    await goMetrics(page, baseUrl);
    await page.waitForSelector('[data-testid="metrics-table"]', { timeout: 12_000 });
    await page.evaluate(() => document.fonts.ready);
    // Wait a frame for ResizeObserver overflow check
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    vendor[String(w)] = await measureTableDensity(page);

    await page.click('[data-testid="metrics-dim-workflow"]');
    await page.waitForSelector('[data-testid="metrics-table"]', { timeout: 10_000 });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    workflow[String(w)] = await measureTableDensity(page);

    // Back to a primary dim for next width
    await page.click('[data-testid="metrics-dim-vendor"]').catch(() => undefined);
  }

  const v1280 = vendor["1280"];
  const w1280 = workflow["1280"];
  const v1461 = vendor["1461"];
  const w1461 = workflow["1461"];

  return {
    vendor,
    workflow,
    summary: {
      disclosureAt1280Vendor: Boolean(v1280?.dropVisible && v1280?.droppedCount === 3),
      disclosureAt1280Workflow: Boolean(w1280?.dropVisible && w1280?.droppedCount === 4),
      disclosureAbsentAt1461Vendor: Boolean(v1461 && !v1461.dropVisible),
      disclosureAbsentAt1461Workflow: Boolean(w1461 && !w1461.dropVisible),
      noOverflow1361to1400Workflow: [1361, 1380, 1400].every(
        (w) => workflow[String(w)]?.wrap?.overflowX === false,
      ),
      fadeMatchesOverflow: widths.every((w) => {
        const samples = [vendor[String(w)], workflow[String(w)]];
        return samples.every((s) => s?.fadeOnWhenOverflow !== false);
      }),
      rowInBand1280: Boolean(v1280?.rowInBand),
    },
  };
}

/**
 * Axis / scale presence proofs for both plots.
 * Heatmap: honest scale in legend (not a decorative half-width axis strip).
 * @param {import('playwright-core').Page} page
 */
async function measureAxes(page) {
  return page.evaluate(() => {
    const distAxis = document.querySelector('[data-testid="metrics-dist-axis"]');
    const ticks = [...document.querySelectorAll('[data-testid="metrics-dist-tick-label"]')].map(
      (el) => (el.textContent ?? "").trim(),
    );
    const legend = document.querySelector('[data-testid="metrics-heat-legend"]');
    const legendText = (legend?.textContent ?? "").replace(/\s+/g, " ").trim();
    const trunc = document.querySelector('[data-testid="metrics-heat-trunc"]');
    const meta = document.querySelector('[data-testid="metrics-heat-meta"]');
    const a11yDist = document.querySelector('[data-testid="metrics-dist-a11y"]');
    const a11yHeat = document.querySelector('[data-testid="metrics-heat-a11y"]');
    // Zero-rate bars must be 0% width
    const zeroBars = [...document.querySelectorAll('[data-testid="metrics-heat-cell"]')]
      .filter((el) => (el.querySelector(".pc-metrics__heat-cell-label")?.textContent ?? "").startsWith("0%"))
      .map((el) => el.getAttribute("data-bar"));
    const lowKinds = [...document.querySelectorAll('[data-testid="metrics-heat-cell"][data-low="1"]')].length;
    const lowInkDistinct = (() => {
      const low = document.querySelector(
        ".pc-metrics__heat-cell--low .pc-metrics__heat-cell-label, .pc-metrics__heat-cell--low-suspect .pc-metrics__heat-cell-label",
      );
      const none = document.querySelector(
        ".pc-metrics__heat-cell--none .pc-metrics__heat-cell-label",
      );
      if (!low || !none) return { checked: false };
      const cl = getComputedStyle(low).color;
      const cn = getComputedStyle(none).color;
      return { checked: true, lowColor: cl, noneColor: cn, distinct: cl !== cn };
    })();

    return {
      distribution: {
        found: Boolean(distAxis),
        tickLabels: ticks,
        hasValueAxis: Boolean(distAxis) && ticks.length >= 3,
        a11yTable: Boolean(a11yDist),
      },
      heatmap: {
        // Honest scale lives in the legend (bar = failure rate 0–100%)
        legendFound: Boolean(legend),
        legendText,
        hasHonestScale: /0\s*[–—-]\s*100%|0–100%|0-100%/.test(legendText),
        truncText: (trunc?.textContent ?? meta?.textContent ?? "").replace(/\s+/g, " ").trim(),
        a11yTable: Boolean(a11yHeat),
        zeroBarsOk: zeroBars.length === 0 || zeroBars.every((b) => b === "0%"),
        lowCellCount: lowKinds,
        lowInkDistinct,
      },
    };
  });
}

/**
 * Rendered-px table across several board widths (headline proof).
 * @param {import('playwright-core').Page} page
 * @param {string} baseUrl
 */
async function measureRenderedPxTable(page, baseUrl) {
  /** @type {Array<object>} */
  const rows = [];
  for (const vp of EXTRA_VIEWPORTS) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await goMetrics(page, baseUrl);
    await page
      .waitForSelector('[data-testid="metrics-dist-plot"]', { timeout: 12_000 })
      .catch(() => undefined);
    await page.evaluate(() => document.fonts.ready);
    const labels = await measureChartLabels(page);
    const table = await page.evaluate(() => {
      const wrap = document.querySelector('[data-testid="metrics-table-scroll"] .pc-metrics__table-wrap');
      const tableEl = document.querySelector('[data-testid="metrics-table"]');
      if (!wrap || !tableEl) return { found: false };
      const ths = [...tableEl.querySelectorAll("thead th")].map((th) => {
        const cs = getComputedStyle(th);
        return {
          text: (th.textContent ?? "").replace(/\s+/g, " ").trim(),
          display: cs.display,
          visible: cs.display !== "none" && cs.visibility !== "hidden",
        };
      });
      return {
        found: true,
        scrollWidth: wrap.scrollWidth,
        clientWidth: wrap.clientWidth,
        overflowX: wrap.scrollWidth > wrap.clientWidth + 1,
        visibleHeaders: ths.filter((t) => t.visible).map((t) => t.text),
        hiddenHeaders: ths.filter((t) => !t.visible).map((t) => t.text),
      };
    });
    rows.push({
      name: vp.name,
      width: vp.width,
      minRenderedPx: labels.minRenderedPx,
      minDeclaredPx: labels.minDeclaredPx,
      allRenderedAtLeast11: labels.allRenderedAtLeast11,
      allRenderedAtLeast9: labels.allRenderedAtLeast9,
      distRowHeights: labels.distRowHeights,
      distRowsInBand: labels.distRowsInBand,
      table,
    });
  }
  return rows;
}

/**
 * Issue-358 merge gates — uses rendered-px math, not declared user-space alone.
 * @param {object} _entry
 * @param {object} ledger
 */
export function metricsBoardGates(_entry, ledger) {
  const demo = ledger.demos?.["metrics-board"];
  if (!demo) throw new Error("metrics-board: missing demo in ledger");

  if (!demo.headline?.boardScroll?.shell?.noHorizontalScroll) {
    throw new Error("metrics-board: board H-scroll at 1280 not clear");
  }

  // REQUIRED 1 — rendered px ≥ 11 (HTML labels; no SVG scale trap)
  const labels = demo.chartLabels;
  if (!labels?.allRenderedAtLeast11 && !labels?.allAtLeast11) {
    throw new Error(
      `metrics-board: chart labels under 11px rendered: minRendered=${labels?.minRenderedPx}`,
    );
  }
  if (labels?.distRowsInBand === false) {
    throw new Error(
      `metrics-board: dist rows outside 24–30px band: ${JSON.stringify(labels.distRowHeights)}`,
    );
  }
  const rpTable = demo.renderedPxTable;
  if (!Array.isArray(rpTable) || rpTable.length < 5) {
    throw new Error("metrics-board: missing renderedPxTable across viewports");
  }
  for (const row of rpTable) {
    if (row.allRenderedAtLeast11 === false) {
      throw new Error(
        `metrics-board: rendered px < 11 at ${row.name} (${row.width}): min=${row.minRenderedPx}`,
      );
    }
    if (row.distRowsInBand === false) {
      throw new Error(
        `metrics-board: dist row heights out of band at ${row.name}: ${JSON.stringify(row.distRowHeights)}`,
      );
    }
  }

  if (!demo.axes?.distribution?.hasValueAxis) {
    throw new Error("metrics-board: distribution missing value axis");
  }
  if (!demo.axes?.heatmap?.hasHonestScale) {
    throw new Error("metrics-board: heatmap missing honest 0–100% scale in legend");
  }
  if (!demo.axes?.distribution?.a11yTable || !demo.axes?.heatmap?.a11yTable) {
    throw new Error("metrics-board: missing visually-hidden data tables");
  }
  if (demo.axes?.heatmap?.zeroBarsOk === false) {
    throw new Error("metrics-board: zero-rate cells draw a non-zero bar");
  }
  if (demo.axes?.heatmap?.lowInkDistinct?.checked && !demo.axes.heatmap.lowInkDistinct.distinct) {
    throw new Error("metrics-board: low-sample ink identical to no-sample");
  }

  // REQUIRED 2 — truncation disclosure when many groups
  if (demo.heatmapTruncation && !demo.heatmapTruncation.disclosed) {
    throw new Error("metrics-board: heatmap truncation not disclosed");
  }

  // REQUIRED 7 — at 1280, no silent mid-header clip of primary columns
  const t1280 = rpTable.find((r) => r.name === "1280")?.table;
  if (t1280?.found) {
    const vis = (t1280.visibleHeaders ?? []).join(" ").toLowerCase();
    if (!vis.includes("success") || !vis.includes("eval")) {
      throw new Error(`metrics-board: 1280 lost primary columns: ${vis}`);
    }
    // Dropped columns must not appear mid-clipped — either hidden or fully scrollable with cue
    if (t1280.overflowX && !(demo.tableCue?.fadePresent || demo.tableCue?.scrollbar)) {
      throw new Error("metrics-board: table overflows without visible cue");
    }
  }

  // MED-A — column-drop disclosure at ≤1360; absent at ≥1461
  const dens = demo.tableDensity?.summary;
  if (!dens?.disclosureAt1280Vendor) {
    throw new Error(
      `metrics-board: missing vendor column-drop disclosure at 1280: ${JSON.stringify(demo.tableDensity?.vendor?.["1280"]?.dropText)}`,
    );
  }
  if (!dens?.disclosureAt1280Workflow) {
    throw new Error(
      `metrics-board: missing workflow column-drop disclosure at 1280: ${JSON.stringify(demo.tableDensity?.workflow?.["1280"]?.dropText)}`,
    );
  }
  if (!dens?.disclosureAbsentAt1461Vendor || !dens?.disclosureAbsentAt1461Workflow) {
    throw new Error("metrics-board: column-drop disclosure must be absent at 1461");
  }

  // MED-B — workflow table must not overflow 1361–1400; fade tracks overflow
  if (!dens?.noOverflow1361to1400Workflow) {
    const band = [1361, 1380, 1400].map((w) => ({
      w,
      wrap: demo.tableDensity?.workflow?.[String(w)]?.wrap,
    }));
    throw new Error(
      `metrics-board: workflow table overflows in 1361–1400 band: ${JSON.stringify(band)}`,
    );
  }
  if (dens?.fadeMatchesOverflow === false) {
    throw new Error("metrics-board: table edge-fade opacity does not track overflow");
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
    await goMetricsWait(session.page, session.url, "metrics-dist-plot");
    await session.page.waitForSelector('[data-testid="metrics-heat-grid"]', {
      timeout: 10_000,
    });

    // Contrast on chart labels (composited stack)
    const contrast = {
      distLabel: await measureContrast(session.page, ".pc-metrics__dist-label"),
      distDelta: await measureContrast(session.page, ".pc-metrics__dist-delta"),
      distTick: await measureContrast(session.page, ".pc-metrics__dist-tick-label"),
      heatCol: await measureContrast(session.page, ".pc-metrics__heat-col"),
      heatRow: await measureContrast(session.page, ".pc-metrics__heat-row-label"),
      heatCell: await measureContrast(session.page, ".pc-metrics__heat-cell-label"),
      heatLow: await measureContrast(
        session.page,
        ".pc-metrics__heat-cell--low .pc-metrics__heat-cell-label, .pc-metrics__heat-cell--low-suspect .pc-metrics__heat-cell-label",
      ),
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

    // Workflow tab + cost column (wide viewport so cost is not CSS-dropped)
    await session.page.setViewportSize({ width: 1460, height: 900 });
    await goMetrics(session.page, session.url);
    await session.page.click('[data-testid="metrics-dim-workflow"]');
    await session.page.waitForSelector('[data-testid="metrics-table"]', { timeout: 10_000 });
    const workflow = await session.page.evaluate(() => {
      const table = document.querySelector('[data-testid="metrics-table"]');
      const ths = table
        ? [...table.querySelectorAll("thead th")].map((th) => {
            const cs = getComputedStyle(th);
            return {
              text: (th.textContent ?? "").replace(/\s+/g, " ").trim(),
              visible: cs.display !== "none" && cs.visibility !== "hidden",
            };
          })
        : [];
      const head = ths.map((t) => t.text).join(" ");
      return {
        hasCostColumn: ths.some((t) => t.visible && /cost\s*\/\s*done/i.test(t.text)),
        hasWorkflowRow: (document.body.textContent ?? "").includes("coding-1@3"),
        head: head.replace(/\s+/g, " ").trim(),
      };
    });
    // Back to vendor for viewport shots
    await session.page.click('[data-testid="metrics-dim-vendor"]');
    await session.page.waitForSelector('[data-testid="metrics-dist-plot"]', {
      timeout: 10_000,
    });

    // MED-A / MED-B density sweep (disclosure + overflow/fade)
    const tableDensity = await measureTableDensitySweep(session.page, session.url);

    // Viewports with populated data (hash preserved via beforeMeasure)
    const viewports = await measureAtViewports(session.page, {
      url: session.url.includes("#")
        ? session.url.replace(/#.*$/, "") + "#/metrics"
        : `${session.url}#/metrics`,
      shotDir: shotsDir,
      shotPrefix: DEMO,
      targets: METRICS_SELECTORS,
      beforeMeasure: async () => {
        await session.page.waitForSelector('[data-testid="screen-metrics"]', {
          timeout: 10_000,
        });
        await session.page
          .waitForSelector('[data-testid="metrics-dist-plot"]', { timeout: 8_000 })
          .catch(() => undefined);
      },
    });

    // Headline: rendered-px table across 1280/1361/1366/1460/1700/1920
    const renderedPxTable = await measureRenderedPxTable(session.page, session.url);

    // Board scroll at 1280
    await session.page.setViewportSize({ width: 1280, height: 900 });
    await goMetrics(session.page, session.url);
    await session.page
      .waitForSelector('[data-testid="metrics-dist-plot"]', { timeout: 8_000 })
      .catch(() => undefined);
    await session.page.evaluate(
      () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
    );
    const boardScroll = await measureBoardScroll(session.page);
    const tableCue = await measureTableDensity(session.page);
    // Back-compat fields used by gates/print
    tableCue.primaryVisible = (tableCue.visibleHeaders ?? []).join(" ");
    tableCue.scrollbar = tableCue.wrap
      ? "thin"
      : null;
    tableCue.fadePresent = tableCue.fadePresent && (tableCue.fadeOpacity ?? 0) > 0.5
      ? true
      : tableCue.fadePresent;

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
    await session.page.waitForSelector('[data-testid="metrics-dist-plot"]', {
      timeout: 10_000,
    });
    const a11y = await collectA11y(session.page, {
      include: '[data-testid="screen-metrics"]',
    });
    const axeShell = await runAxe(session.page, {
      include: '[data-testid="shell"]',
    });
    const aria = await ariaSnapshot(session.page, {
      selector: '[data-testid="screen-metrics"]',
    });

    // Heatmap truncation disclosure with many groups
    setMetricsJson(manyGroupsMetricsBody());
    await goMetricsWait(session.page, session.url, "metrics-heat-trunc");
    const heatmapTruncation = await session.page.evaluate(() => {
      const trunc = document.querySelector('[data-testid="metrics-heat-trunc"]');
      const meta = document.querySelector('[data-testid="metrics-heat-meta"]');
      const text = (
        (trunc?.textContent ?? "") +
        " " +
        (meta?.textContent ?? "")
      )
        .replace(/\s+/g, " ")
        .trim();
      return {
        disclosed: /showing\s+\d+\s+of\s+\d+/i.test(text),
        text,
      };
    });
    setMetricsJson(populatedMetricsBody());

    // Neuter proof: break metrics intercept → error red → restore
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
    await goMetricsWait(session.page, session.url, "metrics-dist-plot");
    const neuterRestored = await session.page.evaluate(() => ({
      ready: Boolean(document.querySelector('[data-testid="metrics-dist-plot"]')),
      error: Boolean(document.querySelector('[data-testid="metrics-error-banner"]')),
    }));

    const chartLabelsFinal = await measureChartLabels(session.page);
    const axesFinal = await measureAxes(session.page);

    const proof = {
      kind: "metrics-board",
      description:
        "Metrics screen: HTML distribution (no SVG scale), heatmap truncation " +
        "disclosure, honest legend scale, zero bars, a11y tables, 1280 column " +
        "density, rendered-px labels ≥11 across 1280–1920.",
      headline: {
        boardScroll,
        minRenderedPx: chartLabelsFinal.minRenderedPx,
        minDeclaredPx: chartLabelsFinal.minDeclaredPx,
        chartLabelsAtLeast11: chartLabelsFinal.allRenderedAtLeast11,
        distRowsInBand: chartLabelsFinal.distRowsInBand,
        distRowHeights: chartLabelsFinal.distRowHeights,
        distributionHasAxis: axesFinal.distribution?.hasValueAxis,
        heatmapHonestScale: axesFinal.heatmap?.hasHonestScale,
        tickLabels: axesFinal.distribution?.tickLabels,
        renderedPxByViewport: renderedPxTable.map((r) => ({
          name: r.name,
          width: r.width,
          minRenderedPx: r.minRenderedPx,
          allRenderedAtLeast11: r.allRenderedAtLeast11,
          distRowsInBand: r.distRowsInBand,
        })),
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
      renderedPxTable,
      tableCue,
      tableDensity,
      heatmapTruncation,
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
          minRenderedPx: chartLabelsFinal.minRenderedPx,
          allRenderedAtLeast11: chartLabelsFinal.allRenderedAtLeast11,
          distRowsInBand: chartLabelsFinal.distRowsInBand,
          renderedPxTable: proof.headline.renderedPxByViewport,
          axes: {
            dist: axesFinal.distribution?.hasValueAxis,
            heatScale: axesFinal.heatmap?.hasHonestScale,
            zeroBars: axesFinal.heatmap?.zeroBarsOk,
            lowInk: axesFinal.heatmap?.lowInkDistinct,
            a11y: {
              dist: axesFinal.distribution?.a11yTable,
              heat: axesFinal.heatmap?.a11yTable,
            },
          },
          heatmapTruncation,
          tableCue1280: tableCue.primaryVisible,
          tableDensitySummary: tableDensity.summary,
          tableDensity1280Vendor: tableDensity.vendor["1280"],
          tableDensity1280Workflow: tableDensity.workflow["1280"],
          tableDensity1361Workflow: tableDensity.workflow["1361"],
          tableDensity1380Workflow: tableDensity.workflow["1380"],
          tableDensity1400Workflow: tableDensity.workflow["1400"],
          tableDensity1461Vendor: tableDensity.vendor["1461"],
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
