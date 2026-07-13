import { stateMetaFor } from "../tokens/state-meta.js";
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
  emblem: string;
}

/** States where a sloop is present at the island. `completed`/`failed`/`pending`
 * hide the ship (spec: flag / wreck / bare rising island). */
function hasShip(state: string): boolean {
  return state === "running" || state === "awaiting_answer" || state === "stalled" || state === "cancelled";
}

/** The rock-and-sand island silhouette with a palm and shore foam — the same
 * for every state; the state layers ride on top. */
function IslandBody({ name }: { name: string }) {
  return (
    <>
      <span className="pc-island__foam" aria-hidden="true" />
      <svg className="pc-island__svg" viewBox="0 0 140 96" aria-hidden="true">
        {/* sand beach */}
        <ellipse cx="70" cy="80" rx="60" ry="14" fill="var(--parchment-bg)" />
        {/* rocky mound, two-tone */}
        <path d="M26 80 Q40 34 70 32 Q100 34 114 80 Z" fill="var(--brass-shadow)" />
        <path d="M44 80 Q56 44 70 42 Q86 46 96 80 Z" fill="var(--brass-frame)" opacity="0.9" />
        {/* palm — trunk + fronds */}
        <path d="M74 46 Q70 30 66 18" stroke="var(--brass-shadow)" strokeWidth="3" fill="none" strokeLinecap="round" />
        <g fill="var(--state-running)">
          <path d="M66 18 Q50 12 42 20 Q54 16 66 22 Z" />
          <path d="M66 18 Q82 10 92 18 Q78 16 66 22 Z" />
          <path d="M66 18 Q58 6 66 -2 Q70 8 68 20 Z" />
        </g>
        {/* driftwood */}
        <line x1="96" y1="82" x2="112" y2="78" stroke="var(--brass-shadow)" strokeWidth="2.4" strokeLinecap="round" />
      </svg>
      <span className="pc-plank" aria-hidden="true">
        <span className="pc-plank__label">{name}</span>
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
 * transitions; everything ambient (foam, orbit, flare pulse, fog drift) is a
 * compositor keyframe.
 */
export function Island({ task }: { task: IslandTask }) {
  const { state } = task;
  const meta = stateMetaFor(state);

  return (
    <div className="pc-island" data-state={state} role="img" aria-label={`${task.name} — ${meta.label}`}>
      <div className="pc-island__rise">
        {state === "awaiting_answer" && <Flare />}
        <IslandBody name={task.name} />
        {state === "stalled" && <Fog />}
        {state === "completed" && <PlantedFlag />}
        {state === "failed" && <Wreck />}
      </div>
      {hasShip(state) && (
        <Ship coat={task.coat} coatDark={task.coatDark} emblem={task.emblem} state={state} />
      )}
      {state === "awaiting_answer" && <ParleyRibbon />}
    </div>
  );
}
