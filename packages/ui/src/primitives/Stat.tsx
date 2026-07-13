import type { CSSProperties } from "react";

export interface StatProps {
  /** The big mono numeral/readout (already formatted). */
  value: string;
  /** The tracked caps label under it. */
  label: string;
  /** Value colour (a `var(--…)` token); defaults to brass-soft. */
  color?: string;
}

/** Layer 1 — the stat readout: big mono numeral over a caps label
 * (design-manifest §4.19). */
export function Stat({ value, label, color }: StatProps) {
  const style = color ? ({ "--stat-color": color } as CSSProperties) : undefined;
  return (
    <div className="pc-stat">
      <span className="pc-stat__value" style={style}>
        {value}
      </span>
      <span className="pc-stat__label">{label}</span>
    </div>
  );
}
