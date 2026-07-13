import type { CSSProperties } from "react";
import { Plate, PlateHeader, Emblem, Stat } from "../primitives/index.js";
import { stateMetaFor } from "../tokens/state-meta.js";
import type { RosterGroup } from "./types.js";

export interface RosterPanelProps {
  /** State groups, already ordered by attention rank (hooks layer). */
  groups: RosterGroup[];
  totalTasks: number;
  activeTasks: number;
}

function Group({ group }: { group: RosterGroup }) {
  const meta = stateMetaFor(group.state);
  const dotStyle = { "--dot-color": meta.colorVar } as CSSProperties;
  const labelStyle = { "--group-color": meta.colorVar } as CSSProperties;
  return (
    <div>
      <div className="pc-roster__group-head">
        <span className="pc-state-dot" style={dotStyle} aria-hidden="true">
          {meta.glyph}
        </span>
        <span className="pc-roster__group-label" style={labelStyle}>
          {meta.label}
        </span>
        <span className="pc-roster__count">{group.tasks.length}</span>
      </div>
      {group.tasks.map((task) => (
        <div className="pc-roster__row" key={task.id}>
          <Emblem coat={task.coat} glyph={task.emblem} size={23} />
          <span className="pc-roster__row-body">
            <span className="pc-roster__name">{task.name}</span>
            <span className="pc-roster__meta">{task.meta}</span>
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * Layer 2 — the fleet roster (design-manifest §4.5/§4.6). Tasks grouped by state
 * in attention order, with a footer of totals. Plain props: the hooks layer does
 * the grouping/ordering via `@useparley/core`'s attention constants.
 */
export function RosterPanel({ groups, totalTasks, activeTasks }: RosterPanelProps) {
  return (
    <Plate padded={false} className="pc-roster">
      <PlateHeader
        icon="⚑"
        iconDark
        title="FLEET ROSTER"
        subtitle="every soul at sea"
        divider
      />
      <div className="pc-roster__scroll">
        {groups.length === 0 ? (
          <p className="pc-roster__empty">The cove is quiet — no voyages under way.</p>
        ) : (
          groups.map((group) => <Group key={group.state} group={group} />)
        )}
      </div>
      <div className="pc-roster__footer">
        <Stat value={String(totalTasks)} label="Total tasks" color="var(--brass)" />
        <Stat value={String(activeTasks)} label="Active" color="var(--state-running)" />
      </div>
    </Plate>
  );
}
