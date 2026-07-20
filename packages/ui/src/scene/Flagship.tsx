import { GALLEON_MASTS, GALLEON_SRC, GALLEON_VIEW } from "./charted.js";

const { stem, fore, main, stern } = GALLEON_MASTS;

/** Dressing-lines for the all-voyages-home ceremony: signal flags strung
 * stem → foremast → mainmast → stern, the traditional "dressed overall".
 * Coordinates are native galleon-sprite pixels so the string seats on the
 * raster masts. Flag fills alternate parchment and completed-sky — the
 * sky-blue is spent as status here (every task in the session IS completed),
 * not decoration. */
const DRESS_HALYARD =
  `M${stem.x} ${stem.y}` +
  ` Q${(stem.x + fore.x) / 2} ${(stem.y + fore.y) / 2 + 20} ${fore.x} ${fore.y}` +
  ` Q${(fore.x + main.x) / 2} ${Math.min(fore.y, main.y) - 6} ${main.x} ${main.y}` +
  ` Q${(main.x + stern.x) / 2} ${(main.y + stern.y) / 2 + 10} ${stern.x} ${stern.y}`;

/** Flag seats sampled along the halyard quadratics (bowsprit → fore → main
 * → mizzen), so every flag hangs from the string instead of floating. */
const DRESS_FLAGS: ReadonlyArray<{ x: number; y: number }> = [
  { x: 74, y: 181 },
  { x: 130, y: 137 },
  { x: 185, y: 89 },
  { x: fore.x, y: fore.y + 4 },
  { x: 274, y: 47 },
  { x: 318, y: 53 },
  { x: main.x, y: main.y + 4 },
  { x: 403, y: 89 },
  { x: 443, y: 106 },
];

/** The hoisted string of signal flags. Rendered only while every task island in
 * the session is completed, so its presence is pure state (never decorative). */
function DressLines() {
  return (
    <g className="pc-dress" aria-hidden="true">
      <path d={DRESS_HALYARD} fill="none" stroke="var(--brass-frame)" strokeWidth="1.6" />
      {DRESS_FLAGS.map(({ x, y }, i) => (
        <path
          key={`${x}-${y}`}
          d={`M${x - 4} ${y} h8 l-1 9 L${x} ${y + 11} l-3 -1.6 Z`}
          fill={i % 2 === 0 ? "var(--parchment-bg)" : "var(--state-completed)"}
          stroke="var(--brass-shadow)"
          strokeWidth="0.8"
        />
      ))}
    </g>
  );
}

/**
 * Layer 3 — the orchestrator galleon (component-system spec §"Scene art
 * direction"): a two-masted flagship flying a gold standard, anchored at the
 * heart of its session's water region while its task-islands cluster around it.
 * Not a faction ship — it wears the house brass, not a coat — so it takes no tint
 * props. Gentle bob is a compositor keyframe.
 *
 * Hull/sails are a charted raster sprite; the dressed-overall signal-flag
 * ceremony is an SVG overlay pinned to the sprite's masts so the hoist
 * survives the art swap.
 *
 * When every voyage in the session is home (`dressed`), the galleon dresses
 * ship: signal flags run up between the masts as a one-shot hoist, then ride
 * the ambient bob. The milestone also lands in the aria-label so it isn't
 * sighted-only.
 */
export function Flagship({ label, dressed = false }: { label: string; dressed?: boolean }) {
  return (
    <div
      className="pc-galleon"
      role="img"
      aria-label={dressed ? `Orchestrator ${label} — all voyages home` : `Orchestrator ${label}`}
    >
      <img className="pc-galleon__sprite" src={GALLEON_SRC} alt="" draggable={false} />
      {dressed && (
        <svg
          className="pc-galleon__dress"
          viewBox={`0 0 ${GALLEON_VIEW.w} ${GALLEON_VIEW.h}`}
          overflow="visible"
          aria-hidden="true"
        >
          <DressLines />
        </svg>
      )}
    </div>
  );
}
