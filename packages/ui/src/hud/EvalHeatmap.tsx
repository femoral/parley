import { memo, type CSSProperties } from "react";
import type { SoundingsHeatmapCell, SoundingsHeatmapView, SoundingsView } from "./types.js";

/** Column dimensions for the criterion-failure heatmap (#166). */
export const HEATMAP_GROUP_BY: readonly { value: string; label: string }[] = [
  { value: "type", label: "Type" },
  { value: "vendor", label: "Vendor" },
  { value: "orch_harness", label: "Orchestrator" },
];

/**
 * Cells with fewer samples than this get a visible low-n cue so the color
 * ramp cannot overstate thin data (n was previously tooltip/aria only).
 */
export const HEATMAP_LOW_SAMPLE_THRESHOLD = 3;

/**
 * Floor / ceiling of quality-poor mixed into opaque --plate-top.
 *
 * The ramp stays inside the parchment-safe band so a single warm ink
 * (--ink-parchment) clears WCAG AA (≥4.5:1) at every intensity. Climbing
 * past ~56% into mid-rose plate mixes creates a luminance valley where no
 * warm ink passes AA; capping the top (muted rose, not pure quality-poor)
 * keeps the encoding strictly monotonic — two different failure rates always
 * paint two different shades. Floor 18% so a single failure stays visible.
 */
export const HEATMAP_MIX_FLOOR = 18;
export const HEATMAP_MIX_CEILING = 56;

export interface EvalHeatmapProps {
  heatmap: SoundingsHeatmapView;
  groupBy: string;
  evalPresence: SoundingsView["evalPresence"];
  filtersActive: boolean;
  onGroupBy: (groupBy: string) => void;
}

/**
 * Percent of --quality-poor mixed into opaque --plate-top for a failure
 * intensity. Plain linear map: floor → ceiling across [0, 1]. Strictly
 * monotonic — no plateaus, no clamps. Exported for contrast / honesty tests.
 */
export function heatmapMixPercent(intensity: number): number {
  return HEATMAP_MIX_FLOOR + intensity * (HEATMAP_MIX_CEILING - HEATMAP_MIX_FLOOR);
}

/**
 * Map failure rate → CSS background + parchment ink. Mixes quality-poor into
 * opaque plate-top (not a translucent black wash) so published contrast math
 * holds against the real composite. Single ink across the whole ramp —
 * missing cells stay unshaded (not a false zero).
 */
export function cellStyle(intensity: number | null): CSSProperties | undefined {
  if (intensity === null) return undefined;
  const pct = heatmapMixPercent(intensity);
  return {
    // Opaque plate-top mix: prior rgba(0,0,0,0.35) composited over plate wood
    // and made pure-quality-poor endpoint math a lie.
    background: `color-mix(in srgb, var(--quality-poor) ${pct}%, var(--plate-top))`,
    color: "var(--ink-parchment)",
  };
}

/** True when a sampled cell is too thin for the ramp to stand alone. */
export function isLowSampleCell(count: number): boolean {
  return count > 0 && count < HEATMAP_LOW_SAMPLE_THRESHOLD;
}

/**
 * Wire can send failures > count (rate > 1). Never paint impossible percents —
 * clamp the visible label at 100% and mark the cell as suspect data.
 */
export function isSuspectHeatmapRate(cell: Pick<SoundingsHeatmapCell, "rate" | "failures" | "count">): boolean {
  if (cell.count > 0 && cell.failures > cell.count) return true;
  if (cell.rate !== null && Number.isFinite(cell.rate) && cell.rate > 1) return true;
  return false;
}

/**
 * Display rate for a heatmap cell. Caps impossible rates at `100%!` so the
 * plate never quietly trusts bad wire data.
 */
export function formatHeatmapRateDisplay(
  cell: Pick<SoundingsHeatmapCell, "rate" | "rateLabel" | "failures" | "count" | "intensity">,
): string {
  if (cell.intensity === null && (cell.count === 0 || cell.rate === null)) {
    return cell.rateLabel || "—";
  }
  if (isSuspectHeatmapRate(cell)) return "100%!";
  return cell.rateLabel;
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
            <span className="pc-eval-heat__legend-item">
              <span className="pc-eval-heat__swatch pc-eval-heat__swatch--low-n" aria-hidden="true" />
              Low n (n&lt;{HEATMAP_LOW_SAMPLE_THRESHOLD})
            </span>
            {sampleEvals <= 2 && (
              <span className="pc-eval-heat__sparse" role="status">
                Sparse — n={sampleEvals} eval{sampleEvals === 1 ? "" : "s"}
              </span>
            )}
          </p>

          <div
            className="pc-eval-heat__scroll"
            tabIndex={0}
            role="region"
            aria-label="Heatmap grid"
          >
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
                      const lowN = !missing && cell != null && isLowSampleCell(cell.count);
                      const suspect = !missing && cell != null && isSuspectHeatmapRate(cell);
                      const style = cellStyle(cell?.intensity ?? null);
                      const rateDisplay = cell ? formatHeatmapRateDisplay(cell) : "—";
                      const label = missing
                        ? `${criterionId} × ${g.label}: no sample`
                        : `${criterionId} × ${g.label}: ${rateDisplay} failed (${cell.failures}/${cell.count})${lowN ? ", low sample" : ""}${suspect ? ", suspect data (rate exceeds 100%)" : ""}`;
                      return (
                        <div
                          key={`${criterionId}:${g.key ?? "(none)"}`}
                          className={`pc-eval-heat__cell${missing ? " pc-eval-heat__cell--empty" : ""}${lowN ? " pc-eval-heat__cell--low-n" : ""}${suspect ? " pc-eval-heat__cell--suspect" : ""}`}
                          role="cell"
                          style={style}
                          title={label}
                          aria-label={label}
                        >
                          <span className="pc-eval-heat__cell-rate">
                            {rateDisplay}
                          </span>
                          {lowN && cell != null && (
                            <span className="pc-eval-heat__cell-n" aria-hidden="true">
                              n={cell.count}
                            </span>
                          )}
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
