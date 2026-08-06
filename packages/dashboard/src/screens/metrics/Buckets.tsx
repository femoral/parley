/**
 * Eval-by-size / eval-by-difficulty chips — Soundings parity.
 */
import type { BucketChip } from "./project.js";
import { Panel } from "../../components/index.js";

export interface BucketsProps {
  bySize: readonly BucketChip[];
  byDifficulty: readonly BucketChip[];
}

export function Buckets({ bySize, byDifficulty }: BucketsProps) {
  if (bySize.length === 0 && byDifficulty.length === 0) return null;

  return (
    <Panel
      className="pc-metrics__panel"
      testId="metrics-buckets"
      aria-label="Eval buckets by size and difficulty"
      titleTag="h2"
      title="eval buckets"
      meta="size · difficulty"
    >
      <div className="pc-metrics__buckets">
        {bySize.length > 0 ? (
          <div className="pc-metrics__bucket-group">
            <span className="pc-metrics__bucket-title">by size</span>
            <div className="pc-metrics__bucket-list">
              {bySize.map((b) => (
                <span
                  key={b.id}
                  className="pc-metrics__bucket-chip"
                  title={`avg ${b.avgLabel} · below ${b.belowLabel}`}
                  data-testid="metrics-bucket-size"
                >
                  <strong>{b.id}</strong>
                  <span>n={b.count}</span>
                  <span>avg {b.avgLabel}</span>
                </span>
              ))}
            </div>
          </div>
        ) : null}
        {byDifficulty.length > 0 ? (
          <div className="pc-metrics__bucket-group">
            <span className="pc-metrics__bucket-title">by difficulty</span>
            <div className="pc-metrics__bucket-list">
              {byDifficulty.map((b) => (
                <span
                  key={b.id}
                  className="pc-metrics__bucket-chip"
                  title={`avg ${b.avgLabel} · below ${b.belowLabel}`}
                  data-testid="metrics-bucket-difficulty"
                >
                  <strong>{b.id}</strong>
                  <span>n={b.count}</span>
                  <span>avg {b.avgLabel}</span>
                </span>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </Panel>
  );
}
