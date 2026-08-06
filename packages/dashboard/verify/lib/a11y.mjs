/**
 * A11y tooling: axe-core scan + accessibility-tree (ARIA) snapshot.
 * Keyboard-path walkthroughs are scripted helpers for later screens.
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
 * Accessibility tree snapshot (ARIA roles/names).
 * @param {import('playwright-core').Page} page
 * @param {object} [opts]
 * @param {boolean} [opts.interestingOnly]
 */
export async function ariaSnapshot(page, opts = {}) {
  const interestingOnly = opts.interestingOnly !== false;
  // page.accessibility is deprecated in newer Playwright but still present
  // on playwright-core 1.62; fall back to a role dump if removed.
  if (page.accessibility && typeof page.accessibility.snapshot === "function") {
    return page.accessibility.snapshot({ interestingOnly });
  }
  return page.evaluate(() => {
    /** @param {Element} el @param {number} depth */
    function walk(el, depth) {
      if (depth > 8) return null;
      const role = el.getAttribute("role") || el.tagName.toLowerCase();
      const name =
        el.getAttribute("aria-label") ||
        (el instanceof HTMLElement ? el.innerText?.slice(0, 80) : "") ||
        "";
      const kids = [...el.children]
        .map((c) => walk(c, depth + 1))
        .filter(Boolean);
      return { role, name: name.trim(), children: kids.length ? kids : undefined };
    }
    const root = document.querySelector('[data-testid="shell"]') || document.body;
    return walk(root, 0);
  });
}

/**
 * Scripted keyboard walk: Tab N times, record focused element each step.
 * Used later for skip links / tablist / combobox paths; works on the shell today.
 * @param {import('playwright-core').Page} page
 * @param {number} [steps]
 */
export async function keyboardWalk(page, steps = 12) {
  /** @type {Array<{ step: number, tag: string, role: string | null, testId: string | null, text: string }>} */
  const path = [];
  await page.locator("body").focus();
  for (let i = 0; i < steps; i += 1) {
    await page.keyboard.press("Tab");
    const focused = await page.evaluate(() => {
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
    path.push({ step: i + 1, ...focused });
  }
  return path;
}
