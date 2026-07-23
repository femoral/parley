import {
  memo,
  useRef,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import { Mark, Plate, PlateHeader } from "../primitives/index.js";
import { MARK_COMPASS } from "../tokens/chrome-glyphs.js";
import { EvalComparison } from "./EvalComparison.js";
import { EvalDistribution } from "./EvalDistribution.js";
import { EvalFilterBar } from "./EvalFilterBar.js";
import { EvalHeatmap } from "./EvalHeatmap.js";
import type {
  SoundingsFiltersView,
  SoundingsGroupView,
  SoundingsView,
  SoundingsViewTab,
} from "./types.js";

/** Group-by options mirror the wire enum; labels stay short for the chip row. */
export const SOUNDINGS_GROUP_BY: readonly { value: string; label: string }[] = [
  { value: "vendor", label: "Vendor" },
  { value: "model", label: "Model" },
  { value: "profile", label: "Profile" },
  { value: "size", label: "Size" },
  { value: "difficulty", label: "Difficulty" },
  { value: "type", label: "Type" },
  { value: "orch_harness", label: "Orch harness" },
  { value: "orch_model", label: "Orch model" },
  { value: "orch_effort", label: "Orch effort" },
  { value: "eval_harness", label: "Judge harness" },
  { value: "eval_model", label: "Judge model" },
  { value: "eval_effort", label: "Judge effort" },
  { value: "rubric", label: "Rubric" },
];

/**
 * Primary group-by chips on first paint (≤5). Remainder live in the More…
 * overflow select so the control wall does not greet the user.
 * Session scope is the roster chip (header), not a group-by dimension.
 */
const PRIMARY_GROUP_BY_VALUES = new Set([
  "vendor",
  "model",
  "type",
  "profile",
  "difficulty",
]);

const PRIMARY_GROUP_BY = SOUNDINGS_GROUP_BY.filter((o) =>
  PRIMARY_GROUP_BY_VALUES.has(o.value),
);
const OVERFLOW_GROUP_BY = SOUNDINGS_GROUP_BY.filter(
  (o) => !PRIMARY_GROUP_BY_VALUES.has(o.value),
);

/** Accessible scent of overflow dimensions (size, orch, judge, rubric, …). */
const MORE_GROUP_BY_ARIA =
  "More dimensions: size, orchestrator, judge, rubric…";
const MORE_GROUP_BY_LABEL = `More (${OVERFLOW_GROUP_BY.length})`;

const VIEW_TABS: readonly { value: SoundingsViewTab; label: string }[] = [
  { value: "groups", label: "Groups" },
  { value: "distribution", label: "Score vs baseline" },
  { value: "comparison", label: "Comparison" },
  { value: "heatmap", label: "Criterion failures" },
];

export interface SoundingsPanelProps {
  /** Fully projected metrics board (hooks layer). */
  soundings: SoundingsView;
  /** Change the aggregation dimension — parent owns state and re-fetch. */
  onGroupBy: (groupBy: string) => void;
  /** Patch quality filters (#165). */
  onFiltersChange: (patch: Partial<SoundingsFiltersView>) => void;
  /** Clear all quality filters. */
  onFiltersClear: () => void;
  /** Switch Groups / Distribution / Comparison. */
  onViewTab: (tab: SoundingsViewTab) => void;
}

/** Inline SVG success-rate track — no chart library, currentColor-free tokens. */
function SuccessBar({ value }: { value: number | null }) {
  const pct = value === null ? 0 : Math.max(0, Math.min(1, value));
  const fill = value === null ? "var(--ink-ghost)" : "var(--quality-good)";
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
          <span className="pc-soundings__label">Duration</span>
          <span
            className="pc-soundings__value"
            aria-label={`average ${group.duration.avg}, 95th percentile ${group.duration.p95}`}
          >
            <span>
              <abbr className="pc-soundings__dur-label" title="average">
                avg
              </abbr>{" "}
              {group.duration.avg}
            </span>
            <span className="pc-soundings__sep" aria-hidden="true">
              ·
            </span>
            <span>
              <abbr className="pc-soundings__dur-label" title="95th percentile">
                p95
              </abbr>{" "}
              {group.duration.p95}
            </span>
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

function SoundingsError({ error }: { error: string | null }) {
  return (
    <div className="pc-soundings__state pc-soundings__state--error" role="alert">
      <p className="pc-soundings__state-title">Soundings failed</p>
      <p className="pc-soundings__state-sub">
        {error ?? "Could not reach the daemon."}
      </p>
    </div>
  );
}

function StaleChartBanner({ error }: { error: string | null }) {
  return (
    <p className="pc-soundings__banner" role="status">
      Chart may be stale — {error ?? "could not refresh soundings."}
    </p>
  );
}

/**
 * Layer 2 — the Soundings metrics board (#119 / #165 / #166). Nautical register
 * for depth readings: group aggregates, score-vs-baseline distribution, quality
 * comparison, and criterion-failure heatmap. Shared filter bar drives every
 * sub-view. Plain props only — fetch, SSE refresh, and projection live in the
 * hooks layer.
 */
export const SoundingsPanel = memo(function SoundingsPanel({
  soundings,
  onGroupBy,
  onFiltersChange,
  onFiltersClear,
  onViewTab,
}: SoundingsPanelProps) {
  const {
    status,
    error,
    groups,
    distribution,
    comparison,
    heatmap,
    groupBy,
    sessionLabel,
    filters,
    viewTab,
    evalPresence,
  } = soundings;
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  // Manual-activation tabs (WAI-ARIA APG): arrows/Home/End move focus;
  // Enter/Space activate through the button's native click.
  const onTabKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ): void => {
    const last = VIEW_TABS.length - 1;
    let next: number | null = null;
    switch (event.key) {
      case "ArrowRight":
        next = index === last ? 0 : index + 1;
        break;
      case "ArrowLeft":
        next = index === 0 ? last : index - 1;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = last;
        break;
      default:
        return;
    }
    event.preventDefault();
    tabRefs.current[next]?.focus();
  };

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

      <EvalFilterBar
        filters={filters}
        onChange={onFiltersChange}
        onClear={onFiltersClear}
      />

      <div className="pc-soundings__tabs" role="tablist" aria-label="Soundings views">
        {VIEW_TABS.map((tab, index) => {
          const active = tab.value === viewTab;
          return (
            <button
              ref={(node) => {
                tabRefs.current[index] = node;
              }}
              key={tab.value}
              type="button"
              role="tab"
              id={`soundings-tab-${tab.value}`}
              aria-selected={active}
              aria-controls={`soundings-panel-${tab.value}`}
              tabIndex={active ? 0 : -1}
              className={`pc-soundings__tab${active ? " pc-soundings__tab--active" : ""}`}
              onKeyDown={(event) => onTabKeyDown(event, index)}
              onClick={() => onViewTab(tab.value)}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {viewTab === "groups" && (
        <div className="pc-soundings__controls" role="group" aria-label="Group by">
          {PRIMARY_GROUP_BY.map((opt) => {
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
          <label className="pc-soundings__group-more" title={MORE_GROUP_BY_ARIA}>
            <span className="pc-soundings__group-more-sr">{MORE_GROUP_BY_ARIA}</span>
            <select
              className={`pc-soundings__group-more-select${
                OVERFLOW_GROUP_BY.some((o) => o.value === groupBy)
                  ? " pc-soundings__group-more-select--active"
                  : ""
              }`}
              value={
                OVERFLOW_GROUP_BY.some((o) => o.value === groupBy) ? groupBy : ""
              }
              aria-label={MORE_GROUP_BY_ARIA}
              title={MORE_GROUP_BY_ARIA}
              onChange={(e) => {
                const v = e.target.value;
                if (v !== "") onGroupBy(v);
              }}
            >
              <option value="">{MORE_GROUP_BY_LABEL}</option>
              {OVERFLOW_GROUP_BY.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      <div
        className="pc-soundings__body"
        role="tabpanel"
        id={`soundings-panel-${viewTab}`}
        aria-labelledby={`soundings-tab-${viewTab}`}
      >
        {viewTab === "groups" && (
          <>
            {status === "loading" && groups.length === 0 && (
              <div className="pc-soundings__state" role="status">
                <p className="pc-soundings__state-title">Reading the ledger…</p>
                <p className="pc-soundings__state-sub">listening for the fleet</p>
              </div>
            )}

            {status === "error" && groups.length === 0 && (
              <SoundingsError error={error} />
            )}

            {status === "empty" && (
              <div className="pc-soundings__state" role="status">
                <p className="pc-soundings__state-title">
                  {filters.active ? "No matching tasks" : "No tasks yet"}
                </p>
                <p className="pc-soundings__state-sub">
                  {filters.active
                    ? "Loosen filters — or clear them — to see group soundings."
                    : "Delegate a voyage — soundings appear when the fleet reports."}
                </p>
              </div>
            )}

            {status === "error" && groups.length > 0 && (
              <StaleChartBanner error={error} />
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
          </>
        )}

        {viewTab === "distribution" && (
          <>
            {status === "error" && groups.length > 0 && (
              <StaleChartBanner error={error} />
            )}
            {status === "error" && groups.length === 0 ? (
              <SoundingsError error={error} />
            ) : (
              <EvalDistribution
                rows={distribution}
                evalPresence={evalPresence}
                filtersActive={filters.active}
              />
            )}
          </>
        )}

        {viewTab === "comparison" && (
          <>
            {status === "error" && groups.length > 0 && (
              <StaleChartBanner error={error} />
            )}
            {status === "error" && groups.length === 0 ? (
              <SoundingsError error={error} />
            ) : (
              <EvalComparison
                rows={comparison}
                groupBy={groupBy}
                evalPresence={evalPresence}
                filtersActive={filters.active}
                onGroupBy={onGroupBy}
              />
            )}
          </>
        )}

        {viewTab === "heatmap" && (
          <>
            {status === "error" && groups.length > 0 && (
              <StaleChartBanner error={error} />
            )}
            {status === "error" && groups.length === 0 ? (
              <SoundingsError error={error} />
            ) : (
              <EvalHeatmap
                heatmap={heatmap}
                groupBy={groupBy}
                evalPresence={evalPresence}
                filtersActive={filters.active}
                onGroupBy={onGroupBy}
              />
            )}
          </>
        )}
      </div>
    </Plate>
  );
});
