/**
 * Footer state legend — square dots + labels so state is never hue alone.
 * Labels and inks come from the shared stateLabels table (#366).
 */

import { legendEntries } from "../components/stateLabels.js";

export interface FooterLegendProps {
  /** Full doctrine note (≥1460). Mock: "state = what a task IS · quality = how good work WAS · …" */
  note?: string;
  /** Compact doctrine note (≤1360 / 1280 floor). Must keep state=IS · quality=WAS lesson. */
  noteCompact?: string;
}

export function FooterLegend({ note, noteCompact }: FooterLegendProps) {
  const legend = legendEntries();
  return (
    <footer className="pc-shell__footer" data-testid="shell-footer">
      <div className="pc-shell__legend" aria-label="Task state legend">
        {legend.map((l) => (
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
        {note ? (
          <span className="pc-shell__footer-note pc-shell__footer-note--full" data-testid="footer-note-full">
            {note}
          </span>
        ) : null}
        {noteCompact || note ? (
          <span
            className="pc-shell__footer-note pc-shell__footer-note--compact"
            data-testid="footer-note-compact"
          >
            {noteCompact ?? note}
          </span>
        ) : null}
        <span className="pc-shell__footer-meta">read-only · parley never merges</span>
      </div>
    </footer>
  );
}
