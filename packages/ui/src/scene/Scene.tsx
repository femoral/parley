import { memo, useCallback, useLayoutEffect, useRef, useState } from "react";
import { Mark } from "../primitives/index.js";
import { MARK_ANCHOR } from "../tokens/chrome-glyphs.js";
import { Camera } from "./Camera.js";
import { EdgeAlerts, type EdgeAlertItem, type EdgeAlertSide } from "./EdgeAlerts.js";
import { fnv1a } from "./layout.js";
import { Sea } from "./Sea.js";
import { SailingScene } from "./SailingScene.js";
import { SessionRegion, type SessionRegionData } from "./SessionRegion.js";

/**
 * Camera cue from task selection (hooks-layer {@link SceneFrameIntent}).
 * `sessionKey` is a region key (session id or `"open-water"`); `seq` bumps on
 * every select so the scene can re-apply after the camera has moved elsewhere.
 */
export interface SceneFrameIntentProp {
  sessionKey: string;
  seq: number;
}

export interface SceneProps {
  /** The session regions to lay out — one per orchestrator session, projected
   * by the app's `projectScene`. Structurally the hooks-layer `SceneSession[]`. */
  sessions: SessionRegionData[];
  /** The roster's selected session (the camera target). `null` ("All hands")
   * frames the loudest attention region rather than filtering the sea. */
  activeSessionId: string | null;
  /** Selects the task represented by a clicked island. */
  onSelectTask: (taskId: string) => void;
  /** Selects a session from an edge-of-frame attention chip (camera sails there).
   * Wired to the roster's `selectSession` — same source of truth as the chips.
   * Not called for the open-water chip (no roster filter target). */
  onSelectSession: (sessionId: string) => void;
  /**
   * Task-selection camera cue: when `seq` advances, frame `sessionKey` via the
   * manual-frame path if that region is not already on camera. Does not change
   * the roster session filter — only the camera sails.
   */
  frameIntent?: SceneFrameIntentProp | null;
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
 * All-hands camera target: the region with the highest-priority (lowest rank)
 * attention rollup. Calm regions rank as Infinity. Tie-break is first-placed
 * (stable projection order from `projectScene`).
 *
 * PRODUCT.md attention hierarchy is law — a fresh wreck or awaiting ship must
 * read on-camera under "All hands", not sit off-frame behind placed[0].
 */
export function loudestRegionIndex(
  placed: ReadonlyArray<{ session: SessionRegionData }>,
): number {
  let best = 0;
  let bestRank = Infinity;
  for (let i = 0; i < placed.length; i++) {
    const rank = placed[i]!.session.attention?.rank ?? Infinity;
    if (rank < bestRank) {
      bestRank = rank;
      best = i;
    }
  }
  return best;
}

/**
 * Resolve which placed region the camera frames.
 * - Manual open-water chip focus wins (no roster filter).
 * - Named roster selection frames that session (fallback to loudest if aged out).
 * - "All hands" (null) frames the loudest attention region.
 */
export function resolveFramedIndex(
  placed: ReadonlyArray<{ session: SessionRegionData }>,
  activeSessionId: string | null,
  manualFrameKey: string | undefined,
): number {
  if (placed.length === 0) return 0;
  if (manualFrameKey !== undefined) {
    const manual = placed.findIndex((p) => regionKey(p.session.id) === manualFrameKey);
    if (manual >= 0) return manual;
  }
  if (activeSessionId !== null) {
    const named = placed.findIndex((p) => p.session.id === activeSessionId);
    if (named >= 0) return named;
  }
  return loudestRegionIndex(placed);
}

/**
 * Sentinel rank for calm presence chips — always stacks after real attention
 * ranks from core (awaiting/stalled/failed), so loud work stays louder.
 */
const QUIET_EDGE_RANK = Number.POSITIVE_INFINITY;

/**
 * Build the edge-of-frame chip list: off-frame regions with an attention
 * rollup (loud), plus calm off-frame regions that still hold tasks (quiet
 * presence — so a second coast is never invisible on the sea).
 *
 * Attention membership, loudest state, and rank arrive on `session.attention`
 * from `projectScene` — this only places them on a side and sorts by rank
 * (never re-derives state sets). Quiet chips use task count + a sentinel rank.
 *
 * Includes the open-water region (session.id null) when it holds attention or
 * calm tasks — session-less work must still read at the edge.
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
    const side: EdgeAlertSide = dx < activeDx ? "left" : "right";
    if (session.attention !== null) {
      items.push({
        sessionId: session.id,
        label: session.label,
        state: session.attention.state,
        count: session.attention.count,
        rank: session.attention.rank,
        side,
      });
      continue;
    }
    // Calm presence: whisper chip when the region still has work at sea.
    const taskCount = session.tasks.length;
    if (taskCount === 0) continue;
    items.push({
      sessionId: session.id,
      label: session.label,
      state: "quiet",
      count: taskCount,
      rank: QUIET_EDGE_RANK,
      side,
      quiet: true,
    });
  }

  // Loudest first within each side (hooks-projected rank; quiet last); id tie-break.
  items.sort((a, b) => {
    if (a.side !== b.side) return a.side === "left" ? -1 : 1;
    if (a.rank !== b.rank) return a.rank - b.rank;
    const ka = a.sessionId ?? "";
    const kb = b.sessionId ?? "";
    return ka.localeCompare(kb);
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
 * Edge-of-frame chips (PRODUCT.md "is anything wrong?" + fleet presence)
 * surface when an off-camera region carries awaiting / stalled / failed work
 * (loud) or calm tasks (quiet whisper) — attention rollups are projected by
 * the hooks layer so this file never re-derives state sets. Chips live in
 * viewport space and do not require off-camera regions mounted.
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
  frameIntent = null,
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
      frameIntent={frameIntent}
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
  frameIntent,
}: {
  sessions: SessionRegionData[];
  activeSessionId: string | null;
  onSelectTask: (taskId: string) => void;
  onSelectSession: (sessionId: string) => void;
  frameIntent: SceneFrameIntentProp | null;
}) {
  const placed = sessions.map((session) => {
    const { dx, dy } = regionWorldOffset(session.id);
    return { session, dx, dy };
  });

  // Manual frame: open-water edge chip, or a task-select cue for a region that
  // is not already on camera. Cleared whenever the roster session filter
  // changes so we never fight an explicit chip pick; also dropped when the
  // target region leaves the sea. Deselect/Escape leaves this alone so the
  // camera is not stranded mid-coast — only an explicit session change releases.
  const [manualFrameKey, setManualFrameKey] = useState<string | undefined>(undefined);
  const [trackedSessionId, setTrackedSessionId] = useState(activeSessionId);
  if (activeSessionId !== trackedSessionId) {
    setTrackedSessionId(activeSessionId);
    setManualFrameKey(undefined);
  }
  // Drop a stale manual target if that region left the sea.
  if (
    manualFrameKey !== undefined &&
    !placed.some((p) => regionKey(p.session.id) === manualFrameKey)
  ) {
    setManualFrameKey(undefined);
  }

  // Task-select camera cue: only set manual frame when the target region is
  // not already framed (loudest / named selection / prior manual). Avoids
  // locking All-hands auto-loudest when the operator inspects a task that is
  // already on camera.
  const [appliedFrameSeq, setAppliedFrameSeq] = useState(0);
  if (frameIntent !== null && frameIntent.seq !== appliedFrameSeq) {
    setAppliedFrameSeq(frameIntent.seq);
    const targetKey = frameIntent.sessionKey;
    const targetExists = placed.some((p) => regionKey(p.session.id) === targetKey);
    if (targetExists) {
      const currentIdx = resolveFramedIndex(placed, activeSessionId, manualFrameKey);
      const currentKey = regionKey((placed[currentIdx] ?? placed[0]!).session.id);
      if (targetKey !== currentKey) {
        setManualFrameKey(targetKey);
      }
    }
  }

  const activeIndex = resolveFramedIndex(placed, activeSessionId, manualFrameKey);
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

  const handleEdgeSelect = useCallback(
    (sessionId: string | null) => {
      if (sessionId === null) {
        // Open water has no roster select target — frame it in-scene only.
        setManualFrameKey("open-water");
        return;
      }
      setManualFrameKey(undefined);
      onSelectSession(sessionId);
    },
    [onSelectSession],
  );

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
    <div className="pc-scene-view pc-scene-view--sailing" role="group" aria-label={`The cove — sailing with ${label}`}>
      <Sea />
      <SailingScene />
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
      <EdgeAlerts items={edgeItems} onSelectSession={handleEdgeSelect} />
    </div>
  );
}
