import { ReportPanel } from "../ReportPanel.js";
import type { ReportView } from "../types.js";

export interface ReportTabProps {
  report: ReportView | null;
}

/** Layer 2 — the Report tab: thin wrapper over the standalone {@link ReportPanel}
 * (design-manifest §4.17 "Report"). */
export function ReportTab({ report }: ReportTabProps) {
  return <ReportPanel report={report} />;
}
