/**
 * Comparison view — first-attempt vs fix (task) or first-run vs fork (run).
 * Avg delta recovery split; capability parity with Soundings, Console treatment.
 */
import type { ComparisonModel } from "./project.js";
import { HonestyPanel, LoadingSkeleton } from "./Honesty.js";

export interface ComparisonPanelProps {
  model: ComparisonModel | null;
  status: "loading" | "ready" | "empty" | "error" | "idle";
  error?: string | null;
  filterActive?: boolean;
}

export function ComparisonPanel({
  model,
  status,
  error,
  filterActive,
}: ComparisonPanelProps) {
  const midTone =
    model?.overallDelta == null
      ? ""
      : model.overallDelta >= 0
        ? "pc-metrics__compare-mid-value--good"
        : "pc-metrics__compare-mid-value--poor";

  return (
    <section
      className="pc-metrics__panel"
      data-testid="metrics-comparison"
      aria-labelledby="metrics-compare-title"
    >
      <div className="pc-metrics__panel-head">
        <h2 id="metrics-compare-title" className="pc-metrics__panel-title">
          comparison
        </h2>
        <span className="pc-metrics__panel-meta">
          {model?.kind === "run" ? "first run vs fork" : "first attempt vs fix"}
        </span>
      </div>
      <div className="pc-metrics__panel-body">
        {status === "loading" || status === "idle" ? (
          <LoadingSkeleton rows={4} />
        ) : status === "error" ? (
          <HonestyPanel
            kind="error"
            body={error ?? "Comparison aggregates could not be loaded."}
            testId="metrics-compare-error"
          />
        ) : !model ? (
          <HonestyPanel
            kind={filterActive ? "filter-empty" : "empty"}
            title="No lineage split yet"
            body={
              filterActive
                ? "Clear filters to compare first attempts against fixes in scope."
                : "First-vs-fix (or first-run-vs-fork) averages appear once rubric evals land on both sides of the lineage."
            }
            testId="metrics-compare-empty"
          />
        ) : (
          <div className="pc-metrics__compare" data-testid="metrics-compare-body">
            <Side split={model.left} />
            <div className="pc-metrics__compare-mid">
              <span className="pc-metrics__compare-mid-label">avg Δ</span>
              <span className={`pc-metrics__compare-mid-value ${midTone}`}>
                {model.overallDeltaLabel}
              </span>
            </div>
            <Side split={model.right} />
          </div>
        )}
      </div>
    </section>
  );
}

function Side({
  split,
}: {
  split: ComparisonModel["left"];
}) {
  return (
    <div className="pc-metrics__compare-side" data-testid="metrics-compare-side">
      <span className="pc-metrics__compare-side-label">{split.label}</span>
      <div className="pc-metrics__compare-stat">
        <span>samples</span>
        <strong>{split.count}</strong>
      </div>
      <div className="pc-metrics__compare-stat">
        <span>avg score</span>
        <strong>{split.avgLabel}</strong>
      </div>
      <div className="pc-metrics__compare-stat">
        <span>avg delta</span>
        <strong>{split.deltaLabel}</strong>
      </div>
      <div className="pc-metrics__compare-stat">
        <span>below base</span>
        <strong>{split.belowLabel}</strong>
      </div>
    </div>
  );
}
