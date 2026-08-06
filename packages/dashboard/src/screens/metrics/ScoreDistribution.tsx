/**
 * Score vs baseline distribution — SVG with an explicit 0–10 value axis.
 * Chart labels are ≥11px (verification floor for plot claims).
 */
import type { DistributionBar } from "./project.js";
import { HonestyPanel, LoadingSkeleton } from "./Honesty.js";

export interface ScoreDistributionProps {
  bars: readonly DistributionBar[];
  status: "loading" | "ready" | "empty" | "error" | "idle";
  error?: string | null;
  filterActive?: boolean;
}

const PAD_L = 118;
const PAD_R = 56;
const PAD_T = 8;
const AXIS_H = 28;
const ROW_H = 28;
const TRACK_H = 12;
const SCORE_MAX = 10;

export function ScoreDistribution({
  bars,
  status,
  error,
  filterActive,
}: ScoreDistributionProps) {
  const plotW = 320;
  const innerW = plotW;
  const rowsH = Math.max(bars.length, 1) * ROW_H;
  const height = PAD_T + rowsH + AXIS_H;
  const width = PAD_L + innerW + PAD_R;

  return (
    <section
      className="pc-metrics__panel"
      data-testid="metrics-distribution"
      aria-labelledby="metrics-dist-title"
    >
      <div className="pc-metrics__panel-head">
        <h2 id="metrics-dist-title" className="pc-metrics__panel-title">
          score vs baseline
        </h2>
        <span className="pc-metrics__panel-meta">0 — 10</span>
      </div>
      <div className="pc-metrics__panel-body">
        {status === "loading" || status === "idle" ? (
          <LoadingSkeleton rows={5} />
        ) : status === "error" ? (
          <HonestyPanel
            kind="error"
            body={error ?? "The score distribution could not be loaded."}
            testId="metrics-dist-error"
          />
        ) : bars.length === 0 ? (
          <HonestyPanel
            kind={filterActive ? "filter-empty" : "empty"}
            title={filterActive ? "No scored groups match" : "No scores to plot"}
            body={
              filterActive
                ? "Clear filters to plot score vs baseline for groups in scope."
                : "Structured rubric evals populate this track. With eval off, the panel stays empty by design."
            }
            testId="metrics-dist-empty"
          />
        ) : (
          <div className="pc-metrics__dist">
            <svg
              className="pc-metrics__dist-svg"
              viewBox={`0 0 ${width} ${height}`}
              role="img"
              aria-label="Score versus baseline distribution, scale zero to ten"
              data-testid="metrics-dist-svg"
            >
              {/* Value axis (x) — required on every plot */}
              <line
                className="pc-metrics__dist-axis-line"
                x1={PAD_L}
                y1={PAD_T + rowsH}
                x2={PAD_L + innerW}
                y2={PAD_T + rowsH}
                data-testid="metrics-dist-axis"
              />
              {[0, 2.5, 5, 7.5, 10].map((tick) => {
                const x = PAD_L + (tick / SCORE_MAX) * innerW;
                return (
                  <g key={tick}>
                    <line
                      className="pc-metrics__dist-tick"
                      x1={x}
                      y1={PAD_T + rowsH}
                      x2={x}
                      y2={PAD_T + rowsH + 4}
                    />
                    <text
                      className="pc-metrics__dist-axis"
                      x={x}
                      y={PAD_T + rowsH + 18}
                      textAnchor="middle"
                      data-testid="metrics-dist-tick-label"
                    >
                      {tick === 2.5 || tick === 7.5 ? tick.toFixed(1) : String(tick)}
                    </text>
                  </g>
                );
              })}

              {bars.map((bar, i) => {
                const y = PAD_T + i * ROW_H + (ROW_H - TRACK_H) / 2;
                const scorePx = (bar.score / SCORE_MAX) * innerW;
                const basePx = (bar.baseline / SCORE_MAX) * innerW;
                const poor = bar.tone === "poor";
                return (
                  <g key={`${bar.key ?? "null"}-${i}`} data-testid="metrics-dist-row">
                    <text
                      className="pc-metrics__dist-label"
                      x={PAD_L - 8}
                      y={y + TRACK_H / 2 + 4}
                      textAnchor="end"
                    >
                      {bar.label.length > 14 ? `${bar.label.slice(0, 13)}…` : bar.label}
                    </text>
                    <title>{bar.label}</title>
                    <rect
                      className="pc-metrics__dist-track"
                      x={PAD_L}
                      y={y}
                      width={innerW}
                      height={TRACK_H}
                    />
                    <rect
                      className={
                        poor
                          ? "pc-metrics__dist-score pc-metrics__dist-score--poor"
                          : "pc-metrics__dist-score"
                      }
                      x={PAD_L}
                      y={y}
                      width={Math.max(0, scorePx)}
                      height={TRACK_H}
                    />
                    <line
                      className="pc-metrics__dist-baseline"
                      x1={PAD_L + basePx}
                      y1={y - 2}
                      x2={PAD_L + basePx}
                      y2={y + TRACK_H + 2}
                    />
                    <text
                      className={
                        poor
                          ? "pc-metrics__dist-delta pc-metrics__dist-delta--poor"
                          : "pc-metrics__dist-delta pc-metrics__dist-delta--good"
                      }
                      x={PAD_L + innerW + 8}
                      y={y + TRACK_H / 2 + 4}
                      textAnchor="start"
                    >
                      {bar.deltaLabel}
                    </text>
                  </g>
                );
              })}
            </svg>
          </div>
        )}
      </div>
    </section>
  );
}
