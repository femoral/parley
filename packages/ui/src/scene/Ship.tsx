import type { CSSProperties, ReactNode } from "react";
import type { EmblemMark } from "../tokens/factions.js";
import { stationOffset, voyageFromFlagship } from "./layout.js";
import { Wake } from "./effects/Wake.js";

export interface ShipProps {
  /** Faction coat colour (hex) — the one loud hue on the sails/pennant. */
  coat: string;
  /** Darker coat (hex) — hull waterline and pennant staff. */
  coatDark: string;
  /** Faction emblem mark, worn on the mainsail. */
  emblem: EmblemMark;
  /** Task state — decides the sloop's pose: floating on station (running),
   * anchored close in (awaiting), adrift (stalled), or sailing off (cancelled). */
  state: string;
  /**
   * Island scatter centre relative to the session region origin. Used to
   * compute the one-shot voyage from the flagship to this island. Defaults
   * keep isolated unit tests rendering a short southbound hop.
   */
  islandX?: number;
  islandY?: number;
}

/** Faction mark on the mainsail — glyph as text, or nested SVG path art. */
function SailMark({ emblem }: { emblem: EmblemMark }): ReactNode {
  if (emblem.kind === "glyph") {
    return (
      <text className="pc-sloop__emblem" x="38" y="30" textAnchor="middle">
        {emblem.char}
      </text>
    );
  }
  const paths = typeof emblem.path === "string" ? [emblem.path] : emblem.path;
  // Nested svg sits over the mainsail belly (viewBox 0 0 60 56 of the sloop).
  return (
    <svg className="pc-sloop__emblem-mark" x="32" y="22" width="12" height="12" viewBox={emblem.viewBox} aria-hidden="true">
      {paths.map((d) => (
        <path key={d} d={d} fillRule={emblem.fillRule} />
      ))}
    </svg>
  );
}

/** The sloop silhouette — a planked hull with a faction-dark waterline, a
 * parchment mainsail + jib tinted by the coat, and an emblem on the main. Shared
 * by every pose. */
function Sloop({ emblem }: { emblem: EmblemMark }) {
  return (
    <svg className="pc-sloop__svg" viewBox="0 0 60 56" aria-hidden="true">
      {/* mast + forestay */}
      <line x1="30" y1="40" x2="30" y2="5" stroke="var(--brass-shadow)" strokeWidth="1.6" />
      {/* mainsail — parchment, coat-tinted by CSS */}
      <path className="pc-sloop__main" d="M31 8 Q47 22 49 35 L31 37 Z" />
      {/* jib */}
      <path className="pc-sloop__jib" d="M28 12 Q17 26 15 34 L28 35 Z" />
      {/* emblem on the mainsail */}
      <SailMark emblem={emblem} />
      {/* hull — wood body over a faction-dark waterline */}
      <path
        className="pc-sloop__hull"
        d="M9 39 Q11 50 24 50 L44 50 Q53 50 55 40 Z"
      />
      <path className="pc-sloop__waterline" d="M9 39 L55 40 L52 45 L12 44 Z" />
      {/* pennant at the masthead */}
      <path className="pc-sloop__pennant" d="M30 5 L44 8 L30 11 Z" />
    </svg>
  );
}

/**
 * Layer 3 — the vendor-agent sloop (component-system spec §"Scene art
 * direction"). Faction is expressed entirely through the `--coat`/`--coat-dark`
 * pair set here, so a new faction record restyles every ship with zero new art.
 *
 * Pose is state-driven and CSS renders it from `data-state`:
 * - Mount: one-shot voyage from the flagship to the island (transform only).
 * - `running`: float on station with gentle bob/sway/drift + subtle wake.
 * - `awaiting_answer`: anchored close in (anchor rode + flare/ribbon on island).
 * - `stalled`: adrift on station.
 * - `cancelled`: sails off the frame.
 *
 * Ambient loops and the voyage are compositor keyframes — zero JS per frame.
 * Base/end frames are on-station at the island so reduced-motion stills there.
 */
export function Ship({
  coat,
  coatDark,
  emblem,
  state,
  islandX = 0,
  islandY = 150,
}: ShipProps) {
  const island = { x: islandX, y: islandY };
  const from = voyageFromFlagship(island);
  // Awaiting sits closer in; running/stalled hold a bit further offshore.
  const closeness = state === "awaiting_answer" ? 58 : state === "stalled" ? 96 : 88;
  const station = stationOffset(island, closeness);
  // Bow art faces starboard (right); flip when the island lies to port of the
  // flagship so the voyage reads as sailing outward rather than reverse.
  const headingPort = islandX < 0;

  const style = {
    "--coat": coat,
    "--coat-dark": coatDark,
    "--voyage-from-x": `${from.x}px`,
    "--voyage-from-y": `${from.y}px`,
    "--station-x": `${station.x}px`,
    "--station-y": `${station.y}px`,
  } as CSSProperties;

  if (state === "cancelled") {
    return (
      <span className="pc-sloop pc-sloop--sailoff" data-state={state} style={style} aria-hidden="true">
        <Sloop emblem={emblem} />
      </span>
    );
  }

  return (
    <span
      className={`pc-voyage${headingPort ? " pc-voyage--port" : ""}`}
      data-state={state}
      style={style}
      aria-hidden="true"
    >
      <span className="pc-station">
        <span className="pc-heading">
          <Wake />
          <span className="pc-sloop">
            <span className="pc-anchor" />
            <Sloop emblem={emblem} />
          </span>
        </span>
      </span>
    </span>
  );
}
