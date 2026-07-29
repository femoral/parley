/**
 * In-page probes for the chart measurement lab.
 *
 * Everything here runs **inside the browser**, serialized across by
 * Playwright, so probe functions may not close over module scope. Shared
 * helpers are injected separately as {@link helpersSource} and reached
 * through `window.__lab`.
 *
 * The governing rule: **measure ink, not boxes.** `getBoundingClientRect()`
 * on a text container reads clean while the glyphs overflow it, which is
 * exactly how the #267 title overprint survived three review passes and how
 * #271 came to report the wrong victim. Text is measured with
 * `Range.getClientRects()`, which returns the painted line boxes.
 */

/**
 * Injected into every page before app scripts run. Defines `window.__lab`:
 *
 * - `rect(el)` — a plain, rounded rect (structured-cloneable; DOMRect is not).
 * - `intersect(a, b)` — overlap area in px², 0 when disjoint.
 * - `glyphs(selector)` — painted line boxes for every text node under every
 *   match, plus nested spans (the run-id rides inside the title as one).
 * - `boxes(selector)` — border boxes, for ink that *is* its element: rings,
 *   wax seals, the compass rose, the helm plate.
 */
export const helpersSource = `
window.__lab = {
  rect(el) {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const n = (v) => Math.round(v * 10) / 10;
    return { l: n(r.left), r: n(r.right), t: n(r.top), b: n(r.bottom), w: n(r.width), h: n(r.height) };
  },
  intersect(a, b) {
    if (!a || !b) return 0;
    const x = Math.max(0, Math.min(a.r, b.r) - Math.max(a.l, b.l));
    const y = Math.max(0, Math.min(a.b, b.b) - Math.max(a.t, b.t));
    return Math.round(x * y * 10) / 10;
  },
  /**
   * Overlap against a mark ring's **painted disc**, not its border box.
   *
   * The box is a square; the stroke is the circle inscribed in it, so the
   * four corners are empty paper covering about 21% of the box. Comparing
   * boxes reported hundreds of px² of "overprint" on charts that render
   * perfectly clean — the destination caption clipping a corner where there
   * is no ink. Integrated on a 24×24 grid; exact enough well below the px²
   * where anything is visible.
   */
  intersectDisc(a, plate) {
    if (!a || !plate) return 0;
    const l = Math.max(a.l, plate.l);
    const r = Math.min(a.r, plate.r);
    const t = Math.max(a.t, plate.t);
    const b = Math.min(a.b, plate.b);
    if (r <= l || b <= t) return 0;
    const cx = (plate.l + plate.r) / 2;
    const cy = (plate.t + plate.b) / 2;
    const radius = Math.min(plate.w, plate.h) / 2;
    const steps = 24;
    const dx = (r - l) / steps;
    const dy = (b - t) / steps;
    let inside = 0;
    for (let i = 0; i < steps; i += 1) {
      for (let j = 0; j < steps; j += 1) {
        const px = l + (i + 0.5) * dx;
        const py = t + (j + 0.5) * dy;
        if ((px - cx) ** 2 + (py - cy) ** 2 <= radius * radius) inside += 1;
      }
    }
    return Math.round(inside * dx * dy * 10) / 10;
  },
  /**
   * Which mark a rect belongs to, or null for chrome and marginalia. Used to
   * suppress self-pairs: a mark's label is *designed* to sit against its own
   * ring, so counting that as overprint drowns every real signal.
   */
  _owner(el) {
    const sel = ".pc-chart-mark, .pc-chart-seal, .pc-chart-spot";
    const mark = el.closest(sel);
    if (!mark) return null;
    return [...document.querySelectorAll(sel)].indexOf(mark);
  },
  _push(out, domRect, sel, owner) {
    const n = (v) => Math.round(v * 10) / 10;
    if (domRect.width <= 0 || domRect.height <= 0) return;
    out.push({
      l: n(domRect.left), r: n(domRect.right), t: n(domRect.top), b: n(domRect.bottom),
      w: n(domRect.width), h: n(domRect.height), sel, owner,
    });
  },
  glyphs(selector) {
    const out = [];
    for (const el of document.querySelectorAll(selector)) {
      const owner = this._owner(el);
      for (const node of el.childNodes) {
        if (node.nodeType !== Node.TEXT_NODE || !node.textContent.trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        for (const r of range.getClientRects()) this._push(out, r, selector, owner);
      }
      // Nested inline spans carry their own text (e.g. the run-id in the title).
      for (const span of el.querySelectorAll("span")) {
        const range = document.createRange();
        range.selectNodeContents(span);
        for (const r of range.getClientRects()) this._push(out, r, selector + " span", owner);
      }
    }
    return out;
  },
  boxes(selector) {
    const out = [];
    for (const el of document.querySelectorAll(selector)) {
      this._push(out, el.getBoundingClientRect(), selector, this._owner(el));
    }
    return out;
  },
  many(fn, selectors) {
    const out = [];
    for (const sel of selectors) out.push(...this[fn](sel));
    return out;
  },
};
`;

/** Text-bearing chart ink, by role. */
export const INK = {
  /** Mark labels, tallies, seal captions, destination spot. */
  marks: [
    ".pc-chart-mark__name",
    ".pc-chart-mark__meta",
    ".pc-chart-tally",
    ".pc-chart-seal__name",
    ".pc-chart-seal__meta",
    ".pc-chart-spot__x",
    ".pc-chart-spot__label",
  ],
  /** The title block above the plot: run title, run id, meta line, flavour. */
  title: [".pc-chart__title", ".pc-chart__meta-line", ".pc-chart__flavor"],
  /** Flavour marginalia lettered on the paper. */
  marginalia: [".pc-chart-marginalia"],
};

/** Chart ink that *is* its element rather than text inside one. */
export const PLATES = {
  rings: [".pc-chart-mark__ring", ".pc-chart-seal__wax"],
  compass: [".pc-chart-compass"],
  helm: [".pc-chart-helm"],
  key: [".pc-chart-key"],
};

/**
 * Sheet, plot and rail geometry — the scale bridge itself.
 *
 * `scale` is the sheet's px-per-viewBox-unit, the number every reserve in the
 * projector is denominated against. It is **not** a constant: it runs about
 * 0.385 at the narrowest desktop triptych up to 1.224 at 1920, and the
 * stacked layout below the breakpoint reaches higher still. A claim measured
 * at one scale says nothing about the others.
 */
export function geometry() {
  const L = window.__lab;
  const sheet = L.rect(document.querySelector(".pc-chart__sheet"));
  const plot = L.rect(document.querySelector("[data-chart-plot]"));
  const strip = L.rect(document.querySelector(".pc-chart__strip"));
  const centre = L.rect(document.querySelector(".pc-region--center"));
  return {
    centreW: centre?.w ?? null,
    sheetW: sheet?.w ?? null,
    sheetH: sheet?.h ?? null,
    plotW: plot?.w ?? null,
    plotH: plot?.h ?? null,
    stripH: strip?.h ?? null,
    // Uniform scale: the plot is `aspect-ratio: CHART_VB_W / vbH`.
    scale: plot ? Math.round((plot.w / 1000) * 1000) / 1000 : null,
    marks: document.querySelectorAll(".pc-chart-mark").length,
    marginalia: document.querySelectorAll(".pc-chart-marginalia").length,
  };
}

/**
 * Ink-level overprint: painted area where one ink group lands on another.
 *
 * Box-level overlap is not the same question and is routinely 0 while ink
 * collides. This intersects glyph line boxes against glyph line boxes and
 * against plate border boxes.
 *
 * Three deliberate exclusions, without which the totals are meaningless. Each
 * was found by driving this probe over charts that render clean and asking
 * why it still reported thousands of px²:
 *
 * - **Self-pairs.** A mark's name and meta are *designed* to sit against
 *   their own ring, and the destination's ✗ and caption against each other.
 *   Rects carry an owner index (mark, seal or destination spot); pairs sharing
 *   one are skipped. A label over *another* mark's ring still counts, because
 *   that is a genuine collision.
 * - **The compass rose is not an obstacle for the route.** It is a watermark
 *   painted *under* the marks at half opacity, deliberately. Only marginalia
 *   must avoid it — lettering over lettering is what turns illegible — so the
 *   compass is paired with marginalia alone. The helm plate is opaque and is
 *   an obstacle for everything.
 * - **The key plate** is not an obstacle for the title block, which since
 *   #267 shares a flex row with it rather than painting over the paper.
 *
 * One known coarseness: plates are compared as **border boxes**, so ink
 * clipping a square corner where the rose is round can score a few px² that
 * no eye would call a collision. This is the same rectangle the projector
 * reserves against, so it is the right comparison for a reserve question —
 * but treat single-digit totals as noise, not as a defect.
 */
export function overprint() {
  const L = window.__lab;
  const marginalia = L.many("glyphs", [".pc-chart-marginalia"]);
  const title = L.many("glyphs", [
    ".pc-chart__title",
    ".pc-chart__meta-line",
    ".pc-chart__flavor",
  ]);
  const marks = L.many("glyphs", [
    ".pc-chart-mark__name",
    ".pc-chart-mark__meta",
    ".pc-chart-tally",
    ".pc-chart-seal__name",
    ".pc-chart-seal__meta",
    ".pc-chart-spot__x",
    ".pc-chart-spot__label",
  ]);
  const rings = L.many("boxes", [".pc-chart-mark__ring", ".pc-chart-seal__wax"]);
  const compass = L.many("boxes", [".pc-chart-compass"]);
  const helm = L.many("boxes", [".pc-chart-helm"]);
  const key = L.many("boxes", [".pc-chart-key"]);

  // `disc` marks a pair whose right-hand side is a painted circle rather than
  // the rectangle its border box describes.
  const pairs = [
    ["marginalia-on-marks", marginalia, marks, false],
    ["marginalia-on-rings", marginalia, rings, true],
    ["marginalia-on-compass", marginalia, compass, false],
    ["marginalia-on-helm", marginalia, helm, false],
    ["marks-on-marks", marks, marks, false],
    ["marks-on-other-rings", marks, rings, true],
    ["marks-on-helm", marks, helm, false],
    ["title-on-marks", title, marks, false],
    ["title-on-compass", title, compass, false],
    ["title-on-helm", title, helm, false],
    ["title-on-key", title, key, false],
  ];

  const out = { total: 0, by: {}, worst: [] };
  for (const [name, a, b, disc] of pairs) {
    let area = 0;
    for (const x of a) {
      for (const y of b) {
        if (x === y) continue;
        // Same mark: label against its own ring is the design, not a defect.
        if (x.owner !== null && x.owner === y.owner) continue;
        const i = disc ? L.intersectDisc(x, y) : L.intersect(x, y);
        if (i > 0.01) {
          area += i;
          out.worst.push({ pair: name, a: x.sel, b: y.sel, area: i });
        }
      }
    }
    // marks-on-marks compares a set with itself, so every hit is double-counted.
    if (name === "marks-on-marks") area /= 2;
    area = Math.round(area * 10) / 10;
    if (area > 0) out.by[name] = area;
    out.total += area;
  }
  out.total = Math.round(out.total * 10) / 10;
  out.worst.sort((p, q) => q.area - p.area);
  out.worst = out.worst.slice(0, 5);
  return out;
}

/**
 * Ink clipped away by the sheet's `overflow: hidden`.
 *
 * A container can honour its width perfectly while an unbreakable token's
 * glyphs run past it; the sheet then cuts them off mid-glyph with no ellipsis
 * and no other cue. Element-box assertions cannot see this at all (#271).
 */
export function clipped() {
  const L = window.__lab;
  const sheet = L.rect(document.querySelector(".pc-chart__sheet"));
  if (!sheet) return { clippedPx2: 0, inkRight: null, sheetRight: null, lines: 0 };
  const title = L.glyphs(".pc-chart__title");
  let area = 0;
  for (const g of title) {
    area += Math.max(0, g.r - sheet.r) * g.h;
    area += Math.max(0, sheet.l - g.l) * g.h;
  }
  const strip = document.querySelector(".pc-chart__strip");
  return {
    lines: title.length,
    clippedPx2: Math.round(area * 10) / 10,
    inkRight: title.length ? Math.max(...title.map((g) => g.r)) : null,
    sheetRight: sheet.r,
    // scrollWidth > clientWidth is the cheap corroborating signal.
    stripScrollW: strip?.scrollWidth ?? null,
    stripClientW: strip?.clientWidth ?? null,
  };
}

/**
 * Marks and mark labels that fall below the initial viewport fold — visible
 * only after a scroll. The chart is an Operate surface; a mark the operator
 * must hunt for is a cost worth quantifying when the sheet grows.
 */
export function belowFold() {
  const L = window.__lab;
  const fold = window.innerHeight;
  const rings = L.many("boxes", [".pc-chart-mark__ring", ".pc-chart-seal__wax"]);
  const labels = L.many("glyphs", [".pc-chart-mark__name", ".pc-chart-mark__meta"]);
  return {
    marksBelowFold: rings.filter((r) => r.t >= fold).length,
    marksCrossingFold: rings.filter((r) => r.t < fold && r.b > fold).length,
    labelsBelowFold: labels.filter((r) => r.t >= fold).length,
    totalMarks: rings.length,
    fold,
  };
}

/** Every probe, by the name the CLI takes. */
export const PROBES = { geometry, overprint, clipped, belowFold };
