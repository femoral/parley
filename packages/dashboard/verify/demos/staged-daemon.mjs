/**
 * Demo 1 — staged daemon state via a fake-vendor action script.
 *
 * Stages `report-success` against a real daemon, then measures the
 * placeholder shell at 1280 / 1460 / 1920. The shell does not yet render
 * task data (#347); we still prove the harness can stage wire state and
 * capture rendered geometry honestly.
 */
import { pathToFileURL } from "node:url";
import { runAxe, ariaSnapshot, keyboardWalk } from "../lib/a11y.mjs";
import { ledgerDirs, writeDemoProof, printRectSummary } from "../lib/ledger.mjs";
import { measureAtViewports } from "../lib/measure.mjs";
import { openVerifySession } from "../lib/session.mjs";

const TICKET = "issue-353";
const DEMO = "staged-daemon";

export async function runStagedDaemonDemo() {
  const session = await openVerifySession();
  try {
    const { taskId } = await session.daemon.stageScript("report-success");
    const task = await session.daemon.waitTask(taskId);
    if (/** @type {{ state?: string }} */ (task).state !== "completed") {
      throw new Error(
        `expected completed task, got ${/** @type {{ state?: string }} */ (task).state}`,
      );
    }

    // Confirm the wire has the staged report before we measure UI.
    const list = await fetch(`${session.daemon.baseUrl}/tasks`);
    const listBody = /** @type {{ tasks: Array<{ task_id: string, state: string, report?: unknown }> }} */ (
      await list.json()
    );
    const listed = listBody.tasks.find((t) => t.task_id === taskId);
    if (!listed || listed.state !== "completed" || !listed.report) {
      throw new Error("staged task missing from GET /tasks with report");
    }

    const { shotsDir } = ledgerDirs(TICKET);
    const viewports = await measureAtViewports(session.page, {
      url: session.url,
      shotDir: shotsDir,
      shotPrefix: DEMO,
    });

    // A11y + keyboard path at the mid viewport (1460).
    await session.page.setViewportSize({ width: 1460, height: 900 });
    await session.page.goto(session.url, { waitUntil: "networkidle" });
    await session.page.waitForSelector('[data-testid="shell"]');
    await session.page.evaluate(() => document.fonts.ready);
    const axe = await runAxe(session.page, { include: '[data-testid="shell"]' });
    const aria = await ariaSnapshot(session.page);
    const keys = await keyboardWalk(session.page, 8);

    const proof = {
      kind: "staged-daemon",
      description:
        "Fake-vendor script report-success → completed task on real daemon; " +
        "placeholder shell measured at board widths.",
      daemon: {
        taskId,
        state: listed.state,
        report: listed.report,
        port: session.daemon.port,
      },
      viewports,
      a11y: { axe, aria, keyboardWalk: keys },
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
  runStagedDaemonDemo().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
