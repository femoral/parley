/** Layer 3 effect — the completed island's planted flag (design-manifest §5): a
 * pole with a hoisted pennant in the `--state-completed` sky-blue. Quiet payoff;
 * the report panel carries the detail.
 *
 * Anchors are in the island flag-layer's 0–100 viewBox (% of the sprite box)
 * so the pennant seats on each charted variant's rocky peak.
 *
 * The payoff is a small one-shot ceremony rather than a pop-in: the pennant
 * runs up the pole (`pc-flag-hoist`) and a brief brass glint blooms at the
 * masthead as it seats (`pc-flag-glint`). Both are finite CSS animations whose
 * end frame is the legible resting state — hoisted pennant, glint gone — so the
 * global reduced-motion rule lands exactly there. */
/** Pole length in flag-layer units (~22% of sprite height). */
const POLE = 22;

export function PlantedFlag({ anchorX, anchorY }: { anchorX: number; anchorY: number }) {
  const poleTop = anchorY - POLE;
  return (
    <g className="pc-flag" style={{ transformOrigin: `${anchorX}px ${anchorY}px` }} aria-hidden="true">
      <line
        x1={anchorX}
        y1={poleTop}
        x2={anchorX}
        y2={anchorY}
        stroke="var(--brass-frame)"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <path
        className="pc-flag__pennant"
        d={`M${anchorX} ${poleTop + 0.8} L${anchorX + 12} ${poleTop + 4.5} L${anchorX} ${poleTop + 9} Z`}
        fill="var(--state-completed)"
      />
      <circle cx={anchorX} cy={poleTop} r="1.6" fill="var(--brass)" />
      <circle className="pc-flag__glint" cx={anchorX} cy={poleTop} r="6" fill="var(--brass-bright)" />
    </g>
  );
}
