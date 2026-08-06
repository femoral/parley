/**
 * Footer state legend — square dots + labels so state is never hue alone.
 * Attention order from DESIGN.md.
 */

const LEGEND: ReadonlyArray<{ state: string; label: string; cssVar: string }> = [
  { state: "awaiting_answer", label: "awaiting", cssVar: "var(--state-awaiting)" },
  { state: "stalled", label: "stalled", cssVar: "var(--state-stalled)" },
  { state: "failed", label: "failed", cssVar: "var(--state-failed)" },
  { state: "running", label: "running", cssVar: "var(--state-running)" },
  { state: "queued", label: "queued", cssVar: "var(--state-queued)" },
  { state: "pending", label: "pending", cssVar: "var(--state-pending)" },
  { state: "completed", label: "completed", cssVar: "var(--state-completed)" },
  { state: "cancelled", label: "cancelled", cssVar: "var(--state-cancelled)" },
];

export interface FooterLegendProps {
  note?: string;
}

export function FooterLegend({ note }: FooterLegendProps) {
  return (
    <footer className="pc-shell__footer" data-testid="shell-footer">
      <div className="pc-shell__legend" aria-label="Task state legend">
        {LEGEND.map((l) => (
          <span key={l.state} className="pc-shell__legend-item" data-state={l.state}>
            <span
              className="pc-shell__legend-dot"
              style={{ background: l.cssVar }}
              aria-hidden="true"
            />
            <span className="pc-shell__legend-label">{l.label}</span>
          </span>
        ))}
      </div>
      <div className="pc-shell__footer-meta-row">
        {note ? <span className="pc-shell__footer-note">{note}</span> : null}
        <span className="pc-shell__footer-meta">read-only · parley never merges</span>
      </div>
    </footer>
  );
}
