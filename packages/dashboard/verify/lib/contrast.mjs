/**
 * WCAG 2.1 contrast against the *composited* stack (not token hex alone).
 * Samples getComputedStyle color + walks ancestors for opaque backgrounds.
 *
 * Also hosts the pure token-pair contrast gate (#364): every state ink on every
 * surface-ladder ground (incl. hover/selected/raised) must clear 4.5:1.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

/** Parse #rgb / #rrggbb into [r,g,b]. */
export function parseHex(hex) {
  const h = hex.replace(/^#/, "").trim();
  if (h.length === 3) {
    return [
      parseInt(h[0] + h[0], 16),
      parseInt(h[1] + h[1], 16),
      parseInt(h[2] + h[2], 16),
    ];
  }
  if (h.length === 6 || h.length === 8) {
    return [
      parseInt(h.slice(0, 2), 16),
      parseInt(h.slice(2, 4), 16),
      parseInt(h.slice(4, 6), 16),
    ];
  }
  return null;
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

/** Surface ladder grounds that status inks sit on (incl. hover/selected/raised). */
export const CONTRAST_GROUNDS = {
  ground: "--ground",
  well: "--well",
  "surface-sunken": "--surface-sunken",
  surface: "--surface",
  "surface-raised": "--surface-raised",
  "surface-hover": "--surface-hover",
  "surface-soft": "--surface-soft",
  "surface-active": "--surface-active",
};

/** Status inks that must clear AA on every ground (#364). */
export const CONTRAST_STATE_INKS = {
  pending: "--state-pending",
  queued: "--state-queued",
  running: "--state-running",
  awaiting: "--state-awaiting",
  stalled: "--state-stalled",
  completed: "--state-completed",
  failed: "--state-failed",
  cancelled: "--state-cancelled",
  "eval-good": "--state-eval-good",
  "eval-poor": "--state-eval-poor",
};

/**
 * Read a custom property hex from tokens.css (source of truth).
 * @param {string} [tokensPath]
 * @returns {Record<string, string>} varName → #hex
 */
export function readTokenHexMap(tokensPath) {
  const resolved =
    tokensPath ??
    path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../src/tokens.css",
    );
  const src = fs.readFileSync(resolved, "utf8");
  /** @type {Record<string, string>} */
  const map = {};
  const re = /(--[\w-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\b/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    map[m[1]] = m[2].toLowerCase();
  }
  return map;
}

/**
 * Compute every state-ink × ground pairing ratio.
 * @param {Record<string, string>} [tokenMap]
 * @returns {Array<{ ink: string, ground: string, inkHex: string, groundHex: string, ratio: number, ok: boolean }>}
 */
export function measureStateInkGroundPairings(tokenMap) {
  const tokens = tokenMap ?? readTokenHexMap();
  /** @type {Array<{ ink: string, ground: string, inkHex: string, groundHex: string, ratio: number, ok: boolean }>} */
  const rows = [];
  for (const [inkName, inkVar] of Object.entries(CONTRAST_STATE_INKS)) {
    const inkHex = tokens[inkVar];
    if (!inkHex) {
      rows.push({
        ink: inkName,
        ground: "?",
        inkHex: "",
        groundHex: "",
        ratio: 0,
        ok: false,
      });
      continue;
    }
    const fg = parseHex(inkHex);
    if (!fg) {
      rows.push({
        ink: inkName,
        ground: "?",
        inkHex,
        groundHex: "",
        ratio: 0,
        ok: false,
      });
      continue;
    }
    for (const [groundName, groundVar] of Object.entries(CONTRAST_GROUNDS)) {
      const groundHex = tokens[groundVar];
      if (!groundHex) {
        rows.push({
          ink: inkName,
          ground: groundName,
          inkHex,
          groundHex: "",
          ratio: 0,
          ok: false,
        });
        continue;
      }
      const bg = parseHex(groundHex);
      if (!bg) {
        rows.push({
          ink: inkName,
          ground: groundName,
          inkHex,
          groundHex,
          ratio: 0,
          ok: false,
        });
        continue;
      }
      const ratio = contrastRatio(fg, bg);
      rows.push({
        ink: inkName,
        ground: groundName,
        inkHex,
        groundHex,
        ratio: Math.round(ratio * 100) / 100,
        ok: ratio >= 4.5,
      });
    }
  }
  return rows;
}

/**
 * Gate: every state-ink/ground pairing ≥ 4.5:1.
 * Throws with the failing pairs listed — demonstrably fails if tokens regress
 * (neuter: set --state-failed back to #d9534a; fails on surface-soft / surface-active).
 * @param {object} [opts]
 * @param {string} [opts.tokensPath]
 * @param {number} [opts.minRatio]
 * @returns {{ ok: true, pairings: number, worst: object }}
 */
export function assertStateInkGroundContrast(opts = {}) {
  const minRatio = opts.minRatio ?? 4.5;
  const rows = measureStateInkGroundPairings(
    opts.tokensPath ? readTokenHexMap(opts.tokensPath) : undefined,
  );
  const fails = rows.filter((r) => !r.ok || r.ratio < minRatio);
  if (fails.length > 0) {
    const detail = fails
      .map(
        (f) =>
          `${f.ink}(${f.inkHex}) on ${f.ground}(${f.groundHex}) = ${f.ratio}:1`,
      )
      .join("; ");
    throw new Error(
      `state-ink contrast gate: ${fails.length} pairing(s) below ${minRatio}:1 — ${detail}`,
    );
  }
  const worst = rows.reduce((a, b) => (a.ratio <= b.ratio ? a : b), rows[0]);
  return { ok: true, pairings: rows.length, worst };
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
  // #370: dropped dead `.pc-screen__title` probe (class never rendered; gate
  // skipped not-found so it was a silent no-op).
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
  ];
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const t of targets) {
    out[t.id] = await measureContrast(page, t.selector);
  }
  return out;
}

/**
 * Grounds the inherited run-card actually paints on (#370).
 * Dim inks must clear AA here — not the full surface ladder.
 */
export const RUN_DIM_GROUNDS = {
  "run-ground-pending": "--run-ground-pending",
  "surface-sunken": "--surface-sunken",
  "surface-raised": "--surface-raised",
  ground: "--ground",
  surface: "--surface",
};

/** Pre-computed dim inks that replace ancestor opacity on inherited cards. */
export const RUN_DIM_INKS = {
  "run-ink-dim": "--run-ink-dim",
  "run-ink-dim-2": "--run-ink-dim-2",
  "run-ink-dim-3": "--run-ink-dim-3",
  "run-ink-dim-4": "--run-ink-dim-4",
  "run-ink-dim-pending": "--run-ink-dim-pending",
};

/**
 * Compute every run-dim-ink × run-card-ground pairing ratio.
 * @param {Record<string, string>} [tokenMap]
 */
export function measureRunDimInkPairings(tokenMap) {
  const tokens = tokenMap ?? readTokenHexMap();
  /** @type {Array<{ ink: string, ground: string, inkHex: string, groundHex: string, ratio: number, ok: boolean }>} */
  const rows = [];
  for (const [inkName, inkVar] of Object.entries(RUN_DIM_INKS)) {
    const inkHex = tokens[inkVar];
    const fg = inkHex ? parseHex(inkHex) : null;
    for (const [groundName, groundVar] of Object.entries(RUN_DIM_GROUNDS)) {
      const groundHex = tokens[groundVar];
      const bg = groundHex ? parseHex(groundHex) : null;
      if (!fg || !bg || !inkHex || !groundHex) {
        rows.push({
          ink: inkName,
          ground: groundName,
          inkHex: inkHex ?? "",
          groundHex: groundHex ?? "",
          ratio: 0,
          ok: false,
        });
        continue;
      }
      const ratio = contrastRatio(fg, bg);
      rows.push({
        ink: inkName,
        ground: groundName,
        inkHex,
        groundHex,
        ratio: Math.round(ratio * 100) / 100,
        ok: ratio >= 4.5,
      });
    }
  }
  return rows;
}

/**
 * Gate: every run dim-ink/card-ground pairing ≥ 4.5:1 (#370).
 * Neuter: restore ancestor `opacity: 0.72` on `.pc-run__node-card--inherited`
 * and drop dim rebinds — axe on the populated run screen fails; or set a
 * dim token too dark (e.g. `--run-ink-dim-4: #3a4248`) and this pure gate fails.
 * @param {object} [opts]
 * @param {string} [opts.tokensPath]
 * @param {number} [opts.minRatio]
 */
export function assertRunDimInkContrast(opts = {}) {
  const minRatio = opts.minRatio ?? 4.5;
  const rows = measureRunDimInkPairings(
    opts.tokensPath ? readTokenHexMap(opts.tokensPath) : undefined,
  );
  const fails = rows.filter((r) => !r.ok || r.ratio < minRatio);
  if (fails.length > 0) {
    const detail = fails
      .map(
        (f) =>
          `${f.ink}(${f.inkHex}) on ${f.ground}(${f.groundHex}) = ${f.ratio}:1`,
      )
      .join("; ");
    throw new Error(
      `run-dim-ink contrast gate: ${fails.length} pairing(s) below ${minRatio}:1 — ${detail}`,
    );
  }
  const worst = rows.reduce((a, b) => (a.ratio <= b.ratio ? a : b), rows[0]);
  return { ok: true, pairings: rows.length, worst };
}
