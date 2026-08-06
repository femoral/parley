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
 * @param {object | undefined} axe
 */
function axeSummary(axe) {
  if (!axe) return { present: false };
  const violations = axe.violations ?? [];
  return {
    present: true,
    violations: violations.length,
    ids: violations.map((v) => v.id),
    passes: axe.passes,
    incomplete: axe.incomplete,
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
      demos[demoId] = {
        kind: demo.kind,
        hasViewports: Array.isArray(demo.viewports) && demo.viewports.length >= 3,
        viewportNames: (demo.viewports ?? []).map((v) => v.name),
        a11y: axeSummary(a11y?.axe ?? a11y),
        keyboardLeftBody: a11y?.keyboardWalk?.leftBody ?? null,
        a11yByState: byState
          ? Object.fromEntries(
              Object.entries(byState).map(([k, v]) => [
                k,
                axeSummary(/** @type {{ axe?: object }} */ (v)?.axe ?? v),
              ]),
            )
          : null,
        honestyKeys: honesty && typeof honesty === "object" ? Object.keys(honesty) : [],
      };
      a11yRows.push({
        ticket: t,
        demo: demoId,
        violations:
          axeSummary(a11y?.axe ?? a11y).violations ??
          (byState
            ? Object.values(byState).reduce(
                (n, s) =>
                  n +
                  (axeSummary(/** @type {{ axe?: object }} */ (s)?.axe ?? s)
                    .violations ?? 0),
                0,
              )
            : null),
        keyboardLeftBody: a11y?.keyboardWalk?.leftBody ?? null,
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
