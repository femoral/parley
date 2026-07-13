import { memo, type CSSProperties } from "react";
import { Plate, PlateHeader, Emblem, Stat } from "../primitives/index.js";
import { stateMetaFor } from "../tokens/state-meta.js";
import type { RosterGroup, RosterSessionOption } from "./types.js";

export interface RosterPanelProps {
  /** State groups, already ordered by attention rank (hooks layer). */
  groups: RosterGroup[];
  /** Distinct orchestrator sessions among the roster's tasks. */
  sessions: RosterSessionOption[];
  /** The active session (`null` = every session). Selecting a session doesn't
   * filter the roster (it's the future scene's camera cue); it only marks
   * which session chip reads active. */
  selectedSessionId: string | null;
  onSelectSession: (id: string | null) => void;
  /** The selected task (feeds the inspector/scene, built in later tickets). */
  selectedTaskId: string | null;
  onSelectTask: (id: string) => void;
  totalTasks: number;
  activeTasks: number;
}

function Group({
  group,
  selectedTaskId,
  onSelectTask,
}: {
  group: RosterGroup;
  selectedTaskId: string | null;
  onSelectTask: (id: string) => void;
}) {
  const meta = stateMetaFor(group.state);
  const dotStyle = { "--dot-color": meta.colorVar } as CSSProperties;
  const labelStyle = { "--group-color": meta.colorVar } as CSSProperties;
  // Quiet/dimmed terminals and the beacon flag both come from the layer-0
  // state language (manifest §5) — this layer never re-derives state sets.
  const rowStyle = meta.dim !== undefined ? { opacity: meta.dim } : undefined;

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
      {group.tasks.map((task) => {
        const selected = task.id === selectedTaskId;
        return (
          <button
            type="button"
            className={`pc-roster__row${selected ? " pc-roster__row--selected" : ""}`}
            style={rowStyle}
            key={task.id}
            aria-pressed={selected}
            onClick={() => onSelectTask(task.id)}
          >
            <Emblem coat={task.coat} glyph={task.emblem} size={23} />
            <span className="pc-roster__row-body">
              <span className="pc-roster__name">{task.name}</span>
              <span className="pc-roster__meta">{task.meta}</span>
            </span>
            {meta.beacon && (
              <span className="pc-roster__beacon pc-dot--beacon" aria-hidden="true">
                {meta.glyph}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function SessionSelector({
  sessions,
  selectedSessionId,
  onSelectSession,
}: {
  sessions: RosterSessionOption[];
  selectedSessionId: string | null;
  onSelectSession: (id: string | null) => void;
}) {
  if (sessions.length === 0) return null;
  return (
    <div className="pc-roster__sessions" role="group" aria-label="Orchestrator sessions">
      <button
        type="button"
        className={`pc-roster__session${selectedSessionId === null ? " pc-roster__session--active" : ""}`}
        aria-pressed={selectedSessionId === null}
        onClick={() => onSelectSession(null)}
      >
        All hands
      </button>
      {sessions.map((session) => (
        <button
          key={session.id}
          type="button"
          className={`pc-roster__session${
            selectedSessionId === session.id ? " pc-roster__session--active" : ""
          }`}
          aria-pressed={selectedSessionId === session.id}
          onClick={() => onSelectSession(session.id)}
        >
          <span aria-hidden="true">⚓</span> {session.label}
          <span className="pc-roster__session-count">{session.count}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * Layer 2 — the fleet roster (design-manifest §4.5/§4.6). Tasks grouped by state
 * in attention order, with a session selector (the future scene's camera cue)
 * and row selection (feeds the inspector/scene, built in later tickets). Plain
 * props throughout: the hooks layer does the grouping/ordering via
 * `@useparley/core`'s attention constants and owns the selection state.
 * Memoized — the cockpit shell re-renders every second for its clock, and all
 * roster props are identity-stable between snapshot updates.
 */
export const RosterPanel = memo(function RosterPanel({
  groups,
  sessions,
  selectedSessionId,
  onSelectSession,
  selectedTaskId,
  onSelectTask,
  totalTasks,
  activeTasks,
}: RosterPanelProps) {
  return (
    <Plate padded={false} className="pc-roster">
      <PlateHeader
        icon="⚑"
        iconDark
        title="FLEET ROSTER"
        subtitle="every soul at sea"
        divider
      />
      <SessionSelector
        sessions={sessions}
        selectedSessionId={selectedSessionId}
        onSelectSession={onSelectSession}
      />
      <div className="pc-roster__scroll">
        {groups.length === 0 ? (
          <p className="pc-roster__empty">The cove is quiet — no voyages under way.</p>
        ) : (
          groups.map((group) => (
            <Group
              key={group.state}
              group={group}
              selectedTaskId={selectedTaskId}
              onSelectTask={onSelectTask}
            />
          ))
        )}
      </div>
      <div className="pc-roster__footer">
        <Stat value={String(totalTasks)} label="Total tasks" color="var(--brass)" />
        <Stat value={String(activeTasks)} label="Active" color="var(--state-running)" />
      </div>
    </Plate>
  );
});
