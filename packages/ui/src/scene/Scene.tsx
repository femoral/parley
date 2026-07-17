import { memo, useCallback, useLayoutEffect, useRef, useState } from "react";
import { Mark } from "../primitives/index.js";
import { MARK_ANCHOR } from "../tokens/chrome-glyphs.js";
import { Camera } from "./Camera.js";
import { EdgeAlerts, type EdgeAlertItem, type EdgeAlertSide } from "./EdgeAlerts.js";
import { fnv1a } from "./layout.js";
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
  /**
   * True before the first snapshot has resolved. Distinguishes "taking
   * soundings" from a genuinely empty cove (PRODUCT.md honesty).
   */
  connecting?: boolean;
}

/** Deterministic world layout: regions march along a row with a gentle vertical
 * stagger, so switching sessions reads as sailing along the coast. */
const REGION_STRIDE_X = 780;
const REGION_STAGGER_Y = 74;

/** Stable map key for a session id (`null` = open-water region). */
function regionKey(sessionId: string | null): string {
  return sessionId ?? "open-water";
}

/**
 * Stable world offset for a session, pure function of its id (never array index).
 * Mirrors island seeding in layout.ts: FNV-1a of the id → slot + stagger, so a
 * given session always pans in from the same direction across reorders/switches.
 * Open water anchors the origin.
 */
export function regionWorldOffset(sessionId: string | null): { dx: number; dy: number } {
  if (sessionId === null) {
    return { dx: 0, dy: -REGION_STAGGER_Y };
  }
  const h = fnv1a(sessionId);
  // Signed slots along the coast; range is wide enough for a typical fleet while
  // keeping pans finite. Rare collisions stack two regions (edge-alert side still
  // resolves; the camera still frames the active id).
  const slot = (h % 31) - 15;
  return {
    dx: slot * REGION_STRIDE_X,
    dy: (h & 1) === 0 ? -REGION_STAGGER_Y : REGION_STAGGER_Y,
  };
}

/**
 * Build the edge-of-frame attention list: named sessions outside the framed
 * region that carry a hooks-layer attention rollup, ordered loudest-first
 * within each side. Membership, loudest state, and rank all arrive on
 * `session.attention` from `projectScene` — this only places them on a side
 * and sorts by the projected rank (never re-derives state sets).
 *
 * Placement uses id-stable world offsets, not array index, so chip sides stay
 * consistent when the sessions array is reordered.
 */
function edgeAlertsFor(
  placed: ReadonlyArray<{ session: SessionRegionData; dx: number }>,
  activeDx: number,
  activeKey: string,
): EdgeAlertItem[] {
  const items: EdgeAlertItem[] = [];

  for (const { session, dx } of placed) {
    if (regionKey(session.id) === activeKey) continue;
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
 * Layer 3 — the living cove (issue #69, active-region mount #129). Only the
 * framed session's region stays mounted; on a switch the outgoing region
 * remains just long enough for the camera pan, then unmounts on the world's
 * `transitionend`. Prop-driven and core-free: the app feeds projected regions
 * and the current selection; CSS owns travel duration/easing.
 *
 * Edge-of-frame attention chips (PRODUCT.md "is anything wrong?") surface when
 * an off-camera region carries awaiting / stalled / failed work — the rollup
 * is projected by the hooks layer so this file never re-derives state sets.
 * Chips live in viewport space and do not require off-camera regions mounted.
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
  connecting = false,
}: SceneProps) {
  if (sessions.length === 0) {
    return (
      <div className="pc-scene-view pc-scene-view--empty">
        <Sea />
        <div className="pc-scene-empty" role={connecting ? "status" : undefined}>
          <span className="pc-scene-empty__glyph" aria-hidden="true">
            <Mark mark={MARK_ANCHOR} size={42} />
          </span>
          {connecting ? (
            <>
              <p className="pc-scene-empty__title">Taking soundings…</p>
              <p className="pc-scene-empty__body">
                Charting the cove — islands will rise as the fleet reports in.
              </p>
            </>
          ) : (
            <p className="pc-scene-empty__body">
              The tide is calm and the cove is empty. Islands will rise as voyages set out.
            </p>
          )}
        </div>
      </div>
    );
  }

  return (
    <SceneWithRegions
      sessions={sessions}
      activeSessionId={activeSessionId}
      onSelectTask={onSelectTask}
      onSelectSession={onSelectSession}
    />
  );
});

/**
 * Non-empty cove body. Split from the empty branch so hooks for departing-region
 * lifetime only run when there is a world to pan.
 */
function SceneWithRegions({
  sessions,
  activeSessionId,
  onSelectTask,
  onSelectSession,
}: {
  sessions: SessionRegionData[];
  activeSessionId: string | null;
  onSelectTask: (taskId: string) => void;
  onSelectSession: (sessionId: string) => void;
}) {
  const placed = sessions.map((session) => {
    const { dx, dy } = regionWorldOffset(session.id);
    return { session, dx, dy };
  });

  // "All hands" (null) frames the first region; a named selection frames its own,
  // falling back to the first if that session has already aged out of the sea.
  const activeIndex =
    activeSessionId === null
      ? 0
      : Math.max(
          0,
          placed.findIndex((p) => p.session.id === activeSessionId),
        );
  const active = placed[activeIndex] ?? placed[0]!;
  const activeKey = regionKey(active.session.id);

  // Snapshot of every session we've seen while mounted, so a departing region
  // can finish its pan even if it drops from the live sessions array mid-travel.
  const snapshotRef = useRef(new Map<string, SessionRegionData>());
  for (const s of sessions) {
    snapshotRef.current.set(regionKey(s.id), s);
  }
  // Always refresh the active entry (live data for the framed region).
  snapshotRef.current.set(activeKey, active.session);

  // Departing region key stays mounted until the camera's transform transition
  // ends. `undefined` = no departing guest. Adjusted during render when the
  // framed key changes (React's "adjusting state when a prop changes" pattern).
  const [departingKey, setDepartingKey] = useState<string | undefined>(undefined);
  const [trackedActiveKey, setTrackedActiveKey] = useState(activeKey);

  if (activeKey !== trackedActiveKey) {
    setTrackedActiveKey(activeKey);
    setDepartingKey(trackedActiveKey);
  }

  const handleTravelEnd = useCallback(() => {
    setDepartingKey(undefined);
  }, []);

  // If the camera offset does not change (hash collision / same slot), no
  // transform transition runs and transitionend never fires — drop the guest.
  useLayoutEffect(() => {
    if (departingKey === undefined || departingKey === activeKey) return;
    const snap = snapshotRef.current.get(departingKey);
    if (!snap) return;
    const off = regionWorldOffset(snap.id);
    if (off.dx === active.dx && off.dy === active.dy) {
      setDepartingKey(undefined);
    }
  }, [departingKey, activeKey, active.dx, active.dy]);

  const mountedKeys = new Set<string>([activeKey]);
  if (departingKey !== undefined && departingKey !== activeKey) {
    mountedKeys.add(departingKey);
  }

  const mountedRegions: Array<{
    session: SessionRegionData;
    dx: number;
    dy: number;
    active: boolean;
    key: string;
  }> = [];

  for (const key of mountedKeys) {
    const session =
      key === activeKey ? active.session : snapshotRef.current.get(key);
    if (!session) continue;
    const { dx, dy } = regionWorldOffset(session.id);
    mountedRegions.push({
      session,
      dx,
      dy,
      active: key === activeKey,
      key,
    });
  }

  const label = active.session.id === null ? "open water" : active.session.label;
  // Edge chips consider the full fleet (projected attention), not only mounted
  // regions — off-camera work stays visible without resident island DOM.
  const edgeItems = edgeAlertsFor(placed, active.dx, activeKey);

  return (
    <div className="pc-scene-view" role="group" aria-label={`The cove — sailing with ${label}`}>
      <Sea />
      <Camera offsetX={active.dx} offsetY={active.dy} onTravelEnd={handleTravelEnd}>
        {mountedRegions.map(({ session, dx, dy, active: isActive, key }) => (
          <SessionRegion
            key={key}
            session={session}
            dx={dx}
            dy={dy}
            active={isActive}
            onSelectTask={onSelectTask}
          />
        ))}
      </Camera>
      {/* Edge chips live in viewport space (not the panning world) so they pin
          to the sea's left/right margins while the camera sails. */}
      <EdgeAlerts items={edgeItems} onSelectSession={onSelectSession} />
    </div>
  );
}
