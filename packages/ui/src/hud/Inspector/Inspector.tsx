import { memo, useState } from "react";
import { Badge, Divider, Emblem, Plate } from "../../primitives/index.js";
import { stateMetaFor } from "../../tokens/state-meta.js";
import { BriefTab } from "./BriefTab.js";
import { LogsTab } from "./LogsTab.js";
import { ReportTab } from "./ReportTab.js";
import { QaTab } from "./QaTab.js";
import type { InspectorTask } from "../types.js";

const TABS = [
  { key: "brief", label: "BRIEF" },
  { key: "logs", label: "LOGS" },
  { key: "report", label: "REPORT" },
  { key: "qa", label: "Q&A" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

export interface InspectorProps {
  /** The selected task's full inspector payload, or `null` when the roster
   * has no selection — renders a quiet placeholder rather than empty tabs. */
  task: InspectorTask | null;
  /** Corner flourishes (design-manifest §4.1 lists the inspector among the
   * premium plates that carry them), gated by the settings bar's "Ornaments"
   * toggle (#70). Defaults off to match this component's pre-#70 look. */
  ornaments?: boolean;
}

/**
 * Layer 2 — the active task inspector (design-manifest §4.17, #68). Premium
 * plate; header (faction emblem, "ACTIVE INSPECTOR" kicker, name + mono id,
 * state badge, eval score badge when present); a four-tab bar (Brief | Logs |
 * Report | Q&A) with local tab-selection state (ephemeral UI state owned
 * here, same as `InboxCard`'s draft text — not a fetch, contract 2 is about
 * data, not interaction state); a scrollable body per tab. Plain props
 * throughout — the hooks layer (`useTaskDetail`, `useLogTail`,
 * `projectInspector`) does every fetch and projection. Memoized like
 * `RosterPanel`/`InboxPanel` — the cockpit shell re-renders every second for
 * its clock, and `task` is identity-stable between real data changes (the
 * hooks layer memoizes the projection).
 */
export const Inspector = memo(function Inspector({ task, ornaments = false }: InspectorProps) {
  const [active, setActive] = useState<TabKey>("brief");

  if (!task) {
    return (
      <Plate variant="premium" className="pc-inspector pc-inspector--empty">
        <p className="pc-inspector__placeholder">
          <span aria-hidden="true">⚓</span> Select a soul from the roster to open the ship's log.
        </p>
      </Plate>
    );
  }

  const meta = stateMetaFor(task.state);

  return (
    <Plate variant="premium" padded={false} ornaments={ornaments} className="pc-inspector">
      <div className="pc-inspector__head">
        <Emblem coat={task.coat} glyph={task.emblem} size={28} />
        <div className="pc-inspector__head-titles">
          <span className="pc-inspector__kicker">ACTIVE INSPECTOR</span>
          <span className="pc-inspector__name">{task.name}</span>
          <span className="pc-inspector__id">{task.id}</span>
        </div>
        <div className="pc-inspector__head-aside">
          {task.evalScore !== null && (
            <Badge label={`★ ${task.evalScore}/10`} color="var(--brass)" />
          )}
          <Badge label={meta.label} glyph={meta.glyph} color={meta.colorVar} />
        </div>
      </div>
      <Divider />
      <div className="pc-inspector__tabs" role="tablist" aria-label="Task inspector">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            type="button"
            role="tab"
            aria-selected={active === tab.key}
            className={`pc-inspector__tab${active === tab.key ? " pc-inspector__tab--active" : ""}`}
            onClick={() => setActive(tab.key)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div className="pc-inspector__body" role="tabpanel">
        {active === "brief" && <BriefTab brief={task.brief} />}
        {active === "logs" && <LogsTab logs={task.logs} />}
        {active === "report" && <ReportTab report={task.report} />}
        {active === "qa" && <QaTab qa={task.qa} coat={task.coat} emblem={task.emblem} />}
      </div>
    </Plate>
  );
});
