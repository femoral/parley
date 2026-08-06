/**
 * Criterion-failure heatmap — criteria × groups.
 * Low-sample cue, no-sample tiles, suspect 100%! cap.
 * Labels ≥11px; value axis legend for failure rate 0–100%.
 */
import type { HeatmapModel } from "./project.js";
import { HonestyPanel, LoadingSkeleton } from "./Honesty.js";
import { truncateLabel } from "./format.js";

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

  return (
    <section
      className="pc-metrics__panel"
      data-testid="metrics-heatmap"
      aria-labelledby="metrics-heat-title"
    >
      <div className="pc-metrics__panel-head">
        <h2 id="metrics-heat-title" className="pc-metrics__panel-title">
          criterion failure rate
        </h2>
        <span className="pc-metrics__panel-meta">
          {model.sampleTotal > 0
            ? `${model.sampleTotal} rubric samples · n<3 low`
            : "no samples"}
        </span>
      </div>
      <div className="pc-metrics__panel-body">
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
                <div
                  key={row.criterion}
                  style={{ display: "contents" }}
                >
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
                          : `${row.criterion} · ${model.columns[i]?.label ?? ""} · ${cell.label} · n=${cell.count}${cell.kind === "low" ? " · low sample" : ""}${cell.kind === "suspect" ? " · all failed" : ""}`
                      }
                      data-testid="metrics-heat-cell"
                      data-kind={cell.kind}
                    >
                      <span className="pc-metrics__heat-cell-label">{cell.label}</span>
                      <span
                        className="pc-metrics__heat-cell-bar"
                        style={{ width: cell.barW }}
                      />
                    </div>
                  ))}
                </div>
              ))}
            </div>

            {/* Value axis for failure rate */}
            <div
              className="pc-metrics__heat-axis"
              data-testid="metrics-heat-axis"
              aria-hidden="true"
            >
              <span>0%</span>
              <span>failure rate</span>
              <span>100%</span>
            </div>
            <div className="pc-metrics__heat-legend">
              <span className="pc-metrics__heat-legend-item">
                <span className="pc-metrics__heat-swatch" />
                no sample
              </span>
              <span className="pc-metrics__heat-legend-item">
                <span className="pc-metrics__heat-swatch pc-metrics__heat-swatch--rate" />
                rate (bar)
              </span>
              <span className="pc-metrics__heat-legend-item">n&lt;3 low sample</span>
              <span className="pc-metrics__heat-legend-item">100%! all failed</span>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
