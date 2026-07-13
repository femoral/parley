/**
 * Layer 3 — the orchestrator galleon (component-system spec §"Scene art
 * direction"): a two-masted flagship flying a gold standard, anchored at the
 * heart of its session's water region while its task-islands cluster around it.
 * Not a faction ship — it wears the house brass, not a coat — so it takes no tint
 * props. Gentle bob is a compositor keyframe.
 */
export function Flagship({ label }: { label: string }) {
  return (
    <div className="pc-galleon" role="img" aria-label={`Orchestrator ${label}`}>
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
