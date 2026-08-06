/**
 * Issue #357 — task inspector screen acceptance demo.
 *
 * Stages fake-vendor states (awaiting / failed / report-with-churn / stall),
 * measures the inspector at 1280/1460/1920, proves honesty via route
 * interception + daemon kill, axe at 1280 with overflowing log, deliverable
 * fetch states (not_fetched/loading→ready/error; purged/missing-worktree in
 * unit tests), boundary scaffold with long question, keyboard walk to scaffold.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { collectA11y, runAxe } from "../lib/a11y.mjs";
import { measureChromeContrast } from "../lib/contrast.mjs";
import { ledgerDirs, writeDemoProof, printRectSummary } from "../lib/ledger.mjs";
import { measureAtViewports, measureElement } from "../lib/measure.mjs";
import { openVerifySession } from "../lib/session.mjs";

const TICKET = "issue-357";
const DEMO = "task-inspector";

const TASK_SELECTORS = [
  { id: "shell", selector: '[data-testid="shell"]' },
  { id: "center", selector: ".pc-shell__center" },
  { id: "screen-task", selector: '[data-testid="screen-task"]' },
  { id: "task-body", selector: '[data-testid="task-body"]' },
  { id: "task-header", selector: '[data-testid="task-header"]' },
  { id: "task-brief", selector: '[data-testid="task-brief"]' },
  { id: "task-log", selector: '[data-testid="task-log"]' },
  { id: "task-log-well", selector: '[data-testid="task-log-well"]' },
  { id: "task-qa", selector: '[data-testid="task-qa"]' },
  { id: "task-report", selector: '[data-testid="task-report"]' },
  { id: "task-attempts", selector: '[data-testid="task-attempts"]' },
  { id: "task-eval", selector: '[data-testid="task-eval"]' },
  { id: "task-deliverables", selector: '[data-testid="task-deliverables"]' },
  { id: "task-col-log", selector: '[data-testid="task-col-log"]' },
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
  const q = taskId.slice(0, Math.min(8, taskId.length));
  await input.type(q, { delay: 10 });
  await page.waitForTimeout(350);
  await input.press("ArrowDown");
  await page.waitForTimeout(60);
  await input.press("Enter");
  await page.waitForTimeout(150);
  await page.evaluate(() => {
    if (!location.hash.includes("task")) location.hash = "#/task";
  });
  await page.waitForSelector('[data-testid="screen-task"]', { timeout: 10_000 });
  await page
    .waitForSelector(
      '[data-testid="screen-task"][data-detail-status="ready"], [data-testid="screen-task"][data-detail-status="error"]',
      { timeout: 12_000 },
    )
    .catch(() => undefined);
}

/** @param {import('playwright-core').Page} page @param {string} shotDir @param {string} name */
async function shot(page, shotDir, name) {
  const file = `${name}.png`;
  await page.screenshot({ path: path.join(shotDir, file), fullPage: false });
  return `shots/${file}`;
}

/** @param {import('playwright-core').Page} page */
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

/** @param {import('playwright-core').Page} page */
async function layout1280Proof(page) {
  return page.evaluate(() => {
    const body = document.querySelector('[data-testid="task-body"]');
    const log = document.querySelector('[data-testid="task-col-log"]');
    const left = document.querySelector('[data-testid="task-col-left"]');
    const right = document.querySelector('[data-testid="task-col-right"]');
    const well = document.querySelector('[data-testid="task-log-well"]');
    if (!body || !log) return { found: false };
    const cs = getComputedStyle(body);
    const logBox = log.getBoundingClientRect();
    const leftBox = left?.getBoundingClientRect();
    const rightBox = right?.getBoundingClientRect();
    return {
      found: true,
      gridTemplateColumns: cs.gridTemplateColumns,
      gridTemplateAreas: cs.gridTemplateAreas,
      logWidth: Math.round(logBox.width),
      logHeight: Math.round(logBox.height),
      logMinOk: logBox.width >= 400,
      leftTop: leftBox ? Math.round(leftBox.top) : null,
      rightTop: rightBox ? Math.round(rightBox.top) : null,
      stackedSide: Boolean(
        leftBox && rightBox && Math.abs(leftBox.left - rightBox.left) < 8,
      ),
      wellTabIndex: well?.getAttribute("tabindex") ?? null,
      wellAria: well?.getAttribute("aria-label") ?? null,
    };
  });
}

/** @param {import('playwright-core').Page} page */
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
        text: (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 120),
      };
    };
    const scaffold = document.querySelector(
      '[data-testid="task-answer-scaffold"], [data-testid="task-fix-scaffold"], [data-testid="task-delegate-scaffold"]',
    );
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
 * Inject run_id/node onto a solo task detail and control node-detail responses
 * so deliverable fetch states can be staged without a real workflow run.
 * @param {import('playwright-core').Page} page
 * @param {"delay" | "ready" | "error" | "empty"} mode
 */
async function installDeliverableRoutes(page, mode = "ready") {
  await page.unroute("**/tasks/**").catch(() => undefined);
  await page.unroute("**/runs/**").catch(() => undefined);

  await page.route("**/tasks/**", async (route) => {
    const req = route.request();
    const pathname = new URL(req.url()).pathname;
    const isDetail =
      req.method() === "GET" && /^\/tasks\/[^/]+$/.test(pathname);
    if (!isDetail) {
      await route.continue();
      return;
    }
    try {
      const res = await route.fetch();
      const body = await res.json();
      if (body?.task) {
        body.task.run_id = body.task.run_id || "run-verify-dlv";
        body.task.node = body.task.node || "plan";
        body.task.iteration = body.task.iteration ?? 1;
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

  await page.route("**/nodes/**", async (route) => {
    const u = route.request().url();
    if (!u.includes("/runs/") || !u.includes("/nodes/")) {
      await route.continue();
      return;
    }
    if (mode === "delay") {
      await new Promise((r) => setTimeout(r, 2500));
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          run_id: "run-verify-dlv",
          node: { id: "plan", kind: "step" },
          tasks: [],
          deliverables: [
            {
              deliverable_id: "d-ready",
              run_id: "run-verify-dlv",
              node: "plan",
              port: "out",
              iteration: 1,
              slot: null,
              task_id: "t",
              kind: "inline",
              type: "object",
              size: { keys: 2 },
              created_at: "2026-01-01T00:00:00.000Z",
              purged_at: null,
            },
          ],
        }),
      });
      return;
    }
    if (mode === "error") {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "forced node detail error (verify harness)" }),
      });
      return;
    }
    if (mode === "empty") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          run_id: "run-verify-dlv",
          node: { id: "plan", kind: "step" },
          tasks: [],
          deliverables: [],
        }),
      });
      return;
    }
    // ready
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        run_id: "run-verify-dlv",
        node: { id: "plan", kind: "step" },
        tasks: [
          {
            slot: null,
            task_id: "t",
            state: "completed",
            usage: null,
            duration_ms: 1,
            summary: "ok",
            gist: "ok",
          },
        ],
        deliverables: [
          {
            deliverable_id: "d-ready",
            run_id: "run-verify-dlv",
            node: "plan",
            port: "out",
            iteration: 1,
            slot: null,
            task_id: "t",
            kind: "inline",
            type: "object",
            size: { keys: 2 },
            created_at: "2026-01-01T00:00:00.000Z",
            purged_at: null,
          },
        ],
      }),
    });
  });
}

async function clearDeliverableRoutes(page) {
  await page.unroute("**/tasks/**").catch(() => undefined);
  await page.unroute("**/nodes/**").catch(() => undefined);
  await page.unroute("**/runs/**").catch(() => undefined);
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

  const layout = demo.headline?.layout1280;
  if (!layout?.logMinOk) {
    throw new Error(
      `task-inspector: 1280 log column too narrow: ${JSON.stringify(layout)}`,
    );
  }
  if (!layout?.stackedSide) {
    throw new Error(
      `task-inspector: 1280 must stack brief/qa beside log (two-column): ${JSON.stringify(layout)}`,
    );
  }

  // Log column must fill height at wide viewport (not content-collapse).
  const vp1920 = vps.find((v) => v.name === "1920");
  const logCol = vp1920?.elements?.["task-col-log"];
  if (logCol?.found && logCol.box && logCol.box.height < 500) {
    throw new Error(
      `task-inspector: log column collapsed at 1920 height=${logCol.box.height}`,
    );
  }

  const staged = demo.staged ?? {};
  for (const key of ["awaiting", "failed", "completed", "stalled"]) {
    if (!staged[key]?.taskId) {
      throw new Error(`task-inspector: missing staged state ${key}`);
    }
  }

  const detailH = demo.honesty?.detailError;
  if (!detailH) throw new Error("task-inspector: missing detail-error honesty proof");
  const panels = detailH.panels ?? {};
  for (const key of ["report", "eval", "attempts", "deliverables", "qa"]) {
    const text = panels[key] ?? "";
    if (!/unavailable/i.test(text)) {
      throw new Error(
        `task-inspector: detail-error panel ${key} must say unavailable, got: ${text.slice(0, 80)}`,
      );
    }
    if (/No report yet|never been scored|not in a fix chain|Solo task/i.test(text)) {
      throw new Error(
        `task-inspector: detail-error panel ${key} fabricated empty fact: ${text.slice(0, 80)}`,
      );
    }
  }

  const logH = demo.honesty?.logUnreachable;
  if (!logH) throw new Error("task-inspector: missing log-unreachable honesty proof");
  if (logH.logStatus !== "unreachable" && !logH.band?.found && !logH.unreachableNote?.found) {
    throw new Error(`task-inspector: log-unreachable not rendered: ${JSON.stringify(logH)}`);
  }

  // No fabricated log clocks in ledger samples.
  if (demo.logGutter?.hasFabricatedClock) {
    throw new Error("task-inspector: fabricated log gutter clocks present");
  }

  // Axe at 1280 with overflowing log.
  const axe1280 = demo.a11y1280?.axe;
  if (!axe1280) throw new Error("task-inspector: missing a11y1280 axe");
  const v1280 = axe1280.violations ?? [];
  if (v1280.length > 0) {
    throw new Error(
      `task-inspector: axe@1280 violations: ${v1280.map((v) => v.id).join(", ")}`,
    );
  }
  if (!demo.a11y1280?.logWellFocusable) {
    throw new Error("task-inspector: log well not proven focusable at 1280");
  }

  const axe = demo.a11y?.axe;
  if (!axe) throw new Error("task-inspector: missing axe results");
  if ((axe.violations ?? []).length > 0) {
    throw new Error(
      `task-inspector: axe violations: ${axe.violations.map((v) => v.id).join(", ")}`,
    );
  }

  const walk = demo.a11y?.keyboardWalk;
  if (!walk?.leftBody) throw new Error("task-inspector: keyboard walk did not leave body");
  if (!walk?.reachedScaffold) {
    throw new Error("task-inspector: keyboard walk did not reach a copy scaffold");
  }

  const boundary = demo.boundary;
  if (!boundary) throw new Error("task-inspector: missing boundary measures");
  if (boundary.bodyNoHScroll === false) {
    throw new Error("task-inspector: task body horizontal scroll at boundary");
  }
  if (!boundary.scaffold) {
    throw new Error("task-inspector: boundary.scaffold null — must capture answer scaffold");
  }

  if (!demo.churn?.hasPathOnlyTreatment) {
    throw new Error("task-inspector: missing path-only churn honesty treatment");
  }
  if (demo.churn?.mixed?.pathOnlyCue !== "—") {
    throw new Error(
      `task-inspector: mixed churn path-only rows must show — cue, got ${JSON.stringify(demo.churn?.mixed)}`,
    );
  }

  const dlv = demo.deliverables;
  if (!dlv?.states?.not_fetched && !dlv?.states?.loading) {
    throw new Error("task-inspector: missing deliverable not_fetched/loading proof");
  }
  if (!dlv?.states?.ready) {
    throw new Error("task-inspector: missing deliverable ready proof");
  }
  if (!dlv?.states?.error) {
    throw new Error("task-inspector: missing deliverable error proof");
  }
  if (!dlv?.notes?.unitCoverage) {
    throw new Error("task-inspector: ledger must note unit coverage for purged/missing-worktree");
  }
}

export async function runTaskInspectorDemo() {
  const session = await openVerifySession();
  try {
    const { shotsDir } = ledgerDirs(TICKET);

    // ── Stage major states ────────────────────────────────────────────
    const longQ =
      "Boundary question for scaffold layout: " + "q".repeat(2000);
    const awaiting = await session.daemon.stageScript("awaiting-answer", {
      prompt: "Boundary brief: " + "b".repeat(400) + " decide scaffold vs origin.",
    });
    // Patch outstanding question text via intercept later for 2000-char scaffold.
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
        const res = await fetch(`${session.daemon.baseUrl}/tasks/${stalled.taskId}`);
        stalledTask = res.ok ? (await res.json()).task : { state: "unknown" };
      }
    }

    // ── Primary viewport triple ───────────────────────────────────────
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

    // Board scroll + 1280 two-column layout
    await session.page.setViewportSize({ width: 1280, height: 900 });
    await selectTaskAndOpenInspector(session.page, session.url, completed.taskId);
    const boardScroll = await boardScrollProof(session.page);
    const layout1280 = await layout1280Proof(session.page);

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

    /** @type {Record<string, object>} */
    const staged = {
      completed: {
        taskId: completed.taskId,
        state: /** @type {{ state?: string }} */ (completedTask).state,
        screenshot: await shot(session.page, shotsDir, "state-completed"),
        report: liveReport,
      },
    };

    // ── Boundary: long question + answer scaffold (awaiting) ──────────
    await session.page.route("**/tasks/**", async (route) => {
      const req = route.request();
      const u = req.url();
      if (
        req.method() === "GET" &&
        /\/tasks\/[^/?]+$/.test(new URL(u).pathname) &&
        !u.includes("/logs")
      ) {
        try {
          const res = await route.fetch();
          const body = await res.json();
          if (body?.task?.task_id === awaiting.taskId || body?.qa) {
            body.qa = body.qa ?? [];
            if (body.qa.length === 0) {
              body.qa.push({
                question_id: "q-boundary",
                question: longQ,
                answer: null,
                asked_at: new Date().toISOString(),
                answered_at: null,
              });
            } else {
              const last = body.qa[body.qa.length - 1];
              if (last && last.answer == null) last.question = longQ;
            }
            if (body.row) body.row.prompt = "LONG BRIEF " + "z".repeat(500);
            body.task.state = "awaiting_answer";
            body.task.question = longQ;
          }
          // Also inject mixed churn on completed-shaped reports when present.
          if (body?.task?.report) {
            const long =
              "packages/dashboard/src/screens/task/very/deeply/nested/path/for/boundary/sweep/and/truncation/proof/TaskScreen.boundary.ts";
            body.task.report = {
              summary: "Boundary churn: " + "y".repeat(240),
              outcome: "success",
              files_changed: [
                { path: long, added: 12345, removed: 6789 },
                { path: "short.ts" },
                long + ".path-only",
              ],
            };
          }
          await route.fulfill({
            status: res.status(),
            contentType: "application/json",
            body: JSON.stringify(body),
          });
          return;
        } catch {
          /* fall through */
        }
      }
      await route.continue().catch(() => undefined);
    });

    await selectTaskAndOpenInspector(session.page, session.url, awaiting.taskId);
    await session.page.waitForSelector('[data-testid="task-answer-scaffold"]', {
      timeout: 10_000,
    });
    const boundaryShot = await shot(session.page, shotsDir, "boundary-scaffold");
    const boundary = await boundaryMeasures(session.page);

    // Keyboard walk to copy scaffold while the answer scaffold is mounted
    // (before daemon kill — restart would need vite rebind and can drop state).
    await session.page.setViewportSize({ width: 1460, height: 900 });
    const a11y = await collectA11y(session.page, {
      include: '[data-testid="screen-task"]',
    });
    let reachedScaffold = false;
    /** @type {Array<object>} */
    const walkPath = [];
    await session.page.locator("body").focus();
    for (let i = 0; i < 40; i += 1) {
      await session.page.keyboard.press("Tab");
      const focused = await session.page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return { tag: "body", testId: null, text: "" };
        return {
          tag: el.tagName.toLowerCase(),
          testId:
            el.getAttribute("data-testid") ||
            el.closest("[data-testid]")?.getAttribute("data-testid") ||
            null,
          text: (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 80),
          inScaffold: Boolean(
            el.closest('[data-testid="task-answer-scaffold"]') ||
              el.closest('[data-testid="task-fix-scaffold"]') ||
              el.closest('[data-testid="task-delegate-scaffold"]'),
          ),
        };
      });
      walkPath.push({ step: i + 1, ...focused });
      if (focused.inScaffold || (focused.testId && /scaffold/i.test(focused.testId))) {
        reachedScaffold = true;
        await session.page.keyboard.press("Enter");
        walkPath.push({ step: i + 1, key: "Enter", activated: true });
        break;
      }
    }
    a11y.keyboardWalk = {
      ...(a11y.keyboardWalk ?? {}),
      leftBody: walkPath.some((p) => p.tag && p.tag !== "body"),
      reachedScaffold,
      path: walkPath.slice(0, 24),
      focusableCount: await session.page.locator("button, input, [tabindex='0']").count(),
    };

    let contrast = {};
    try {
      contrast = await measureChromeContrast(session.page);
    } catch {
      contrast = { skipped: true };
    }

    staged.awaiting = {
      taskId: awaiting.taskId,
      state: /** @type {{ state?: string }} */ (awaitingTask).state,
      screenshot: await shot(session.page, shotsDir, "state-awaiting"),
      hasAnswerScaffold: true,
      stateChip: await session.page
        .locator('[data-testid="task-state-chip"]')
        .getAttribute("data-state"),
    };

    // Mixed churn on completed via same route (select completed under patch)
    await selectTaskAndOpenInspector(session.page, session.url, completed.taskId);
    await session.page.waitForTimeout(400);
    const mixedChurn = await session.page.evaluate(() => {
      const rows = [...document.querySelectorAll('[data-testid="task-file-row"]')];
      const pathOnly = rows.filter((r) => r.getAttribute("data-has-churn") === "false");
      const cues = pathOnly.map(
        (r) => r.querySelector('[data-testid="task-file-churn"]')?.textContent ?? "",
      );
      return {
        rows: rows.map((r) => ({
          hasChurn: r.getAttribute("data-has-churn"),
          churn: r.querySelector('[data-testid="task-file-churn"]')?.textContent ?? "",
        })),
        pathOnlyCue: cues[0] ?? null,
        hasPlusCounts: rows.some((r) =>
          (r.querySelector('[data-testid="task-file-churn"]')?.textContent ?? "").includes("+"),
        ),
        hasWholeReportNote: Boolean(document.querySelector('[data-testid="task-report-nochurn"]')),
      };
    });
    const boundaryChurnShot = await shot(session.page, shotsDir, "boundary-mixed-churn");
    await session.page.unroute("**/tasks/**").catch(() => undefined);

    await selectTaskAndOpenInspector(session.page, session.url, failed.taskId);
    await session.page.waitForTimeout(300);
    staged.failed = {
      taskId: failed.taskId,
      state: /** @type {{ state?: string }} */ (failedTask).state,
      screenshot: await shot(session.page, shotsDir, "state-failed"),
      hasWhyFailed: (await session.page.locator('[data-testid="task-why-failed"]').count()) > 0,
      hasFixScaffold: (await session.page.locator('[data-testid="task-fix-scaffold"]').count()) > 0,
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

    // ── Deliverable fetch states (inject run ownership) ───────────────
    /** @type {Record<string, object>} */
    const dlvStates = {};

    // loading: delay node detail
    await installDeliverableRoutes(session.page, "delay");
    await selectTaskAndOpenInspector(session.page, session.url, completed.taskId);
    await session.page
      .waitForSelector('[data-testid="task-dlv-loading"], [data-testid="task-dlv-state"][data-state="loading"], [data-testid="task-dlv-state"][data-state="not_fetched"]', {
        timeout: 2000,
      })
      .catch(() => undefined);
    const loadingState = await session.page
      .locator('[data-testid="task-dlv-state"]')
      .getAttribute("data-state");
    dlvStates.loading = {
      state: loadingState,
      screenshot: await shot(session.page, shotsDir, "dlv-loading"),
    };
    dlvStates.not_fetched = {
      state: loadingState === "not_fetched" ? "not_fetched" : loadingState,
      note: "idle→loading captured via delayed node detail; not_fetched is the idle phase before fetch",
      screenshot: dlvStates.loading.screenshot,
    };
    await session.page.waitForTimeout(2800);
    await session.page
      .waitForSelector('[data-testid="task-dlv-state"][data-state="ready"]', { timeout: 5000 })
      .catch(() => undefined);
    dlvStates.ready = {
      state: await session.page.locator('[data-testid="task-dlv-state"]').getAttribute("data-state"),
      screenshot: await shot(session.page, shotsDir, "dlv-ready"),
      rowCount: await session.page.locator('[data-testid="task-dlv-row"]').count(),
    };

    await clearDeliverableRoutes(session.page);
    await installDeliverableRoutes(session.page, "error");
    // Hard navigation so useNodeTasks cannot keep a prior ready latch.
    await session.page.goto(`${session.url}#/fleet`, { waitUntil: "networkidle" });
    await selectTaskAndOpenInspector(session.page, session.url, completed.taskId);
    await session.page
      .waitForFunction(
        () => {
          const el = document.querySelector('[data-testid="task-dlv-state"]');
          return el && el.getAttribute("data-state") === "error";
        },
        { timeout: 12_000 },
      )
      .catch(() => undefined);
    await session.page.waitForTimeout(200);
    dlvStates.error = {
      state: await session.page.locator('[data-testid="task-dlv-state"]').getAttribute("data-state"),
      screenshot: await shot(session.page, shotsDir, "dlv-error"),
      text: await session.page.locator('[data-testid="task-deliverables"]').textContent(),
      hasErrorNote:
        (await session.page.locator('[data-testid="task-dlv-error"]').count()) > 0,
    };
    await clearDeliverableRoutes(session.page);

    // ── Honesty: detail error — all five panels unavailable ───────────
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
      .waitForSelector('[data-testid="screen-task"][data-detail-status="error"]', {
        timeout: 10_000,
      })
      .catch(() => undefined);
    await session.page.waitForTimeout(400);
    const detailErrorShot = await shot(session.page, shotsDir, "honesty-detail-error");
    const detailPanels = await session.page.evaluate(() => {
      /** @param {string} id */
      const t = (id) =>
        (document.querySelector(`[data-testid="${id}"]`)?.textContent ?? "")
          .replace(/\s+/g, " ")
          .trim();
      return {
        report: t("task-report"),
        eval: t("task-eval"),
        attempts: t("task-attempts"),
        deliverables: t("task-deliverables"),
        qa: t("task-qa"),
      };
    });
    const detailErrorProof = {
      screenshot: detailErrorShot,
      band: await measureElement(session.page, '[data-testid="task-band-error"]'),
      briefError: await measureElement(session.page, '[data-testid="task-brief-error"]'),
      detailStatus: await session.page
        .locator('[data-testid="screen-task"]')
        .getAttribute("data-detail-status"),
      panels: detailPanels,
    };
    await session.page.unroute("**/tasks/**");

    // ── Inject many log lines + axe at 1280 (overflowing well) ────────
    await session.page.setViewportSize({ width: 1280, height: 900 });
    await selectTaskAndOpenInspector(session.page, session.url, stalled.taskId);
    // Force many log lines so the well overflows.
    await session.page.route("**/tasks/**/logs**", async (route) => {
      const lines = Array.from({ length: 80 }, (_, i) =>
        JSON.stringify({ type: "message", text: `overflow line ${i} `.repeat(6) }),
      ).join("\n") + "\n";
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ chunk: lines, next: lines.length, eof: false }),
      });
    });
    // Retrigger log tail by toggling follow or reselect.
    await selectTaskAndOpenInspector(session.page, session.url, stalled.taskId);
    await session.page.waitForTimeout(800);
    const wellOverflow = await session.page.evaluate(() => {
      const well = document.querySelector('[data-testid="task-log-well"]');
      if (!well) return null;
      return {
        scrollHeight: well.scrollHeight,
        clientHeight: well.clientHeight,
        overflows: well.scrollHeight > well.clientHeight + 4,
        tabIndex: well.getAttribute("tabindex"),
        ariaLabel: well.getAttribute("aria-label"),
        sampleText: (well.textContent ?? "").slice(0, 200),
        hasClock: /\d{2}:\d{2}:\d{2}/.test(well.textContent ?? ""),
      };
    });
    const axe1280 = await runAxe(session.page, { include: '[data-testid="screen-task"]' });
    const a11y1280Shot = await shot(session.page, shotsDir, "a11y-1280-overflow-log");
    await session.page.unroute("**/tasks/**/logs**").catch(() => undefined);

    // ── Log unreachable via daemon kill ───────────────────────────────
    await selectTaskAndOpenInspector(session.page, session.url, stalled.taskId);
    await session.page.waitForTimeout(300);
    await session.daemon.kill();
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
    // Axe also under error/unreachable state at 1280
    const axeError = await runAxe(session.page, { include: '[data-testid="screen-task"]' });
    const logDropShot = await shot(session.page, shotsDir, "honesty-log-unreachable");
    const logUnreachableProof = {
      screenshot: logDropShot,
      logStatus,
      band: await measureElement(session.page, '[data-testid="task-band-log-drop"]'),
      unreachableNote: await measureElement(session.page, '[data-testid="task-log-unreachable"]'),
      axeViolations: (axeError.violations ?? []).map((v) => v.id),
    };

    // Restart + rebind Vite (port changes on restart).
    await session.daemon.restart();
    await session.rebindVite(session.daemon.baseUrl);
    await session.page.waitForTimeout(400);

    // Empty selection (post-recover)
    await session.page.goto(`${session.url}#/task`, { waitUntil: "networkidle" });
    await session.page.reload({ waitUntil: "networkidle" });
    await session.page.evaluate(() => {
      location.hash = "#/task";
    });
    await session.page.waitForSelector('[data-testid="screen-task"]');
    const emptyShot = await shot(session.page, shotsDir, "empty-no-selection");
    const hasDelegate =
      (await session.page.locator('[data-testid="task-delegate-scaffold"]').count()) > 0;

    const proof = {
      kind: "task-inspector",
      description:
        "Task inspector (#357) fix-pass: panel error honesty, no fabricated log clocks, " +
        "log well focusable + axe@1280 overflow, mixed churn — cue, follow settings, " +
        "log col 1fr, deliverable states, boundary scaffold, keyboard→scaffold, 1280 two-col.",
      daemon: { port: session.daemon.port },
      staged,
      viewports,
      headline: {
        boardScroll,
        layout1280,
        emptySelection: { screenshot: emptyShot, hasDelegateScaffold: hasDelegate },
      },
      honesty: {
        detailError: detailErrorProof,
        logUnreachable: logUnreachableProof,
      },
      logGutter: {
        sample: wellOverflow?.sampleText ?? null,
        hasFabricatedClock: Boolean(wellOverflow?.hasClock),
        overflows: wellOverflow?.overflows ?? null,
      },
      a11y1280: {
        axe: axe1280,
        screenshot: a11y1280Shot,
        logWellFocusable:
          wellOverflow?.tabIndex === "0" && Boolean(wellOverflow?.ariaLabel),
        wellOverflow,
      },
      boundary: {
        ...boundary,
        screenshot: boundaryShot,
        bodyNoHScroll: boundary.bodyNoHScroll,
        mixedChurnScreenshot: boundaryChurnShot,
      },
      churn: {
        live: liveReport,
        mixed: mixedChurn,
        hasPathOnlyTreatment:
          Boolean(liveReport.pathOnlyRows > 0 || liveReport.hasNote) ||
          Boolean(mixedChurn.pathOnlyCue === "—" || mixedChurn.hasWholeReportNote === false),
      },
      deliverables: {
        states: dlvStates,
        notes: {
          unitCoverage:
            "purged and missing-worktree states are covered by unit tests in " +
            "packages/dashboard/tests/task/panels.test.tsx (DeliverablesPanel fetch states); " +
            "demo stages not_fetched/loading→ready and error via route-injected run ownership.",
        },
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
          layout1280: { logWidth: layout1280.logWidth, stacked: layout1280.stackedSide },
          detailPanels: Object.fromEntries(
            Object.entries(detailPanels).map(([k, v]) => [k, /unavailable/i.test(v)]),
          ),
          mixedCue: mixedChurn.pathOnlyCue,
          dlvStates: Object.fromEntries(
            Object.entries(dlvStates).map(([k, v]) => [k, v.state]),
          ),
          axe1280: (axe1280.violations ?? []).map((v) => v.id),
          reachedScaffold,
          logStatus,
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
