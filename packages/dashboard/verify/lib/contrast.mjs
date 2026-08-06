/**
 * WCAG 2.1 contrast against the *composited* stack (not token hex alone).
 * Samples getComputedStyle color + walks ancestors for opaque backgrounds.
 */

/**
 * @param {string} color css color (rgb/rgba)
 * @returns {[number, number, number, number] | null} sRGB 0–255 + alpha
 */
export function parseCssColor(color) {
  if (!color || color === "transparent") return [0, 0, 0, 0];
  const m = color.match(
    /rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)/,
  );
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] !== undefined ? Number(m[4]) : 1];
}

/** Relative luminance (sRGB). */
export function relativeLuminance(r, g, b) {
  const lin = [r, g, b].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

export function contrastRatio(fg, bg) {
  const L1 = relativeLuminance(fg[0], fg[1], fg[2]);
  const L2 = relativeLuminance(bg[0], bg[1], bg[2]);
  const lighter = Math.max(L1, L2);
  const darker = Math.min(L1, L2);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Composite opaque background by walking ancestors.
 * @param {import('playwright-core').Page} page
 * @param {string} selector
 */
export async function measureContrast(page, selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return { selector: sel, found: false };

    function parse(color) {
      if (!color || color === "transparent") return [0, 0, 0, 0];
      const m = color.match(
        /rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)/,
      );
      if (!m) return null;
      return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] !== undefined ? Number(m[4]) : 1];
    }

    function relLum(r, g, b) {
      const lin = [r, g, b].map((c) => {
        const s = c / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
    }

    function ratio(fg, bg) {
      const L1 = relLum(fg[0], fg[1], fg[2]);
      const L2 = relLum(bg[0], bg[1], bg[2]);
      return (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
    }

    function compositeBg(node) {
      let r = 11,
        g = 13,
        b = 15; // --ground fallback
      const stack = [];
      let cur = node;
      while (cur && cur !== document.documentElement) {
        const cs = getComputedStyle(cur);
        const bg = parse(cs.backgroundColor);
        if (bg && bg[3] > 0.99) {
          stack.push(bg);
          break;
        }
        if (bg && bg[3] > 0) stack.push(bg);
        cur = cur.parentElement;
      }
      // paint bottom-up
      for (let i = stack.length - 1; i >= 0; i--) {
        const [cr, cg, cb, a] = stack[i];
        r = cr * a + r * (1 - a);
        g = cg * a + g * (1 - a);
        b = cb * a + b * (1 - a);
      }
      return [Math.round(r), Math.round(g), Math.round(b)];
    }

    const cs = getComputedStyle(el);
    const fg = parse(cs.color);
    if (!fg) return { selector: sel, found: true, error: "unparsed foreground" };
    const bg = compositeBg(el);
    const cr = ratio(fg, bg);
    const fontSize = parseFloat(cs.fontSize) || 0;
    const fontWeight = parseInt(cs.fontWeight, 10) || 400;
    // WCAG large text is 18pt (~24px) or 14pt (~18.67px) bold — not CSS px@18.
    const large = fontSize >= 24 || (fontSize >= 18.67 && fontWeight >= 700);
    const aa = large ? cr >= 3 : cr >= 4.5;
    return {
      selector: sel,
      found: true,
      color: cs.color,
      background: `rgb(${bg[0]}, ${bg[1]}, ${bg[2]})`,
      fontSize: cs.fontSize,
      fontWeight: cs.fontWeight,
      ratio: Math.round(cr * 100) / 100,
      largeText: large,
      wcagAA: aa,
      text: (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 80),
    };
  }, selector);
}

/**
 * Measure a set of text-carrying chrome selectors.
 * @param {import('playwright-core').Page} page
 */
export async function measureChromeContrast(page) {
  const targets = [
    { id: "brand-name", selector: ".pc-shell__brand-name" },
    { id: "brand-sub", selector: ".pc-shell__brand-sub" },
    { id: "tab-label", selector: ".pc-shell__tab-label" },
    { id: "status-label", selector: ".pc-shell__status-label" },
    { id: "status-value", selector: ".pc-shell__status-value" },
    { id: "attention-label", selector: ".pc-shell__attention-label" },
    { id: "attention-count", selector: ".pc-shell__attention-count" },
    { id: "clock", selector: ".pc-shell__clock" },
    { id: "find-input", selector: ".pc-find__input" },
    { id: "legend-label", selector: ".pc-shell__legend-label" },
    { id: "footer-meta", selector: ".pc-shell__footer-meta" },
    { id: "screen-title", selector: ".pc-screen__title" },
  ];
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const t of targets) {
    out[t.id] = await measureContrast(page, t.selector);
  }
  return out;
}
