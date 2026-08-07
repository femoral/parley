/**
 * Demo registry — single source of truth for verify runners.
 *
 * Screen tickets APPEND entries only (never reorder/delete others).
 * See packages/dashboard/src/screens/SCREENS.md § registration protocol.
 *
 * Each entry:
 *   ticket  — ledger dir name (issue-NNN)
 *   id      — demo key inside entry.json demos
 *   run     — async () => proof
 *   kind    — optional; "find-honesty" skips viewport triple check in check.mjs
 *   gates   — optional; (entry, ledgerEntry) => void | throws — ticket-specific
 *             merge gates. check.mjs calls this when present so screen tickets
 *             never need to hard-branch in check.mjs.
 */
import { runStagedDaemonDemo } from "./staged-daemon.mjs";
import { runInterceptErrorDemo } from "./intercept-error.mjs";
import { runReconnectDemo } from "./reconnect.mjs";
import { runShellChromeDemo, shellChromeGates } from "./shell-chrome.mjs";
import { runFindHonestyDemo } from "./find-honesty.mjs";
import { runTaskInspectorDemo, taskInspectorGates } from "./task-inspector.mjs";
import { runFleetBoardDemo, fleetBoardGates } from "./fleet-board.mjs";
import { runMetricsBoardDemo, metricsBoardGates } from "./metrics-board.mjs";
import { runRunDetailDemo, runDetailGates } from "./run-detail.mjs";
import { runConsoleRailsDemo, consoleRailsGates } from "./console-rails.mjs";

/**
 * @typedef {{
 *   ticket: string,
 *   id: string,
 *   run: () => Promise<object>,
 *   kind?: string,
 *   gates?: (entry: object, ledgerEntry: object) => void,
 * }} DemoRegistryEntry
 */

/** @type {DemoRegistryEntry[]} */
export const DEMO_REGISTRY = [
  // #353 harness
  { ticket: "issue-353", id: "staged-daemon", run: runStagedDaemonDemo },
  { ticket: "issue-353", id: "intercept-error", run: runInterceptErrorDemo },
  { ticket: "issue-353", id: "reconnect", run: runReconnectDemo },
  // #354 shell chrome
  {
    ticket: "issue-354",
    id: "shell-chrome",
    run: runShellChromeDemo,
    gates: shellChromeGates,
  },
  {
    ticket: "issue-354",
    id: "find-honesty",
    run: runFindHonestyDemo,
    kind: "find-honesty",
  },
  // #355 fleet board
  {
    ticket: "issue-355",
    id: "fleet-board",
    run: runFleetBoardDemo,
    gates: fleetBoardGates,
  },
  // #357 task inspector
  {
    ticket: "issue-357",
    id: "task-inspector",
    run: runTaskInspectorDemo,
    gates: taskInspectorGates,
  },
  // #358 metrics board
  {
    ticket: "issue-358",
    id: "metrics-board",
    run: runMetricsBoardDemo,
    gates: metricsBoardGates,
  },
  // #356 run detail
  {
    ticket: "issue-356",
    id: "run-detail",
    run: runRunDetailDemo,
    gates: runDetailGates,
  },
  // #363 console rails + AttentionCard
  {
    ticket: "issue-363",
    id: "console-rails",
    run: runConsoleRailsDemo,
    gates: consoleRailsGates,
  },
];

/** Group registry into TICKETS map: { "issue-354": ["shell-chrome", ...] } */
export function ticketsFromRegistry() {
  /** @type {Record<string, string[]>} */
  const out = {};
  for (const d of DEMO_REGISTRY) {
    if (!out[d.ticket]) out[d.ticket] = [];
    out[d.ticket].push(d.id);
  }
  return out;
}
