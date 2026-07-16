import { memo } from "react";
import { Camera } from "./Camera.js";
import { EdgeAlerts, type EdgeAlertItem, type EdgeAlertSide } from "./EdgeAlerts.js";
import { Sea } from "./Sea.js";
import { SessionRegion, type SessionRegionData } from "./SessionRegion.js";

export interface SceneProps {
  /** The session regions to lay out — one per orchestrator session, projected
   * by the app's `projectScene`. Structurally the hooks-layer `SceneSession[]`. */
  sessions: SessionRegionData[];
  /** The roster's selected session (the camera target). `null` ("All hands")
   * frames the first region rather than filtering the sea. */
  activeSessionId: string | null;
  /** Selects the task represented by a clicked island. */
  onSelectTask: (taskId: string) => void;
  /** Selects a session from an edge-of-frame attention chip (camera sails there).
   * Wired to the roster's `selectSession` — same source of truth as the chips. */
  onSelectSession: (sessionId: string) => void;
}

/** Deterministic world layout: regions march along a row with a gentle vertical
 * stagger, so switching sessions reads as sailing along the coast. */
const REGION_STRIDE_X = 780;
const REGION_STAGGER_Y = 74;

/**
 * Build the edge-of-frame attention list: named sessions outside the framed
 * region that carry a hooks-layer attention rollup, ordered loudest-first
 * within each side. Membership, loudest state, and rank all arrive on
 * `session.attention` from `projectScene` — this only places them on a side
 * and sorts by the projected rank (never re-derives state sets).
 */
function edgeAlertsFor(
  placed: ReadonlyArray<{ session: SessionRegionData; dx: number }>,
  activeIndex: number,
): EdgeAlertItem[] {
  const activeDx = placed[activeIndex]?.dx ?? 0;
  const items: EdgeAlertItem[] = [];

  for (let i = 0; i < placed.length; i++) {
    if (i === activeIndex) continue;
    const { session, dx } = placed[i]!;
    // Open water (id null) has no roster select target — skip the chip.
    if (session.id === null || session.attention === null) continue;
    const side: EdgeAlertSide = dx < activeDx ? "left" : "right";
    items.push({
      sessionId: session.id,
      label: session.label,
      state: session.attention.state,
      count: session.attention.count,
      rank: session.attention.rank,
      side,
    });
  }

  // Loudest first within each side (hooks-projected rank); id tie-break.
  items.sort((a, b) => {
    if (a.side !== b.side) return a.side === "left" ? -1 : 1;
    if (a.rank !== b.rank) return a.rank - b.rank;
    return a.sessionId.localeCompare(b.sessionId);
  });

  return items;
}

/**
 * Layer 3 — the living cove (issue #69). One continuous sea holding every
 * session's region; the {@link Camera} sails to the active one. Prop-driven and
 * core-free: the app feeds it the projected regions and the current selection,
 * and CSS renders every entity's state and every ambient loop.
 *
 * Edge-of-frame attention chips (PRODUCT.md "is anything wrong?") surface when
 * an off-camera region carries awaiting / stalled / failed work — the rollup
 * is projected by the hooks layer so this file never re-derives state sets.
 *
 * Memoized for the same reason RosterPanel/InboxPanel are: the cockpit shell
 * re-renders every second for its clock, but `sessions` and `activeSessionId`
 * only change on an SSE transition or a session switch — so the cove reconciles
 * only when the sea actually changes, keeping idle work at the compositor.
 */
export const Scene = memo(function Scene({
  sessions,
  activeSessionId,
  onSelectTask,
  onSelectSession,
}: SceneProps) {
  if (sessions.length === 0) {
    return (
      <div className="pc-scene-view pc-scene-view--empty">
        <Sea />
        <div className="pc-scene-empty">
          <span className="pc-scene-empty__glyph" aria-hidden="true">
            ⚓
          </span>
          <p className="pc-scene-empty__body">
            The tide is calm and the cove is empty. Islands will rise as voyages set out.
          </p>
        </div>
      </div>
    );
  }

  const placed = sessions.map((session, i) => ({
    session,
    dx: i * REGION_STRIDE_X,
    dy: i % 2 === 0 ? -REGION_STAGGER_Y : REGION_STAGGER_Y,
  }));

  // "All hands" (null) frames the first region; a named selection frames its own,
  // falling back to the first if that session has already aged out of the sea.
  const activeIndex =
    activeSessionId === null ? 0 : Math.max(0, placed.findIndex((p) => p.session.id === activeSessionId));
  const active = placed[activeIndex] ?? placed[0]!;

  const label = active.session.id === null ? "open water" : active.session.label;
  const edgeItems = edgeAlertsFor(placed, activeIndex);

  return (
    <div className="pc-scene-view" role="group" aria-label={`The cove — sailing with ${label}`}>
      <Sea />
      <Camera offsetX={active.dx} offsetY={active.dy}>
        {placed.map(({ session, dx, dy }) => (
          <SessionRegion
            key={session.id ?? "open-water"}
            session={session}
            dx={dx}
            dy={dy}
            onSelectTask={onSelectTask}
          />
        ))}
      </Camera>
      {/* Edge chips live in viewport space (not the panning world) so they pin
          to the sea's left/right margins while the camera sails. */}
      <EdgeAlerts items={edgeItems} onSelectSession={onSelectSession} />
    </div>
  );
});
