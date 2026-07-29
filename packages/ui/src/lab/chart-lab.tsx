/**
 * Chart measurement lab — a dev-only fixture, never bundled into `www`.
 *
 * It mounts the **real** `RunChart` inside the **real** cockpit column
 * geometry, so the sheet resolves the same CSS-px scale it does in the
 * product. That is the whole point: the unit suite runs under happy-dom,
 * which performs no layout, so every question about where ink actually lands
 * — overprint, clipping, below-the-fold, the px↔viewBox scale bridge — is
 * unanswerable there. See `packages/ui/lab/README.md`.
 *
 * Driven by query params so a sweep can address one cell per navigation:
 *
 *   ?n=8&held=0&workflow=research&sparse=0
 *
 * The page sets `data-lab-ready` on <html> once fonts have settled, which is
 * the only sound signal to measure on — text metrics move under a fallback
 * face and every ink measurement taken before that is wrong.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../fonts.js";
import "../tokens/tokens.css";
import "../base.css";
import "../app/cockpit.css";
import { Cartouche, DayChip, ChartKey, SettingsBar } from "../hud/index.js";
import { RunChart } from "../chart/index.js";
import type { InspectorRunNode, InspectorRunReady } from "../hud/types.js";

const params = new URLSearchParams(location.search);
const nodeCount = Math.max(0, Number(params.get("n") ?? "8"));
const heldGate = params.get("held") === "1";
const workflow = params.get("workflow") ?? "research";

/**
 * Node names cycle a plausible research trail. Beyond one lap they gain a
 * `-2`, `-3` suffix so every mark's label stays distinct — label collision is
 * one of the things worth measuring, and duplicate names would mask it.
 */
const NODE_NAMES = [
  "search",
  "gather-sources",
  "outline",
  "draft",
  "review-gate",
  "revise",
  "fact-check",
  "polish",
] as const;

/**
 * Spread the full ink vocabulary across the trail so a render exercises every
 * state's colour and glyph: completed → done, running → live, failed → fail,
 * queued → ghost, plus the held gate when asked for.
 */
function nodeState(index: number, count: number, isGate: boolean): string {
  if (isGate) return "waiting";
  if (index === Math.floor(count / 2)) return "failed";
  if (index < count - 3) return "completed";
  if (index === count - 3) return "running";
  return "queued";
}

/**
 * Inspector node keys are `node\0iteration` — a NUL separator, so a node name
 * containing the separator cannot forge another node's key. Spelled as an
 * escape rather than a literal byte: a raw NUL makes git treat the source as
 * binary and stop diffing it.
 */
const KEY_SEP = "\u0000";

function labNode(index: number, count: number): InspectorRunNode {
  const lap = Math.floor(index / NODE_NAMES.length);
  const name = `${NODE_NAMES[index % NODE_NAMES.length]}${lap > 0 ? `-${lap + 1}` : ""}`;
  const isGate = heldGate && index === count - 1;
  const state = nodeState(index, count, isGate);
  return {
    key: `${name}${KEY_SEP}1`,
    node: name,
    kind: isGate ? "gate" : "step",
    iteration: 1,
    state,
    stateLabel: state,
    tasksLabel: isGate ? "—" : "1",
    gist: "—",
    age: state === "running" ? "2m" : null,
    fanoutWidth: null,
    spineState: state,
    live: state === "running",
    onReject: null,
  };
}

const run: InspectorRunReady = {
  status: "ready",
  id: "r-chart01abcdef",
  workflow,
  workflowVersion: 1,
  runState: "running",
  stateLabel: "running",
  branch: null,
  currentNode: NODE_NAMES[0],
  iteration: 1,
  duration: "12m 0s",
  tasksTotal: 41,
  heldGate,
  deliverables: { status: "not_fetched" },
  block: null,
  nodes: Array.from({ length: nodeCount }, (_, i) => labNode(i, nodeCount)),
};

/**
 * The cockpit triptych, reproduced structurally rather than mocked: the rails
 * are what pin the centre stage's width, and the centre stage's width is what
 * sets the sheet's scale. Their *contents* are irrelevant to that, so they are
 * plain filled boxes — but their classes and the layout wrapper are the real
 * ones, because that is what the CSS measures against.
 */
function ChartLab() {
  return (
    <div className="pc-cockpit">
      <div className="pc-cockpit__layout">
        <main className="pc-cockpit__main" aria-label="Cockpit board">
          <section className="pc-region--roster" aria-label="Fleet roster">
            <div style={{ flex: 1, background: "rgba(0,0,0,.2)" }} />
          </section>
          <section className="pc-region--center" aria-label="Run chart">
            <div className="pc-center__head">
              <div className="pc-center__title-stack">
                <Cartouche />
              </div>
              <DayChip day={1} daemonUptimeDays={1} clock="09:41" />
            </div>
            <div className="pc-chart-stage">
              <RunChart run={run} />
            </div>
          </section>
          <section className="pc-region--right" aria-label="Status stack">
            <div style={{ flex: 1, background: "rgba(0,0,0,.2)" }} />
          </section>
        </main>
        <footer className="pc-settings-row" aria-label="Chart key and settings">
          <ChartKey />
          <nav className="pc-footer-nav" aria-label="Cockpit views">
            <button type="button" className="pc-footer-nav__tab pc-footer-nav__tab--active">
              Cove
            </button>
            <button type="button" className="pc-footer-nav__tab">
              Soundings
            </button>
          </nav>
          <SettingsBar
            showKit={false}
            followLogs
            shortcuts
            onToggleShowKit={() => {}}
            onToggleFollowLogs={() => {}}
            onToggleShortcuts={() => {}}
          />
        </footer>
      </div>
    </div>
  );
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <ChartLab />
    </StrictMode>,
  );
  // Ink measurements taken under a fallback face are wrong — Cinzel and IM
  // Fell shape very differently from the system stack. Sweeps wait on this.
  void document.fonts.ready.then(() => {
    document.documentElement.dataset.labReady = "true";
  });
}
