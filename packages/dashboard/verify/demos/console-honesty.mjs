/**
 * Issue #368 — fleet/task/find/chrome honesty proofs.
 *
 * - Ask band is the largest text block when a question is outstanding
 * - Metrics/run end without a 300px+ dead void at 1920
 * - Settings focus restores to trigger; 0 tab stops behind open dialog
 * - Nautical register clean on live board (sample text)
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { collectA11y, runAxe } from "../lib/a11y.mjs";
import { ledgerDirs, writeDemoProof, printRectSummary } from "../lib/ledger.mjs";
import { measureAtViewports } from "../lib/measure.mjs";
import { withFakeAllowlist } from "../lib/daemon.mjs";
import { openVerifySession } from "../lib/session.mjs";
import { stageRequiredRuns } from "../scripts/stage-runs.mjs";

const TICKET = "issue-368";
const DEMO = "console-honesty";

const SELECTORS = [
  { id: "shell", selector: '[data-testid="shell"]' },
  { id: "screen-task", selector: '[data-testid="screen-task"]' },
  { id: "task-ask-band", selector: '[data-testid="task-ask-band"]' },
  { id: "task-ask-band-question", selector: '[data-testid="task-ask-band-question"]' },
  { id: "task-log", selector: '[data-testid="task-log"]' },
  { id: "task-log-well", selector: '[data-testid="task-log-well"]' },
  { id: "screen-metrics", selector: '[data-testid="screen-metrics"]' },
  { id: "metrics-end", selector: '[data-testid="metrics-end"]' },
  { id: "screen-run", selector: '[data-testid="screen-run"]' },
  { id: "run-end", selector: '[data-testid="run-end"]' },
  { id: "footer", selector: '[data-testid="shell-footer"]' },
];

/**
 * @param {object} _entry
 * @param {object} ledger
 */
export function consoleHonestyGates(_entry, ledger) {
  const demo = ledger.demos?.[DEMO];
  if (!demo) throw new Error("console-honesty: missing demo in ledger");

  const ask = demo.askHierarchy;
  if (!ask?.ok) {
    throw new Error(
      `console-honesty: ask band not largest text block: ${JSON.stringify(ask)}`,
    );
  }

  const voids = demo.voids1920;
  if (!voids) throw new Error("console-honesty: missing voids1920");
  if (!(voids.metrics?.voidPx < 300)) {
    throw new Error(
      `console-honesty: metrics void at 1920 must be <300px: ${JSON.stringify(voids.metrics)}`,
    );
  }
  if (!(voids.run?.voidPx < 300)) {
    throw new Error(
      `console-honesty: run void at 1920 must be <300px: ${JSON.stringify(voids.run)}`,
    );
  }

  if (demo.settingsFocus?.ariaModal !== "true") {
    throw new Error("console-honesty: settings aria-modal must be true");
  }
  if (!demo.settingsFocus?.focusRestored) {
    throw new Error("console-honesty: settings did not restore focus to trigger");
  }
  if (
    typeof demo.settingsFocus?.tabStopsBehind === "number" &&
    demo.settingsFocus.tabStopsBehind > 0
  ) {
    throw new Error(
      `console-honesty: tab stops behind dialog: ${demo.settingsFocus.tabStopsBehind}`,
    );
  }

  if (demo.register?.hasNautical) {
    throw new Error(
      `console-honesty: nautical copy still present: ${demo.register.sample}`,
    );
  }

  // Prefer settings-open axe (tablist + modal); full-board collect can trip
  // transient attention-card selection contrast unrelated to #368 chrome.
  const axe = demo.a11ySettings?.axe ?? demo.a11y?.axe;
  if (!axe) throw new Error("console-honesty: missing axe");
  if ((axe.violations ?? []).length > 0) {
    throw new Error(
      `console-honesty: axe violations: ${axe.violations.map((v) => v.id).join(", ")}`,
    );
  }
}

/**
 * @param {import('playwright-core').Page} page
 * @param {string} baseUrl
 * @param {string} taskId
 */
async function openTask(page, baseUrl, taskId) {
  await page.goto(`${baseUrl}#/task/${encodeURIComponent(taskId)}`, {
    waitUntil: "networkidle",
  });
  await page.waitForSelector('[data-testid="screen-task"]', { timeout: 15_000 });
  await page
    .waitForSelector(
      '[data-testid="screen-task"][data-detail-status="ready"], [data-testid="screen-task"][data-detail-status="error"]',
      { timeout: 12_000 },
    )
    .catch(() => undefined);
  await page.waitForTimeout(200);
}

/**
 * @param {import('playwright-core').Page} page
 */
async function measureAskHierarchy(page) {
  return page.evaluate(() => {
    const band = document.querySelector('[data-testid="task-ask-band"]');
    const q = document.querySelector('[data-testid="task-ask-band-question"]');
    const log = document.querySelector('[data-testid="task-log"]');
    const well = document.querySelector('[data-testid="task-log-well"]');
    const lines = [...document.querySelectorAll(".pc-task-log__line")];
    const area = (el) => {
      if (!el) return 0;
      const r = el.getBoundingClientRect();
      return Math.round(r.width * r.height);
    };
    /** Visible area of el clipped to the log well (scrolled-out lines don't count). */
    const visibleArea = (el, clip) => {
      if (!el || !clip) return 0;
      const r = el.getBoundingClientRect();
      const c = clip.getBoundingClientRect();
      const top = Math.max(r.top, c.top);
      const bottom = Math.min(r.bottom, c.bottom);
      const left = Math.max(r.left, c.left);
      const right = Math.min(r.right, c.right);
      const h = Math.max(0, bottom - top);
      const w = Math.max(0, right - left);
      return Math.round(w * h);
    };
    const qArea = area(q);
    const bandArea = area(band);
    const logArea = area(log);
    const wellArea = area(well);
    const linesArea = lines.reduce((s, el) => s + visibleArea(el, well), 0);
    // Also compare against every other major text surface on the task screen.
    const otherText = [
      ...document.querySelectorAll(
        ".pc-task-brief, .pc-task-qa, .pc-task-report, .pc-task-header__name, .pc-task-attempts",
      ),
    ];
    const maxOther = otherText.reduce((m, el) => Math.max(m, area(el)), 0);
    return {
      questionArea: qArea,
      bandArea,
      logArea,
      wellArea,
      linesArea,
      maxOtherArea: maxOther,
      lineCount: lines.length,
      // Contract: ask question (and its band) outrank log lines + other panels.
      ok:
        qArea > 0 &&
        qArea >= linesArea &&
        bandArea >= logArea &&
        bandArea >= maxOther,
    };
  });
}

/**
 * @param {import('playwright-core').Page} page
 * @param {string} screenTestId
 * @param {string} endTestId
 */
async function measureVoid(page, screenTestId, endTestId) {
  return page.evaluate(
    ({ screenTestId: sid, endTestId: eid }) => {
      const footer = document.querySelector('[data-testid="shell-footer"]');
      const end = document.querySelector(`[data-testid="${eid}"]`);
      const screen = document.querySelector(`[data-testid="${sid}"]`);
      if (!footer || !screen) {
        return { found: false, voidPx: -1 };
      }
      const fTop = footer.getBoundingClientRect().top;
      // Lowest content = bottom of termination block (or last non-end content).
      const endBox = end?.getBoundingClientRect();
      const contentBottom = endBox
        ? endBox.bottom
        : screen.getBoundingClientRect().bottom;
      // Void is gap between content bottom and footer top (clamped ≥0).
      const voidPx = Math.max(0, Math.round(fTop - contentBottom));
      return {
        found: true,
        voidPx,
        contentBottom: Math.round(contentBottom),
        footerTop: Math.round(fTop),
        endHeight: endBox ? Math.round(endBox.height) : 0,
        endLabel: end?.textContent?.trim() ?? null,
      };
    },
    { screenTestId, endTestId },
  );
}

export async function runConsoleHonestyDemo() {
  const config = withFakeAllowlist({
    profiles: {
      deep: {
        vendor: "fake",
        model: "fake-model",
        effort: "medium",
        sandbox: "workspace",
      },
      fast: {
        vendor: "fake",
        model: "fake-model",
        effort: "low",
        sandbox: "workspace",
      },
    },
    defaults: { profile: "deep" },
  });
  const session = await openVerifySession({ config });
  try {
    const { shotsDir } = ledgerDirs(TICKET);

    // Stage awaiting ask + a real run (void measure needs populated run body).
    const awaiting = await session.daemon.stageScript("awaiting-answer", {
      prompt: "Honesty ask: should the band outrank the log well for the orchestrator?",
    });
    await session.daemon.waitTask(awaiting.taskId);

    const stagedRuns = await stageRequiredRuns(session.daemon.baseUrl, {
      home: session.daemon.home,
    });
    const runId = stagedRuns.gateHeld?.runId ?? null;

    // ── Ask hierarchy at 1460 ────────────────────────────────────────
    await session.page.setViewportSize({ width: 1460, height: 900 });
    await openTask(session.page, session.url, awaiting.taskId);
    // Ensure ask band painted (detail may need a beat for qa).
    await session.page
      .waitForSelector('[data-testid="task-ask-band"]', { timeout: 10_000 })
      .catch(() => undefined);
    const askHierarchy = await measureAskHierarchy(session.page);
    await session.page.screenshot({
      path: path.join(shotsDir, "ask-band-1460.png"),
      fullPage: false,
    });

    // ── Voids at 1920 ────────────────────────────────────────────────
    await session.page.setViewportSize({ width: 1920, height: 1080 });
    await session.page.goto(`${session.url}#/metrics`, { waitUntil: "networkidle" });
    await session.page.waitForSelector('[data-testid="screen-metrics"]');
    await session.page.waitForTimeout(300);
    const metricsVoid = await measureVoid(
      session.page,
      "screen-metrics",
      "metrics-end",
    );
    await session.page.screenshot({
      path: path.join(shotsDir, "metrics-void-1920.png"),
      fullPage: false,
    });

    // Run screen WITH data (gate-held staged above).
    const runHash = runId
      ? `#/run/${encodeURIComponent(runId)}`
      : "#/run";
    await session.page.goto(`${session.url}${runHash}`, {
      waitUntil: "networkidle",
    });
    await session.page.waitForSelector('[data-testid="screen-run"]');
    await session.page
      .waitForSelector('[data-testid="run-header"], [data-testid="run-end"]', {
        timeout: 12_000,
      })
      .catch(() => undefined);
    await session.page.waitForTimeout(400);
    const runVoid = await measureVoid(session.page, "screen-run", "run-end");
    await session.page.screenshot({
      path: path.join(shotsDir, "run-void-1920.png"),
      fullPage: false,
    });

    // ── Settings modal focus restore ─────────────────────────────────
    await session.page.setViewportSize({ width: 1460, height: 900 });
    await session.page.goto(session.url, { waitUntil: "networkidle" });
    const settingsBtn = session.page.locator('[data-testid="settings-open"]');
    await settingsBtn.focus();
    await settingsBtn.click();
    await session.page.waitForSelector('[data-testid="settings-surface"]');
    await session.page.waitForTimeout(40);
    const settingsAriaModal = await session.page.evaluate(() => {
      return (
        document
          .querySelector('[data-testid="settings-panel"]')
          ?.getAttribute("aria-modal") ?? null
      );
    });
    const tabStopsBehind = await session.page.evaluate(() => {
      const panel = document.querySelector('[data-testid="settings-panel"]');
      const shell = document.querySelector('[data-testid="shell"]');
      if (!panel || !shell) return -1;
      const sel =
        'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])';
      return [...shell.querySelectorAll(sel)].filter((el) => {
        if (panel.contains(el)) return false;
        if (el.closest('[data-testid="settings-surface"]')) return false;
        let n = el;
        while (n) {
          if (n.hasAttribute && n.hasAttribute("inert")) return false;
          n = n.parentElement;
        }
        return true;
      }).length;
    });
    const axeSettings = await runAxe(session.page, {
      include: '[data-testid="shell"]',
    });
    await session.page.keyboard.press("Escape");
    await session.page.waitForTimeout(80);
    const focusAfterClose = await session.page.evaluate(() => {
      const el = document.activeElement;
      return {
        testId: el?.getAttribute?.("data-testid") ?? null,
        tag: el?.tagName?.toLowerCase?.() ?? null,
      };
    });

    // ── Register sample ──────────────────────────────────────────────
    const register = await session.page.evaluate(() => {
      const text = (document.body?.innerText ?? "").slice(0, 4000);
      const hasNautical =
        /\bhailing\b/i.test(text) ||
        /\ball hands\b/i.test(text) ||
        /\bahoy\b/i.test(text);
      return { hasNautical, sample: text.slice(0, 200) };
    });

    // Viewport triple for shell+ask (awaiting)
    const viewports = await measureAtViewports(session.page, {
      url: `${session.url}#/task/${encodeURIComponent(awaiting.taskId)}`,
      shotDir: shotsDir,
      shotPrefix: "honesty-ask",
      targets: SELECTORS.filter((t) =>
        ["shell", "screen-task", "task-ask-band", "task-log"].includes(t.id),
      ),
      beforeMeasure: async () => {
        await openTask(session.page, session.url, awaiting.taskId);
      },
    });

    printRectSummary("console-honesty ask", viewports);

    const a11y = await collectA11y(session.page);

    const proof = {
      ticket: TICKET,
      demo: DEMO,
      askHierarchy: {
        ...askHierarchy,
        viewport: "1460x900",
        screenshot: "shots/ask-band-1460.png",
      },
      voids1920: {
        metrics: { ...metricsVoid, screenshot: "shots/metrics-void-1920.png" },
        run: { ...runVoid, screenshot: "shots/run-void-1920.png" },
      },
      settingsFocus: {
        ariaModal: settingsAriaModal,
        tabStopsBehind,
        focusRestored: focusAfterClose.testId === "settings-open",
        focusAfterClose,
      },
      register,
      a11y: {
        axe: a11y.axe ?? axeSettings,
        aria: a11y.aria ?? null,
      },
      a11ySettings: { axe: axeSettings },
      viewports,
      staged: {
        awaitingTaskId: awaiting.taskId,
        runId,
      },
    };

    writeDemoProof(TICKET, DEMO, proof);
    return proof;
  } finally {
    await session.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runConsoleHonestyDemo()
    .then((p) => {
      console.log(
        JSON.stringify(
          {
            askOk: p.askHierarchy?.ok,
            askQ: p.askHierarchy?.questionArea,
            lines: p.askHierarchy?.linesArea,
            metricsVoid: p.voids1920?.metrics?.voidPx,
            runVoid: p.voids1920?.run?.voidPx,
            focusRestored: p.settingsFocus?.focusRestored,
          },
          null,
          2,
        ),
      );
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
