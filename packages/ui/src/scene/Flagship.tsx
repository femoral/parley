/** Dressing-lines for the all-voyages-home ceremony: signal flags strung
 * stem → foremast → mainmast → stern, the traditional "dressed overall".
 * Flag fills alternate parchment and completed-sky — the sky-blue is spent as
 * status here (every task in the session IS completed), not decoration. */
const DRESS_HALYARD = "M20 60 Q40 42 55 10 Q75 14 95 4 Q110 40 134 60";
const DRESS_FLAGS: ReadonlyArray<{ x: number; y: number }> = [
  { x: 33, y: 45 },
  { x: 44, y: 30 },
  { x: 51, y: 18 },
  { x: 67, y: 10 },
  { x: 75, y: 11 },
  { x: 83, y: 9 },
  { x: 105, y: 24 },
  { x: 114, y: 38 },
  { x: 125, y: 51 },
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
 * direction"): a two-masted flagship flying a gold standard, anchored at the
 * heart of its session's water region while its task-islands cluster around it.
 * Not a faction ship — it wears the house brass, not a coat — so it takes no tint
 * props. Gentle bob is a compositor keyframe.
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
      {/* Stern lantern — warm environmental glow (quieter than the awaiting flare). */}
      <span className="pc-galleon__lantern" aria-hidden="true">
        <span className="pc-galleon__lantern-glow" />
        <span className="pc-galleon__lantern-core" />
        <span className="pc-galleon__lantern-shimmer" />
      </span>
      <svg className="pc-galleon__svg" viewBox="0 0 150 110">
        {/* masts */}
        <line x1="55" y1="70" x2="55" y2="10" stroke="var(--brass-shadow)" strokeWidth="2.4" />
        <line x1="95" y1="70" x2="95" y2="4" stroke="var(--brass-shadow)" strokeWidth="2.4" />
        {/* gold standard at the main masthead */}
        <path d="M95 4 L120 10 L95 17 Z" fill="var(--brass)" />
        <circle cx="95" cy="3" r="2.4" fill="var(--brass-bright)" />
        {/* sails — parchment, brass-edged */}
        <path
          d="M57 14 Q78 30 80 58 L57 60 Z"
          fill="var(--parchment-bg)"
          stroke="var(--brass-frame)"
          strokeWidth="1"
        />
        <path
          d="M53 14 Q34 30 32 58 L53 60 Z"
          fill="var(--parchment-bg)"
          stroke="var(--brass-frame)"
          strokeWidth="1"
        />
        <path
          d="M97 8 Q116 26 118 56 L97 58 Z"
          fill="var(--parchment-bg)"
          stroke="var(--brass-frame)"
          strokeWidth="1"
        />
        {dressed && <DressLines />}
        {/* hull — tall planked body with a brass sheer line */}
        <path
          d="M18 64 Q22 96 52 96 L104 96 Q132 96 138 66 L128 62 Z"
          fill="var(--plate-top)"
          stroke="var(--brass-frame)"
          strokeWidth="1.4"
        />
        <path d="M18 64 L138 66 L134 74 L22 72 Z" fill="var(--brass-frame)" opacity="0.85" />
        {/* gunports */}
        <circle cx="45" cy="80" r="2.6" fill="var(--brass-deep)" />
        <circle cx="65" cy="82" r="2.6" fill="var(--brass-deep)" />
        <circle cx="85" cy="82" r="2.6" fill="var(--brass-deep)" />
        <circle cx="105" cy="80" r="2.6" fill="var(--brass-deep)" />
      </svg>
    </div>
  );
}
