import { Flagship } from "./Flagship.js";
import { Island, type IslandTask } from "./Island.js";

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
}

/** Deterministic island slot: a centred grid beneath the galleon, up to four
 * across. Position is a pure function of the island's index, so the cove's
 * geography holds still as tasks transition (islands change in place, never
 * leap). */
function slot(index: number, count: number): string {
  const cols = Math.min(count, 4) || 1;
  const col = index % cols;
  const row = Math.floor(index / cols);
  const x = (col - (cols - 1) / 2) * 176;
  const y = 150 + row * 170;
  return `translate(-50%, -50%) translate(${x}px, ${y}px)`;
}

/**
 * Layer 3 — one orchestrator session's water region (spec §"Scene grammar"):
 * the anchored galleon with its task-islands clustered around it. Positioned at
 * its world coordinates by the {@link Camera}; islands are keyed by task id so
 * React mounts one on create (it rises) and unmounts it on clean (it's gone).
 */
export function SessionRegion({ session, onSelectTask, dx, dy }: SessionRegionProps) {
  const style = { transform: `translate(-50%, -50%) translate(${dx}px, ${dy}px)` };
  return (
    <div className="pc-region" style={style} aria-label={`Session ${session.label}`}>
      <span className="pc-region__banner">{session.label}</span>
      <div className="pc-region__flagship">
        <Flagship label={session.label} />
      </div>
      {session.tasks.map((task, i) => (
        <div key={task.id} className="pc-island-slot" style={{ transform: slot(i, session.tasks.length) }}>
          <Island task={task} onSelectTask={onSelectTask} />
        </div>
      ))}
    </div>
  );
}
