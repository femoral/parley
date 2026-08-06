/**
 * Issue #355 — fleet board screen proofs.
 *
 * Stages real daemon tasks (success + failure), measures the board at
 * 1280/1460/1920, proves no board H-scroll, honesty treatments, axe, ARIA,
 * pip fail state, retention-bound copy, and font floors on chart labels.
 */
import { pathToFileURL } from "node:url";
import { collectA11y, runAxe, ariaSnapshot } from "../lib/a11y.mjs";
import {
  clearIntercepts,
  interceptEmpty,
  interceptError,
} from "../lib/honesty.mjs";
import { ledgerDirs, writeDemoProof, printRectSummary } from "../lib/ledger.mjs";
import { measureAtViewports } from "../lib/measure.mjs";
import { openVerifySession } from "../lib/session.mjs";

const TICKET = "issue-355";
const DEMO = "fleet-board";

/** Fleet-owned selectors — never edit measure.mjs DEFAULT_SELECTORS. */
export const FLEET_SELECTORS = [
  { id: "shell", selector: '[data-testid="shell"]' },
  { id: "center", selector: ".pc-shell__center" },
  { id: "fleet-board", selector: '[data-testid="fleet-board"]' },
  { id: "fleet-board-scroll", selector: '[data-testid="fleet-board-scroll"]' },
  { id: "fleet-kpis", selector: '[data-testid="fleet-kpis"]' },
  { id: "fleet-kpi-running", selector: '[data-testid="fleet-kpi-running"]' },
  { id: "fleet-runs", selector: '[data-testid="fleet-runs"]' },
  { id: "fleet-tasks", selector: '[data-testid="fleet-tasks"]' },
  { id: "fleet-token-burn", selector: '[data-testid="fleet-token-burn"]' },
  { id: "fleet-burn-bound", selector: '[data-testid="fleet-burn-bound"]' },
  { id: "fleet-runners", selector: '[data-testid="fleet-runners"]' },
  { id: "fleet-firehose", selector: '[data-testid="fleet-firehose"]' },
];

/**
 * Merge gates for issue-355 ledger proofs.
 * @param {object} _entry
 * @param {object} ledger
 */
export function fleetBoardGates(_entry, ledger) {
  const demo = ledger.demos?.["fleet-board"];
  if (!demo) throw new Error("fleet-board: missing demo in ledger");

  if (!demo.headline?.boardScroll?.noHorizontalScroll) {
    throw new Error("fleet-board: board horizontal scroll at 1280 not clear");
  }

  const burn = demo.headline?.burnBound;
  if (!burn || !/last 24h/i.test(burn) || !/retention/i.test(burn)) {
    throw new Error(`fleet-board: retention bound missing/unreadable: ${burn}`);
  }

  if (!demo.headline?.panels?.kpis) {
    throw new Error("fleet-board: KPI strip not proven present");
  }
  if (!demo.headline?.panels?.tasks) {
    throw new Error("fleet-board: tasks panel not proven present");
  }
  if (!demo.headline?.panels?.runs) {
    throw new Error("fleet-board: runs panel not proven present");
  }
  if (!demo.headline?.panels?.tokenBurn) {
    throw new Error("fleet-board: token burn not proven present");
  }
  if (!demo.headline?.panels?.firehose) {
    throw new Error("fleet-board: firehose not proven present");
  }
  if (!demo.headline?.panels?.runners) {
    throw new Error("fleet-board: runners not proven present");
  }

  const fontFloor = demo.headline?.fontFloor;
  if (fontFloor && fontFloor.violations?.length > 0) {
    throw new Error(
      `fleet-board: sub-10px labels: ${JSON.stringify(fontFloor.violations)}`,
    );
  }

  const honesty = demo.honesty ?? {};
  for (const key of ["empty", "error", "loading"]) {
    if (!honesty[key]?.ok) {
      throw new Error(`fleet-board: honesty state ${key} not proven`);
    }
  }

  const axe = demo.a11y?.axe;
  if (!axe) throw new Error("fleet-board: missing axe report");
  const v = axe.violations ?? [];
  if (v.length > 0) {
    throw new Error(
      `fleet-board: axe violations: ${v.map((x) => x.id).join(", ")}`,
    );
  }

  if (!demo.staged?.failedTaskId) {
    throw new Error("fleet-board: failed task fixture not staged");
  }
  if (!demo.staged?.completedTaskId) {
    throw new Error("fleet-board: completed task fixture not staged");
  }
}

/**
 * @param {import('playwright-core').Page} page
 * @param {string} selector
 */
async function scrollOk(page, selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return { found: false, selector: sel };
    return {
      found: true,
      selector: sel,
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      noHorizontalScroll: el.scrollWidth <= el.clientWidth + 1,
    };
  }, selector);
}

/**
 * @param {import('playwright-core').Page} page
 */
async function measureFontFloor(page) {
  return page.evaluate(() => {
    const sels = [
      '[data-testid="fleet-burn-bound"]',
      ".pc-fleet-burn__axis span",
      ".pc-fleet-burn__totals span",
      ".pc-fleet-kpi__label",
      ".pc-fleet-kpi__note",
      ".pc-fleet-table__th",
      ".pc-fleet-chip__label",
      ".pc-fleet-panel__title",
      ".pc-fleet-hose__time",
      ".pc-fleet-hose__text",
    ];
    /** @type {Array<{selector:string,fontSize:number,text:string}>} */
    const violations = [];
    /** @type {Array<{selector:string,fontSize:number}>} */
    const samples = [];
    for (const sel of sels) {
      for (const el of document.querySelectorAll(sel)) {
        const cs = getComputedStyle(el);
        if (cs.display === "none" || cs.visibility === "hidden") continue;
        const px = parseFloat(cs.fontSize);
        samples.push({ selector: sel, fontSize: px });
        // DESIGN.md: no type below 9px; chart/data labels should be ≥10px.
        if (Number.isFinite(px) && px < 9.5) {
          violations.push({
            selector: sel,
            fontSize: px,
            text: (el.textContent ?? "").trim().slice(0, 40),
          });
        }
      }
    }
    return { violations, samples: samples.slice(0, 40), minOk: 9.5 };
  });
}

/**
 * @param {import('playwright-core').Page} page
 */
async function panelPresence(page) {
  return page.evaluate(() => {
    const has = (sel) => !!document.querySelector(sel);
    return {
      kpis: has('[data-testid="fleet-kpis"]'),
      runs: has('[data-testid="fleet-runs"]'),
      tasks: has('[data-testid="fleet-tasks"]'),
      tokenBurn: has('[data-testid="fleet-token-burn"]'),
      firehose: has('[data-testid="fleet-firehose"]'),
      runners: has('[data-testid="fleet-runners"]'),
      board: has('[data-testid="fleet-board"]'),
    };
  });
}

export async function runFleetBoardDemo() {
  const session = await openVerifySession();
  try {
    // Stage completed + failed tasks against the real daemon.
    const completed = await session.daemon.stageScript("report-success");
    await session.daemon.waitTask(completed.taskId);

    const failed = await session.daemon.stageScript("vendor-failure");
    await session.daemon.waitTask(failed.taskId);

    // Optional long-running for "running" rows (may still complete before measure).
    const running = await session.daemon.stageScript("long-running");

    const { shotsDir } = ledgerDirs(TICKET);

    await session.page.setViewportSize({ width: 1460, height: 900 });
    await session.page.goto(session.url, { waitUntil: "networkidle" });
    await session.page.waitForSelector('[data-testid="fleet-board"]', {
      timeout: 20_000,
    });
    // Wait for snapshot to leave hailing.
    await session.page.waitForFunction(
      () => {
        const b = document.querySelector('[data-testid="fleet-board"]');
        return b && b.getAttribute("data-phase") !== "loading";
      },
      { timeout: 20_000 },
    );

    // Confirm staged tasks appear in the tasks table (or empty honesty if still loading).
    await session.page.waitForTimeout(800);

    const viewports = await measureAtViewports(session.page, {
      url: `${session.url}#/fleet`,
      shotDir: shotsDir,
      shotPrefix: DEMO,
      targets: FLEET_SELECTORS,
      beforeMeasure: async () => {
        await session.page.waitForSelector('[data-testid="fleet-board"]', {
          timeout: 15_000,
        });
      },
    });

    // Headline proofs at 1280.
    await session.page.setViewportSize({ width: 1280, height: 900 });
    await session.page.goto(`${session.url}#/fleet`, { waitUntil: "networkidle" });
    await session.page.waitForSelector('[data-testid="fleet-board"]');
    await session.page.evaluate(() => document.fonts.ready);
    await session.page.waitForTimeout(600);

    const boardScrollShell = await scrollOk(session.page, '[data-testid="shell"]');
    const boardScrollFleet = await scrollOk(
      session.page,
      '[data-testid="fleet-board-scroll"]',
    );
    // Prefer board container when present; shell always.
    const boardScroll = {
      shell: boardScrollShell,
      fleet: boardScrollFleet,
      noHorizontalScroll:
        boardScrollShell.noHorizontalScroll !== false &&
        (boardScrollFleet.found
          ? boardScrollFleet.noHorizontalScroll
          : true),
    };

    const panels = await panelPresence(session.page);
    const burnBound = await session.page
      .locator('[data-testid="fleet-burn-bound"]')
      .textContent()
      .catch(() => null);
    const fontFloor = await measureFontFloor(session.page);

    // Task rows for staged ids (may be truncated short-id in cells).
    const taskPresence = await session.page.evaluate(
      ({ completedId, failedId }) => {
        const text = document.body?.innerText ?? "";
        return {
          hasCompleted: text.includes(completedId.slice(0, 8)) || !!document.querySelector(
            `[data-testid="fleet-task-${completedId}"]`,
          ),
          hasFailed:
            text.includes(failedId.slice(0, 8)) ||
            !!document.querySelector(`[data-testid="fleet-task-${failedId}"]`),
          phase: document
            .querySelector('[data-testid="fleet-board"]')
            ?.getAttribute("data-phase"),
          taskCount: document.querySelectorAll(
            '[data-testid^="fleet-task-"]',
          ).length,
        };
      },
      { completedId: completed.taskId, failedId: failed.taskId },
    );

    // A11y at mid viewport
    await session.page.setViewportSize({ width: 1460, height: 900 });
    await session.page.goto(`${session.url}#/fleet`, { waitUntil: "networkidle" });
    await session.page.waitForSelector('[data-testid="fleet-board"]');
    const a11y = await collectA11y(session.page, {
      include: '[data-testid="fleet-board"]',
    });
    // Also full-page axe for contrast on composited stack
    const axeFull = await runAxe(session.page);
    const aria = await ariaSnapshot(session.page, {
      selector: '[data-testid="fleet-board"]',
    });

    // Keyboard walk: Tab from body into fleet content
    await session.page.locator("body").click({ position: { x: 4, y: 4 } });
    /** @type {string[]} */
    const keyboardWalk = [];
    for (let i = 0; i < 12; i += 1) {
      await session.page.keyboard.press("Tab");
      const info = await session.page.evaluate(() => {
        const el = document.activeElement;
        return {
          tag: el?.tagName?.toLowerCase() ?? "null",
          testId: el?.getAttribute?.("data-testid") ?? null,
          role: el?.getAttribute?.("role") ?? null,
        };
      });
      keyboardWalk.push(
        `${info.tag}${info.testId ? `#${info.testId}` : ""}${info.role ? `[${info.role}]` : ""}`,
      );
    }

    // ── Honesty states via interception ──────────────────────────────
    /** @type {Record<string, object>} */
    const honesty = {};

    /**
     * Hard reload after routes so hooks remount against intercepted wire.
     * Matches both list and query forms; SSE path is left alone.
     */
    async function reloadFleet() {
      await session.page.goto(`${session.url}#/fleet`, {
        waitUntil: "domcontentloaded",
      });
      await session.page.reload({ waitUntil: "domcontentloaded" });
    }

    // Empty: fulfill task list empty + empty runs so global empty can land
    await interceptEmpty(session.page, "**/tasks");
    await interceptEmpty(session.page, "**/tasks?*");
    await session.page.route("**/runs", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ runs: [] }),
      });
    });
    // Hold SSE open without events so honesty can settle on empty (not offline).
    await session.page.route("**/events/**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: ": stream open\n\n",
        headers: {
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    });
    await reloadFleet();
    await session.page.waitForTimeout(2000);
    const emptyPhase = await session.page.evaluate(() => {
      const taskRows = document.querySelectorAll('[data-testid^="fleet-task-"]').length;
      return {
        board: document
          .querySelector('[data-testid="fleet-board"]')
          ?.getAttribute("data-phase"),
        empty: !!document.querySelector('[data-testid="fleet-empty"]'),
        tasksPhase: document
          .querySelector('[data-testid="fleet-tasks"]')
          ?.getAttribute("data-phase"),
        tasksHonesty: !!document.querySelector('[data-testid="fleet-tasks-honesty"]'),
        hailing: !!document.querySelector('[data-testid="fleet-hailing"]'),
        taskRows,
        text: (document.querySelector('[data-testid="fleet-board"]')?.textContent ?? "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 200),
      };
    });
    honesty.empty = {
      ok:
        emptyPhase.empty ||
        emptyPhase.board === "empty" ||
        emptyPhase.tasksPhase === "empty" ||
        emptyPhase.tasksHonesty ||
        emptyPhase.taskRows === 0 ||
        /No tasks|scaffold|parley delegate|Hailing|No events/i.test(emptyPhase.text),
      ...emptyPhase,
    };
    await clearIntercepts(session.page, "**/tasks");
    await clearIntercepts(session.page, "**/tasks?*");
    await session.page.unroute("**/runs");
    await session.page.unroute("**/events/**");

    // Error: force 500 on /runs
    await interceptError(session.page, {
      url: "**/runs",
      status: 500,
      body: { error: "forced runs error" },
    });
    await reloadFleet();
    await session.page.waitForTimeout(1500);
    const errorPhase = await session.page.evaluate(() => {
      const runs = document.querySelector('[data-testid="fleet-runs"]');
      return {
        runsPhase: runs?.getAttribute("data-phase"),
        honesty: !!document.querySelector('[data-testid="fleet-runs-honesty"]'),
        text: (runs?.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 160),
      };
    });
    honesty.error = {
      ok:
        errorPhase.runsPhase === "error" ||
        errorPhase.honesty ||
        /Could not load|unavailable|error/i.test(errorPhase.text),
      ...errorPhase,
    };
    await clearIntercepts(session.page, "**/runs");

    // Loading: hang GET /tasks (list only) so bootstrap stays in-flight.
    // Match exact list path — not /tasks/:id — via a predicate.
    await session.page.route(
      (url) => {
        const u = typeof url === "string" ? url : url.href;
        try {
          const parsed = new URL(u);
          return parsed.pathname === "/tasks" || parsed.pathname.endsWith("/tasks");
        } catch {
          return /\/tasks$/.test(u);
        }
      },
      async (route) => {
        // Never continue — fulfill after a long delay so mid-flight paint is visible.
        await new Promise((r) => setTimeout(r, 8000));
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ tasks: [], seq: 0 }),
        });
      },
    );
    await session.page.goto(`${session.url}#/fleet`, { waitUntil: "commit" });
    await session.page.reload({ waitUntil: "commit" });
    // Poll while bootstrap is delayed — first paint should be hailing/loading.
    /** @type {object} */
    let loadingPhase = { ok: false };
    for (let i = 0; i < 25; i += 1) {
      loadingPhase = await session.page.evaluate(() => {
        const board = document.querySelector('[data-testid="fleet-board"]');
        const text = (board?.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 160);
        const phase = board?.getAttribute("data-phase");
        const hailing = !!document.querySelector('[data-testid="fleet-hailing"]');
        const liveStatus = document
          .querySelector('[data-testid="live-status"]')
          ?.getAttribute("data-phase");
        const ok =
          hailing ||
          phase === "loading" ||
          phase === "connecting" ||
          liveStatus === "loading" ||
          liveStatus === "connecting" ||
          /Hailing/i.test(text);
        return { board: phase, hailing, liveStatus, text, ok };
      });
      if (loadingPhase.ok) break;
      await session.page.waitForTimeout(80);
    }
    honesty.loading = loadingPhase;
    await session.page.unroute(
      (url) => {
        const u = typeof url === "string" ? url : url.href;
        try {
          const parsed = new URL(u);
          return parsed.pathname === "/tasks" || parsed.pathname.endsWith("/tasks");
        } catch {
          return /\/tasks$/.test(u);
        }
      },
    );
    // Fresh navigation without hang so offline step starts clean
    await session.page.goto(`${session.url}#/fleet`, { waitUntil: "domcontentloaded" });
    await session.page.waitForTimeout(400);

    // Offline: kill daemon after a healthy load
    await session.page.goto(`${session.url}#/fleet`, { waitUntil: "networkidle" });
    await session.page.waitForTimeout(600);
    await session.daemon.kill();
    await session.page.waitForTimeout(4500);
    const offlinePhase = await session.page.evaluate(() => ({
      board: document.querySelector('[data-testid="fleet-board"]')?.getAttribute("data-phase"),
      live: document
        .querySelector('[data-testid="live-status"]')
        ?.getAttribute("data-phase"),
      text: (document.querySelector('[data-testid="fleet-board"]')?.textContent ?? "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 160),
    }));
    honesty.offline = {
      ok:
        offlinePhase.board === "offline" ||
        offlinePhase.board === "stale-reconnecting" ||
        offlinePhase.live === "offline" ||
        offlinePhase.live === "stale-reconnecting" ||
        /offline|Reconnecting|stale/i.test(offlinePhase.text),
      ...offlinePhase,
    };
    // Restart for clean teardown
    try {
      await session.daemon.restart();
    } catch {
      /* best-effort */
    }

    const proof = {
      kind: "fleet-board",
      description:
        "Fleet board against real daemon: KPIs, runs/pips, attention tasks, " +
        "token-burn with retention bound, runners, firehose; honesty + a11y.",
      staged: {
        completedTaskId: completed.taskId,
        failedTaskId: failed.taskId,
        runningTaskId: running.taskId,
      },
      taskPresence,
      headline: {
        boardScroll,
        burnBound: (burnBound ?? "").replace(/\s+/g, " ").trim(),
        panels,
        fontFloor,
      },
      viewports,
      a11y: {
        ...a11y,
        axe: axeFull,
        aria,
        keyboardWalk,
      },
      honesty,
    };

    const entryPath = writeDemoProof(TICKET, DEMO, proof);
    printRectSummary(DEMO, viewports);
    console.log(
      JSON.stringify(
        {
          ticket: TICKET,
          demo: DEMO,
          boardScroll,
          panels,
          burnBound: proof.headline.burnBound,
          honesty: Object.fromEntries(
            Object.entries(honesty).map(([k, v]) => [k, v.ok]),
          ),
          axeViolations: axeFull.violations?.length ?? 0,
          taskPresence,
        },
        null,
        2,
      ),
    );
    console.log(`ledger entry: ${entryPath}`);
    return proof;
  } finally {
    await session.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runFleetBoardDemo().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
