import { Badge } from "../primitives/index.js";
import type { ReportView } from "./types.js";

export interface ReportPanelProps {
  /** `null` renders the manifest's empty state — no report yet. */
  report: ReportView | null;
  emptyMessage?: string;
}

const OUTCOME_COLOR: Record<ReportView["outcome"], string> = {
  success: "var(--outcome-success)",
  partial: "var(--outcome-partial)",
  blocked: "var(--outcome-blocked)",
};

/**
 * Layer 2 — the structured report (design-manifest §4.13/§4.17 "Report").
 * Plain props throughout (contract 2). Standalone hud component (component-
 * system spec's Inspector/ReportPanel split) so the future central report
 * band (§4.13, out of scope for #68) can reuse the same rendering as the
 * Inspector's Report tab. Files changed lists paths only — the contract's
 * `Report` shape carries no per-file add/del counts, so the manifest's
 * `+adds`/`−dels` footer stat is out for v1 (docs/spec/ui-v1-scope.md: "fills
 * panels only from data parley exposes today"). Paths render with a neutral
 * diamond mark — never `+`/`−`, which would imply add/delete semantics the
 * contract does not carry.
 *
 * The summary mirrors the Brief's GOAL well: long reports clamp to a 3-line
 * excerpt with a character count so the panel never scrolls open, and "Read
 * full report" opens the whole dispatch in the brass-framed "Ship's Report"
 * popover over the vignetted sea (native Popover API).
 */
export function ReportPanel({
  report,
  emptyMessage = "No report yet — this soul is still at sea.",
}: ReportPanelProps) {
  if (!report) {
    return <p className="pc-report__empty">{emptyMessage}</p>;
  }
  return (
    <div className="pc-report">
      <Badge label={report.outcome.toUpperCase()} color={OUTCOME_COLOR[report.outcome]} />
      <div className="pc-report__summary pc-report__summary--log">
        <span className="pc-report__summary-head">
          <span className="pc-report__summary-label">Summary</span>
          <span className="pc-report__summary-count">{report.summary.length} ch</span>
        </span>
        <p className="pc-report__excerpt">{report.summary}</p>
        <button type="button" className="pc-report__orders-open" popoverTarget="pc-report-orders">
          Read full report
        </button>
        <div id="pc-report-orders" popover="auto" className="pc-report__orders">
          <div className="pc-report__orders-head">
            <span className="pc-report__orders-title">Ship&rsquo;s Report</span>
            <button
              type="button"
              className="pc-report__orders-close"
              popoverTarget="pc-report-orders"
              popoverTargetAction="hide"
              aria-label="Close full report"
            >
              ✕
            </button>
          </div>
          <p className="pc-report__orders-body">{report.summary}</p>
        </div>
      </div>
      {report.files.length > 0 && (
        <div className="pc-report__files">
          <span className="pc-report__files-label">FILES CHANGED</span>
          <ul>
            {report.files.map((file) => (
              <li key={file.path}>{file.path}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
