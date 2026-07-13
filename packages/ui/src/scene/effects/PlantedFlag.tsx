/** Layer 3 effect — the completed island's planted flag (design-manifest §5): a
 * pole with a hoisted pennant in the `--state-completed` sky-blue. Quiet payoff;
 * the report panel carries the detail. */
export function PlantedFlag() {
  return (
    <svg className="pc-flag" viewBox="0 0 28 40" aria-hidden="true">
      <line x1="6" y1="2" x2="6" y2="40" stroke="var(--brass-frame)" strokeWidth="2" strokeLinecap="round" />
      <path d="M6 3 L24 8 L6 15 Z" fill="var(--state-completed)" />
      <circle cx="6" cy="2" r="2" fill="var(--brass)" />
    </svg>
  );
}
