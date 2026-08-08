/**
 * Issue #363 — shell rails + AttentionCard proofs.
 *
 * - Neither placeholder note string renders
 * - Right rail: attention queue + firehose; fleet center has no firehose
 * - Left rail: scope, state filter, burn
 * - Rails scroll internally; no board H-scroll at 1280
 * - Populated rails: staged tasks so axe + AA see real cards/hose lines
 * - New ≤11px text passes AA against actual grounds
 * - Focus ring on interactive attention cards is a real, visible outline
 *   (post-#366 tokens; #373 gates outline-color alpha + contrast ≥ 3:1)
 * - Rows density is single-line (~≤32px)
 */
import { pathToFileURL } from "node:url";
import { collectA11y } from "../lib/a11y.mjs";
import {
  contrastRatio,
  measureContrast,
  measureInkVsTokenGround,
  parseCssColor,
  readTokenHexMap,
} from "../lib/contrast.mjs";
import {
  ledgerDirs,
  writeDemoProof,
  printRectSummary,
  readLedger,
} from "../lib/ledger.mjs";
import { measureAtViewports } from "../lib/measure.mjs";
import { openVerifySession } from "../lib/session.mjs";

const TICKET = "issue-363";
const DEMO = "console-rails";

export const RAIL_SELECTORS = [
  { id: "shell", selector: '[data-testid="shell"]' },
  { id: "body", selector: '[data-testid="shell-body"]' },
  { id: "rail-left", selector: '[data-testid="rail-left"]' },
  { id: "rail-right", selector: '[data-testid="rail-right"]' },
  { id: "center", selector: '[data-testid="shell-center"]' },
  { id: "rail-scope", selector: '[data-testid="rail-scope"]' },
  { id: "rail-state-filter", selector: '[data-testid="rail-state-filter"]' },
  { id: "rail-token-burn", selector: '[data-testid="rail-token-burn"]' },
  { id: "rail-attention", selector: '[data-testid="rail-attention"]' },
  { id: "rail-firehose", selector: '[data-testid="rail-firehose"]' },
];

/**
 * @param {object} _entry
 * @param {object} ledger
 */
export function consoleRailsGates(_entry, ledger) {
  const demo = ledger.demos?.[DEMO];
  if (!demo) throw new Error("console-rails: missing demo in ledger");

  if (demo.placeholders?.leftNote || demo.placeholders?.rightNote) {
    throw new Error(
      `console-rails: placeholder notes still render: ${JSON.stringify(demo.placeholders)}`,
    );
  }
  if (demo.panels?.fleetFirehose) {
    throw new Error("console-rails: fleet center still has firehose panel");
  }
  for (const key of [
    "scope",
    "stateFilter",
    "tokenBurn",
    "attention",
    "firehose",
  ]) {
    if (!demo.panels?.[key]) {
      throw new Error(`console-rails: missing panel ${key}`);
    }
  }
  if (!demo.scroll1280?.noBoardHScroll) {
    throw new Error(
      `console-rails: board H-scroll at 1280: ${JSON.stringify(demo.scroll1280)}`,
    );
  }
  if (!demo.scroll1280?.railsInternalOk) {
    throw new Error(
      `console-rails: rails not internal scroll owners: ${JSON.stringify(demo.scroll1280)}`,
    );
  }

  // Populated rails — gates below only work when cards/hose lines exist.
  const pop = demo.populated ?? {};
  if (!(pop.attentionCards >= 1)) {
    throw new Error(
      `console-rails: expected staged attention cards, got ${pop.attentionCards}`,
    );
  }
  if (!(pop.hoseLines >= 1)) {
    throw new Error(
      `console-rails: expected staged firehose lines, got ${pop.hoseLines}`,
    );
  }
  if (pop.scopeLabelAllHands) {
    throw new Error(
      'console-rails: forbidden "All hands" scope label still present',
    );
  }

  // Rows single-line: auto-placement bug yields ~44px; fixed is ~27px.
  const rows = demo.rowsDensity;
  if (rows?.found && rows.heightPx != null && rows.heightPx > 34) {
    throw new Error(
      `console-rails: rows variant not single-line (height ${rows.heightPx}px > 34)`,
    );
  }

  // Focus affordance: rule-text tokens + rendered outline under real Tab.
  // :focus-visible does not fire under programmatic .focus() alone (#369).
  // Single reachable failure path; message distinguishes Tab vs shape vs color
  // visibility (#373) — do not pre-gate on focus.ok then re-check sub-fields
  // (those branches were unreachable when ok already ANDed them).
  const focus = demo.focusRing;
  if (!focus?.ok) {
    let detail = "missing/invalid";
    if (focus?.found && focus.ruleOk) {
      if (!focus.viaTab) {
        detail = "not measured via Tab traversal";
      } else if (
        !focus.computedOutlineStyle ||
        focus.computedOutlineStyle === "none" ||
        !(parseFloat(focus.computedOutlineWidth) > 0)
      ) {
        detail = "rendered focus outline missing/none";
      } else if (focus.outlineVisible !== true) {
        detail = "rendered focus outline not visible";
      }
    }
    throw new Error(
      `console-rails: interactive attention focus ring ${detail}: ${JSON.stringify(focus)}`,
    );
  }

  // AA on ≤11px text (includes 10.5px hose time that ≤10 filter missed).
  const contrast = demo.contrast ?? {};
  for (const [id, m] of Object.entries(contrast)) {
    if (
      m &&
      m.found &&
      m.fontSizePx != null &&
      m.fontSizePx <= 11 &&
      m.wcagAA === false
    ) {
      throw new Error(
        `console-rails: AA fail ≤11px ${id} ratio=${m.ratio} size=${m.fontSizePx}`,
      );
    }
  }
  // Explicit hose-time floor: must be measured on real rail (not empty).
  const hoseTime = contrast["rail-hose-time-live"] ?? contrast["rail-hose-time"];
  if (!hoseTime?.found) {
    throw new Error("console-rails: hose time contrast sample missing");
  }
  if (hoseTime.wcagAA === false || (hoseTime.ratio != null && hoseTime.ratio < 4.5)) {
    throw new Error(
      `console-rails: hose time AA fail ratio=${hoseTime.ratio} size=${hoseTime.fontSizePx}`,
    );
  }
  // Worst-case ground (#369): ink must clear 4.5:1 against panel --surface,
  // not only the firehose's own dark well (where weak --text-time still passes).
  const hoseVsSurface = contrast["rail-hose-time-vs-surface"];
  if (!hoseVsSurface?.found) {
    throw new Error(
      "console-rails: hose time vs --surface contrast sample missing",
    );
  }
  if (
    hoseVsSurface.wcagAA === false ||
    (hoseVsSurface.ratio != null && hoseVsSurface.ratio < 4.5)
  ) {
    throw new Error(
      `console-rails: hose time AA fail vs --surface ratio=${hoseVsSurface.ratio} ink=${hoseVsSurface.ink}`,
    );
  }

  const axe = demo.a11y?.axe;
  if (!axe) throw new Error("console-rails: missing axe");
  if ((axe.violations ?? []).length > 0) {
    throw new Error(
      `console-rails: axe violations: ${axe.violations.map((v) => v.id).join(", ")}`,
    );
  }
}

/**
 * @param {import('playwright-core').Page} page
 */
async function measureScrollOwners(page) {
  return page.evaluate(() => {
    const shell = document.querySelector('[data-testid="shell"]');
    const left = document.querySelector('[data-testid="rail-left"]');
    const right = document.querySelector('[data-testid="rail-right"]');
    const center = document.querySelector('[data-testid="shell-center"]');
    const body = document.querySelector('[data-testid="shell-body"]');
    const pageEl = document.documentElement;

    function pack(el, name) {
      if (!el) return { name, found: false };
      const cs = getComputedStyle(el);
      return {
        name,
        found: true,
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
        overflowX: cs.overflowX,
        overflowY: cs.overflowY,
        noHScroll: el.scrollWidth <= el.clientWidth + 1,
      };
    }

    const shellP = pack(shell, "shell");
    const leftP = pack(left, "rail-left");
    const rightP = pack(right, "rail-right");
    const centerP = pack(center, "center");
    const bodyP = pack(body, "body");
    const pageP = pack(pageEl, "page");

    return {
      shell: shellP,
      left: leftP,
      right: rightP,
      center: centerP,
      body: bodyP,
      page: pageP,
      noBoardHScroll:
        shellP.noHScroll !== false &&
        bodyP.noHScroll !== false &&
        pageP.scrollWidth <= pageP.clientWidth + 1,
      railsInternalOk:
        (leftP.overflowY === "auto" || leftP.overflowY === "scroll") &&
        (rightP.overflowY === "auto" || rightP.overflowY === "scroll"),
    };
  });
}

/**
 * @param {import('playwright-core').Page} page
 */
async function measurePlaceholders(page) {
  return page.evaluate(() => {
    const text = document.body?.innerText ?? "";
    return {
      leftNote: text.includes(
        "Scope, state filter, and list navigation land with each screen ticket",
      ),
      rightNote: text.includes(
        "Attention and the event firehose live on the fleet board screen",
      ),
    };
  });
}

/**
 * @param {import('playwright-core').Page} page
 */
async function measurePanels(page) {
  return page.evaluate(() => {
    const has = (sel) => !!document.querySelector(sel);
    return {
      scope: has('[data-testid="rail-scope"]'),
      stateFilter: has('[data-testid="rail-state-filter"]'),
      tokenBurn: has('[data-testid="rail-token-burn"]'),
      attention: has('[data-testid="rail-attention"]'),
      firehose: has('[data-testid="rail-firehose"]'),
      fleetFirehose: has('[data-testid="fleet-firehose"]'),
      leftContent: has('[data-testid="rail-left-content"]'),
      rightContent: has('[data-testid="rail-right-content"]'),
    };
  });
}

/**
 * @param {import('playwright-core').Page} page
 */
async function measurePopulated(page) {
  return page.evaluate(() => {
    const cards = document.querySelectorAll(
      '[data-testid="rail-attention"] .pc-attn',
    );
    const hoseLines = document.querySelectorAll(
      '[data-testid="rail-firehose"] .pc-rail-hose__line',
    );
    const scopeText =
      document.querySelector('[data-testid="rail-scope"]')?.textContent ?? "";
    return {
      attentionCards: cards.length,
      hoseLines: hoseLines.length,
      interactiveCards: document.querySelectorAll(
        '[data-testid="rail-attention"] .pc-attn--interactive',
      ).length,
      scopeLabelAllHands: /All hands/.test(scopeText),
      scopeLabelAllSessions: /All sessions/.test(scopeText),
    };
  });
}

/**
 * Measure rows variant height — multi-row auto-placement bug is ~44px.
 * Forces rows density via the density toggle.
 * @param {import('playwright-core').Page} page
 */
async function measureRowsDensity(page) {
  const rowsBtn = page.locator('[data-testid="rail-density-rows"]');
  if ((await rowsBtn.count()) > 0) {
    await rowsBtn.click();
    await page.waitForTimeout(150);
  }

  return page.evaluate(() => {
    const row = document.querySelector(
      '[data-testid="rail-attention"] .pc-attn--rows',
    );
    if (!row) {
      return { found: false, heightPx: null };
    }
    const r = row.getBoundingClientRect();
    return {
      found: true,
      heightPx: Math.round(r.height * 10) / 10,
      titleHeight: row
        .querySelector(".pc-attn__title")
        ?.getBoundingClientRect().height,
    };
  });
}

/**
 * Interactive attention card must paint a visible focus outline (post-#366:
 * --focus-ring is a color; width is --focus-ring-width).
 *
 * Rule-text checks stay (CSSOM). Rendered outline is authoritative under a real
 * Tab traversal — `:focus-visible` does not fire under programmatic `.focus()`
 * (#369). #373 also gates outline-color: alpha > 0 and ≥ 3:1 contrast against
 * the card ground the inset outline paints over (WCAG non-text indicator).
 *
 * @param {import('playwright-core').Page} page
 */
async function measureFocusRing(page) {
  // CSSOM + token shape (independent of focus modality).
  const rulePart = await page.evaluate(() => {
    const el = document.querySelector(
      '[data-testid="rail-attention"] .pc-attn--interactive',
    );
    if (!el) return { found: false, ok: false, reason: "no interactive card" };

    let ruleOutline = null;
    let ruleOffset = null;
    for (const sheet of document.styleSheets) {
      let rules;
      try {
        rules = sheet.cssRules;
      } catch {
        continue;
      }
      for (const rule of rules) {
        if (
          rule instanceof CSSStyleRule &&
          rule.selectorText?.includes(".pc-attn--interactive:focus-visible")
        ) {
          ruleOutline =
            rule.style.outline || rule.style.getPropertyValue("outline");
          ruleOffset =
            rule.style.outlineOffset ||
            rule.style.getPropertyValue("outline-offset");
        }
      }
    }
    const root = getComputedStyle(document.documentElement);
    const ringColor = root.getPropertyValue("--focus-ring").trim();
    const ringWidth = root.getPropertyValue("--focus-ring-width").trim();
    const outlineOk =
      ruleOutline != null &&
      /var\(--focus-ring-width\)/.test(ruleOutline) &&
      /var\(--focus-ring\)/.test(ruleOutline) &&
      !/var\(--link\)/.test(ruleOutline);
    const colorIsColor =
      ringColor.startsWith("#") ||
      ringColor.startsWith("rgb") ||
      ringColor.startsWith("hsl");
    const widthIsLength = /^\d/.test(ringWidth);

    return {
      found: true,
      ruleOutline,
      ruleOffset,
      ringColor,
      ringWidth,
      ruleOk: outlineOk && colorIsColor && widthIsLength,
    };
  });

  if (!rulePart.found) {
    return { found: false, ok: false, viaTab: false, reason: rulePart.reason };
  }

  // Real Tab into the first interactive attention card so :focus-visible matches.
  // Probe button sits immediately before the card in tab order — one Tab lands
  // on the card without depending on full-shell focus order.
  await page.evaluate(() => {
    document.getElementById("pc-verify-focus-probe")?.remove();
    const target = document.querySelector(
      '[data-testid="rail-attention"] .pc-attn--interactive',
    );
    if (!target?.parentElement) return;
    const probe = document.createElement("button");
    probe.id = "pc-verify-focus-probe";
    probe.type = "button";
    probe.setAttribute("aria-hidden", "true");
    probe.tabIndex = 0;
    probe.style.cssText =
      "position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none;";
    target.parentElement.insertBefore(probe, target);
    probe.focus();
  });
  await page.keyboard.press("Tab");

  const rendered = await page.evaluate(() => {
    const el = document.activeElement;
    const isAttn =
      el instanceof HTMLElement &&
      el.classList.contains("pc-attn--interactive") &&
      el.closest('[data-testid="rail-attention"]');
    if (!isAttn) {
      return {
        viaTab: false,
        focusedInteractive: false,
        activeTag: el?.tagName?.toLowerCase() ?? null,
        activeClass: el instanceof HTMLElement ? el.className : null,
        computedOutline: null,
        computedOutlineStyle: null,
        computedOutlineWidth: null,
        computedOutlineColor: null,
        outlineGround: null,
        matchesFocusVisible: false,
      };
    }

    // Composite opaque ground under the outline. outline-offset is -2px so the
    // ring paints over the card's own surface (not the page behind it).
    function parse(color) {
      if (!color || color === "transparent") return [0, 0, 0, 0];
      const m = color.match(
        /rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)/,
      );
      if (!m) return null;
      return [
        Number(m[1]),
        Number(m[2]),
        Number(m[3]),
        m[4] !== undefined ? Number(m[4]) : 1,
      ];
    }
    function compositeBg(node) {
      let r = 11,
        g = 13,
        b = 15; // --ground fallback
      const stack = [];
      let cur = node;
      while (cur && cur !== document.documentElement) {
        const bgCs = getComputedStyle(cur);
        const bg = parse(bgCs.backgroundColor);
        if (bg && bg[3] > 0.99) {
          stack.push(bg);
          break;
        }
        if (bg && bg[3] > 0) stack.push(bg);
        cur = cur.parentElement;
      }
      for (let i = stack.length - 1; i >= 0; i--) {
        const [cr, cg, cb, a] = stack[i];
        r = cr * a + r * (1 - a);
        g = cg * a + g * (1 - a);
        b = cb * a + b * (1 - a);
      }
      return [Math.round(r), Math.round(g), Math.round(b)];
    }

    const cs = getComputedStyle(el);
    const ground = compositeBg(el);
    return {
      viaTab: true,
      focusedInteractive: true,
      activeTag: el.tagName.toLowerCase(),
      activeClass: el.className,
      computedOutline: cs.outline,
      computedOutlineStyle: cs.outlineStyle,
      computedOutlineWidth: cs.outlineWidth,
      computedOutlineColor: cs.outlineColor,
      outlineGround: `rgb(${ground[0]}, ${ground[1]}, ${ground[2]})`,
      outlineGroundRgb: ground,
      matchesFocusVisible: el.matches(":focus-visible"),
    };
  });

  await page.evaluate(() => {
    document.getElementById("pc-verify-focus-probe")?.remove();
  });

  // Shape: style present + non-zero width (pre-#373 renderedOk).
  const shapeOk =
    rendered.viaTab &&
    rendered.focusedInteractive &&
    rendered.computedOutlineStyle != null &&
    rendered.computedOutlineStyle !== "none" &&
    parseFloat(rendered.computedOutlineWidth) > 0;

  // Visibility (#373): alpha > 0 and ≥ 3:1 contrast vs the ground the outline
  // paints over (WCAG non-text indicator). Reuse Node-side contrast helpers.
  const outlineRgba = parseCssColor(rendered.computedOutlineColor);
  const outlineAlpha = outlineRgba ? outlineRgba[3] : null;
  const outlineAlphaOk = outlineAlpha != null && outlineAlpha > 0;
  /** @type {number | null} */
  let outlineContrastRatio = null;
  let outlineContrastOk = false;
  if (outlineAlphaOk && outlineRgba && Array.isArray(rendered.outlineGroundRgb)) {
    outlineContrastRatio =
      Math.round(
        contrastRatio(
          [outlineRgba[0], outlineRgba[1], outlineRgba[2]],
          rendered.outlineGroundRgb,
        ) * 100,
      ) / 100;
    outlineContrastOk = outlineContrastRatio >= 3;
  }
  const outlineVisible = Boolean(outlineAlphaOk && outlineContrastOk);

  const renderedOk = Boolean(shapeOk && outlineVisible);

  return {
    found: true,
    ok: Boolean(rulePart.ruleOk && renderedOk),
    viaTab: Boolean(rendered.viaTab && rendered.focusedInteractive),
    ruleOutline: rulePart.ruleOutline,
    ruleOffset: rulePart.ruleOffset,
    ringColor: rulePart.ringColor,
    ringWidth: rulePart.ringWidth,
    ruleOk: rulePart.ruleOk,
    renderedOk,
    matchesFocusVisible: rendered.matchesFocusVisible,
    computedOutline: rendered.computedOutline,
    computedOutlineStyle: rendered.computedOutlineStyle,
    computedOutlineWidth: rendered.computedOutlineWidth,
    computedOutlineColor: rendered.computedOutlineColor,
    outlineGround: rendered.outlineGround,
    outlineAlpha,
    outlineAlphaOk,
    outlineContrastRatio,
    outlineContrastOk,
    outlineVisible,
    activeTag: rendered.activeTag,
  };
}

/**
 * Inject sample nodes for styles not present on the live rails (burn axis).
 * Live attention + hose are preferred when staged data exists.
 * @param {import('playwright-core').Page} page
 */
async function injectContrastSamples(page) {
  await page.evaluate(() => {
    const host = document.createElement("div");
    host.id = "pc-verify-contrast-samples";
    host.setAttribute("aria-hidden", "true");
    host.style.cssText =
      "position:fixed;left:-9999px;top:0;width:320px;pointer-events:none;";
    host.innerHTML = `
      <article class="pc-attn pc-attn--card pc-attn--awaiting_answer">
        <div class="pc-attn__head">
          <span class="pc-chip pc-chip--awaiting_answer"><span class="pc-chip__label">AWAITING</span></span>
          <span class="pc-attn__age">12m</span>
        </div>
        <div class="pc-attn__title">sample-ask</div>
        <div class="pc-attn__reason">Why did this fail?</div>
        <div class="pc-attn__meta">feat/x · fake</div>
      </article>
      <div class="pc-rail-hose">
        <div class="pc-rail-hose__line">
          <span class="pc-rail-hose__time">12:00:00</span>
          <span class="pc-rail-hose__text pc-rail-hose__text--running">task.started sample</span>
        </div>
      </div>
      <div class="pc-rail-burn__totals"><span>in 1.2k</span></div>
      <div class="pc-rail-burn__axis"><span>1.2k</span></div>
    `;
    document.body.appendChild(host);
  });
}

/**
 * @param {import('playwright-core').Page} page
 */
async function measureRailContrast(page) {
  await injectContrastSamples(page);
  const targets = [
    { id: "rail-section-title", selector: ".pc-rail-section__title" },
    { id: "rail-section-meta", selector: ".pc-rail-section__meta" },
    { id: "rail-chip-label", selector: ".pc-rail-chip__label" },
    { id: "rail-chip-count", selector: ".pc-rail-chip__count" },
    { id: "rail-burn-bound", selector: ".pc-rail-burn__bound" },
    {
      id: "rail-burn-totals",
      selector: "#pc-verify-contrast-samples .pc-rail-burn__totals span",
    },
    {
      id: "rail-burn-axis",
      selector: "#pc-verify-contrast-samples .pc-rail-burn__axis span",
    },
    // Live hose time on the right rail (populated) — this is the AA gate that
    // empty demos previously missed.
    {
      id: "rail-hose-time-live",
      selector: '[data-testid="rail-firehose"] .pc-rail-hose__time',
    },
    {
      id: "rail-hose-text-live",
      selector: '[data-testid="rail-firehose"] .pc-rail-hose__text',
    },
    {
      id: "rail-hose-time",
      selector: "#pc-verify-contrast-samples .pc-rail-hose__time",
    },
    {
      id: "rail-hose-text",
      selector: "#pc-verify-contrast-samples .pc-rail-hose__text",
    },
    {
      id: "attn-age-live",
      selector: '[data-testid="rail-attention"] .pc-attn__age',
    },
    {
      id: "attn-reason-live",
      selector: '[data-testid="rail-attention"] .pc-attn__reason',
    },
    {
      id: "attn-meta-live",
      selector: '[data-testid="rail-attention"] .pc-attn__meta',
    },
    {
      id: "attn-age",
      selector: "#pc-verify-contrast-samples .pc-attn__age",
    },
    {
      id: "attn-reason",
      selector: "#pc-verify-contrast-samples .pc-attn__reason",
    },
    {
      id: "attn-meta",
      selector: "#pc-verify-contrast-samples .pc-attn__meta",
    },
    { id: "panel-title", selector: ".pc-rail-attention .pc-panel__title" },
    { id: "panel-meta", selector: ".pc-rail-attention .pc-panel__meta" },
    { id: "density-btn", selector: ".pc-rail-density__btn" },
    { id: "rail-honesty", selector: ".pc-rail-honesty" },
    { id: "panel-honesty", selector: ".pc-panel__honesty-msg" },
  ];
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const t of targets) {
    const m = await measureContrast(page, t.selector);
    if (m && m.found && m.fontSize) {
      m.fontSizePx = parseFloat(m.fontSize);
    }
    out[t.id] = m;
  }

  // Worst-case ground for hose-time ink: panel --surface (not the hose well).
  // Live sample preferred; inject sample is the fallback when rail is empty.
  const hoseLive = /** @type {{ found?: boolean, color?: string }} */ (
    out["rail-hose-time-live"]
  );
  const hoseSample = /** @type {{ found?: boolean, color?: string }} */ (
    out["rail-hose-time"]
  );
  const hoseInk =
    (hoseLive?.found && hoseLive.color) ||
    (hoseSample?.found && hoseSample.color) ||
    null;
  const tokens = readTokenHexMap();
  out["rail-hose-time-vs-surface"] = hoseInk
    ? {
        ...measureInkVsTokenGround(hoseInk, "--surface", tokens),
        source: hoseLive?.found && hoseLive.color ? "live" : "sample",
      }
    : { found: false, reason: "no hose-time ink sample" };

  await page.evaluate(() => {
    document.getElementById("pc-verify-contrast-samples")?.remove();
  });
  return out;
}

/**
 * Wait until the right rail has attention cards (and optionally hose lines).
 * @param {import('playwright-core').Page} page
 * @param {{ hose?: boolean, timeoutMs?: number }} [opts]
 */
async function waitForPopulatedRails(page, opts = {}) {
  const { hose = true, timeoutMs = 45_000 } = opts;
  await page.waitForFunction(
    ({ needHose }) => {
      const cards = document.querySelectorAll(
        '[data-testid="rail-attention"] .pc-attn',
      );
      if (cards.length < 1) return false;
      if (!needHose) return true;
      const hoseLines = document.querySelectorAll(
        '[data-testid="rail-firehose"] .pc-rail-hose__line',
      );
      return hoseLines.length >= 1;
    },
    { needHose: hose },
    { timeout: timeoutMs },
  );
}

/**
 * Stage mixed task states (awaiting / failed / running).
 * @param {Awaited<ReturnType<typeof openVerifySession>>} session
 */
async function stageRailFixtures(session) {
  const awaiting = await session.daemon.stageScript("awaiting-answer");
  await session.daemon.waitTask(awaiting.taskId);
  const failed = await session.daemon.stageScript("vendor-failure");
  await session.daemon.waitTask(failed.taskId);
  const running = await session.daemon.stageScript("long-running");
  return {
    awaitingTaskId: awaiting.taskId,
    failedTaskId: failed.taskId,
    runningTaskId: running.taskId,
  };
}

/**
 * After a full page reload the firehose re-seeds silently. Stage one more
 * terminal task so it arrives post-bootstrap and emits a hose line.
 * @param {Awaited<ReturnType<typeof openVerifySession>>} session
 */
async function pokeFirehose(session) {
  const poke = await session.daemon.stageScript("vendor-failure", {
    prompt: "verify harness: firehose poke",
  });
  await session.daemon.waitTask(poke.taskId);
  return poke.taskId;
}

export async function runConsoleRailsDemo() {
  const session = await openVerifySession();
  const { shotsDir } = ledgerDirs(TICKET);
  try {
    // Stage fixtures first (daemon has mixed states before any page load).
    const staged = await stageRailFixtures(session);

    // Viewport walk (each goto reloads; attention cards rehydrate from daemon).
    const viewports = await measureAtViewports(session.page, {
      url: session.url,
      shotDir: shotsDir,
      shotPrefix: DEMO,
      targets: RAIL_SELECTORS,
      beforeMeasure: async () => {
        await session.page.waitForSelector(
          '[data-testid="rail-right-content"]',
          { timeout: 15_000 },
        );
        await waitForPopulatedRails(session.page, {
          hose: false,
          timeoutMs: 25_000,
        }).catch(() => undefined);
      },
    });

    // Headline proofs at 1280: reload settles fonts, then poke firehose so
    // axe + AA measure real populated cards and hose lines (not empty rails).
    await session.page.setViewportSize({ width: 1280, height: 900 });
    await session.page.goto(session.url, { waitUntil: "networkidle" });
    await session.page.waitForSelector('[data-testid="rail-left-content"]', {
      timeout: 15_000,
    });
    await session.page.waitForSelector('[data-testid="rail-right-content"]', {
      timeout: 15_000,
    });
    await session.page.evaluate(() => document.fonts.ready);
    await waitForPopulatedRails(session.page, { hose: false });
    staged.hosePokeTaskId = await pokeFirehose(session);
    await waitForPopulatedRails(session.page, { hose: true });

    const placeholders = await measurePlaceholders(session.page);
    const panels = await measurePanels(session.page);
    const scroll1280 = await measureScrollOwners(session.page);
    const populated = await measurePopulated(session.page);
    const rowsDensity = await measureRowsDensity(session.page);
    const focusRing = await measureFocusRing(session.page);
    const contrast = await measureRailContrast(session.page);
    // Axe after population — catches article+role=button and hose contrast.
    const a11y = await collectA11y(session.page);

    const geometry = await session.page.evaluate(() => {
      const left = document.querySelector('[data-testid="rail-left"]');
      const right = document.querySelector('[data-testid="rail-right"]');
      const shell = document.querySelector('[data-testid="shell"]');
      return {
        railLeftWidth: left?.getBoundingClientRect().width ?? null,
        railRightWidth: right?.getBoundingClientRect().width ?? null,
        shellWidth: shell?.getBoundingClientRect().width ?? null,
      };
    });

    const proof = {
      ticket: TICKET,
      demo: DEMO,
      staged,
      placeholders,
      panels,
      populated,
      rowsDensity,
      focusRing,
      scroll1280,
      contrast,
      geometry,
      viewports,
      a11y,
    };

    writeDemoProof(TICKET, DEMO, proof);
    printRectSummary(DEMO, viewports);

    const contrastSummary = Object.fromEntries(
      Object.entries(contrast).map(([k, v]) => [
        k,
        v && typeof v === "object"
          ? {
              found: /** @type {{found?:boolean}} */ (v).found,
              fontSizePx: /** @type {{fontSizePx?:number}} */ (v).fontSizePx,
              ratio: /** @type {{ratio?:number}} */ (v).ratio,
              wcagAA: /** @type {{wcagAA?:boolean}} */ (v).wcagAA,
              text: /** @type {{text?:string}} */ (v).text,
              fg: /** @type {{fg?:string}} */ (v).fg,
              bg: /** @type {{bg?:string}} */ (v).bg,
            }
          : v,
      ]),
    );

    console.log(
      JSON.stringify(
        {
          staged: proof.staged,
          placeholders,
          panels,
          populated,
          rowsDensity,
          focusRing,
          scroll1280: {
            noBoardHScroll: scroll1280.noBoardHScroll,
            railsInternalOk: scroll1280.railsInternalOk,
            left: scroll1280.left,
            right: scroll1280.right,
          },
          geometry,
          contrastSummary,
          axeViolations: (a11y.axe?.violations ?? []).map((v) => v.id),
        },
        null,
        2,
      ),
    );

    // Self-gate so `verify:rails` fails on proof regressions without needing
    // the full verify:check suite (neuter evidence for #369).
    const ledger = readLedger(TICKET);
    if (!ledger) throw new Error("console-rails: ledger missing after write");
    consoleRailsGates({}, ledger);

    return proof;
  } finally {
    await session.close();
  }
}

// CLI
const isMain =
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  runConsoleRailsDemo()
    .then(() => {
      console.log("console-rails: ok");
    })
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    });
}
