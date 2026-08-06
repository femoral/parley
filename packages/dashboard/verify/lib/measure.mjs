/**
 * Rendered measurement — bounding rects + computed styles.
 * Viewports from DESIGN.md / PRODUCT.md: 1280 / 1460 / 1920.
 */

/** Named console board widths (px). Height is fixed for density comparisons. */
export const VIEWPORTS = [
  { name: "1280", width: 1280, height: 900 },
  { name: "1460", width: 1460, height: 900 },
  { name: "1920", width: 1920, height: 900 },
];

/** Shell selectors measured on every proof (#354 chrome board). */
export const DEFAULT_SELECTORS = [
  { id: "shell", selector: '[data-testid="shell"]' },
  { id: "header", selector: ".pc-shell__header" },
  { id: "brand", selector: ".pc-shell__brand" },
  { id: "nav", selector: '[data-testid="shell-nav"]' },
  { id: "status", selector: ".pc-shell__status" },
  { id: "needs-orch", selector: '[data-testid="needs-orch"]' },
  { id: "live-status", selector: '[data-testid="live-status"]' },
  { id: "find", selector: '[data-testid="find-combobox"]' },
  { id: "find-input", selector: '[data-testid="find-input"]' },
  { id: "body", selector: ".pc-shell__body" },
  { id: "rail-left", selector: ".pc-shell__rail--left" },
  { id: "center", selector: ".pc-shell__center" },
  { id: "rail-right", selector: ".pc-shell__rail--right" },
  { id: "footer", selector: ".pc-shell__footer" },
];

/** Computed style keys that prove density / ink contracts. */
const STYLE_KEYS = [
  "display",
  "position",
  "width",
  "height",
  "minWidth",
  "minHeight",
  "backgroundColor",
  "color",
  "font",
  "fontSize",
  "fontWeight",
  "fontFamily",
  "letterSpacing",
  "textTransform",
  "borderTopWidth",
  "borderBottomWidth",
  "borderLeftWidth",
  "borderRightWidth",
  "borderTopColor",
  "borderBottomColor",
  "borderLeftColor",
  "borderRightColor",
  "gridTemplateRows",
  "gridTemplateColumns",
  "gap",
  "padding",
  "margin",
  "overflow",
  "opacity",
];

/**
 * Measure one element: bounding box + selected computed styles + text sample.
 * @param {import('playwright-core').Page} page
 * @param {string} selector
 */
export async function measureElement(page, selector) {
  const handle = await page.$(selector);
  if (!handle) {
    return { selector, found: false };
  }
  const box = await handle.boundingBox();
  const styles = await handle.evaluate((el, keys) => {
    const cs = getComputedStyle(el);
    /** @type {Record<string, string>} */
    const out = {};
    for (const k of keys) out[k] = cs[k];
    return out;
  }, STYLE_KEYS);
  const text = await handle.evaluate((el) => {
    const t = (el.textContent ?? "").replace(/\s+/g, " ").trim();
    return t.length > 160 ? `${t.slice(0, 157)}…` : t;
  });
  await handle.dispose();
  return {
    selector,
    found: true,
    box: box
      ? {
          x: round(box.x),
          y: round(box.y),
          width: round(box.width),
          height: round(box.height),
        }
      : null,
    styles,
    text,
  };
}

/**
 * Measure a list of named selectors at the current viewport.
 * @param {import('playwright-core').Page} page
 * @param {Array<{ id: string, selector: string }>} [targets]
 */
export async function measureSelectors(page, targets = DEFAULT_SELECTORS) {
  /** @type {Record<string, Awaited<ReturnType<typeof measureElement>>>} */
  const elements = {};
  for (const t of targets) {
    elements[t.id] = await measureElement(page, t.selector);
  }
  return elements;
}

/**
 * Walk every named viewport: set size → wait fonts → measure → optional shot.
 * @param {import('playwright-core').Page} page
 * @param {object} opts
 * @param {string} opts.url
 * @param {string} [opts.shotDir] absolute dir for PNGs (created if missing)
 * @param {string} [opts.shotPrefix] file prefix (e.g. "staged")
 * @param {Array<{ id: string, selector: string }>} [opts.targets]
 * @param {() => Promise<void>} [opts.beforeMeasure] hook after navigation / resize
 */
export async function measureAtViewports(page, opts) {
  const { url, shotDir, shotPrefix = "shot", targets, beforeMeasure } = opts;
  const fs = await import("node:fs");
  const path = await import("node:path");
  if (shotDir) fs.mkdirSync(shotDir, { recursive: true });

  /** @type {Array<object>} */
  const viewports = [];
  for (const vp of VIEWPORTS) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.goto(url, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-testid="shell"]', { timeout: 15_000 });
    // Fonts must settle before any geometry claim (lab lesson).
    await page.evaluate(() => document.fonts.ready);
    if (beforeMeasure) await beforeMeasure();

    const elements = await measureSelectors(page, targets);
    /** @type {string | null} */
    let screenshot = null;
    if (shotDir) {
      const file = `${shotPrefix}-${vp.name}.png`;
      const abs = path.join(shotDir, file);
      await page.screenshot({ path: abs, fullPage: false });
      // Relative to shotDir parent (ledger entry), not absolute /home paths.
      screenshot = path.join(path.basename(shotDir), file).split(path.sep).join("/");
    }
    viewports.push({
      name: vp.name,
      width: vp.width,
      height: vp.height,
      screenshot,
      elements,
    });
  }
  return viewports;
}

function round(n) {
  return Math.round(n * 100) / 100;
}
