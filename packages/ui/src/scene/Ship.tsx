import type { CSSProperties, ReactNode } from "react";
import type { EmblemMark } from "../tokens/factions.js";
import { stationOffset, voyageFromFlagship } from "./layout.js";
import { Wake } from "./effects/Wake.js";
import sloopUrl from "./assets/charted/sloop.png";
// Tint masks (sloop-{silhouette,sail,hullband,pennant}-mask.png) are referenced
// directly from scene.css via relative `mask-image: url(...)` — Vite resolves
// and fingerprints them like any other CSS asset. Kept out of JS/inline style:
// an earlier attempt setting `mask-image` via React inline `style` silently
// dropped the property (camelCase `maskImage`/`WebkitMaskImage` never reached
// the DOM), so the mask lives in the stylesheet instead.

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

/** Faction mark on the mainsail — glyph as text, or authored SVG path art.
 * Rendered as its own small svg, absolutely positioned over the mainsail
 * belly by `.pc-sloop__emblem-layer` (see scene.css). */
function SailMark({ emblem }: { emblem: EmblemMark }): ReactNode {
  if (emblem.kind === "glyph") {
    return (
      <svg className="pc-sloop__emblem-layer" viewBox="0 0 40 40" aria-hidden="true">
        <text className="pc-sloop__emblem" x="20" y="27" textAnchor="middle">
          {emblem.char}
        </text>
      </svg>
    );
  }
  const paths = typeof emblem.path === "string" ? [emblem.path] : emblem.path;
  return (
    <svg className="pc-sloop__emblem-layer" viewBox={emblem.viewBox} aria-hidden="true">
      {paths.map((d) => (
        <path key={d} className="pc-sloop__emblem-mark" d={d} fillRule={emblem.fillRule} />
      ))}
    </svg>
  );
}

/**
 * The sloop art — a painted aged-chart raster sprite (same codex-imagegen art
 * direction and style-locked composition as the galleon/islands), with the
 * faction coat expressed via CSS `mask-image` + `background-color` recolor
 * layers instead of hand-authored SVG fills. Three tintable regions were
 * segmented as aligned raster masks from the same composition:
 * mainsail+jib and masthead pennant (coat, `mix-blend-mode: color` so the
 * raster's own paint shading/highlights show through the recolor), and the
 * hull waterline band (coat-dark, opaque). A fourth mask of the full sprite's
 * own alpha silhouette clips the tint layers so a slightly generous mask trace
 * never bleeds paint past the hull/sail edges. The neutral wood-hull/rigging
 * detail underneath is shared by every faction — zero new art per faction,
 * same product law as the old inline-SVG sloop, now on painted art. */
function Sloop({ emblem }: { emblem: EmblemMark }) {
  return (
    <span className="pc-sloop__art">
      <img className="pc-sloop__base" src={sloopUrl} alt="" draggable={false} />
      <span className="pc-sloop__tints" aria-hidden="true">
        <span className="pc-sloop__tint pc-sloop__tint--sail" />
        <span className="pc-sloop__tint pc-sloop__tint--pennant" />
        <span className="pc-sloop__tint pc-sloop__tint--hull" />
      </span>
      <SailMark emblem={emblem} />
    </span>
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
