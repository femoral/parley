/**
 * A11y tooling: axe-core scan + accessibility-tree (ARIA) snapshot +
 * keyboard-path walkthroughs.
 *
 * ARIA snapshots use Playwright's `locator.ariaSnapshot()` (YAML a11y tree).
 * `page.accessibility` is undefined on playwright-core 1.62 — do not use it.
 */
import AxeBuilder from "@axe-core/playwright";

/**
 * Run axe against the current page. Returns a compact serializable report.
 * @param {import('playwright-core').Page} page
 * @param {object} [opts]
 * @param {string} [opts.include] CSS selector to scope the scan
 */
export async function runAxe(page, opts = {}) {
  let builder = new AxeBuilder({ page });
  if (opts.include) builder = builder.include(opts.include);
  const results = await builder.analyze();
  return {
    url: results.url,
    violations: results.violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      description: v.description,
      helpUrl: v.helpUrl,
      nodes: v.nodes.length,
      targets: v.nodes.slice(0, 5).map((n) => n.target),
    })),
    passes: results.passes.length,
    incomplete: results.incomplete.length,
    inapplicable: results.inapplicable.length,
  };
}

/**
 * Accessibility tree snapshot via Playwright's ARIA snapshot API.
 * Returns YAML text of roles/names (not a DOM walk).
 *
 * @param {import('playwright-core').Page} page
 * @param {object} [opts]
 * @param {string} [opts.selector] root to snapshot (default shell / body)
 */
export async function ariaSnapshot(page, opts = {}) {
  const selector = opts.selector ?? '[data-testid="shell"]';
  const root = page.locator(selector);
  const count = await root.count();
  const target = count > 0 ? root.first() : page.locator("body");
  if (typeof target.ariaSnapshot !== "function") {
    throw new Error(
      "locator.ariaSnapshot() unavailable — playwright-core too old; " +
        "do not fall back to a DOM walk under the name \"aria\"",
    );
  }
  const yaml = await target.ariaSnapshot();
  return {
    api: "locator.ariaSnapshot",
    selector: count > 0 ? selector : "body",
    // YAML accessibility tree (roles, names, structure).
    tree: yaml,
  };
}

/** Selectors that approximate keyboard-reachable surface for counting. */
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
  "[contenteditable='true']",
].join(", ");

/**
 * Count elements that can receive keyboard focus (rough tab-stop set).
 * @param {import('playwright-core').Page} page
 */
export async function countFocusables(page) {
  return page.locator(FOCUSABLE_SELECTOR).count();
}

/**
 * Scripted keyboard walk with real assertions.
 *
 * - If zero focusable elements: record `focusableCount: 0` and a clear
 *   "no keyboard surface yet (placeholder shell)" note — no vacuous Tab spam.
 * - If focusables exist: Tab (and Enter on non-body focus), require focus to
 *   leave `body`. FAIL if every step stays on body.
 *
 * @param {import('playwright-core').Page} page
 * @param {object} [opts]
 * @param {number} [opts.maxSteps] max Tab presses when focusables exist
 */
export async function keyboardWalk(page, opts = {}) {
  const maxSteps = opts.maxSteps ?? 12;
  const focusableCount = await countFocusables(page);

  if (focusableCount === 0) {
    return {
      focusableCount: 0,
      note: "no keyboard surface yet (placeholder shell)",
      path: [],
      entered: false,
      leftBody: false,
    };
  }

  /** @type {Array<{ step: number, key: string, tag: string, role: string | null, testId: string | null, text: string }>} */
  const path = [];
  let leftBody = false;
  let entered = false;

  // Start from a known non-control so Tab moves into the document.
  await page.locator("body").focus();

  for (let i = 0; i < maxSteps; i += 1) {
    await page.keyboard.press("Tab");
    const focused = await describeFocus(page);
    path.push({ step: i + 1, key: "Tab", ...focused });
    if (focused.tag !== "body") {
      leftBody = true;
      // Activate the focused control once so later screens prove Enter paths.
      await page.keyboard.press("Enter");
      entered = true;
      const afterEnter = await describeFocus(page);
      path.push({ step: i + 1, key: "Enter", ...afterEnter });
      // One successful leave-body + Enter is enough for the gate shape.
      break;
    }
  }

  if (!leftBody) {
    throw new Error(
      `keyboardWalk: ${focusableCount} focusable element(s) exist but focus ` +
        `never left body after ${maxSteps} Tab presses — keyboard surface broken`,
    );
  }

  return {
    focusableCount,
    note: null,
    path,
    entered,
    leftBody,
  };
}

/**
 * @param {import('playwright-core').Page} page
 */
async function describeFocus(page) {
  return page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) {
      return { tag: "body", role: null, testId: null, text: "" };
    }
    const text = (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
    return {
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute("role"),
      testId: el.getAttribute("data-testid"),
      text,
    };
  });
}

/**
 * Full a11y proof block for a ledger demo entry (axe + ARIA tree + keyboard).
 * @param {import('playwright-core').Page} page
 * @param {object} [opts]
 * @param {string} [opts.include]
 */
export async function collectA11y(page, opts = {}) {
  const include = opts.include ?? '[data-testid="shell"]';
  await page.evaluate(() => document.fonts.ready).catch(() => undefined);
  const axe = await runAxe(page, { include });
  const aria = await ariaSnapshot(page, { selector: include });
  const keyboard = await keyboardWalk(page);
  return { axe, aria, keyboardWalk: keyboard };
}
