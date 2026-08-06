/**
 * Criterion-failure heatmap — criteria × groups.
 * Low-sample / no-sample / suspect cues; zero rate → zero bar.
 * Truncation disclosed; scale lives in the legend (not a fake axis strip).
 * Visually-hidden data table for AT.
 */
import type { HeatmapModel } from "./project.js";
import { HonestyPanel, LoadingSkeleton } from "./Honesty.js";
import { plural, truncateLabel } from "./format.js";
import { Panel } from "../../components/index.js";

export interface CriterionHeatmapProps {
  model: HeatmapModel;
  status: "loading" | "ready" | "empty" | "error" | "idle";
  error?: string | null;
  filterActive?: boolean;
}

export function CriterionHeatmap({
  model,
  status,
  error,
  filterActive,
}: CriterionHeatmapProps) {
  const cols = Math.max(model.columns.length, 1);
  const gridCols = `minmax(120px, 150px) repeat(${cols}, minmax(44px, 1fr))`;

  const meta = (() => {
    if (model.sampleTotal === 0) return "no samples";
    const samples = plural(model.sampleShown, "rubric sample");
    if (model.truncated) {
      return `showing ${model.shownCols} of ${model.totalCols} groups · ${samples} of ${model.sampleTotal}`;
    }
    return samples;
  })();

  return (
    <Panel
      className="pc-metrics__panel"
      testId="metrics-heatmap"
      aria-labelledby="metrics-heat-title"
      titleId="metrics-heat-title"
      titleTag="h2"
      title="criterion failure rate"
      meta={
        <span
          data-testid="metrics-heat-meta"
          title={
            model.truncated
              ? `Columns: ${model.selectionRule}. ${model.totalCols - model.shownCols} groups (${model.sampleTotal - model.sampleShown} samples) not shown.`
              : undefined
          }
        >
          {meta}
        </span>
      }
    >
        {status === "loading" || status === "idle" ? (
          <LoadingSkeleton rows={6} />
        ) : status === "error" ? (
          <HonestyPanel
            kind="error"
            body={error ?? "The criterion heatmap could not be loaded."}
            testId="metrics-heat-error"
          />
        ) : model.rows.length === 0 || model.columns.length === 0 ? (
          <HonestyPanel
            kind={filterActive ? "filter-empty" : "empty"}
            title={filterActive ? "No criteria match" : "No criterion failures to show"}
            body={
              filterActive
                ? "Clear filters to surface criterion failure rates for groups in scope."
                : "Per-criterion failure rates appear after structured rubric evals. Empty is the honest default when eval is off."
            }
            testId="metrics-heat-empty"
          />
        ) : (
          <div className="pc-metrics__heat">
            {model.truncated ? (
              <p className="pc-metrics__heat-trunc" data-testid="metrics-heat-trunc">
                Showing {model.shownCols} of {model.totalCols} groups (
                {model.sampleShown} of {model.sampleTotal} rubric samples) —{" "}
                {model.selectionRule}.
              </p>
            ) : null}

            {/* Visually-hidden data table for AT */}
            <table className="pc-sr-only" data-testid="metrics-heat-a11y">
              <caption>
                Criterion failure rate by group
                {model.truncated
                  ? ` (showing ${model.shownCols} of ${model.totalCols} groups)`
                  : ""}
              </caption>
              <thead>
                <tr>
                  <th scope="col">criterion</th>
                  {model.columns.map((c) => (
                    <th key={c.key ?? "null"} scope="col">
                      {c.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {model.rows.map((row) => (
                  <tr key={row.criterion}>
                    <th scope="row">{row.criterion}</th>
                    {row.cells.map((cell, i) => (
                      <td key={`${row.criterion}-${model.columns[i]?.key ?? i}`}>
                        {cell.kind === "none"
                          ? "no sample"
                          : `${cell.label}${cell.low ? " low sample" : ""}${cell.suspect ? " all failed" : ""}`}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>

            <div
              className="pc-metrics__heat-grid"
              style={{ gridTemplateColumns: gridCols }}
              role="group"
              aria-label="Criterion failure rate by group"
              data-testid="metrics-heat-grid"
            >
              <div className="pc-metrics__heat-corner" aria-hidden="true" />
              {model.columns.map((c) => (
                <div
                  key={c.key ?? "null"}
                  className="pc-metrics__heat-col"
                  title={c.label}
                >
                  {truncateLabel(c.label, 10)}
                </div>
              ))}
              {model.rows.map((row) => (
                <div key={row.criterion} style={{ display: "contents" }}>
                  <div
                    className="pc-metrics__heat-row-label"
                    title={row.criterion}
                  >
                    {row.criterion}
                  </div>
                  {row.cells.map((cell, i) => (
                    <div
                      key={`${row.criterion}-${model.columns[i]?.key ?? i}`}
                      className={`pc-metrics__heat-cell pc-metrics__heat-cell--${cell.kind}`}
                      title={
                        cell.kind === "none"
                          ? `${row.criterion} · ${model.columns[i]?.label ?? ""} · no sample`
                          : `${row.criterion} · ${model.columns[i]?.label ?? ""} · ${cell.label}${cell.low ? " · low sample" : ""}${cell.suspect ? " · all failed" : ""}`
                      }
                      data-testid="metrics-heat-cell"
                      data-kind={cell.kind}
                      data-low={cell.low ? "1" : "0"}
                      data-suspect={cell.suspect ? "1" : "0"}
                      data-bar={cell.barW}
                    >
                      <span className="pc-metrics__heat-cell-label">{cell.label}</span>
                      <span
                        className="pc-metrics__heat-cell-bar"
                        style={{ width: cell.barW }}
                        data-testid="metrics-heat-bar"
                      />
                    </div>
                  ))}
                </div>
              ))}
            </div>

            {/* Honest scale in the legend — not a decorative half-width axis strip */}
            <div
              className="pc-metrics__heat-legend"
              data-testid="metrics-heat-legend"
            >
              <span className="pc-metrics__heat-legend-item">
                <span className="pc-metrics__heat-swatch pc-metrics__heat-swatch--rate" />
                bar = failure rate 0–100%
              </span>
              <span className="pc-metrics__heat-legend-item">
                <span className="pc-metrics__heat-swatch" />
                — no sample
              </span>
              <span className="pc-metrics__heat-legend-item pc-metrics__heat-legend-item--low">
                n=&lt;3 low sample (ink + n= in cell)
              </span>
              <span className="pc-metrics__heat-legend-item pc-metrics__heat-legend-item--suspect">
                100%! all failed
              </span>
            </div>
          </div>
        )}
    </Panel>
  );
}
