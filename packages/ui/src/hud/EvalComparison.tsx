import { memo, type CSSProperties } from "react";
import type { SoundingsComparisonRow, SoundingsView } from "./types.js";

/** Comparison dimension chips — vendor / orchestrator / judge. */
export const COMPARISON_GROUP_BY: readonly { value: string; label: string }[] = [
  { value: "vendor", label: "Vendor" },
  { value: "model", label: "Model" },
  { value: "orch_harness", label: "Orch harness" },
  { value: "orch_model", label: "Orch model" },
  { value: "eval_harness", label: "Judge harness" },
  { value: "eval_model", label: "Judge model" },
];

export interface EvalComparisonProps {
  rows: SoundingsComparisonRow[];
  groupBy: string;
  evalPresence: SoundingsView["evalPresence"];
  filtersActive: boolean;
  onGroupBy: (groupBy: string) => void;
}

function deltaColor(value: number | null): string | undefined {
  if (value === null || !Number.isFinite(value)) return undefined;
  if (value < 0) return "var(--quality-poor)";
  if (value > 0) return "var(--quality-good)";
  return undefined;
}

function ComparisonCard({ row }: { row: SoundingsComparisonRow }) {
  const deltaStyle = {
    color: deltaColor(row.avgDeltaValue) ?? "var(--quality-neutral)",
  } as CSSProperties;
  const rateStyle = {
    color:
      row.belowBaselineRateValue !== null &&
      Number.isFinite(row.belowBaselineRateValue) &&
      row.belowBaselineRateValue > 0
        ? "var(--quality-poor)"
        : "var(--quality-neutral)",
  } as CSSProperties;

  return (
    <article className="pc-eval-cmp__card" aria-label={`Comparison for ${row.label}`}>
      <header className="pc-eval-cmp__head">
        <h3 className="pc-eval-cmp__label">{row.label}</h3>
        <span className="pc-eval-cmp__n">n={row.count}</span>
      </header>

      <div className="pc-eval-cmp__stats">
        <div className="pc-eval-cmp__stat">
          <span className="pc-soundings__label">Avg delta</span>
          <span className="pc-eval-cmp__value" style={deltaStyle}>
            {row.avgDelta}
          </span>
          <span className="pc-eval-cmp__hint">score − baseline</span>
        </div>
        <div className="pc-eval-cmp__stat">
          <span className="pc-soundings__label">Below baseline</span>
          <span className="pc-eval-cmp__value" style={rateStyle}>
            {row.belowBaselineRate}
          </span>
          <span className="pc-eval-cmp__hint">rate</span>
        </div>
      </div>

      <div className="pc-eval-cmp__split" aria-label="First attempt vs fix recovery">
        <span className="pc-soundings__label">Recovery split</span>
        <div className="pc-eval-cmp__split-row">
          <div className="pc-eval-cmp__split-cell">
            <span className="pc-eval-cmp__split-k">First</span>
            <span className="pc-eval-cmp__split-v">{row.firstAttempt}</span>
          </div>
          <div className="pc-eval-cmp__split-cell">
            <span className="pc-eval-cmp__split-k">Fix</span>
            <span className="pc-eval-cmp__split-v">{row.fix}</span>
          </div>
        </div>
      </div>
    </article>
  );
}

/**
 * Layer 2 — side-by-side quality comparison (#165). Three stats per group:
 * avg delta, below-baseline rate, first-vs-fix recovery. Dimension chips
 * re-group the same filter set. Plain props only.
 */
export const EvalComparison = memo(function EvalComparison({
  rows,
  groupBy,
  evalPresence,
  filtersActive,
  onGroupBy,
}: EvalComparisonProps) {
  return (
    <div className="pc-eval-cmp">
      <div className="pc-soundings__controls" role="group" aria-label="Compare by">
        {COMPARISON_GROUP_BY.map((opt) => {
          const active = opt.value === groupBy;
          return (
            <button
              key={opt.value}
              type="button"
              className={`pc-soundings__chip-btn${active ? " pc-soundings__chip-btn--active" : ""}`}
              aria-pressed={active}
              onClick={() => onGroupBy(opt.value)}
            >
              {opt.label}
            </button>
          );
        })}
      </div>

      {evalPresence === "loading" && (
        <div className="pc-soundings__state" role="status">
          <p className="pc-soundings__state-title">Comparing quality…</p>
          <p className="pc-soundings__state-sub">listening for the fleet</p>
        </div>
      )}

      {evalPresence === "empty" && (
        <div className="pc-soundings__state" role="status">
          <p className="pc-soundings__state-title">
            {filtersActive ? "No matching tasks" : "No tasks yet"}
          </p>
          <p className="pc-soundings__state-sub">
            {filtersActive
              ? "Loosen filters — or clear them — to compare groups."
              : "Delegate a voyage — comparisons appear when the fleet reports."}
          </p>
        </div>
      )}

      {evalPresence === "off" && (
        <div className="pc-soundings__state" role="status">
          <p className="pc-soundings__state-title">No structured evals yet</p>
          <p className="pc-soundings__state-sub">
            Evaluation may be off for this project, or no task has been scored
            with a rubric. Delta, below-baseline rate, and recovery need
            structured scores — enable eval and score reviewed work to compare.
          </p>
        </div>
      )}

      {evalPresence === "ready" && (
        <>
          {rows.filter((r) => r.count > 0).length === 0 ? (
            <div className="pc-soundings__state" role="status">
              <p className="pc-soundings__state-title">No scored groups</p>
              <p className="pc-soundings__state-sub">
                These groups have tasks but no rubric scores under the current filters.
              </p>
            </div>
          ) : (
            <div className="pc-eval-cmp__list" role="list" aria-label="Quality comparison">
              {rows
                .filter((r) => r.count > 0)
                .map((row) => (
                  <div key={row.key ?? "(none)"} role="listitem">
                    <ComparisonCard row={row} />
                  </div>
                ))}
            </div>
          )}
        </>
      )}
    </div>
  );
});
