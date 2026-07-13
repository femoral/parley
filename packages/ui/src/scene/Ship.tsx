import type { CSSProperties } from "react";
import { Wake } from "./effects/Wake.js";

export interface ShipProps {
  /** Faction coat colour (hex) — the one loud hue on the sails/pennant. */
  coat: string;
  /** Darker coat (hex) — hull waterline and pennant staff. */
  coatDark: string;
  /** Faction emblem glyph, worn on the mainsail. */
  emblem: string;
  /** Task state — decides the sloop's pose: circling (running), anchored
   * (awaiting/stalled), or sailing off (cancelled). */
  state: string;
}

/** The sloop silhouette — a planked hull with a faction-dark waterline, a
 * parchment mainsail + jib tinted by the coat, and an emblem on the main. Shared
 * by every pose. */
function Sloop({ emblem }: { emblem: string }) {
  return (
    <svg className="pc-sloop__svg" viewBox="0 0 60 56" aria-hidden="true">
      {/* mast + forestay */}
      <line x1="30" y1="40" x2="30" y2="5" stroke="var(--brass-shadow)" strokeWidth="1.6" />
      {/* mainsail — parchment, coat-tinted by CSS */}
      <path className="pc-sloop__main" d="M31 8 Q47 22 49 35 L31 37 Z" />
      {/* jib */}
      <path className="pc-sloop__jib" d="M28 12 Q17 26 15 34 L28 35 Z" />
      {/* emblem on the mainsail */}
      <text className="pc-sloop__emblem" x="38" y="30" textAnchor="middle">
        {emblem}
      </text>
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
 * Pose is state-driven and CSS renders it from `data-state`: `running` orbits its
 * island with a wake; `awaiting_answer`/`stalled` drop anchor (orbit paused, wake
 * gone); `cancelled` sails off the edge. Orbit and bob are compositor keyframes —
 * zero JS per frame.
 */
export function Ship({ coat, coatDark, emblem, state }: ShipProps) {
  const style = { "--coat": coat, "--coat-dark": coatDark } as CSSProperties;

  if (state === "cancelled") {
    return (
      <span className="pc-sloop pc-sloop--sailoff" data-state={state} style={style} aria-hidden="true">
        <Sloop emblem={emblem} />
      </span>
    );
  }

  // running / awaiting_answer / stalled all ride the orbit wrapper; CSS pauses it
  // and swaps the pose for the anchored/adrift states.
  return (
    <span className="pc-orbit" data-state={state} style={style} aria-hidden="true">
      <span className="pc-orbit__arm">
        <Wake />
        <span className="pc-sloop">
          <span className="pc-anchor" />
          <Sloop emblem={emblem} />
        </span>
      </span>
    </span>
  );
}
