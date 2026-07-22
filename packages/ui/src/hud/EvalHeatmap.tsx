import { memo, type CSSProperties } from "react";
import type { SoundingsHeatmapView, SoundingsView } from "./types.js";

/** Column dimensions for the criterion-failure heatmap (#166). */
export const HEATMAP_GROUP_BY: readonly { value: string; label: string }[] = [
  { value: "type", label: "Type" },
  { value: "vendor", label: "Vendor" },
  { value: "orch_harness", label: "Orchestrator" },
];

export interface EvalHeatmapProps {
  heatmap: SoundingsHeatmapView;
  groupBy: string;
  evalPresence: SoundingsView["evalPresence"];
  filtersActive: boolean;
  onGroupBy: (groupBy: string) => void;
}

/**
 * Map failure rate → CSS background. Floor opacity so 1–2 data points stay
 * legible; missing cells stay unshaded (not a false zero).
 */
function cellStyle(intensity: number | null): CSSProperties | undefined {
  if (intensity === null) return undefined;
  // Floor ~18% so a single failure is visible on the dark plate; full rate → coral.
  const pct = Math.round((0.18 + intensity * 0.82) * 100);
  return {
    background: `color-mix(in srgb, var(--state-failed) ${pct}%, rgba(0, 0, 0, 0.35))`,
    color: intensity >= 0.45 ? "var(--ink-parchment)" : "var(--ink-soft)",
  };
}

/**
 * Layer 2 — criterion failure heatmap (#166). Rubric criteria on the row axis,
 * the chosen dimension (type / vendor / orchestrator) on the column axis; cells
 * shade by failure rate. Shares Soundings filters and group_by with the rest of
 * the board. Plain props only.
 */
export const EvalHeatmap = memo(function EvalHeatmap({
  heatmap,
  groupBy,
  evalPresence,
  filtersActive,
  onGroupBy,
}: EvalHeatmapProps) {
  const { criteria, groups, cells, sampleEvals } = heatmap;

  return (
    <div className="pc-eval-heat">
      <div className="pc-soundings__controls" role="group" aria-label="Heatmap dimension">
        {HEATMAP_GROUP_BY.map((opt) => {
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
          <p className="pc-soundings__state-title">Charting failures…</p>
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
              ? "Loosen filters — or clear them — to map criterion failures."
              : "Delegate a voyage — the heatmap fills when rubric answers land."}
          </p>
        </div>
      )}

      {evalPresence === "off" && (
        <div className="pc-soundings__state" role="status">
          <p className="pc-soundings__state-title">No structured evals yet</p>
          <p className="pc-soundings__state-sub">
            Evaluation may be off for this project, or no task has been scored
            with a rubric. Criterion failures need structured answers — enable
            eval via the wizard and run{" "}
            <span className="pc-eval-dist__code">parley eval</span> after reviews.
          </p>
        </div>
      )}

      {evalPresence === "ready" && criteria.length === 0 && (
        <div className="pc-soundings__state" role="status">
          <p className="pc-soundings__state-title">
            {sampleEvals > 0 ? "No criterion answers yet" : "No scored groups"}
          </p>
          <p className="pc-soundings__state-sub">
            {sampleEvals > 0
              ? "Rubric scores are present, but no per-criterion answers were recorded under the current filters. Sparse data stays empty rather than inventing zeros."
              : "These groups have tasks but no rubric criterion data under the current filters."}
          </p>
        </div>
      )}

      {evalPresence === "ready" && criteria.length > 0 && (
        <div className="pc-eval-heat__wrap">
          <p className="pc-eval-heat__legend">
            <span className="pc-eval-heat__legend-item">
              <span className="pc-eval-heat__swatch pc-eval-heat__swatch--low" aria-hidden="true" />
              Low fail rate
            </span>
            <span className="pc-eval-heat__legend-item">
              <span className="pc-eval-heat__swatch pc-eval-heat__swatch--high" aria-hidden="true" />
              High fail rate
            </span>
            <span className="pc-eval-heat__legend-item">
              <span className="pc-eval-heat__swatch pc-eval-heat__swatch--empty" aria-hidden="true" />
              No sample
            </span>
            {sampleEvals <= 2 && (
              <span className="pc-eval-heat__sparse" role="status">
                Sparse — n={sampleEvals} eval{sampleEvals === 1 ? "" : "s"}
              </span>
            )}
          </p>

          <div className="pc-eval-heat__scroll">
            <div
              className="pc-eval-heat__grid"
              role="table"
              aria-label="Criterion failure heatmap"
              style={
                {
                  "--heat-cols": String(groups.length),
                } as CSSProperties
              }
            >
              {/* ARIA requires columnheaders inside a row; display:contents keeps
                  the wrapper out of the grid's layout. */}
              <div className="pc-eval-heat__contents" role="row">
                <div className="pc-eval-heat__corner" role="columnheader">
                  Criterion
                </div>
                {groups.map((g) => (
                  <div
                    key={g.key ?? "(none)"}
                    className="pc-eval-heat__colhead"
                    role="columnheader"
                    title={g.label}
                  >
                    {g.label}
                  </div>
                ))}
              </div>

              {criteria.map((criterionId, rowIdx) => {
                const row = cells[rowIdx] ?? [];
                return (
                  <div key={criterionId} className="pc-eval-heat__contents" role="row">
                    <div
                      className="pc-eval-heat__rowhead"
                      role="rowheader"
                      title={criterionId}
                    >
                      {criterionId}
                    </div>
                    {groups.map((g, colIdx) => {
                      const cell = row[colIdx];
                      const missing = !cell || cell.intensity === null;
                      const style = cellStyle(cell?.intensity ?? null);
                      const label = missing
                        ? `${criterionId} × ${g.label}: no sample`
                        : `${criterionId} × ${g.label}: ${cell.rateLabel} failed (${cell.failures}/${cell.count})`;
                      return (
                        <div
                          key={`${criterionId}:${g.key ?? "(none)"}`}
                          className={`pc-eval-heat__cell${missing ? " pc-eval-heat__cell--empty" : ""}`}
                          role="cell"
                          style={style}
                          title={label}
                          aria-label={label}
                        >
                          <span className="pc-eval-heat__cell-rate">
                            {cell?.rateLabel ?? "—"}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
});
