import { memo } from "react";
import { Camera } from "./Camera.js";
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
}

/** Deterministic world layout: regions march along a row with a gentle vertical
 * stagger, so switching sessions reads as sailing along the coast. */
const REGION_STRIDE_X = 780;
const REGION_STAGGER_Y = 74;

/**
 * Layer 3 — the living cove (issue #69). One continuous sea holding every
 * session's region; the {@link Camera} sails to the active one. Prop-driven and
 * core-free: the app feeds it the projected regions and the current selection,
 * and CSS renders every entity's state and every ambient loop.
 *
 * Memoized for the same reason RosterPanel/InboxPanel are: the cockpit shell
 * re-renders every second for its clock, but `sessions` and `activeSessionId`
 * only change on an SSE transition or a session switch — so the cove reconciles
 * only when the sea actually changes, keeping idle work at the compositor.
 */
export const Scene = memo(function Scene({ sessions, activeSessionId, onSelectTask }: SceneProps) {
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
    </div>
  );
});
