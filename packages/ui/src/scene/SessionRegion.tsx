import { Flagship } from "./Flagship.js";
import { Island, type IslandTask } from "./Island.js";
import { islandSlotTransform, placeIslands } from "./layout.js";

export interface SessionRegionData {
  /** Orchestrator session id, or null for the open-water region. */
  id: string | null;
  /** Short banner label. */
  label: string;
  tasks: IslandTask[];
  /** Loudest edge-attention rollup from `projectScene`; null = calm region.
   * Structurally the hooks-layer `SceneSessionAttention | null`. */
  attention: { state: string; count: number; rank: number } | null;
}

export interface SessionRegionProps {
  session: SessionRegionData;
  onSelectTask: (taskId: string) => void;
  /** World offset (px) of this region's centre — the camera translates to it. */
  dx: number;
  dy: number;
  /**
   * Whether this region is the camera's framed target. Off-camera islands are
   * taken out of the tab order so keyboard focus never vanishes off-canvas;
   * the roster is the path to every task.
   */
  active?: boolean;
}

/**
 * Layer 3 — one orchestrator session's water region (spec §"Scene grammar"):
 * the anchored galleon with its task-islands scattered around it. Positioned at
 * its world coordinates by the {@link Camera}; islands are keyed by task id so
 * React mounts one on create (it rises) and unmounts it on clean (it's gone).
 *
 * Island geography comes from {@link placeIslands}: deterministic per task id,
 * append-stable in array order, never keyed on index alone — so a sibling
 * completing or cleaning cannot make surviving islands leap.
 */
export function SessionRegion({
  session,
  onSelectTask,
  dx,
  dy,
  active = true,
}: SessionRegionProps) {
  const islandCount = session.tasks.length;
  // The harness's pull-back is local to this region: spread new berths through
  // a larger world, then the scene-level driver eases --region-zoom to fit the
  // padded island box (plus sloop orbit) to the viewport (#201). Camera still
  // owns only the cross-session pan.
  const spread = Math.max(1, Math.sqrt(islandCount / 5));
  const style = {
    transform: `translate(-50%, -50%) translate(${dx}px, ${dy}px) scale(var(--region-zoom, 1))`,
  };
  // All voyages home — every task island completed. The flagship dresses ship
  // (signal flags between the masts); pure state, so it can never lie.
  const dressed = session.tasks.length > 0 && session.tasks.every((t) => t.state === "completed");
  const positions = placeIslands(session.tasks.map((t) => t.id));

  return (
    <div
      className="pc-region"
      style={style}
      data-island-count={islandCount}
      aria-label={`Session ${session.label}`}
      // `inert` is belt-and-suspenders with per-island tabIndex={-1}: blocks
      // pointer/keyboard activation of anything still nested off-camera.
      inert={!active || undefined}
    >
      <span className="pc-region__banner">{session.label}</span>
      <div className="pc-region__flagship">
        <Flagship label={session.label} dressed={dressed} />
      </div>
      {session.tasks.map((task) => {
        const raw = positions.get(task.id) ?? { x: 0, y: 150 };
        const pos = { x: raw.x * spread, y: raw.y * spread };
        return (
          <div
            key={task.id}
            className="pc-island-slot"
            data-x={pos.x}
            data-y={pos.y}
            style={{ transform: islandSlotTransform(pos) }}
          >
            <Island
              task={task}
              islandX={pos.x}
              islandY={pos.y}
              onSelectTask={onSelectTask}
              focusable={active}
            />
          </div>
        );
      })}
    </div>
  );
}
