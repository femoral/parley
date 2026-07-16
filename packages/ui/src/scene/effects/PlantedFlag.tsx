/** Layer 3 effect — the completed island's planted flag (design-manifest §5): a
 * pole with a hoisted pennant in the `--state-completed` sky-blue. Quiet payoff;
 * the report panel carries the detail.
 *
 * Self-contained SVG (pole base at bottom-left of the local viewBox) so the
 * island can plant it at a per-variant peak via CSS percentage anchors.
 *
 * The payoff is a small one-shot ceremony rather than a pop-in: the pennant
 * runs up the pole (`pc-flag-hoist`) and a brief brass glint blooms at the
 * masthead as it seats (`pc-flag-glint`). Both are finite CSS animations whose
 * end frame is the legible resting state — hoisted pennant, glint gone — so the
 * global reduced-motion rule lands exactly there. */
export function PlantedFlag() {
  // Local space: pole base (10, 38), masthead (10, 4). Wave pivots on the base.
  const poleX = 10;
  const poleBase = 38;
  const poleTop = 4;
  return (
    <svg
      className="pc-flag"
      viewBox="0 0 36 40"
      width="36"
      height="40"
      aria-hidden="true"
    >
      <line
        x1={poleX}
        y1={poleTop}
        x2={poleX}
        y2={poleBase}
        stroke="var(--brass-frame)"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path
        className="pc-flag__pennant"
        d={`M${poleX} ${poleTop + 1} L${poleX + 18} ${poleTop + 6} L${poleX} ${poleTop + 13} Z`}
        fill="var(--state-completed)"
      />
      <circle cx={poleX} cy={poleTop} r="2" fill="var(--brass)" />
      <circle className="pc-flag__glint" cx={poleX} cy={poleTop} r="9" fill="var(--brass-bright)" />
    </svg>
  );
}
