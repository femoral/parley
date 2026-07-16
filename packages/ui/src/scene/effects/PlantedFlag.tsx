/** Layer 3 effect — the completed island's planted flag (design-manifest §5): a
 * pole with a hoisted pennant in the `--state-completed` sky-blue. Quiet payoff;
 * the report panel carries the detail.
 *
 * The payoff is a small one-shot ceremony rather than a pop-in: the pennant
 * runs up the pole (`pc-flag-hoist`) and a brief brass glint blooms at the
 * masthead as it seats (`pc-flag-glint`). Both are finite CSS animations whose
 * end frame is the legible resting state — hoisted pennant, glint gone — so the
 * global reduced-motion rule lands exactly there. */
export function PlantedFlag({ anchorX, anchorY }: { anchorX: number; anchorY: number }) {
  const poleTop = anchorY - 30;
  return (
    <g className="pc-flag" style={{ transformOrigin: `${anchorX}px ${anchorY}px` }} aria-hidden="true">
      <line
        x1={anchorX}
        y1={poleTop}
        x2={anchorX}
        y2={anchorY}
        stroke="var(--brass-frame)"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path
        className="pc-flag__pennant"
        d={`M${anchorX} ${poleTop + 1} L${anchorX + 18} ${poleTop + 6} L${anchorX} ${poleTop + 13} Z`}
        fill="var(--state-completed)"
      />
      <circle cx={anchorX} cy={poleTop} r="2" fill="var(--brass)" />
      <circle className="pc-flag__glint" cx={anchorX} cy={poleTop} r="9" fill="var(--brass-bright)" />
    </g>
  );
}
