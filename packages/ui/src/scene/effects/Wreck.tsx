/** Layer 3 effect — the failed task's shipwreck (design-manifest §5): a
 * broken-masted hull run up on the rocks, listing, its snapped mast and torn sail
 * in muted wood and the `--state-failed` coral. Quiet but unmistakable. */
export function Wreck() {
  return (
    <svg className="pc-wreck" viewBox="0 0 64 44" aria-hidden="true">
      {/* listing hull */}
      <path
        d="M8 30 Q10 40 22 40 L46 40 Q54 40 56 31 L50 29 Z"
        fill="var(--brass-shadow)"
        stroke="var(--plate-well-border)"
        strokeWidth="1.2"
      />
      <path d="M8 30 L56 31 L54 34 L10 33 Z" fill="var(--state-failed)" opacity="0.55" />
      {/* snapped mast, canted */}
      <line x1="30" y1="30" x2="40" y2="8" stroke="var(--brass-frame)" strokeWidth="2.4" strokeLinecap="round" />
      <line x1="40" y1="8" x2="46" y2="14" stroke="var(--brass-shadow)" strokeWidth="2" strokeLinecap="round" />
      {/* torn sail */}
      <path d="M40 10 Q30 16 33 26 L40 24 Z" fill="var(--parchment-bg)" opacity="0.7" />
    </svg>
  );
}
