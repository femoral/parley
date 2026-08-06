/**
 * Per-panel honesty states for the metrics screen.
 * Designed as first-class screens — never a blank region.
 */

export type HonestyKind = "loading" | "empty" | "error" | "filter-empty";

export interface HonestyProps {
  kind: HonestyKind;
  title?: string;
  body?: string;
  /** Extra class on the root for test hooks. */
  testId?: string;
}

const DEFAULTS: Record<HonestyKind, { title: string; body: string }> = {
  loading: {
    title: "Loading metrics",
    body: "Fetching aggregates from the daemon.",
  },
  empty: {
    title: "No scored work yet",
    body:
      "Eval is off for this project — score, baseline, and criterion panels stay empty until structured evals land. Completed tasks without rubric scores still appear in the group table.",
  },
  "filter-empty": {
    title: "No groups match",
    body: "Widen or clear filters to see aggregates for this scope.",
  },
  error: {
    title: "Could not load metrics",
    body: "The daemon did not return aggregates for this panel.",
  },
};

export function HonestyPanel({ kind, title, body, testId }: HonestyProps) {
  const d = DEFAULTS[kind];
  return (
    <div
      className={`pc-metrics__honesty pc-metrics__honesty--${kind}`}
      data-testid={testId ?? `metrics-honesty-${kind}`}
      role={kind === "error" ? "alert" : "status"}
    >
      <p className="pc-metrics__honesty-title">{title ?? d.title}</p>
      <p className="pc-metrics__honesty-body">{body ?? d.body}</p>
    </div>
  );
}

export function LoadingSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div data-testid="metrics-loading" role="status" aria-label="Loading metrics">
      {Array.from({ length: rows }, (_, i) => (
        <div
          key={i}
          className={`pc-metrics__skeleton ${i % 2 === 0 ? "pc-metrics__skeleton--wide" : "pc-metrics__skeleton--mid"}`}
        />
      ))}
    </div>
  );
}

export function StaleBanner({ message }: { message?: string }) {
  return (
    <div
      className="pc-metrics__banner pc-metrics__banner--stale"
      data-testid="metrics-stale-banner"
      role="status"
    >
      {message ?? "Showing last good metrics — reconnecting to the daemon."}
    </div>
  );
}

export function ErrorBanner({ message }: { message: string }) {
  return (
    <div
      className="pc-metrics__banner pc-metrics__banner--error"
      data-testid="metrics-error-banner"
      role="alert"
    >
      {message}
    </div>
  );
}
