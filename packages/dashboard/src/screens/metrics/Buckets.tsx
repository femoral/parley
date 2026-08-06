/**
 * Eval-by-size / eval-by-difficulty chips — Soundings parity.
 */
import type { BucketChip } from "./project.js";

export interface BucketsProps {
  bySize: readonly BucketChip[];
  byDifficulty: readonly BucketChip[];
}

export function Buckets({ bySize, byDifficulty }: BucketsProps) {
  if (bySize.length === 0 && byDifficulty.length === 0) return null;

  return (
    <section
      className="pc-metrics__panel"
      data-testid="metrics-buckets"
      aria-label="Eval buckets by size and difficulty"
    >
      <div className="pc-metrics__panel-head">
        <h2 className="pc-metrics__panel-title">eval buckets</h2>
        <span className="pc-metrics__panel-meta">size · difficulty</span>
      </div>
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
                  <span>{b.avgLabel}</span>
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
                  <span>{b.avgLabel}</span>
                </span>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}
