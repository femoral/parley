/**
 * Issue #357 — task inspector screen acceptance demo.
 *
 * Stages fake-vendor states (awaiting / failed / report-with-churn / stall),
 * measures the inspector at 1280/1460/1920, proves honesty via route
 * interception + daemon kill, axe + aria snapshot + keyboard walk, and
 * boundary-length copy sweeps.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { collectA11y } from "../lib/a11y.mjs";
import { measureChromeContrast } from "../lib/contrast.mjs";
import { ledgerDirs, writeDemoProof, printRectSummary } from "../lib/ledger.mjs";
import { measureAtViewports, measureElement } from "../lib/measure.mjs";
import { openVerifySession } from "../lib/session.mjs";

const TICKET = "issue-357";
const DEMO = "task-inspector";

/** Screen-local measure targets (never edit DEFAULT_SELECTORS). */
const TASK_SELECTORS = [
  { id: "shell", selector: '[data-testid="shell"]' },
  { id: "center", selector: ".pc-shell__center" },
  { id: "screen-task", selector: '[data-testid="screen-task"]' },
  { id: "task-body", selector: '[data-testid="task-body"]' },
  { id: "task-header", selector: '[data-testid="task-header"]' },
  { id: "task-brief", selector: '[data-testid="task-brief"]' },
  { id: "task-log", selector: '[data-testid="task-log"]' },
  { id: "task-qa", selector: '[data-testid="task-qa"]' },
  { id: "task-report", selector: '[data-testid="task-report"]' },
  { id: "task-attempts", selector: '[data-testid="task-attempts"]' },
  { id: "task-eval", selector: '[data-testid="task-eval"]' },
  { id: "task-deliverables", selector: '[data-testid="task-deliverables"]' },
];

/**
 * @param {import('playwright-core').Page} page
 * @param {string} baseUrl
 * @param {string} taskId
 */
async function selectTaskAndOpenInspector(page, baseUrl, taskId) {
  await page.goto(`${baseUrl}#/task`, { waitUntil: "networkidle" });
  await page.waitForSelector('[data-testid="find-input"]', { timeout: 15_000 });
  const input = page.locator('[data-testid="find-input"]');
  await input.click();
  await input.fill("");
  // Prefer a stable unique prefix of the task id.
  const q = taskId.slice(0, Math.min(8, taskId.length));
  await input.type(q, { delay: 12 });
  await page.waitForTimeout(350);
  // Arrow into results and activate.
  await input.press("ArrowDown");
  await page.waitForTimeout(80);
  await input.press("Enter");
  await page.waitForTimeout(200);
  // Ensure we're on the task screen with selection.
  await page.evaluate(() => {
    if (!location.hash.includes("task")) location.hash = "#/task";
  });
  await page.waitForSelector('[data-testid="screen-task"]', { timeout: 10_000 });
  // Wait for detail to leave loading when possible.
  await page
    .waitForSelector('[data-testid="screen-task"][data-detail-status="ready"]', {
      timeout: 12_000,
    })
    .catch(() => undefined);
}

/**
 * @param {import('playwright-core').Page} page
 * @param {string} shotDir
 * @param {string} name
 */
async function shot(page, shotDir, name) {
  const file = `${name}.png`;
  await page.screenshot({ path: path.join(shotDir, file), fullPage: false });
  return `shots/${file}`;
}

/**
 * Board-level H-scroll proof on the shell.
 * @param {import('playwright-core').Page} page
 */
async function boardScrollProof(page) {
  return page.evaluate(() => {
    const shell = document.querySelector('[data-testid="shell"]');
    if (!shell) return { found: false };
    return {
      found: true,
      scrollWidth: shell.scrollWidth,
      clientWidth: shell.clientWidth,
      noHorizontalScroll: shell.scrollWidth <= shell.clientWidth + 1,
    };
  });
}

/**
 * Truncation / layout measures for long paths and scaffolds.
 * @param {import('playwright-core').Page} page
 */
async function boundaryMeasures(page) {
  return page.evaluate(() => {
    /** @param {Element | null} el */
    const box = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return {
        width: Math.round(r.width),
        height: Math.round(r.height),
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
        overflow: cs.overflow,
        overflowWrap: cs.overflowWrap,
        textOverflow: cs.textOverflow,
        whiteSpace: cs.whiteSpace,
      };
    };
    const scaffold = document.querySelector('[data-testid="task-fix-scaffold"], [data-testid="task-answer-scaffold"], [data-testid="task-delegate-scaffold"]');
    const pathEl = document.querySelector(".pc-task-files__path");
    const body = document.querySelector('[data-testid="task-body"]');
    const report = document.querySelector('[data-testid="task-report"]');
    return {
      scaffold: box(scaffold),
      filePath: box(pathEl),
      body: box(body),
      report: box(report),
      bodyNoHScroll: body ? body.scrollWidth <= body.clientWidth + 2 : null,
    };
  });
}

/**
 * Issue-357 merge gates.
 * @param {object} _entry
 * @param {object} ledger
 */
export function taskInspectorGates(_entry, ledger) {
  const demo = ledger.demos?.["task-inspector"];
  if (!demo) throw new Error("task-inspector: missing demo in ledger");

  const vps = demo.viewports;
  if (!Array.isArray(vps) || vps.length < 3) {
    throw new Error("task-inspector: need ≥3 viewport proofs");
  }
  for (const vp of vps) {
    if (!vp.elements?.shell?.found) {
      throw new Error(`task-inspector: shell missing at ${vp.name}`);
    }
    if (!vp.elements?.["screen-task"]?.found) {
      throw new Error(`task-inspector: screen-task missing at ${vp.name}`);
    }
  }

  const scroll = demo.headline?.boardScroll;
  if (!scroll?.noHorizontalScroll) {
    throw new Error(
      `task-inspector: board horizontal scroll at 1280 not clear: ${JSON.stringify(scroll)}`,
    );
  }

  const staged = demo.staged ?? {};
  for (const key of ["awaiting", "failed", "completed", "stalled"]) {
    if (!staged[key]?.taskId) {
      throw new Error(`task-inspector: missing staged state ${key}`);
    }
  }

  const detailH = demo.honesty?.detailError;
  if (!detailH) {
    throw new Error("task-inspector: missing detail-error honesty proof");
  }
  const detailHonest =
    detailH.detailStatus === "error" ||
    detailH.band?.found ||
    detailH.briefError?.found ||
    detailH.staleBand?.found;
  if (!detailHonest) {
    throw new Error(
      `task-inspector: detail-error honesty not rendered: ${JSON.stringify({
        detailStatus: detailH.detailStatus,
        band: detailH.band?.found,
        brief: detailH.briefError?.found,
        stale: detailH.staleBand?.found,
      })}`,
    );
  }
  if (!demo.honesty?.logUnreachable) {
    throw new Error("task-inspector: missing log-unreachable honesty proof");
  }
  const logH = demo.honesty.logUnreachable;
  if (logH.logStatus !== "unreachable" && !logH.band?.found && !logH.unreachableNote?.found) {
    throw new Error(
      `task-inspector: log-unreachable honesty not rendered: ${JSON.stringify({
        logStatus: logH.logStatus,
        band: logH.band?.found,
      })}`,
    );
  }

  const axe = demo.a11y?.axe;
  if (!axe) throw new Error("task-inspector: missing axe results");
  const violations = axe.violations ?? [];
  if (violations.length > 0) {
    throw new Error(
      `task-inspector: axe violations: ${violations.map((v) => v.id).join(", ")}`,
    );
  }

  if (!demo.a11y?.keyboardWalk) {
    throw new Error("task-inspector: missing keyboard walk");
  }

  const boundary = demo.boundary;
  if (!boundary) throw new Error("task-inspector: missing boundary measures");
  if (boundary.bodyNoHScroll === false) {
    throw new Error("task-inspector: task body horizontal scroll at boundary");
  }

  // Churn honesty: either live churn counts or path-only note present in proof.
  if (!demo.churn?.hasPathOnlyTreatment) {
    throw new Error("task-inspector: missing path-only churn honesty treatment");
  }
}

export async function runTaskInspectorDemo() {
  const session = await openVerifySession();
  try {
    const { shotsDir } = ledgerDirs(TICKET);

    // ── Stage major states ────────────────────────────────────────────
    const awaiting = await session.daemon.stageScript("awaiting-answer", {
      prompt:
        "Boundary brief: ".padEnd(400, "x") +
        " decide scaffold vs origin for the console header.",
    });
    const awaitingTask = await session.daemon.waitTask(awaiting.taskId);

    const failed = await session.daemon.stageScript("vendor-failure", {
      prompt: "Force a failure for why-it-failed well.",
    });
    const failedTask = await session.daemon.waitTask(failed.taskId);

    const completed = await session.daemon.stageScript("report-with-churn", {
      prompt: "Complete with files_changed for the report panel.",
    });
    const completedTask = await session.daemon.waitTask(completed.taskId);

    const stalled = await session.daemon.stageScript("stall", {
      prompt: "Stay quiet for stall observation.",
    });
    // Stall script sleeps long; wait until running (not terminal).
    let stalledTask = null;
    {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const res = await fetch(`${session.daemon.baseUrl}/tasks/${stalled.taskId}`);
        if (res.ok) {
          const body = await res.json();
          const state = body.task?.state;
          if (state === "running" || state === "stalled" || state === "queued") {
            stalledTask = body.task;
            break;
          }
        }
        await new Promise((r) => setTimeout(r, 40));
      }
      if (!stalledTask) {
        // Accept whatever state we got for ledger honesty.
        const res = await fetch(`${session.daemon.baseUrl}/tasks/${stalled.taskId}`);
        stalledTask = res.ok ? (await res.json()).task : { state: "unknown" };
      }
    }

    // ── Primary viewport triple on completed (churn report) ───────────
    await selectTaskAndOpenInspector(session.page, session.url, completed.taskId);

    // Inject object-form churn for boundary + honesty of counts via one-shot
    // detail enrichment is hard without mutating daemon; prove path-only on
    // live wire, and render object-form via a route patch for one capture.
    const viewports = await measureAtViewports(session.page, {
      url: `${session.url}#/task`,
      shotDir: shotsDir,
      shotPrefix: "task-completed",
      targets: TASK_SELECTORS,
      beforeMeasure: async () => {
        await selectTaskAndOpenInspector(session.page, session.url, completed.taskId);
        await session.page.waitForTimeout(200);
      },
    });

    // Board scroll at 1280
    await session.page.setViewportSize({ width: 1280, height: 900 });
    await selectTaskAndOpenInspector(session.page, session.url, completed.taskId);
    const boardScroll = await boardScrollProof(session.page);

    // Path-only churn treatment on live report
    const liveReport = await session.page.evaluate(() => {
      const rows = [...document.querySelectorAll('[data-testid="task-file-row"]')];
      const note = document.querySelector('[data-testid="task-report-nochurn"]');
      return {
        fileCount: rows.length,
        pathOnlyRows: rows.filter((r) => r.getAttribute("data-has-churn") === "false").length,
        hasNote: Boolean(note),
        summary: document.querySelector('[data-testid="task-report-summary"]')?.textContent ?? null,
      };
    });

    // ── Staged state screenshots ──────────────────────────────────────
    /** @type {Record<string, object>} */
    const staged = {
      completed: {
        taskId: completed.taskId,
        state: /** @type {{ state?: string }} */ (completedTask).state,
        screenshot: await shot(session.page, shotsDir, "state-completed"),
        report: liveReport,
      },
    };

    await selectTaskAndOpenInspector(session.page, session.url, awaiting.taskId);
    await session.page.waitForTimeout(300);
    staged.awaiting = {
      taskId: awaiting.taskId,
      state: /** @type {{ state?: string }} */ (awaitingTask).state,
      screenshot: await shot(session.page, shotsDir, "state-awaiting"),
      hasAnswerScaffold: await session.page
        .locator('[data-testid="task-answer-scaffold"]')
        .count()
        .then((n) => n > 0),
      stateChip: await session.page
        .locator('[data-testid="task-state-chip"]')
        .getAttribute("data-state"),
    };

    await selectTaskAndOpenInspector(session.page, session.url, failed.taskId);
    await session.page.waitForTimeout(300);
    staged.failed = {
      taskId: failed.taskId,
      state: /** @type {{ state?: string }} */ (failedTask).state,
      screenshot: await shot(session.page, shotsDir, "state-failed"),
      hasWhyFailed: await session.page
        .locator('[data-testid="task-why-failed"]')
        .count()
        .then((n) => n > 0),
      hasFixScaffold: await session.page
        .locator('[data-testid="task-fix-scaffold"]')
        .count()
        .then((n) => n > 0),
    };

    await selectTaskAndOpenInspector(session.page, session.url, stalled.taskId);
    await session.page.waitForTimeout(300);
    staged.stalled = {
      taskId: stalled.taskId,
      state: /** @type {{ state?: string }} */ (stalledTask).state,
      screenshot: await shot(session.page, shotsDir, "state-stalled"),
      logStatus: await session.page
        .locator('[data-testid="task-log-status"]')
        .getAttribute("data-status"),
    };

    // ── Boundary: inject long-path churn objects via route ────────────
    await session.page.route("**/tasks/**", async (route) => {
      const req = route.request();
      if (req.method() !== "GET") {
        await route.continue();
        return;
      }
      const url = req.url();
      // Only detail (not logs).
      if (url.includes("/logs")) {
        await route.continue();
        return;
      }
      try {
        const res = await route.fetch();
        const body = await res.json();
        if (body?.task?.report) {
          const long =
            "packages/dashboard/src/screens/task/very/deeply/nested/path/for/boundary/sweep/and/truncation/proof/TaskScreen.boundary.ts";
          body.task.report = {
            summary: "Boundary churn: " + "y".repeat(240),
            outcome: "success",
            files_changed: [
              { path: long, added: 42, removed: 7 },
              { path: "short.ts" },
              long + ".path-only",
            ],
          };
          // Long prompt for brief clamp.
          if (body.row) {
            body.row.prompt = "LONG BRIEF " + "z".repeat(500);
          }
        }
        await route.fulfill({
          status: res.status(),
          contentType: "application/json",
          body: JSON.stringify(body),
        });
      } catch {
        await route.continue().catch(() => undefined);
      }
    });

    await selectTaskAndOpenInspector(session.page, session.url, completed.taskId);
    await session.page.waitForTimeout(500);
    const boundaryShot = await shot(session.page, shotsDir, "boundary-long");
    const boundary = await boundaryMeasures(session.page);
    const boundaryChurn = await session.page.evaluate(() => {
      const rows = [...document.querySelectorAll('[data-testid="task-file-row"]')];
      return {
        rows: rows.map((r) => ({
          hasChurn: r.getAttribute("data-has-churn"),
          path: r.querySelector(".pc-task-files__path")?.textContent ?? "",
          churn: r.querySelector('[data-testid="task-file-churn"]')?.textContent ?? "",
        })),
        hasPathOnlyTreatment: rows.some((r) => r.getAttribute("data-has-churn") === "false"),
        hasPlusCounts: rows.some((r) => (r.querySelector('[data-testid="task-file-churn"]')?.textContent ?? "").includes("+")),
      };
    });
    await session.page.unroute("**/tasks/**").catch(() => undefined);

    // ── Honesty: detail error via interception ────────────────────────
    // Clear selection first so useTaskDetail remounts on a fresh taskId fetch
    // under the failing route (same-id reselect does not re-run the effect).
    await session.page.goto(`${session.url}#/task`, { waitUntil: "networkidle" });
    await session.page.reload({ waitUntil: "networkidle" });
    await session.page.evaluate(() => {
      location.hash = "#/task";
    });
    await session.page.waitForSelector('[data-testid="task-delegate-scaffold"]', {
      timeout: 10_000,
    });

    await session.page.route("**/tasks/**", async (route) => {
      const req = route.request();
      const u = req.url();
      // Fail detail only: /tasks/<id> not /tasks list and not /logs.
      if (
        req.method() === "GET" &&
        /\/tasks\/[^/?]+$/.test(new URL(u).pathname) &&
        !u.includes("/logs")
      ) {
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ error: "forced task detail error (verify harness)" }),
        });
        return;
      }
      await route.continue();
    });

    await selectTaskAndOpenInspector(session.page, session.url, completed.taskId);
    await session.page
      .waitForSelector(
        '[data-testid="task-band-error"], [data-testid="task-brief-error"], [data-testid="screen-task"][data-detail-status="error"]',
        { timeout: 10_000 },
      )
      .catch(() => undefined);
    await session.page.waitForTimeout(400);
    const detailErrorShot = await shot(session.page, shotsDir, "honesty-detail-error");
    const detailErrorProof = {
      screenshot: detailErrorShot,
      band: await measureElement(session.page, '[data-testid="task-band-error"]'),
      briefError: await measureElement(session.page, '[data-testid="task-brief-error"]'),
      detailStatus: await session.page
        .locator('[data-testid="screen-task"]')
        .getAttribute("data-detail-status"),
      // Accept stale band if detail had raced with prior cache.
      staleBand: await measureElement(session.page, '[data-testid="task-band-stale"]'),
    };
    await session.page.unroute("**/tasks/**");

    // ── Honesty: log unreachable via daemon kill ──────────────────────
    await selectTaskAndOpenInspector(session.page, session.url, stalled.taskId);
    await session.page.waitForTimeout(400);
    await session.daemon.kill();
    // Poll until log status is unreachable (or timeout).
    let logStatus = null;
    {
      const deadline = Date.now() + 12_000;
      while (Date.now() < deadline) {
        logStatus = await session.page
          .locator('[data-testid="task-log-status"]')
          .getAttribute("data-status")
          .catch(() => null);
        const band = await session.page.locator('[data-testid="task-band-log-drop"]').count();
        if (logStatus === "unreachable" || band > 0) break;
        await session.page.waitForTimeout(200);
      }
    }
    const logDropShot = await shot(session.page, shotsDir, "honesty-log-unreachable");
    const logUnreachableProof = {
      screenshot: logDropShot,
      logStatus,
      band: await measureElement(session.page, '[data-testid="task-band-log-drop"]'),
      unreachableNote: await measureElement(session.page, '[data-testid="task-log-unreachable"]'),
    };

    // Restart daemon so session.close is clean.
    await session.daemon.restart();
    await session.page.waitForTimeout(300);

    // ── A11y on healthy completed view ────────────────────────────────
    await selectTaskAndOpenInspector(session.page, session.url, completed.taskId);
    await session.page.setViewportSize({ width: 1460, height: 900 });
    await session.page.waitForTimeout(400);
    const a11y = await collectA11y(session.page, {
      include: '[data-testid="screen-task"]',
    });

    // Contrast samples on state chip / section labels
    let contrast = {};
    try {
      contrast = await measureChromeContrast(session.page);
    } catch {
      contrast = { skipped: true };
    }

    // Empty selection (no task) delegate scaffold
    await session.page.goto(`${session.url}#/task`, { waitUntil: "networkidle" });
    // Clear selection: reload wipes React state.
    await session.page.reload({ waitUntil: "networkidle" });
    await session.page.evaluate(() => {
      location.hash = "#/task";
    });
    await session.page.waitForSelector('[data-testid="screen-task"]');
    const emptyShot = await shot(session.page, shotsDir, "empty-no-selection");
    const hasDelegate = await session.page
      .locator('[data-testid="task-delegate-scaffold"]')
      .count()
      .then((n) => n > 0);

    const proof = {
      kind: "task-inspector",
      description:
        "Task inspector (#357): staged awaiting/failed/completed/stalled; " +
        "viewports 1280/1460/1920; honesty detail-error + log-unreachable; " +
        "boundary long brief/paths; axe + keyboard.",
      daemon: { port: session.daemon.port },
      staged,
      viewports,
      headline: {
        boardScroll,
        emptySelection: { screenshot: emptyShot, hasDelegateScaffold: hasDelegate },
      },
      honesty: {
        detailError: detailErrorProof,
        logUnreachable: logUnreachableProof,
      },
      boundary: {
        ...boundary,
        screenshot: boundaryShot,
        bodyNoHScroll: boundary.bodyNoHScroll,
      },
      churn: {
        live: liveReport,
        boundary: boundaryChurn,
        hasPathOnlyTreatment:
          Boolean(liveReport.pathOnlyRows > 0 || liveReport.hasNote) ||
          Boolean(boundaryChurn.hasPathOnlyTreatment),
      },
      a11y,
      contrast,
    };

    const entryPath = writeDemoProof(TICKET, DEMO, proof);
    printRectSummary(DEMO, viewports);
    console.log(`ledger entry: ${entryPath}`);
    console.log(
      JSON.stringify(
        {
          boardScroll,
          stagedStates: Object.fromEntries(
            Object.entries(staged).map(([k, v]) => [k, v.state]),
          ),
          hasDelegate,
          logStatus: logUnreachableProof.logStatus,
          axeViolations: a11y.axe?.violations?.length ?? a11y.violations?.length ?? "?",
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runTaskInspectorDemo().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
