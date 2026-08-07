/**
 * Issue #355 — fleet board screen proofs.
 *
 * Stages real daemon tasks (success + failure), measures the board at
 * 1280/1460/1920, proves no board H-scroll, honesty treatments, axe, ARIA,
 * pip fail state, attention order, cap-absent, runner statuses, table density,
 * retention-bound copy, and font floors on chart labels.
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
import { buildListPipTrack } from "../../src/screens/fleet/pips.ts";
import { sortTasksByAttention } from "../../src/screens/fleet/attentionSort.ts";
import { projectFleetKpis } from "../../src/screens/fleet/kpis.ts";
import {
  runnerStatusClass,
  runnerStatusLabel,
} from "../../src/screens/fleet/runners.ts";

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
  { id: "fleet-kpi-settled", selector: '[data-testid="fleet-kpi-settled"]' },
  { id: "fleet-kpi-token-burn", selector: '[data-testid="fleet-kpi-token-burn"]' },
  { id: "fleet-runs", selector: '[data-testid="fleet-runs"]' },
  { id: "fleet-tasks", selector: '[data-testid="fleet-tasks"]' },
  { id: "fleet-tasks-scroll", selector: '[data-testid="fleet-tasks-scroll"]' },
  { id: "fleet-runners", selector: '[data-testid="fleet-runners"]' },
  // #363: burn + firehose moved to shell rails
  { id: "rail-token-burn", selector: '[data-testid="rail-token-burn"]' },
  { id: "rail-burn-bound", selector: '[data-testid="rail-burn-bound"]' },
  { id: "rail-firehose", selector: '[data-testid="rail-firehose"]' },
  { id: "rail-attention", selector: '[data-testid="rail-attention"]' },
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
  // #363: burn + firehose live on shell rails, not fleet center
  if (!demo.headline?.panels?.tokenBurn) {
    throw new Error("fleet-board: token burn (left rail) not proven present");
  }
  if (!demo.headline?.panels?.firehose) {
    throw new Error("fleet-board: firehose (right rail) not proven present");
  }
  if (demo.headline?.panels?.fleetFirehose) {
    throw new Error("fleet-board: firehose must not remain on fleet center");
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

  // Tasks table density: at 1280, no silent H-scroll on the table scroll region
  // (columns dropped so tokens/dur stay visible).
  const table1280 = demo.headline?.tasksTable1280;
  if (!table1280?.noHorizontalScroll) {
    throw new Error(
      `fleet-board: tasks table H-scroll at 1280 not clear: ${JSON.stringify(table1280)}`,
    );
  }
  if (!table1280?.tokensVisible || !table1280?.durVisible) {
    throw new Error(
      `fleet-board: tokens/dur columns not visible at 1280: ${JSON.stringify(table1280)}`,
    );
  }

  // #364 — state chips untruncated at board widths
  const chips = demo.chipUntruncated ?? {};
  for (const w of ["1280", "1460", "1920"]) {
    const row = chips[w];
    if (row?.found && row.truncated) {
      throw new Error(
        `fleet-board: state chip truncated at ${w}: ${JSON.stringify(row)}`,
      );
    }
  }

  // #364 — overflow cue: ResizeObserver sets data-h-overflow; no gradient
  const overflow = demo.overflowCue ?? {};
  if (!overflow.forceOverflow?.cueVisible) {
    throw new Error(
      `fleet-board: overflow cue not visible under forced clip: ${JSON.stringify(overflow.forceOverflow)}`,
    );
  }
  if (overflow.forceOverflow?.usesGradient) {
    throw new Error(
      `fleet-board: overflow cue uses forbidden gradient: ${JSON.stringify(overflow.forceOverflow)}`,
    );
  }
  // Columns restore at ~1520 (addr/branch visible); still dropped at 1460.
  if (!overflow.columnRestore?.hiddenAt1460) {
    throw new Error(
      `fleet-board: branch/addr should stay dropped at 1460: ${JSON.stringify(overflow.columnRestore)}`,
    );
  }
  if (!overflow.columnRestore?.restoredAt1520) {
    throw new Error(
      `fleet-board: branch/addr should restore by 1520: ${JSON.stringify(overflow.columnRestore)}`,
    );
  }

  // KPI notes not clipped at 1280
  const kpiNotes = demo.headline?.kpiNotes1280;
  if (!kpiNotes?.allOk) {
    throw new Error(
      `fleet-board: KPI notes clipped at 1280: ${JSON.stringify(kpiNotes)}`,
    );
  }

  const honesty = demo.honesty ?? {};
  for (const key of ["empty", "error", "loading"]) {
    if (!honesty[key]?.ok) {
      throw new Error(
        `fleet-board: honesty state ${key} not proven: ${JSON.stringify(honesty[key])}`,
      );
    }
  }
  // Empty must actually reach data-phase=empty (no taskRows===0 tautology).
  if (honesty.empty?.board !== "empty" && !honesty.empty?.empty) {
    throw new Error(
      `fleet-board: empty honesty did not reach empty treatment: ${JSON.stringify(honesty.empty)}`,
    );
  }
  // Loading must show fleet loading treatment, not just shell chip.
  if (!honesty.loading?.loading) {
    throw new Error(
      `fleet-board: loading honesty missing fleet loading: ${JSON.stringify(honesty.loading)}`,
    );
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

  // Behavioral gates (not just presence)
  const b = demo.behavioral ?? {};
  if (!b.failPip?.ok || !b.failPip?.kinds?.includes("fail")) {
    throw new Error(`fleet-board: fail pip behavioral gate failed: ${JSON.stringify(b.failPip)}`);
  }
  if (!b.attentionOrder?.ok) {
    throw new Error(
      `fleet-board: attention order gate failed: ${JSON.stringify(b.attentionOrder)}`,
    );
  }
  if (!b.capAbsent?.ok) {
    throw new Error(`fleet-board: cap-absent gate failed: ${JSON.stringify(b.capAbsent)}`);
  }
  if (!b.runnerStatuses?.ok) {
    throw new Error(
      `fleet-board: runner status gate failed: ${JSON.stringify(b.runnerStatuses)}`,
    );
  }
  if (!b.settled24h?.ok) {
    throw new Error(
      `fleet-board: settled 24h window gate failed: ${JSON.stringify(b.settled24h)}`,
    );
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
      '[data-testid="rail-burn-bound"]',
      ".pc-rail-burn__axis span",
      ".pc-rail-burn__totals span",
      ".pc-fleet-kpi__label",
      ".pc-fleet-kpi__note",
      ".pc-fleet-table__th",
      ".pc-fleet-chip__label",
      ".pc-fleet-panel__title",
      ".pc-rail-hose__time",
      ".pc-rail-hose__text",
      ".pc-attn__age",
      ".pc-attn__meta",
      ".pc-attn__reason",
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
      tokenBurn: has('[data-testid="rail-token-burn"]'),
      firehose: has('[data-testid="rail-firehose"]'),
      fleetFirehose: has('[data-testid="fleet-firehose"]'),
      attention: has('[data-testid="rail-attention"]'),
      runners: has('[data-testid="fleet-runners"]'),
      board: has('[data-testid="fleet-board"]'),
    };
  });
}

/**
 * @param {import('playwright-core').Page} page
 */
async function measureTasksTable1280(page) {
  return page.evaluate(() => {
    const scroll = document.querySelector('[data-testid="fleet-tasks-scroll"]');
    const table = scroll?.querySelector(".pc-fleet-table");
    if (!scroll) {
      return { found: false, noHorizontalScroll: false, tokensVisible: false, durVisible: false };
    }
    const heads = [...(table?.querySelectorAll(".pc-fleet-table__th") ?? [])].map(
      (el) => ({
        text: (el.textContent ?? "").trim().toLowerCase(),
        display: getComputedStyle(el).display,
        visible: getComputedStyle(el).display !== "none",
      }),
    );
    const tokensVisible = heads.some((h) => h.text === "tokens" && h.visible);
    const durVisible = heads.some((h) => h.text === "dur" && h.visible);
    const addrHidden = heads.some(
      (h) => h.text.includes("run address") && !h.visible,
    );
    return {
      found: true,
      scrollWidth: scroll.scrollWidth,
      clientWidth: scroll.clientWidth,
      noHorizontalScroll: scroll.scrollWidth <= scroll.clientWidth + 1,
      tokensVisible,
      durVisible,
      addrHidden,
      heads,
    };
  });
}

/**
 * @param {import('playwright-core').Page} page
 */
async function measureKpiNotes1280(page) {
  return page.evaluate(() => {
    const notes = [...document.querySelectorAll(".pc-fleet-kpi__note")];
    const rows = notes.map((el) => ({
      text: (el.textContent ?? "").trim().slice(0, 80),
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      ok: el.scrollWidth <= el.clientWidth + 2,
    }));
    return {
      rows,
      allOk: rows.length > 0 && rows.every((r) => r.ok),
    };
  });
}

/**
 * Pure behavioral proofs (fixtures) — always available, stageable or not.
 */
function pureBehavioralProofs() {
  const failPips = buildListPipTrack({
    run_id: "fail-proof",
    workflow: "proof",
    workflow_version: 1,
    orchestrator_session_id: null,
    state: "failed",
    block: null,
    current_node: "x",
    iteration: 1,
    parent_run_id: null,
    attempt: 1,
    tasks_settled: 4,
    tasks_total: 4,
    usage: { input_tokens: 0, output_tokens: 0 },
    duration_ms: null,
    branch: null,
    worktree: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    completed_at: null,
    purged_at: null,
    workspace: "scratch",
    type: "other",
    repo: null,
    error: null,
    track_bound: 4,
    track: null,
  });
  const kinds = failPips.map((p) => p.kind);

  const now = Date.parse("2026-06-15T12:00:00.000Z");
  const tasks = [
    {
      task_id: "old-done",
      state: "completed",
      completed_at: "2026-06-05T12:00:00.000Z",
      updated_at: "2026-06-05T12:00:00.000Z",
      usage: { input_tokens: 900000, output_tokens: 1 },
    },
    {
      task_id: "ask",
      state: "awaiting_answer",
      updated_at: "2026-06-15T11:00:00.000Z",
    },
    {
      task_id: "fail",
      state: "failed",
      completed_at: "2026-06-15T11:30:00.000Z",
      updated_at: "2026-06-15T11:30:00.000Z",
    },
    {
      task_id: "run",
      state: "running",
      started_at: "2026-06-15T11:40:00.000Z",
      updated_at: "2026-06-15T11:40:00.000Z",
    },
    {
      task_id: "done",
      state: "completed",
      completed_at: "2026-06-15T11:50:00.000Z",
      updated_at: "2026-06-15T11:50:00.000Z",
      usage: { input_tokens: 100, output_tokens: 10 },
    },
  ];
  // Minimal envelopes for sort + kpis (sort only needs state + timestamps).
  const sorted = sortTasksByAttention(
    /** @type {any} */ (tasks),
  ).map((t) => t.task_id);
  const attentionOk =
    sorted[0] === "ask" &&
    sorted[1] === "fail" &&
    sorted.indexOf("run") < sorted.indexOf("done");

  const kpis = projectFleetKpis({
    nowMs: now,
    tasks: /** @type {any} */ (tasks),
    runs: [],
  });
  const settled = kpis.find((k) => k.id === "settled");
  const burn = kpis.find((k) => k.id === "token-burn");
  // Old 900k task must not dominate; settled must be 1 done / 1 fail (in window).
  const settledOk = settled?.value === "1 / 1";
  const burnOk = burn?.value !== "900k" && burn?.value !== "900.0k";

  const capKpis = projectFleetKpis({
    nowMs: now,
    tasks: /** @type {any} */ ([
      { task_id: "r", state: "running", started_at: "2026-06-15T11:00:00.000Z" },
    ]),
    runs: [],
  });
  const running = capKpis.find((k) => k.id === "running");
  const capAbsentOk =
    running?.value === "1" && /cap unknown/i.test(running?.note ?? "");

  const runnerStatuses = ["online", "stale", "offline"].map((s) => ({
    status: s,
    className: runnerStatusClass(s),
    label: runnerStatusLabel(s),
  }));
  const runnerOk =
    runnerStatuses.every((r) => r.className.endsWith(`--${r.status}`)) &&
    runnerStatuses.every((r) => r.label === r.status) &&
    new Set(runnerStatuses.map((r) => r.className)).size === 3;

  return {
    failPip: {
      ok: kinds.includes("fail") && !kinds.every((k) => k === "done"),
      kinds,
    },
    attentionOrder: { ok: attentionOk, sorted },
    capAbsent: { ok: capAbsentOk, value: running?.value, note: running?.note },
    runnerStatuses: { ok: runnerOk, rows: runnerStatuses },
    settled24h: {
      ok: settledOk && burnOk,
      settled: settled?.value,
      burn: burn?.value,
    },
  };
}

export async function runFleetBoardDemo() {
  const session = await openVerifySession();
  try {
    const completed = await session.daemon.stageScript("report-success");
    await session.daemon.waitTask(completed.taskId);

    const failed = await session.daemon.stageScript("vendor-failure");
    await session.daemon.waitTask(failed.taskId);

    const running = await session.daemon.stageScript("long-running");

    const { shotsDir } = ledgerDirs(TICKET);

    await session.page.setViewportSize({ width: 1460, height: 900 });
    await session.page.goto(session.url, { waitUntil: "networkidle" });
    await session.page.waitForSelector('[data-testid="fleet-board"]', {
      timeout: 20_000,
    });
    await session.page.waitForFunction(
      () => {
        const b = document.querySelector('[data-testid="fleet-board"]');
        return b && b.getAttribute("data-phase") !== "loading";
      },
      { timeout: 20_000 },
    );
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
      .locator('[data-testid="rail-burn-bound"]')
      .textContent()
      .catch(() => null);
    const fontFloor = await measureFontFloor(session.page);
    const tasksTable1280 = await measureTasksTable1280(session.page);
    const kpiNotes1280 = await measureKpiNotes1280(session.page);

    // #364 — chip untruncated + overflow cue + column restore breakpoint
    /** @type {Record<string, object>} */
    const chipUntruncated = {};
    for (const w of [1280, 1460, 1920]) {
      await session.page.setViewportSize({ width: w, height: 900 });
      await session.page.waitForTimeout(50);
      await session.page.evaluate(() => document.fonts.ready);
      chipUntruncated[String(w)] = await session.page.evaluate(() => {
        const labels = [...document.querySelectorAll(".pc-chip__label")];
        if (labels.length === 0) return { found: false };
        const samples = labels.slice(0, 12).map((label) => {
          const text = (label.textContent ?? "").replace(/\s+/g, " ").trim();
          const truncated =
            label.scrollWidth > label.clientWidth + 1 ||
            /\u2026|\.\.\.$/.test(text);
          return {
            text,
            clientWidth: Math.round(label.clientWidth),
            scrollWidth: Math.round(label.scrollWidth),
            truncated,
          };
        });
        return {
          found: true,
          samples,
          truncated: samples.some((s) => s.truncated),
          widest: samples.reduce(
            (a, b) => (b.scrollWidth > (a?.scrollWidth ?? 0) ? b : a),
            samples[0],
          ),
        };
      });
    }

    // Column restore: secondary cols hidden below 1520, visible at 1520+
    const columnRestore = {};
    for (const w of [1460, 1520]) {
      await session.page.setViewportSize({ width: w, height: 900 });
      await session.page.waitForTimeout(50);
      columnRestore[String(w)] = await session.page.evaluate(() => {
        const branch = document.querySelector(
          ".pc-fleet-tasks .pc-fleet-col--branch",
        );
        const addr = document.querySelector(".pc-fleet-tasks .pc-fleet-col--addr");
        const disp = (el) => (el ? getComputedStyle(el).display : null);
        return {
          branchDisplay: disp(branch),
          addrDisplay: disp(addr),
          branchVisible: branch ? getComputedStyle(branch).display !== "none" : false,
          addrVisible: addr ? getComputedStyle(addr).display !== "none" : false,
        };
      });
    }

    // Force horizontal overflow on tasks scroll and assert cue + data-h-overflow.
    // ResizeObserver → React state is async; wait for data-h-overflow="true".
    await session.page.setViewportSize({ width: 1460, height: 900 });
    await session.page.waitForTimeout(40);
    await session.page.evaluate(() => {
      const table = document.querySelector(
        '[data-testid="fleet-tasks-scroll"] .pc-fleet-table',
      );
      if (table) /** @type {HTMLElement} */ (table).style.minWidth = "2400px";
    });
    await session.page
      .waitForFunction(
        () => {
          const scroll = document.querySelector(
            '[data-testid="fleet-tasks-scroll"]',
          );
          return (
            scroll &&
            scroll.getAttribute("data-h-overflow") === "true" &&
            scroll.scrollWidth > scroll.clientWidth + 1
          );
        },
        { timeout: 3_000 },
      )
      .catch(() => null);
    const forceOverflow = await session.page.evaluate(() => {
      const scroll = document.querySelector('[data-testid="fleet-tasks-scroll"]');
      const table = scroll?.querySelector(".pc-fleet-table");
      if (!scroll || !table) return { found: false };
      const cs = getComputedStyle(scroll, "::after");
      const bg = cs.backgroundImage || "";
      const width = parseFloat(cs.width) || 0;
      const opacity = parseFloat(cs.opacity) || 0;
      const attr = scroll.getAttribute("data-h-overflow");
      const result = {
        found: true,
        attr,
        cueVisible:
          attr === "true" &&
          (width >= 8 || opacity > 0.5 || parseFloat(cs.borderLeftWidth) > 0),
        usesGradient: /gradient/i.test(bg),
        afterWidth: width,
        afterOpacity: opacity,
        afterBg: bg.slice(0, 80),
        borderLeftWidth: cs.borderLeftWidth,
        scrollWidth: scroll.scrollWidth,
        clientWidth: scroll.clientWidth,
      };
      /** @type {HTMLElement} */ (table).style.minWidth = "";
      return result;
    });

    const overflowCue = {
      forceOverflow,
      columnRestore: {
        at1460: columnRestore["1460"],
        at1520: columnRestore["1520"],
        hiddenAt1460:
          columnRestore["1460"] &&
          !columnRestore["1460"].branchVisible &&
          !columnRestore["1460"].addrVisible,
        restoredAt1520:
          columnRestore["1520"] &&
          columnRestore["1520"].branchVisible &&
          columnRestore["1520"].addrVisible,
      },
    };

    // Live DOM behavioral samples (attention order of staged tasks).
    const liveAttention = await session.page.evaluate(
      ({ completedId, failedId }) => {
        const rows = [
          ...document.querySelectorAll('[data-testid^="fleet-task-"]'),
        ].map((el) => el.getAttribute("data-testid") ?? "");
        const states = [
          ...document.querySelectorAll('[data-testid^="fleet-task-"]'),
        ].map((el) => el.getAttribute("data-state") ?? "");
        const failBeforeDone =
          states.indexOf("failed") >= 0 &&
          states.indexOf("completed") >= 0 &&
          states.indexOf("failed") < states.indexOf("completed");
        const runningKpi =
          document.querySelector('[data-testid="fleet-kpi-running"]')
            ?.textContent ?? "";
        const capAbsent = /cap unknown/i.test(runningKpi) || !/\d+\/\d+/.test(runningKpi);
        // Pip tracks on any run that has fail
        const pipTracks = [
          ...document.querySelectorAll('[data-testid^="fleet-pips-"]'),
        ].map((el) => el.getAttribute("data-pip-kinds") ?? "");
        return {
          rows,
          states,
          failBeforeDone,
          runningKpi: runningKpi.replace(/\s+/g, " ").trim().slice(0, 80),
          capAbsent,
          pipTracks,
          hasCompleted: rows.some((r) => r.includes(completedId.slice(0, 8))) ||
            !!document.querySelector(`[data-testid="fleet-task-${completedId}"]`),
          hasFailed:
            rows.some((r) => r.includes(failedId.slice(0, 8))) ||
            !!document.querySelector(`[data-testid="fleet-task-${failedId}"]`),
        };
      },
      { completedId: completed.taskId, failedId: failed.taskId },
    );

    const taskPresence = {
      hasCompleted: liveAttention.hasCompleted,
      hasFailed: liveAttention.hasFailed,
      phase: await session.page
        .locator('[data-testid="fleet-board"]')
        .getAttribute("data-phase"),
      taskCount: liveAttention.rows.length,
    };

    // Pure + live behavioral bundle
    const pure = pureBehavioralProofs();
    const behavioral = {
      ...pure,
      liveAttention,
      // If a failed run pip is painted, record it; pure gate always covers fail pip.
      renderedFailPip: liveAttention.pipTracks.some((k) => k.includes("fail")),
    };

    // A11y at mid viewport
    await session.page.setViewportSize({ width: 1460, height: 900 });
    await session.page.goto(`${session.url}#/fleet`, { waitUntil: "networkidle" });
    await session.page.waitForSelector('[data-testid="fleet-board"]');
    const a11y = await collectA11y(session.page, {
      include: '[data-testid="fleet-board"]',
    });
    const axeFull = await runAxe(session.page);
    const aria = await ariaSnapshot(session.page, {
      selector: '[data-testid="fleet-board"]',
    });

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
          tabIndex: el?.getAttribute?.("tabindex") ?? null,
        };
      });
      keyboardWalk.push(
        `${info.tag}${info.testId ? `#${info.testId}` : ""}${info.role ? `[${info.role}]` : ""}`,
      );
    }

    // ── Honesty states ───────────────────────────────────────────────
    /** @type {Record<string, object>} */
    const honesty = {};

    async function reloadFleet() {
      await session.page.goto(`${session.url}#/fleet`, {
        waitUntil: "domcontentloaded",
      });
      await session.page.reload({ waitUntil: "domcontentloaded" });
    }

    // Empty: empty tasks + empty runs. Component promotes nothing-to-show to
    // data-phase=empty even if SSE drops into stale-reconnecting.
    await interceptEmpty(session.page, "**/tasks");
    await interceptEmpty(session.page, "**/tasks?*");
    await session.page.route("**/runs", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ runs: [] }),
      });
    });
    // Keep SSE "open" with a slow drip so we prefer empty over offline.
    await session.page.route("**/events/**", async (route) => {
      await new Promise((r) => setTimeout(r, 50));
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
    await session.page.waitForTimeout(2500);
    // Poll until empty treatment lands
    /** @type {object} */
    let emptyPhase = {};
    for (let i = 0; i < 20; i += 1) {
      emptyPhase = await session.page.evaluate(() => ({
        board: document
          .querySelector('[data-testid="fleet-board"]')
          ?.getAttribute("data-phase"),
        empty: !!document.querySelector('[data-testid="fleet-empty"]'),
        text: (document.querySelector('[data-testid="fleet-board"]')?.textContent ?? "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 200),
      }));
      if (emptyPhase.board === "empty" && emptyPhase.empty) break;
      await session.page.waitForTimeout(150);
    }
    // Gate: must reach empty treatment — NO taskRows===0 tautology.
    honesty.empty = {
      ok: emptyPhase.board === "empty" && emptyPhase.empty === true,
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

    // Loading: hang GET /tasks; require fleet loading (not shell chip alone).
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
    /** @type {object} */
    let loadingPhase = { ok: false, loading: false };
    for (let i = 0; i < 30; i += 1) {
      loadingPhase = await session.page.evaluate(() => {
        const board = document.querySelector('[data-testid="fleet-board"]');
        const phase = board?.getAttribute("data-phase");
        const loading = !!document.querySelector('[data-testid="fleet-loading"]');
        const text = (board?.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 160);
        return {
          board: phase,
          loading,
          text,
          // REQUIRED: fleet's own loading treatment, not shell live-status chip.
          ok: loading === true,
        };
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
    await session.page.goto(`${session.url}#/fleet`, { waitUntil: "domcontentloaded" });
    await session.page.waitForTimeout(400);

    // Offline
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
    try {
      await session.daemon.restart();
    } catch {
      /* best-effort */
    }

    const proof = {
      kind: "fleet-board",
      description:
        "Fleet board against real daemon: KPIs (24h window), runs/pips, attention tasks, " +
        "token-burn with retention bound, runners, firehose; honesty + a11y + density.",
      staged: {
        completedTaskId: completed.taskId,
        failedTaskId: failed.taskId,
        runningTaskId: running.taskId,
      },
      taskPresence,
      behavioral,
      headline: {
        boardScroll,
        burnBound: (burnBound ?? "").replace(/\s+/g, " ").trim(),
        panels,
        fontFloor,
        tasksTable1280,
        kpiNotes1280,
      },
      chipUntruncated,
      overflowCue,
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
          tasksTable1280,
          kpiNotes1280: { allOk: kpiNotes1280.allOk },
          honesty: Object.fromEntries(
            Object.entries(honesty).map(([k, v]) => [k, v.ok]),
          ),
          behavioral: {
            failPip: behavioral.failPip.ok,
            attentionOrder: behavioral.attentionOrder.ok,
            capAbsent: behavioral.capAbsent.ok,
            runnerStatuses: behavioral.runnerStatuses.ok,
            settled24h: behavioral.settled24h.ok,
          },
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
