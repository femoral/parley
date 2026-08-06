/**
 * Demo 2 — interception-forced per-panel error state.
 *
 * Playwright route interception fulfills GET /tasks (and /health) with 500s.
 * No test hooks in shipped code. Measures what the placeholder shell paints
 * today while the intercept is active (honest: shell is still static scaffold).
 */
import { pathToFileURL } from "node:url";
import { collectA11y } from "../lib/a11y.mjs";
import { interceptError } from "../lib/honesty.mjs";
import { ledgerDirs, writeDemoProof, printRectSummary } from "../lib/ledger.mjs";
import { measureAtViewports } from "../lib/measure.mjs";
import { openVerifySession } from "../lib/session.mjs";

const TICKET = "issue-353";
const DEMO = "intercept-error";

export async function runInterceptErrorDemo() {
  const session = await openVerifySession();
  try {
    // Stage a healthy task first so the real daemon would have data —
    // then force the browser-facing routes to fail.
    const { taskId } = await session.daemon.stageScript("report-success");
    await session.daemon.waitTask(taskId);

    // Need a document origin before same-origin fetch / route intercepts apply.
    await session.page.goto(session.url, { waitUntil: "networkidle" });
    await session.page.waitForSelector('[data-testid="shell"]');

    await interceptError(session.page, {
      url: "**/tasks**",
      status: 500,
      body: {
        error: "forced panel error (verify harness)",
        code: "VERIFY_INTERCEPT",
      },
    });
    await interceptError(session.page, {
      url: "**/health**",
      status: 503,
      body: { error: "forced health failure (verify harness)" },
    });

    // Prove the intercept actually fires before measuring UI.
    // Browser same-origin routes are forced; Node-side daemon remains healthy
    // (Playwright routes only intercept the browser context).
    const probe = await session.page.evaluate(async () => {
      const tasks = await fetch("/tasks").then(async (r) => ({
        status: r.status,
        body: await r.json().catch(() => null),
      }));
      const health = await fetch("/health").then(async (r) => ({
        status: r.status,
        body: await r.json().catch(() => null),
      }));
      return { tasks, health };
    });
    const daemonWire = await fetch(`${session.daemon.baseUrl}/tasks`).then(async (r) => ({
      status: r.status,
      count: (await r.json()).tasks?.length ?? null,
    }));
    probe.daemonWire = daemonWire;

    if (probe.tasks.status !== 500) {
      throw new Error(`expected intercepted /tasks 500, got ${probe.tasks.status}`);
    }
    if (probe.health.status !== 503) {
      throw new Error(`expected intercepted /health 503, got ${probe.health.status}`);
    }
    if (probe.daemonWire.status !== 200) {
      throw new Error(
        `expected healthy daemon wire GET /tasks 200, got ${probe.daemonWire.status}`,
      );
    }

    const { shotsDir } = ledgerDirs(TICKET);
    const viewports = await measureAtViewports(session.page, {
      url: session.url,
      shotDir: shotsDir,
      shotPrefix: DEMO,
      beforeMeasure: async () => {
        // Re-arm is not needed (routes persist); ensure fonts ready already done.
      },
    });

    // A11y under forced error routes (shell still scaffold; scan is still real).
    await session.page.setViewportSize({ width: 1460, height: 900 });
    await session.page.goto(session.url, { waitUntil: "networkidle" });
    await session.page.waitForSelector('[data-testid="shell"]');
    const a11y = await collectA11y(session.page);

    const proof = {
      kind: "intercept-error",
      description:
        "Playwright route interception forces /tasks 500 and /health 503; " +
        "shell measured under forced error paths (scaffold UI, no error chrome yet).",
      intercept: {
        routes: [
          { url: "**/tasks**", status: 500 },
          { url: "**/health**", status: 503 },
        ],
        probe,
      },
      daemon: {
        taskId,
        // Real daemon still healthy — honesty is browser-route-only.
        note: "daemon wire remains healthy; failure is client-intercept only",
      },
      viewports,
      a11y,
    };
    const entryPath = writeDemoProof(TICKET, DEMO, proof);
    printRectSummary(DEMO, viewports);
    console.log(`ledger entry: ${entryPath}`);
    return proof;
  } finally {
    await session.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runInterceptErrorDemo().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
