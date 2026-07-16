import { memo, type CSSProperties } from "react";
import { Mark, Plate, PlateHeader } from "../primitives/index.js";
import { MARK_COMPASS } from "../tokens/chrome-glyphs.js";
import type { SoundingsGroupView, SoundingsView } from "./types.js";

/** Group-by options mirror the wire enum; labels stay short for the chip row. */
export const SOUNDINGS_GROUP_BY: readonly { value: string; label: string }[] = [
  { value: "vendor", label: "Vendor" },
  { value: "model", label: "Model" },
  { value: "profile", label: "Profile" },
  { value: "size", label: "Size" },
  { value: "difficulty", label: "Difficulty" },
];

export interface SoundingsPanelProps {
  /** Fully projected metrics board (hooks layer). */
  soundings: SoundingsView;
  /** Change the aggregation dimension — parent owns state and re-fetch. */
  onGroupBy: (groupBy: string) => void;
}

/** Inline SVG success-rate track — no chart library, currentColor-free tokens. */
function SuccessBar({ value }: { value: number | null }) {
  const pct = value === null ? 0 : Math.max(0, Math.min(1, value));
  const fill = value === null ? "var(--ink-ghost)" : "var(--state-completed)";
  return (
    <svg
      className="pc-soundings__bar"
      viewBox="0 0 48 6"
      width="48"
      height="6"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="0" y="0" width="48" height="6" rx="2" fill="var(--progress-track)" />
      <rect
        x="0"
        y="0"
        width={48 * pct}
        height="6"
        rx="2"
        fill={fill}
        opacity={value === null ? 0.35 : 1}
      />
    </svg>
  );
}

function GroupCard({ group }: { group: SoundingsGroupView }) {
  const failStyle = { color: "var(--state-failed)" } as CSSProperties;
  const runStyle = { color: "var(--state-running)" } as CSSProperties;
  const doneStyle = { color: "var(--state-completed)" } as CSSProperties;

  return (
    <article className="pc-soundings__card" aria-label={`Metrics for ${group.label}`}>
      <header className="pc-soundings__card-head">
        <h3 className="pc-soundings__group-key">{group.label}</h3>
        <span className="pc-soundings__total">{group.tasks.total} tasks</span>
      </header>

      <div className="pc-soundings__counts" aria-label="Task counts">
        <span className="pc-soundings__count" style={doneStyle}>
          <span className="pc-soundings__count-n">{group.tasks.done}</span>
          <span className="pc-soundings__count-l">Done</span>
        </span>
        <span className="pc-soundings__count" style={failStyle}>
          <span className="pc-soundings__count-n">{group.tasks.failed}</span>
          <span className="pc-soundings__count-l">Failed</span>
        </span>
        <span className="pc-soundings__count" style={runStyle}>
          <span className="pc-soundings__count-n">{group.tasks.running}</span>
          <span className="pc-soundings__count-l">Running</span>
        </span>
      </div>

      <div className="pc-soundings__grid">
        <div className="pc-soundings__cell pc-soundings__cell--success">
          <span className="pc-soundings__label">Success</span>
          <span className="pc-soundings__value-row">
            <span className="pc-soundings__value">{group.successRate}</span>
            <SuccessBar value={group.successRateValue} />
          </span>
        </div>
        <div className="pc-soundings__cell">
          <span className="pc-soundings__label">Eval</span>
          <span className="pc-soundings__value">{group.evals}</span>
        </div>
        <div className="pc-soundings__cell">
          <span className="pc-soundings__label">Tokens I / O / C</span>
          <span className="pc-soundings__value pc-soundings__value--tokens">
            <span>{group.tokens.input}</span>
            <span className="pc-soundings__sep">/</span>
            <span>{group.tokens.output}</span>
            <span className="pc-soundings__sep">/</span>
            <span>{group.tokens.cached}</span>
          </span>
        </div>
        <div className="pc-soundings__cell">
          <span className="pc-soundings__label">Duration avg · p95</span>
          <span className="pc-soundings__value">
            <span>{group.duration.avg}</span>
            <span className="pc-soundings__sep">·</span>
            <span>{group.duration.p95}</span>
          </span>
        </div>
      </div>

      {group.evalsBySize.length > 0 && (
        <div className="pc-soundings__breakdown" aria-label="Eval by size">
          <span className="pc-soundings__label">Eval by size</span>
          <ul className="pc-soundings__chips">
            {group.evalsBySize.map((b) => (
              <li key={b.key} className="pc-soundings__chip">
                <span className="pc-soundings__chip-k">{b.key}</span>
                <span className="pc-soundings__chip-v">{b.avg}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {group.evalsByDifficulty.length > 0 && (
        <div className="pc-soundings__breakdown" aria-label="Eval by difficulty">
          <span className="pc-soundings__label">Eval by difficulty</span>
          <ul className="pc-soundings__chips">
            {group.evalsByDifficulty.map((b) => (
              <li key={b.key} className="pc-soundings__chip">
                <span className="pc-soundings__chip-k">{b.key}</span>
                <span className="pc-soundings__chip-v">{b.avg}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </article>
  );
}

/**
 * Layer 2 — the Soundings metrics board (#119). Nautical register for depth
 * readings: per-group task/eval/token/duration aggregates. Plain props only —
 * fetch, SSE refresh, and projection live in the hooks layer. Memoized like
 * RosterPanel; the cockpit clock re-render must not re-paint this board.
 */
export const SoundingsPanel = memo(function SoundingsPanel({
  soundings,
  onGroupBy,
}: SoundingsPanelProps) {
  const { status, error, groups, groupBy, sessionLabel } = soundings;

  return (
    <Plate padded={false} className="pc-soundings">
      <PlateHeader
        icon={<Mark mark={MARK_COMPASS} size={14} />}
        iconDark
        title="SOUNDINGS"
        subtitle="how deep the fleet has drawn"
        divider
        aside={
          <span className="pc-soundings__scope" title="Session scope from the fleet roster">
            {sessionLabel}
          </span>
        }
      />

      <div className="pc-soundings__controls" role="group" aria-label="Group by">
        {SOUNDINGS_GROUP_BY.map((opt) => {
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

      <div className="pc-soundings__body">
        {status === "loading" && groups.length === 0 && (
          <div className="pc-soundings__state" role="status">
            <p className="pc-soundings__state-title">Taking soundings…</p>
            <p className="pc-soundings__state-sub">listening for the fleet</p>
          </div>
        )}

        {status === "error" && groups.length === 0 && (
          <div className="pc-soundings__state pc-soundings__state--error" role="alert">
            <p className="pc-soundings__state-title">Soundings failed</p>
            <p className="pc-soundings__state-sub">
              {error ?? "Could not reach the daemon."}
            </p>
          </div>
        )}

        {status === "empty" && (
          <div className="pc-soundings__state" role="status">
            <p className="pc-soundings__state-title">No tasks yet</p>
            <p className="pc-soundings__state-sub">
              Delegate a voyage — soundings appear when the fleet reports.
            </p>
          </div>
        )}

        {status === "error" && groups.length > 0 && (
          <p className="pc-soundings__banner" role="status">
            Chart may be stale — {error ?? "could not refresh soundings."}
          </p>
        )}

        {groups.length > 0 && (
          <div className="pc-soundings__list" role="list" aria-label="Metrics groups">
            {groups.map((g) => (
              <div key={g.key ?? "(none)"} role="listitem">
                <GroupCard group={g} />
              </div>
            ))}
          </div>
        )}
      </div>
    </Plate>
  );
});
