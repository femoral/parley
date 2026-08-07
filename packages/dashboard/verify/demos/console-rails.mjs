/**
 * Issue #363 — shell rails + AttentionCard proofs.
 *
 * - Neither placeholder note string renders
 * - Right rail: attention queue + firehose; fleet center has no firehose
 * - Left rail: scope, state filter, burn
 * - Rails scroll internally; no board H-scroll at 1280
 * - Populated rails: staged tasks so axe + AA see real cards/hose lines
 * - New ≤11px text passes AA against actual grounds
 * - Focus ring on interactive attention cards is a real outline (post-#366 tokens)
 * - Rows density is single-line (~≤32px)
 */
import { pathToFileURL } from "node:url";
import { collectA11y } from "../lib/a11y.mjs";
import { measureContrast } from "../lib/contrast.mjs";
import { ledgerDirs, writeDemoProof, printRectSummary } from "../lib/ledger.mjs";
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

  // Focus affordance: invalid outline (color-as-width) drops to none.
  const focus = demo.focusRing;
  if (!focus?.ok) {
    throw new Error(
      `console-rails: interactive attention focus ring missing/invalid: ${JSON.stringify(focus)}`,
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
 * @param {import('playwright-core').Page} page
 */
async function measureFocusRing(page) {
  return page.evaluate(() => {
    const el = document.querySelector(
      '[data-testid="rail-attention"] .pc-attn--interactive',
    );
    if (!el) return { found: false, ok: false, reason: "no interactive card" };
    el.focus();
    // :focus-visible may require keyboard modality; force the class path via
    // computed style of the focus-visible rule by matching :focus and reading
    // the declared outline from the stylesheet when :focus-visible doesn't fire
    // under Playwright focus(). Fall back to temporary class probe.
    el.classList.add("pc-attn--interactive");
    const cs = getComputedStyle(el);
    // Trigger focus-visible where supported.
    el.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", bubbles: true }),
    );
    el.focus();
    const after = getComputedStyle(el);
    // Read the rule directly from CSSOM so we don't depend on :focus-visible
    // matching under automation.
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
          ruleOutline = rule.style.outline || rule.style.getPropertyValue("outline");
          ruleOffset =
            rule.style.outlineOffset ||
            rule.style.getPropertyValue("outline-offset");
        }
      }
    }
    // Also apply the expected outline inline-check: parse tokens.
    const root = getComputedStyle(document.documentElement);
    const ringColor = root.getPropertyValue("--focus-ring").trim();
    const ringWidth = root.getPropertyValue("--focus-ring-width").trim();
    // Valid rule uses width token + color token (not color-as-width).
    const outlineOk =
      ruleOutline != null &&
      /var\(--focus-ring-width\)/.test(ruleOutline) &&
      /var\(--focus-ring\)/.test(ruleOutline) &&
      !/var\(--link\)/.test(ruleOutline);
    // Color token must actually be a color, not a length.
    const colorIsColor =
      ringColor.startsWith("#") ||
      ringColor.startsWith("rgb") ||
      ringColor.startsWith("hsl");
    const widthIsLength = /^\d/.test(ringWidth);

    return {
      found: true,
      ok: outlineOk && colorIsColor && widthIsLength,
      ruleOutline,
      ruleOffset,
      ringColor,
      ringWidth,
      computedOutline: after.outline,
      computedOutlineStyle: after.outlineStyle,
      computedOutlineWidth: after.outlineWidth,
      focusOutlineStyle: cs.outlineStyle,
    };
  });
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
