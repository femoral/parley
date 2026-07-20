import type { CSSProperties, ReactNode } from "react";
import type { EmblemMark } from "../tokens/factions.js";
import { Wake } from "./effects/Wake.js";
import sloopUrl from "./assets/charted/sloop.png";
// Tint masks (sloop-{silhouette,sail,pennant}-mask.png) are referenced
// directly from scene.css via relative `mask-image: url(...)` — Vite resolves
// and fingerprints them like any other CSS asset. Kept out of JS/inline style:
// an earlier attempt setting `mask-image` via React inline `style` silently
// dropped the property (camelCase `maskImage`/`WebkitMaskImage` never reached
// the DOM), so the mask lives in the stylesheet instead.

export interface ShipProps {
  /** Faction coat colour (hex) — the one loud hue on the sails/pennant. */
  coat: string;
  /** Darker coat (hex) — faction emblem ink. */
  coatDark: string;
  /** Faction emblem mark, worn on the mainsail. */
  emblem: EmblemMark;
  /** Task state — decides the sloop's pose: circling the island (running),
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
 * layers instead of hand-authored SVG fills. The mainsail+jib and masthead
 * pennant use `mix-blend-mode: color` so the raster's own paint shading and
 * highlights show through. The approved hull tint opacity is zero, so its
 * dead mask/layer is intentionally omitted. A full-sprite mask
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
 * Pose is state-driven and the scene's single sailing driver renders it from
 * `data-sailing-pose` using transform-only writes:
 * - Mount: one-shot voyage from the flagship to the island.
 * - `running`: orbit the island with gentle bob/sway + subtle wake.
 * - `awaiting_answer`: anchored close in (anchor rode + flare/ribbon on island).
 * - `stalled`: adrift on station.
 * - `cancelled`: sails off the frame.
 *
 * Reduced motion freezes the driver's sim clock at the on-station frame.
 */
export function Ship({
  coat,
  coatDark,
  emblem,
  state,
  islandX = 0,
  islandY = 150,
}: ShipProps) {
  const pose =
    state === "running"
      ? "orbit"
      : state === "awaiting_answer"
        ? "anchored"
        : state === "stalled"
          ? "adrift"
          : "sailoff";

  const style = {
    "--coat": coat,
    "--coat-dark": coatDark,
  } as CSSProperties;

  return (
    <span
      className={`pc-voyage${state === "cancelled" ? " pc-sloop--sailoff" : ""}`}
      data-state={state}
      data-sailing-ship="sloop"
      data-sailing-pose={pose}
      data-island-x={islandX}
      data-island-y={islandY}
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
