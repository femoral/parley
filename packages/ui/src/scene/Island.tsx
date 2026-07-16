import type { CSSProperties } from "react";
import type { EmblemMark } from "../tokens/factions.js";
import { stateMetaFor } from "../tokens/state-meta.js";
import island1 from "./assets/storybook/island-1.png";
import island2 from "./assets/storybook/island-2.png";
import island3 from "./assets/storybook/island-3.png";
import { Ship } from "./Ship.js";
import { Flare } from "./effects/Flare.js";
import { Fog } from "./effects/Fog.js";
import { ParleyRibbon } from "./effects/ParleyRibbon.js";
import { PlantedFlag } from "./effects/PlantedFlag.js";
import { Wreck } from "./effects/Wreck.js";

/** Storybook island variants — painterly night sprites (lantern posts, campfire, rock arch). */
export type IslandVariant = 1 | 2 | 3;

/** Per-variant layout anchors as % of the art stage (flag peak, warm halo, wreck beach). */
interface VariantLayout {
  src: string;
  /** Image width / height — stage aspect so the overlay matches the sprite. */
  aspect: number;
  /** Rocky peak / flag plant point. */
  flagX: number;
  flagY: number;
  /** Soft ambient halo under lanterns / campfire. */
  haloX: number;
  haloY: number;
}

/**
 * Variant art + anchors. Peaks sit on the highest rock/palm base; halos sit under
 * the sprite's baked light (lantern pair, campfire, arch-top lantern). Tuned by
 * eye against the three storybook PNGs.
 */
const VARIANT: Record<IslandVariant, VariantLayout> = {
  1: {
    src: island1,
    aspect: 480 / 342,
    flagX: 46,
    flagY: 26,
    haloX: 54,
    haloY: 52,
  },
  2: {
    src: island2,
    aspect: 480 / 372,
    flagX: 42,
    flagY: 20,
    haloX: 50,
    haloY: 60,
  },
  3: {
    src: island3,
    aspect: 480 / 400,
    flagX: 50,
    flagY: 14,
    haloX: 50,
    haloY: 20,
  },
};

/** Stable hash of a task id → island art variant 1..3 (deterministic per task). */
export function islandVariantFor(taskId: string): IslandVariant {
  let h = 0;
  for (let i = 0; i < taskId.length; i++) {
    h = (Math.imul(h, 31) + taskId.charCodeAt(i)) | 0;
  }
  return ((Math.abs(h) % 3) + 1) as IslandVariant;
}

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

/** States where a sloop is present at the island. `completed`/`failed`/`pending`
 * hide the ship (spec: flag / wreck / bare rising island). */
function hasShip(state: string): boolean {
  return state === "running" || state === "awaiting_answer" || state === "stalled" || state === "cancelled";
}

/** Painterly island body: raster sprite + foam (dialed down — sprites carry their
 * own water skirt) + name plank + soft warm halo under the baked light. */
function IslandBody({
  name,
  completed,
  variant,
}: {
  name: string;
  completed: boolean;
  variant: IslandVariant;
}) {
  const layout = VARIANT[variant];
  const stageStyle = {
    "--island-aspect": String(layout.aspect),
    "--halo-x": `${layout.haloX}%`,
    "--halo-y": `${layout.haloY}%`,
    "--flag-x": `${layout.flagX}%`,
    "--flag-y": `${layout.flagY}%`,
  } as CSSProperties;

  return (
    <>
      {/* Soft shore ring — sprites bake their own foam, so this stays a whisper. */}
      <span className="pc-island__foam" aria-hidden="true" />
      <div className="pc-island__stage" style={stageStyle}>
        {/* Ambient warm halo under lanterns/campfire — decor only; flare/wreck stay louder. */}
        <span className="pc-island__halo" aria-hidden="true" />
        <img
          className="pc-island__art"
          src={layout.src}
          alt=""
          draggable={false}
          width={480}
          height={Math.round(480 / layout.aspect)}
        />
        {completed && (
          <span className="pc-island__flag" aria-hidden="true">
            <PlantedFlag />
          </span>
        )}
      </div>
      <span className="pc-plank" aria-hidden="true">
        <span className="pc-plank__label" title={name}>
          {name}
        </span>
      </span>
    </>
  );
}

/**
 * Layer 3 — a task-island (component-system spec §"Scene art direction"). The
 * scene's state contract lives here: `data-state` on the root is the single
 * source every effect and the ambient CSS read, so an island can only ever show
 * one coherent state — and that state is the exact string the roster badges and
 * the inbox card by. Rising on mount and sinking on `cancelled` are finite CSS
 * transitions; everything ambient (foam, station float, flare pulse, fog drift)
 * is a compositor keyframe.
 *
 * Art is a painterly storybook sprite, chosen deterministically from the task id
 * (`data-variant` 1..3) so the same task always lands on the same island.
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

  return (
    <div
      className="pc-island"
      data-state={state}
      data-variant={variant}
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
        <IslandBody name={task.name} completed={state === "completed"} variant={variant} />
        {state === "stalled" && <Fog />}
        {state === "failed" && <Wreck />}
      </div>
      {hasShip(state) && (
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
