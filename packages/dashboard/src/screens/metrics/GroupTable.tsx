/**
 * Group metrics table — tasks/runs, success, eval, tokens, duration, below base.
 * Workflow mode adds cost-per-completed-run.
 * At ≤1360, lower-priority columns drop so no silent mid-header clip.
 * Horizontal scroll (when needed) uses a visible edge fade + always-on scrollbar.
 */
import type { GroupRow } from "./project.js";
import { HonestyPanel, LoadingSkeleton } from "./Honesty.js";

export interface GroupTableProps {
  rows: readonly GroupRow[];
  dimLabel: string;
  workflow: boolean;
  status: "loading" | "ready" | "empty" | "error" | "idle";
  error?: string | null;
  filterActive?: boolean;
}

export function GroupTable({
  rows,
  dimLabel,
  workflow,
  status,
  error,
  filterActive,
}: GroupTableProps) {
  return (
    <section
      className="pc-metrics__panel"
      data-testid="metrics-group-table"
      aria-labelledby="metrics-table-title"
    >
      <div className="pc-metrics__panel-head">
        <h2 id="metrics-table-title" className="pc-metrics__panel-title">
          by {dimLabel}
        </h2>
        <span className="pc-metrics__panel-meta">
          {status === "ready"
            ? `${rows.length} group${rows.length === 1 ? "" : "s"}`
            : status}
        </span>
      </div>
      <div className="pc-metrics__panel-body">
        {status === "loading" || status === "idle" ? (
          <LoadingSkeleton rows={6} />
        ) : status === "error" ? (
          <HonestyPanel
            kind="error"
            body={error ?? "Group aggregates could not be loaded."}
            testId="metrics-table-error"
          />
        ) : rows.length === 0 ? (
          <HonestyPanel
            kind={filterActive ? "filter-empty" : "empty"}
            title={filterActive ? "No groups match" : "No groups yet"}
            body={
              filterActive
                ? "Widen or clear filters to see group aggregates."
                : workflow
                  ? "No runs in this scope. Workflow metrics appear once runs complete."
                  : "No tasks in this scope. Complete delegated work to populate the group table."
            }
            testId="metrics-table-empty"
          />
        ) : (
          <div className="pc-metrics__table-scroll" data-testid="metrics-table-scroll">
            <div className="pc-metrics__table-wrap">
              <table
                className={`pc-metrics__table${workflow ? " pc-metrics__table--workflow" : ""}`}
                data-testid="metrics-table"
              >
                <thead>
                  <tr>
                    <th scope="col" className="pc-metrics__th-name">
                      {dimLabel}
                    </th>
                    <th scope="col" data-align="right" className="pc-metrics__th-count">
                      {workflow ? "runs" : "tasks"}
                    </th>
                    <th scope="col" className="pc-metrics__th-success">
                      success
                    </th>
                    <th scope="col" className="pc-metrics__th-eval">
                      eval avg
                    </th>
                    <th
                      scope="col"
                      data-align="right"
                      className="pc-metrics__th-tokens"
                    >
                      tokens in ▸ out ▸ cached
                    </th>
                    <th
                      scope="col"
                      data-align="right"
                      className="pc-metrics__th-dur"
                    >
                      avg · p95
                    </th>
                    <th
                      scope="col"
                      data-align="right"
                      className="pc-metrics__th-below"
                    >
                      below base
                    </th>
                    {workflow ? (
                      <th
                        scope="col"
                        data-align="right"
                        className="pc-metrics__th-cost"
                      >
                        cost / done
                      </th>
                    ) : null}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.key ?? "(unset)"} data-testid="metrics-table-row">
                      <td className="pc-metrics__td-name">
                        <span className="pc-metrics__cell-name" title={row.label}>
                          {row.label}
                        </span>
                      </td>
                      <td data-align="right" className="pc-metrics__td-count">
                        <span className="pc-metrics__cell-data">{row.count}</span>
                      </td>
                      <td className="pc-metrics__td-success">
                        <div className="pc-metrics__success">
                          <div className="pc-metrics__success-track" aria-hidden="true">
                            <div
                              className={`pc-metrics__success-fill pc-metrics__success-fill--${row.successTone}`}
                              style={{ width: row.successWidth }}
                            />
                          </div>
                          <span className="pc-metrics__success-label">
                            {row.successLabel}
                          </span>
                        </div>
                      </td>
                      <td className="pc-metrics__td-eval">
                        <span
                          className={`pc-metrics__cell-data pc-metrics__cell-data--${row.evalTone}`}
                          title={row.evalTitle}
                        >
                          {row.evalLabel}
                        </span>
                      </td>
                      <td data-align="right" className="pc-metrics__td-tokens">
                        <span className="pc-metrics__cell-data" title={row.tokensLabel}>
                          {row.tokensLabel}
                        </span>
                      </td>
                      <td data-align="right" className="pc-metrics__td-dur">
                        <span className="pc-metrics__cell-data">{row.durationLabel}</span>
                      </td>
                      <td data-align="right" className="pc-metrics__td-below">
                        <span
                          className={`pc-metrics__cell-data pc-metrics__cell-data--${row.belowTone}`}
                        >
                          {row.belowLabel}
                        </span>
                      </td>
                      {workflow ? (
                        <td data-align="right" className="pc-metrics__td-cost">
                          <span
                            className="pc-metrics__cell-data"
                            title="tokens per completed run"
                          >
                            {row.costLabel}
                          </span>
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div
              className="pc-metrics__table-fade"
              aria-hidden="true"
              data-testid="metrics-table-fade"
            />
          </div>
        )}
      </div>
    </section>
  );
}
