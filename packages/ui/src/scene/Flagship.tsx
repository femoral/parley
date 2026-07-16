import galleonSrc from "./assets/storybook/galleon.png";

/** Dressing-lines for the all-voyages-home ceremony: signal flags strung
 * stem → foremast → mainmast → mizzen → stern, the traditional "dressed overall".
 * Coordinates are tuned to the painterly three-masted galleon sprite (viewBox
 * matches the art frame). Flag fills alternate parchment and completed-sky —
 * the sky-blue is spent as status here (every task in the session IS completed),
 * not decoration. */
const DRESS_HALYARD = "M18 58 Q36 28 52 8 Q72 4 88 10 Q108 28 128 56";
const DRESS_FLAGS: ReadonlyArray<{ x: number; y: number }> = [
  { x: 28, y: 48 },
  { x: 38, y: 32 },
  { x: 48, y: 16 },
  { x: 58, y: 8 },
  { x: 70, y: 6 },
  { x: 82, y: 10 },
  { x: 96, y: 22 },
  { x: 108, y: 36 },
  { x: 120, y: 50 },
];

/** The hoisted string of signal flags. Rendered only while every task island in
 * the session is completed, so its presence is pure state (never decorative). */
function DressLines() {
  return (
    <g className="pc-dress" aria-hidden="true">
      <path d={DRESS_HALYARD} fill="none" stroke="var(--brass-frame)" strokeWidth="1" />
      {DRESS_FLAGS.map(({ x, y }, i) => (
        <path
          key={`${x}-${y}`}
          d={`M${x - 2.5} ${y} h5 l-0.6 5.5 L${x} ${y + 6.5} l-1.9 -1 Z`}
          fill={i % 2 === 0 ? "var(--parchment-bg)" : "var(--state-completed)"}
          stroke="var(--brass-shadow)"
          strokeWidth="0.5"
        />
      ))}
    </g>
  );
}

/**
 * Layer 3 — the orchestrator galleon (component-system spec §"Scene art
 * direction"): a painterly three-masted flagship with baked amber cabin light,
 * anchored at the heart of its session's water region while its task-islands
 * cluster around it. Not a faction ship — it wears the house brass, not a coat
 * — so it takes no tint props. Gentle bob is a compositor keyframe.
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
      <div className="pc-galleon__bob">
        {/* Soft cabin-window halo — decor; never competes with awaiting/failed. */}
        <span className="pc-galleon__halo" aria-hidden="true" />
        <img
          className="pc-galleon__art"
          src={galleonSrc}
          alt=""
          draggable={false}
          width={560}
          height={525}
        />
        {dressed && (
          <svg className="pc-galleon__dress-layer" viewBox="0 0 150 110" aria-hidden="true">
            <DressLines />
          </svg>
        )}
      </div>
    </div>
  );
}
