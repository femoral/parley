import { useEffect, useRef, useState } from "react";
import type { EmblemMark } from "../tokens/factions.js";
import { stateMetaFor } from "../tokens/state-meta.js";
import { islandVariantFor, type IslandVariant } from "./charted.js";
import {
  cancelDeathPhase,
  hasShip,
  sailoffHoldMs,
} from "./island-death.js";
import { Ship } from "./Ship.js";
import { Flare } from "./effects/Flare.js";
import { Fog } from "./effects/Fog.js";
import { ParleyRibbon } from "./effects/ParleyRibbon.js";
import { PlantedFlag } from "./effects/PlantedFlag.js";
import { Wreck } from "./effects/Wreck.js";

/** One task as the scene renders it — the island's data. Defined in the scene
 * layer (plain props, no core import); the app's projection is structurally
 * compatible and passes straight through. */
export interface IslandTask {
  id: string;
  name: string;
  /** Canonical task state — the single `data-state` value all effects key off. */
  state: string;
  coat: string;
  coatDark: string;
  emblem: EmblemMark;
}

export {
  cancelDeathPhase,
  hasShip,
  sailoffHoldMs,
  SAILOFF_MS,
  SINK_MS,
  shipEffectsOpacity,
  shouldPaintShipEffects,
} from "./island-death.js";
export type { CancelDeathPhase } from "./island-death.js";

/**
 * Charted-waters island body: a deterministic raster sprite (one of three
 * aged-chart cutouts) with the name plank, foam ring, and state layers riding
 * on top. The completed flag is an SVG overlay pinned to the variant's peak.
 */
function IslandBody({
  completed,
  variant,
}: {
  completed: boolean;
  variant: IslandVariant;
}) {
  const { peak } = variant;
  return (
    <>
      <span className="pc-island__foam" aria-hidden="true" />
      <div className="pc-island__art" aria-hidden="true">
        <img className="pc-island__sprite" src={variant.src} alt="" draggable={false} />
        {completed && (
          <svg
            className="pc-island__flag-layer"
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            overflow="visible"
          >
            <PlantedFlag anchorX={peak.x} anchorY={peak.y} />
          </svg>
        )}
      </div>
    </>
  );
}

/**
 * Layer 3 — a task-island (component-system spec §"Scene art direction"). The
 * scene's state contract lives here: `data-state` on the root is the single
 * source every effect and the ambient CSS read, so an island can only ever show
 * one coherent state — and that state is the exact string the roster badges and
 * the inbox card by. Rising on mount is a finite CSS transition; sinking on a
 * *live* cancel is too. A task that mounts already-cancelled skips choreography
 * and paints the settled aftermath (`data-death="settled"`) so reload never
 * replays the death sequence (#187). Everything ambient (foam, station float,
 * flare pulse, fog drift) is a compositor keyframe.
 *
 * `data-variant` (1..3) selects the charted sprite and tunes effect seats
 * (flag peak, wreck beach, foam scale) so nothing floats detached from the art.
 */
export interface IslandProps {
  task: IslandTask;
  onSelectTask: (taskId: string) => void;
  /**
   * Scatter centre of this island relative to the session region origin.
   * Used by the sloop to voyage from the flagship (region origin −70y) to
   * station. Defaults to a south-of-flagship placeholder for isolated tests.
   */
  islandX?: number;
  islandY?: number;
  /**
   * When false, the island is removed from the tab order (off-camera regions).
   * The roster remains the canonical keyboard path to every task. Defaults true
   * so a lone island stays reachable.
   */
  focusable?: boolean;
}

function reducedMotionPreferred(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
    : false;
}

export function Island({
  task,
  onSelectTask,
  islandX = 0,
  islandY = 150,
  focusable = true,
}: IslandProps) {
  const { state } = task;
  const meta = stateMetaFor(state);
  const variant = islandVariantFor(task.id);

  // Captured on first render only: retained cancelled tasks mount settled.
  const mountedAsCancelledRef = useRef(state === "cancelled");
  const prevStateRef = useRef(state);
  const [sailoffComplete, setSailoffComplete] = useState(false);

  useEffect(() => {
    const previous = prevStateRef.current;
    prevStateRef.current = state;

    if (state !== "cancelled") {
      setSailoffComplete(false);
      return;
    }

    // Live cancel: was non-cancelled last paint, and we did not mount already dead.
    if (previous !== "cancelled" && !mountedAsCancelledRef.current) {
      setSailoffComplete(false);
      const hold = sailoffHoldMs(reducedMotionPreferred());
      if (hold <= 0) {
        setSailoffComplete(true);
        return;
      }
      const timer = window.setTimeout(() => setSailoffComplete(true), hold);
      return () => window.clearTimeout(timer);
    }
  }, [state]);

  const deathPhase = cancelDeathPhase({
    state,
    mountedAsCancelled: mountedAsCancelledRef.current,
    sailoffComplete,
  });

  return (
    <div
      className="pc-island"
      data-state={state}
      data-death={deathPhase ?? undefined}
      data-variant={variant.id}
      role="button"
      tabIndex={focusable ? 0 : -1}
      aria-label={`${task.name} — ${meta.label}`}
      onClick={() => onSelectTask(task.id)}
      onKeyDown={(event) => {
        if (!focusable) return;
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        onSelectTask(task.id);
      }}
    >
      <div className="pc-island__rise">
        {state === "awaiting_answer" && <Flare />}
        <IslandBody completed={state === "completed"} variant={variant} />
        {state === "stalled" && <Fog />}
        {state === "failed" && <Wreck />}
      </div>
      <div className="pc-island__plank-rise">
        <span className="pc-plank" aria-hidden="true">
          <span className="pc-plank__label" title={task.name}>
            {task.name}
          </span>
        </span>
      </div>
      {hasShip(state, deathPhase) && (
        <Ship
          coat={task.coat}
          coatDark={task.coatDark}
          emblem={task.emblem}
          state={state}
          islandX={islandX}
          islandY={islandY}
        />
      )}
      {state === "awaiting_answer" && <ParleyRibbon />}
    </div>
  );
}
