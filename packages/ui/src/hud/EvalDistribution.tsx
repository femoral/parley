import { memo, type CSSProperties } from "react";
import type { SoundingsDistributionRow, SoundingsView } from "./types.js";

export interface EvalDistributionProps {
  rows: SoundingsDistributionRow[];
  evalPresence: SoundingsView["evalPresence"];
  filtersActive: boolean;
}

function DistributionRow({ row }: { row: SoundingsDistributionRow }) {
  const below =
    row.deltaValue !== null && Number.isFinite(row.deltaValue) && row.deltaValue < 0;
  const fill = below ? "var(--quality-poor)" : "var(--quality-good)";
  const scoreWidth =
    row.scorePos === null ? 0 : Math.max(0, Math.min(100, row.scorePos * 100));
  const baselineLeft =
    row.baselinePos === null ? null : Math.max(0, Math.min(100, row.baselinePos * 100));

  return (
    <article className="pc-eval-dist__row" aria-label={`Score vs baseline for ${row.label}`}>
      <header className="pc-eval-dist__head">
        <h3 className="pc-eval-dist__label">{row.label}</h3>
        <span className="pc-eval-dist__meta">
          <span className="pc-eval-dist__score" style={{ color: fill } as CSSProperties}>
            {row.score}
          </span>
          <span className="pc-eval-dist__sep">vs</span>
          <span className="pc-eval-dist__baseline" title="Group baseline">
            {row.baseline}
          </span>
          <span className="pc-eval-dist__delta" style={{ color: fill } as CSSProperties}>
            ({row.delta})
          </span>
          <span className="pc-eval-dist__n">n={row.count}</span>
        </span>
      </header>

      <div
        className="pc-eval-dist__track"
        role="img"
        aria-label={
          row.scorePos === null
            ? `${row.label}: no structured score`
            : `${row.label}: score ${row.score} of 10, baseline ${row.baseline}`
        }
      >
        <div
          className="pc-eval-dist__fill"
          style={{ width: `${scoreWidth}%`, background: fill }}
        />
        {baselineLeft !== null && (
          <span
            className="pc-eval-dist__baseline-mark"
            style={{ left: `${baselineLeft}%` }}
            title={`Baseline ${row.baseline}`}
          />
        )}
        <span className="pc-eval-dist__axis pc-eval-dist__axis--0">0</span>
        <span className="pc-eval-dist__axis pc-eval-dist__axis--10">10</span>
      </div>
    </article>
  );
}

/**
 * Layer 2 — score-vs-baseline distribution (#165). Each group is a 0–10 track
 * with avg score as fill and baseline as an explicit mark. Plain props only.
 */
export const EvalDistribution = memo(function EvalDistribution({
  rows,
  evalPresence,
  filtersActive,
}: EvalDistributionProps) {
  if (evalPresence === "loading") {
    return (
      <div className="pc-soundings__state" role="status">
        <p className="pc-soundings__state-title">Charting scores…</p>
        <p className="pc-soundings__state-sub">listening for the fleet</p>
      </div>
    );
  }

  if (evalPresence === "empty") {
    return (
      <div className="pc-soundings__state" role="status">
        <p className="pc-soundings__state-title">
          {filtersActive ? "No matching tasks" : "No tasks yet"}
        </p>
        <p className="pc-soundings__state-sub">
          {filtersActive
            ? "Loosen filters — or clear them — to see the distribution."
            : "Delegate a voyage — score tracks appear when the fleet reports."}
        </p>
      </div>
    );
  }

  if (evalPresence === "off") {
    return (
      <div className="pc-soundings__state" role="status">
        <p className="pc-soundings__state-title">No structured evals yet</p>
        <p className="pc-soundings__state-sub">
          Evaluation may be off for this project, or no task has been scored
          with a rubric. Enable eval via the wizard and run{" "}
          <span className="pc-eval-dist__code">parley eval</span> after reviews —
          then scores and baselines will chart here.
        </p>
      </div>
    );
  }

  const scored = rows.filter((r) => r.count > 0);
  if (scored.length === 0) {
    return (
      <div className="pc-soundings__state" role="status">
        <p className="pc-soundings__state-title">No scored groups</p>
        <p className="pc-soundings__state-sub">
          These groups have tasks but no rubric scores under the current filters.
        </p>
      </div>
    );
  }

  return (
    <div className="pc-eval-dist" role="list" aria-label="Score vs baseline distribution">
      <p className="pc-eval-dist__legend">
        <span className="pc-eval-dist__legend-item">
          <span className="pc-eval-dist__legend-fill" aria-hidden="true" />
          Avg score
        </span>
        <span className="pc-eval-dist__legend-item">
          <span className="pc-eval-dist__legend-mark" aria-hidden="true" />
          Baseline
        </span>
      </p>
      {scored.map((row) => (
        <div key={row.key ?? "(none)"} role="listitem">
          <DistributionRow row={row} />
        </div>
      ))}
    </div>
  );
});
