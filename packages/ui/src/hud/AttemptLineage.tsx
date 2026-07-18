import { memo } from "react";
import { Badge } from "../primitives/index.js";
import type { AttemptLineageItem } from "./types.js";

export interface AttemptLineageProps {
  /** Full chain root → latest; empty only when projection has no attempts. */
  attempts: AttemptLineageItem[];
}

/**
 * Layer 2 — attempt-lineage timeline on task detail (#166). Shows the full
 * fix chain with resumed/cache badges and per-attempt scores, mirroring
 * enriched `parley status`. Plain props only.
 */
export const AttemptLineage = memo(function AttemptLineage({
  attempts,
}: AttemptLineageProps) {
  if (attempts.length === 0) {
    return (
      <div className="pc-lineage" role="status">
        <span className="pc-lineage__label">ATTEMPTS</span>
        <p className="pc-lineage__empty">No attempt chain on record.</p>
      </div>
    );
  }

  return (
    <div className="pc-lineage" aria-label="Attempt lineage">
      <span className="pc-lineage__label">ATTEMPTS</span>
      <ol className="pc-lineage__list">
        {attempts.map((a, index) => {
          const isLast = index === attempts.length - 1;
          return (
            <li
              key={a.id}
              className={`pc-lineage__item${a.current ? " pc-lineage__item--current" : ""}`}
            >
              {!isLast && <span className="pc-lineage__rail" aria-hidden="true" />}
              <span className="pc-lineage__node" aria-hidden="true">
                <span className="pc-lineage__dot" />
              </span>
              <div className="pc-lineage__body">
                <header className="pc-lineage__head">
                  <span className="pc-lineage__attempt">{`#${a.attempt}`}</span>
                  <span className="pc-lineage__id" title={a.id}>
                    {a.id}
                  </span>
                  <Badge label={a.stateLabel} color={a.stateColor} />
                  {a.current && (
                    <Badge label="THIS" color="var(--brass)" />
                  )}
                </header>
                <div className="pc-lineage__meta">
                  {a.score !== null ? (
                    <span className="pc-lineage__score" title="Eval score / baseline">
                      {`★ ${a.score}`}
                    </span>
                  ) : (
                    <span className="pc-lineage__score pc-lineage__score--none">
                      unscored
                    </span>
                  )}
                  <span className="pc-lineage__badges">
                    {a.resumed && (
                      <Badge label="RESUMED" color="var(--state-running)" />
                    )}
                    {a.cacheBadge === "cache" && (
                      <Badge label="CACHE" color="var(--state-completed)" />
                    )}
                    {a.cacheBadge === "no-cache" && (
                      <Badge label="NO-CACHE" color="var(--ink-label)" />
                    )}
                  </span>
                </div>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
});
