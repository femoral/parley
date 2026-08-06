/**
 * Issue #359 — Console v1 acceptance gate.
 *
 * Wave-4 acceptance demo on top of per-screen ledgers (#353–#358):
 *   - Stage a multi-task daemon (fake-vendor scripts) → populated fleet
 *   - Drive all four screens + chrome at 1280 / 1460 / 1920
 *   - axe + ariaSnapshot + keyboard walk per screen (populated)
 *   - Spot-check empty/error treatments already gated by per-screen demos
 *     (consolidates their a11y + honesty into this ticket's ledger)
 *   - Record measured rects + screenshots under verify/ledger/issue-359/
 *
 * Not registered in DEMO_REGISTRY (those stay per-screen tickets). Run via:
 *   pnpm --filter @useparley/dashboard verify:acceptance
 * or as part of the acceptance record workflow for #359.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { collectA11y, runAxe, ariaSnapshot, keyboardWalk } from "../lib/a11y.mjs";
import { measureChromeContrast } from "../lib/contrast.mjs";
import {
  ledgerDirs,
  writeDemoProof,
  printRectSummary,
  readLedger,
} from "../lib/ledger.mjs";
import {
  measureAtViewports,
  DEFAULT_SELECTORS,
} from "../lib/measure.mjs";
import { relFromRepo } from "../lib/paths.mjs";
import { openVerifySession } from "../lib/session.mjs";

const TICKET = "issue-359";
const DEMO = "acceptance-sweep";

const SCREENS = [
  {
    id: "fleet",
    hash: "#/fleet",
    ready: '[data-testid="fleet-board"]',
    measure: [
      { id: "fleet-board", selector: '[data-testid="fleet-board"]' },
      { id: "fleet-kpis", selector: '[data-testid="fleet-kpis"]' },
    ],
  },
  {
    id: "run",
    hash: "#/run",
    ready: '[data-testid="screen-run"]',
    measure: [{ id: "screen-run", selector: '[data-testid="screen-run"]' }],
  },
  {
    id: "task",
    hash: "#/task",
    ready: '[data-testid="screen-task"]',
    measure: [{ id: "screen-task", selector: '[data-testid="screen-task"]' }],
  },
  {
    id: "metrics",
    hash: "#/metrics",
    ready: '[data-testid="screen-metrics"]',
    measure: [
      { id: "screen-metrics", selector: '[data-testid="screen-metrics"]' },
    ],
  },
];

/**
 * Compact axe summary for the consolidated a11y table.
 * @param {object | undefined | null} axe
 */
function axeSummary(axe) {
  if (!axe || typeof axe !== "object") return { present: false };
  // Accept either a full axe report or an already-compact summary.
  if (typeof axe.violations === "number" && axe.present === true) {
    return /** @type {{ present: true, violations: number, ids?: string[], passes?: number, incomplete?: number }} */ (
      axe
    );
  }
  if (!Array.isArray(axe.violations) && axe.violations !== undefined) {
    // Not an axe-shaped object (e.g. bare honesty state).
    if (!("passes" in axe) && !("incomplete" in axe) && !("id" in axe)) {
      return { present: false };
    }
  }
  const violations = Array.isArray(axe.violations) ? axe.violations : [];
  return {
    present: true,
    violations: violations.length,
    ids: violations.map((v) => (typeof v === "string" ? v : v.id)).filter(Boolean),
    passes: axe.passes,
    incomplete: axe.incomplete,
  };
}

/**
 * keyboardWalk has two historical ledger shapes:
 *   1. Object `{ leftBody, path, focusableCount, ... }` (current collectA11y)
 *   2. Array of path steps — either strings (`"button#nav-fleet[tab]"`, `"body"`)
 *      or objects `{ tag, key, ... }` (older fleet-board demos)
 * @param {unknown} kw
 * @returns {boolean | null}
 */
function keyboardLeftBody(kw) {
  if (kw == null) return null;
  if (typeof kw === "object" && !Array.isArray(kw)) {
    const obj = /** @type {Record<string, unknown>} */ (kw);
    if (typeof obj.leftBody === "boolean") return obj.leftBody;
    if (Array.isArray(obj.path)) {
      const fromPath = keyboardLeftBody(obj.path);
      if (fromPath !== null) return fromPath;
    }
    return null;
  }
  if (!Array.isArray(kw) || kw.length === 0) return null;
  return kw.some((step) => {
    if (typeof step === "string") {
      const s = step.trim().toLowerCase();
      if (s === "" || s === "body" || s === "html") return false;
      // Path tokens like "a#skip-main" / "button#nav-fleet[tab]" left body.
      return true;
    }
    if (step && typeof step === "object") {
      const tag = String(/** @type {{ tag?: string }} */ (step).tag ?? "").toLowerCase();
      return tag !== "" && tag !== "body" && tag !== "html";
    }
    return false;
  });
}

/**
 * Best-effort violation count for a demo entry (top-level a11y, a11yByState, or
 * find-honesty-style state map with nested axe if present).
 * @param {object} demo
 * @returns {{ violations: number | null, axePresent: boolean, keyboardLeftBody: boolean | null }}
 */
function demoA11yRollup(demo) {
  const a11y = demo.a11y ?? null;
  const byState = demo.a11yByState ?? null;
  const states = demo.states ?? null;

  /** @type {object | null} */
  let axe = null;
  if (a11y?.axe) axe = a11y.axe;
  else if (a11y && Array.isArray(a11y.violations)) axe = a11y;

  let violations = null;
  let axePresent = false;
  const top = axeSummary(axe);
  if (top.present) {
    axePresent = true;
    violations = top.violations ?? 0;
  }

  if (byState && typeof byState === "object") {
    let sum = 0;
    let any = false;
    for (const v of Object.values(byState)) {
      const block = /** @type {{ axe?: object }} */ (v);
      const s = axeSummary(block?.axe ?? block);
      if (s.present) {
        any = true;
        sum += s.violations ?? 0;
      }
    }
    if (any) {
      axePresent = true;
      // Prefer sum of per-state scans when top-level was missing.
      if (violations === null) violations = sum;
    }
  }

  // Older honesty demos may nest axe under states.<name>.axe (none today for
  // find-honesty — it is ARIA-status only — but parse if present).
  if (states && typeof states === "object" && violations === null) {
    let sum = 0;
    let any = false;
    for (const v of Object.values(states)) {
      if (!v || typeof v !== "object") continue;
      const block = /** @type {{ axe?: object }} */ (v);
      const s = axeSummary(block.axe);
      if (s.present) {
        any = true;
        sum += s.violations ?? 0;
      }
    }
    if (any) {
      axePresent = true;
      violations = sum;
    }
  }

  const kw =
    a11y?.keyboardWalk ??
    (byState
      ? Object.values(byState)
          .map((s) => /** @type {{ keyboardWalk?: unknown }} */ (s)?.keyboardWalk)
          .find((k) => k != null)
      : null) ??
    null;

  return {
    violations,
    axePresent,
    keyboardLeftBody: keyboardLeftBody(kw),
  };
}

/**
 * Pull a11y + honesty state coverage from every prior ticket ledger.
 * This is the SWEEP: re-validate that every screen already proved a11y and
 * honesty states, then surface gaps as explicit notes.
 */
function consolidatePriorLedgers() {
  const tickets = [
    "issue-353",
    "issue-354",
    "issue-355",
    "issue-356",
    "issue-357",
    "issue-358",
  ];
  /** @type {Record<string, object>} */
  const byTicket = {};
  /** @type {Array<object>} */
  const a11yRows = [];

  for (const t of tickets) {
    const ledger = readLedger(t);
    if (!ledger) {
      byTicket[t] = { present: false };
      continue;
    }
    /** @type {Record<string, object>} */
    const demos = {};
    for (const [demoId, demo] of Object.entries(ledger.demos ?? {})) {
      const a11y = demo.a11y ?? null;
      const byState = demo.a11yByState ?? null;
      const honesty = demo.honesty ?? demo.states ?? null;
      const rollup = demoA11yRollup(demo);
      demos[demoId] = {
        kind: demo.kind,
        hasViewports: Array.isArray(demo.viewports) && demo.viewports.length >= 3,
        viewportNames: (demo.viewports ?? []).map((v) => v.name),
        a11y: axeSummary(a11y?.axe ?? (Array.isArray(a11y?.violations) ? a11y : null)),
        keyboardLeftBody: rollup.keyboardLeftBody,
        a11yByState: byState
          ? Object.fromEntries(
              Object.entries(byState).map(([k, v]) => [
                k,
                axeSummary(/** @type {{ axe?: object }} */ (v)?.axe ?? v),
              ]),
            )
          : null,
        honestyKeys: honesty && typeof honesty === "object" ? Object.keys(honesty) : [],
        axePresent: rollup.axePresent,
      };
      a11yRows.push({
        ticket: t,
        demo: demoId,
        violations: rollup.violations,
        axePresent: rollup.axePresent,
        keyboardLeftBody: rollup.keyboardLeftBody,
        // find-honesty: no axe scan in that demo — honesty states only.
        honestyStates:
          demo.states && typeof demo.states === "object"
            ? Object.keys(demo.states)
            : undefined,
      });
    }
    byTicket[t] = { present: true, demos };
  }

  return { byTicket, a11yRows };
}

/**
 * @param {import('playwright-core').Page} page
 * @param {string} url
 * @param {string} readySelector
 */
async function gotoReady(page, url, readySelector) {
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForSelector('[data-testid="shell"]', { timeout: 20_000 });
  await page.waitForSelector(readySelector, { timeout: 20_000 }).catch(() => {
    /* some screens still mount with empty selection — shell is enough */
  });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
}

export async function runAcceptance359Demo() {
  const prior = consolidatePriorLedgers();
  const session = await openVerifySession();
  try {
    // Multi-task populated daemon — mirrors e2e realism at fake-vendor layer.
    const completed = await session.daemon.stageScript("report-success");
    await session.daemon.waitTask(completed.taskId);
    const failed = await session.daemon.stageScript("vendor-failure");
    await session.daemon.waitTask(failed.taskId);
    const awaiting = await session.daemon.stageScript("awaiting-answer");
    await session.daemon.waitTask(awaiting.taskId);
    const running = await session.daemon.stageScript("long-running");

    const listRes = await fetch(`${session.daemon.baseUrl}/tasks`);
    const listBody = /** @type {{ tasks: Array<{ task_id: string, state: string }> }} */ (
      await listRes.json()
    );
    const daemonState = {
      port: session.daemon.port,
      taskCount: listBody.tasks.length,
      states: Object.fromEntries(
        listBody.tasks.map((t) => [t.task_id, t.state]),
      ),
      staged: {
        completed: completed.taskId,
        failed: failed.taskId,
        awaiting: awaiting.taskId,
        running: running.taskId,
      },
    };

    const { shotsDir, dir } = ledgerDirs(TICKET);

    /** @type {Record<string, object>} */
    const screens = {};

    for (const screen of SCREENS) {
      console.log(`[acceptance-359] screen ${screen.id}`);
      const url = `${session.url}${screen.hash}`;
      const targets = [...DEFAULT_SELECTORS, ...screen.measure];

      const viewports = await measureAtViewports(session.page, {
        url,
        shotDir: shotsDir,
        shotPrefix: `acceptance-${screen.id}`,
        targets,
        beforeMeasure: async () => {
          await gotoReady(session.page, url, screen.ready);
        },
      });

      // A11y at mid board width (1460) — composited stack at real density.
      await session.page.setViewportSize({ width: 1460, height: 900 });
      await gotoReady(session.page, url, screen.ready);
      const a11y = await collectA11y(session.page, {
        include: '[data-testid="shell"]',
      });
      // Also axe the screen mount when present.
      let screenAxe = null;
      const screenCount = await session.page.locator(screen.ready).count();
      if (screenCount > 0) {
        screenAxe = await runAxe(session.page, { include: screen.ready });
      }
      const contrast = await measureChromeContrast(session.page).catch(() => null);

      // Keyboard: ensure Tab leaves body on each screen.
      const walk = a11y.keyboardWalk ?? (await keyboardWalk(session.page));

      // Compact a11y for the committed ledger (full trees stay in prior demos).
      const compactA11y = {
        axe: axeSummary(a11y.axe),
        aria: {
          api: a11y.aria?.api,
          selector: a11y.aria?.selector,
          treeBytes: (a11y.aria?.tree ?? "").length,
        },
        keyboardWalk: {
          focusableCount: walk?.focusableCount,
          leftBody: walk?.leftBody === true,
          entered: walk?.entered === true,
          pathSteps: Array.isArray(walk?.path) ? walk.path.length : 0,
        },
        screenAxe: screenAxe ? axeSummary(screenAxe) : null,
      };

      screens[screen.id] = {
        hash: screen.hash,
        viewports,
        a11y: compactA11y,
        keyboardLeftBody: walk?.leftBody === true,
        contrastAaFails: contrast
          ? Object.entries(contrast).filter(
              ([, m]) => m && m.found && m.wcagAA === false,
            ).length
          : null,
        phase: await session.page
          .locator(screen.ready)
          .first()
          .getAttribute("data-phase")
          .catch(() => null),
      };

      if (compactA11y.axe.violations && compactA11y.axe.violations > 0) {
        console.warn(
          `[acceptance-359] axe violations on ${screen.id}: ${compactA11y.axe.ids?.join(", ")}`,
        );
      }
    }

    // Chrome-only rest state at all three widths (header / nav / find / footer).
    const chromeViewports = await measureAtViewports(session.page, {
      url: `${session.url}#/fleet`,
      shotDir: shotsDir,
      shotPrefix: "acceptance-chrome",
      targets: DEFAULT_SELECTORS,
      beforeMeasure: async () => {
        await gotoReady(session.page, `${session.url}#/fleet`, '[data-testid="shell"]');
      },
    });

    // Headline: no board H-scroll at 1280 on fleet (the densest).
    await session.page.setViewportSize({ width: 1280, height: 900 });
    await gotoReady(
      session.page,
      `${session.url}#/fleet`,
      '[data-testid="fleet-board"]',
    );
    const scroll = await session.page.evaluate(() => {
      const shell = document.querySelector('[data-testid="shell"]');
      if (!shell) return { found: false };
      return {
        found: true,
        scrollWidth: shell.scrollWidth,
        clientWidth: shell.clientWidth,
        noHorizontalScroll: shell.scrollWidth <= shell.clientWidth + 1,
      };
    });

    // Spot-check aria snapshots exist for each screen.
    /** @type {Record<string, object>} */
    const ariaByScreen = {};
    for (const screen of SCREENS) {
      await gotoReady(
        session.page,
        `${session.url}${screen.hash}`,
        screen.ready,
      );
      ariaByScreen[screen.id] = await ariaSnapshot(session.page);
    }

    const totalAxeViolations = Object.values(screens).reduce((n, s) => {
      const v = s.a11y?.axe?.violations ?? 0;
      const sv = s.a11y?.screenAxe?.violations ?? 0;
      return n + v + sv;
    }, 0);

    const proof = {
      kind: "acceptance-sweep",
      description:
        "Console v1 acceptance: multi-task fake-vendor daemon, all four screens " +
        "+ chrome measured at 1280/1460/1920, consolidated a11y sweep.",
      daemon: daemonState,
      screens,
      chromeViewports,
      ariaByScreen: Object.fromEntries(
        Object.entries(ariaByScreen).map(([k, v]) => [
          k,
          { selector: v.selector, api: v.api, treeBytes: (v.tree ?? "").length },
        ]),
      ),
      headline: {
        boardScroll1280: scroll,
        totalAxeViolations,
        screensExercised: SCREENS.map((s) => s.id),
        keyboardAllLeftBody: Object.values(screens).every((s) => s.keyboardLeftBody),
      },
      priorLedgers: prior,
    };

    const entryPath = writeDemoProof(TICKET, DEMO, proof);
    printRectSummary(DEMO, chromeViewports);

    // Also write a compact a11y-sweep.json for the human acceptance record.
    const a11ySweep = {
      ticket: TICKET,
      recordedAt: new Date().toISOString(),
      populated: Object.fromEntries(
        Object.entries(screens).map(([id, s]) => [
          id,
          {
            axe: s.a11y?.axe,
            screenAxe: s.a11y?.screenAxe,
            keyboardLeftBody: s.keyboardLeftBody,
            phase: s.phase,
          },
        ]),
      ),
      prior: prior.a11yRows,
      totalAxeViolations,
      allGreen: totalAxeViolations === 0 && proof.headline.keyboardAllLeftBody,
    };
    const a11yPath = path.join(dir, "a11y-sweep.json");
    fs.writeFileSync(a11yPath, `${JSON.stringify(a11ySweep, null, 2)}\n`);

    console.log(`ledger entry: ${entryPath}`);
    console.log(`a11y sweep: ${relFromRepo(a11yPath)}`);
    console.log(
      JSON.stringify(
        {
          taskCount: daemonState.taskCount,
          totalAxeViolations,
          keyboardAllLeftBody: proof.headline.keyboardAllLeftBody,
          noHScroll1280: scroll.noHorizontalScroll,
        },
        null,
        2,
      ),
    );

    if (totalAxeViolations > 0) {
      throw new Error(
        `acceptance-359: ${totalAxeViolations} axe violation(s) across screens — fix one-liners or report structural`,
      );
    }
    if (!proof.headline.keyboardAllLeftBody) {
      throw new Error("acceptance-359: keyboard walk failed to leave body on a screen");
    }
    if (scroll.found && !scroll.noHorizontalScroll) {
      throw new Error("acceptance-359: horizontal scroll at 1280 on fleet board");
    }

    return proof;
  } finally {
    await session.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runAcceptance359Demo().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
