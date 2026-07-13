import type { CSSProperties } from "react";
import type { LogLine } from "./types.js";

export interface LogStreamProps {
  lines: LogLine[];
  /** Whether the tail is still following (false once the daemon reports `eof`). */
  live: boolean;
  emptyMessage?: string;
}

/**
 * Layer 2 — the raw vendor log well (design-manifest §4.17 "Logs" / §2.8's
 * per-kind colours). Plain props, no polling here (contract 2) —
 * `Inspector`'s Logs tab is the only current caller, but this stays a
 * standalone hud component (component-system spec's Inspector/LogStream
 * split) so a future merged global stream (design-manifest §4.12, out of
 * scope for #68) can reuse the same line rendering.
 */
export function LogStream({
  lines,
  live,
  emptyMessage = "No log yet — the ship hasn't left the dock.",
}: LogStreamProps) {
  const dotStyle = { "--dot-color": live ? "var(--healthy-dot)" : "var(--ink-label)" } as CSSProperties;
  return (
    <div className="pc-logstream">
      <div className="pc-logstream__head">
        <span className={`pc-dot${live ? " pc-dot--beacon" : ""}`} style={dotStyle} aria-hidden="true" />
        <span className="pc-logstream__status">{live ? "Live · Follow" : "Paused"}</span>
      </div>
      <div className="pc-logstream__body" role="log">
        {lines.length === 0 ? (
          <p className="pc-logstream__empty">{emptyMessage}</p>
        ) : (
          lines.map((line) => (
            <div key={line.key} className={`pc-logstream__line pc-logstream__line--${line.kind}`}>
              {line.text}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
