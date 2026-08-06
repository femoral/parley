/**
 * Score vs baseline distribution — HTML track (mock shape), not SVG.
 * Labels stay at declared CSS px (no viewBox scale); rows 24–30px.
 * Visually-hidden data table for AT (DESIGN.md pip-track precedent).
 */
import type { DistributionBar } from "./project.js";
import { HonestyPanel, LoadingSkeleton } from "./Honesty.js";
import { formatScore } from "./format.js";
import { Panel } from "../../components/index.js";

export interface ScoreDistributionProps {
  bars: readonly DistributionBar[];
  status: "loading" | "ready" | "empty" | "error" | "idle";
  error?: string | null;
  filterActive?: boolean;
}

const TICKS = [0, 2.5, 5, 7.5, 10] as const;

export function ScoreDistribution({
  bars,
  status,
  error,
  filterActive,
}: ScoreDistributionProps) {
  const hasData = bars.length > 0 && status === "ready";

  return (
    <Panel
      className="pc-metrics__panel"
      testId="metrics-distribution"
      aria-labelledby="metrics-dist-title"
      titleId="metrics-dist-title"
      titleTag="h2"
      title="score vs baseline"
      meta={hasData ? "0 — 10" : undefined}
    >
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
          <div className="pc-metrics__dist" data-testid="metrics-dist-plot">
            {/* Visually-hidden data table — deltas exist nowhere else for AT */}
            <table className="pc-sr-only" data-testid="metrics-dist-a11y">
              <caption>Score versus baseline by group (scale 0 to 10)</caption>
              <thead>
                <tr>
                  <th scope="col">group</th>
                  <th scope="col">score</th>
                  <th scope="col">baseline</th>
                  <th scope="col">delta</th>
                </tr>
              </thead>
              <tbody>
                {bars.map((bar) => (
                  <tr key={bar.key ?? bar.label}>
                    <th scope="row">{bar.label}</th>
                    <td>{formatScore(bar.score)}</td>
                    <td>{formatScore(bar.baseline)}</td>
                    <td>{bar.deltaLabel}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div
              className="pc-metrics__dist-rows"
              role="list"
              aria-label="Score versus baseline tracks"
              data-testid="metrics-dist-rows"
            >
              {bars.map((bar) => {
                const poor = bar.tone === "poor";
                const scorePct = Math.max(0, Math.min(100, bar.score * 10));
                const basePct = Math.max(0, Math.min(100, bar.baseline * 10));
                return (
                  <div
                    key={bar.key ?? bar.label}
                    className="pc-metrics__dist-row"
                    role="listitem"
                    data-testid="metrics-dist-row"
                  >
                    <span
                      className="pc-metrics__dist-label"
                      title={bar.label}
                      data-testid="metrics-dist-label"
                    >
                      {bar.label}
                    </span>
                    <div
                      className="pc-metrics__dist-track"
                      data-testid="metrics-dist-track"
                    >
                      <div
                        className={
                          poor
                            ? "pc-metrics__dist-score pc-metrics__dist-score--poor"
                            : "pc-metrics__dist-score"
                        }
                        style={{ width: `${scorePct}%` }}
                      />
                      <div
                        className="pc-metrics__dist-baseline"
                        style={{ left: `${basePct}%` }}
                        title={`baseline ${formatScore(bar.baseline)}`}
                      />
                    </div>
                    <span
                      className={
                        poor
                          ? "pc-metrics__dist-delta pc-metrics__dist-delta--poor"
                          : "pc-metrics__dist-delta pc-metrics__dist-delta--good"
                      }
                      data-testid="metrics-dist-delta"
                    >
                      {bar.deltaLabel}
                    </span>
                  </div>
                );
              })}
            </div>

            {/* Value axis — HTML labels at declared 11px, aligned to track column */}
            <div
              className="pc-metrics__dist-axis"
              data-testid="metrics-dist-axis"
              aria-hidden="true"
            >
              <span className="pc-metrics__dist-axis-gutter" />
              <div className="pc-metrics__dist-axis-track">
                {TICKS.map((tick) => (
                  <span
                    key={tick}
                    className="pc-metrics__dist-tick-label"
                    style={{ left: `${tick * 10}%` }}
                    data-testid="metrics-dist-tick-label"
                  >
                    {tick === 2.5 || tick === 7.5 ? tick.toFixed(1) : String(tick)}
                  </span>
                ))}
              </div>
              <span className="pc-metrics__dist-axis-end" />
            </div>
          </div>
        )}
    </Panel>
  );
}
