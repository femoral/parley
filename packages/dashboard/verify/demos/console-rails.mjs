/**
 * Issue #363 — shell rails + AttentionCard proofs.
 *
 * - Neither placeholder note string renders
 * - Right rail: attention queue + firehose; fleet center has no firehose
 * - Left rail: scope, state filter, burn
 * - Rails scroll internally; no board H-scroll at 1280
 * - New ≤10px text passes AA against actual grounds
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
  const contrast = demo.contrast ?? {};
  for (const [id, m] of Object.entries(contrast)) {
    if (
      m &&
      m.found &&
      m.fontSizePx != null &&
      m.fontSizePx <= 10 &&
      m.wcagAA === false
    ) {
      throw new Error(
        `console-rails: AA fail ≤10px ${id} ratio=${m.ratio} size=${m.fontSizePx}`,
      );
    }
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
      // Rails own vertical overflow (overflow:auto on .pc-shell__rail)
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
 * Inject sample attention + firehose nodes so ≤10px styles are measurable
 * even on an empty daemon.
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
    { id: "rail-burn-totals", selector: "#pc-verify-contrast-samples .pc-rail-burn__totals span" },
    { id: "rail-burn-axis", selector: "#pc-verify-contrast-samples .pc-rail-burn__axis span" },
    { id: "rail-hose-time", selector: "#pc-verify-contrast-samples .pc-rail-hose__time" },
    { id: "rail-hose-text", selector: "#pc-verify-contrast-samples .pc-rail-hose__text" },
    { id: "attn-age", selector: "#pc-verify-contrast-samples .pc-attn__age" },
    { id: "attn-reason", selector: "#pc-verify-contrast-samples .pc-attn__reason" },
    { id: "attn-meta", selector: "#pc-verify-contrast-samples .pc-attn__meta" },
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

export async function runConsoleRailsDemo() {
  const session = await openVerifySession();
  const { shotsDir } = ledgerDirs(TICKET);
  try {
    await session.page.goto(session.url, { waitUntil: "networkidle" });
    await session.page.waitForSelector('[data-testid="rail-left-content"]', {
      timeout: 15_000,
    });
    await session.page.waitForSelector('[data-testid="rail-right-content"]', {
      timeout: 15_000,
    });
    await session.page.evaluate(() => document.fonts.ready);

    const viewports = await measureAtViewports(session.page, {
      url: session.url,
      shotDir: shotsDir,
      shotPrefix: DEMO,
      targets: RAIL_SELECTORS,
    });

    await session.page.setViewportSize({ width: 1280, height: 900 });
    await session.page.goto(session.url, { waitUntil: "networkidle" });
    await session.page.waitForSelector('[data-testid="rail-left-content"]', {
      timeout: 15_000,
    });
    await session.page.evaluate(() => document.fonts.ready);

    const placeholders = await measurePlaceholders(session.page);
    const panels = await measurePanels(session.page);
    const scroll1280 = await measureScrollOwners(session.page);
    const contrast = await measureRailContrast(session.page);
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
      placeholders,
      panels,
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
            }
          : v,
      ]),
    );

    console.log(
      JSON.stringify(
        {
          placeholders,
          panels,
          scroll1280: {
            noBoardHScroll: scroll1280.noBoardHScroll,
            railsInternalOk: scroll1280.railsInternalOk,
            left: scroll1280.left,
            right: scroll1280.right,
          },
          geometry,
          contrastSummary,
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
