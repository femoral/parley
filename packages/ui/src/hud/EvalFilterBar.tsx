import { memo, useId, useMemo, useState } from "react";
import type { SoundingsFiltersView } from "./types.js";

/** Field descriptors for the text filter row — keep labels short for the bar. */
const TEXT_FIELDS: readonly {
  key: keyof Pick<
    SoundingsFiltersView,
    | "type"
    | "vendor"
    | "model"
    | "orch_harness"
    | "orch_model"
    | "eval_harness"
    | "eval_model"
    | "rubric"
  >;
  label: string;
  placeholder: string;
}[] = [
  { key: "type", label: "Type", placeholder: "e.g. coding" },
  { key: "vendor", label: "Vendor", placeholder: "e.g. codex" },
  { key: "model", label: "Model", placeholder: "e.g. …" },
  { key: "orch_harness", label: "Orch harness", placeholder: "e.g. claude" },
  { key: "orch_model", label: "Orch model", placeholder: "e.g. …" },
  { key: "eval_harness", label: "Judge", placeholder: "e.g. harness" },
  { key: "eval_model", label: "Judge model", placeholder: "e.g. …" },
  { key: "rubric", label: "Rubric", placeholder: "e.g. coding@1" },
];

/** Chunked under group headings so the expanded panel is not a flat wall. */
const FILTER_GROUPS: readonly {
  heading: string;
  keys: readonly (typeof TEXT_FIELDS)[number]["key"][];
}[] = [
  { heading: "Task", keys: ["type", "vendor", "model"] },
  { heading: "Orchestrator", keys: ["orch_harness", "orch_model"] },
  { heading: "Judge", keys: ["eval_harness", "eval_model", "rubric"] },
];

const FIELD_BY_KEY = Object.fromEntries(TEXT_FIELDS.map((f) => [f.key, f])) as Record<
  (typeof TEXT_FIELDS)[number]["key"],
  (typeof TEXT_FIELDS)[number]
>;

/** Count each non-empty text field and each pressed toggle as one active filter. */
export function countActiveFilters(filters: SoundingsFiltersView): number {
  let n = 0;
  for (const field of TEXT_FIELDS) {
    if (filters[field.key].trim() !== "") n += 1;
  }
  if (filters.firstAttemptOnly) n += 1;
  if (filters.belowBaselineOnly) n += 1;
  return n;
}

export interface EvalFilterBarProps {
  filters: SoundingsFiltersView;
  /** Patch text fields or toggles — parent owns state and re-fetch. */
  onChange: (patch: Partial<SoundingsFiltersView>) => void;
  /** Clear every constraint. */
  onClear: () => void;
}

/**
 * Layer 2 — composable quality filter bar for Soundings (#165).
 * Designed so #166 (heatmap / lineage) can mount the same control against
 * shared filter state. Plain props only — no SDK types.
 *
 * Collapsed by default (calm first paint); expands to the full field grid.
 * Active-filter count badge keeps state legible when collapsed.
 */
export const EvalFilterBar = memo(function EvalFilterBar({
  filters,
  onChange,
  onClear,
}: EvalFilterBarProps) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const activeCount = useMemo(() => countActiveFilters(filters), [filters]);

  return (
    <div className="pc-eval-filters" role="search" aria-label="Eval filters">
      <div className="pc-eval-filters__summary">
        <button
          type="button"
          className="pc-eval-filters__disclosure"
          aria-expanded={open}
          aria-controls={panelId}
          aria-label={
            activeCount > 0
              ? `Filters, ${activeCount} active`
              : "Filters"
          }
          onClick={() => setOpen((v) => !v)}
        >
          <span className="pc-eval-filters__disclosure-label" aria-hidden="true">
            {open ? "▾" : "▸"}
          </span>
          <span className="pc-eval-filters__disclosure-text" aria-hidden="true">
            Filters
          </span>
          {activeCount > 0 && (
            <span className="pc-eval-filters__badge" aria-hidden="true">
              {activeCount}
            </span>
          )}
        </button>
        {filters.active && (
          <button type="button" className="pc-eval-filters__clear" onClick={onClear}>
            Clear filters
          </button>
        )}
      </div>

      {open && (
        <div
          id={panelId}
          className="pc-eval-filters__panel"
          role="region"
          aria-label="Filter fields"
        >
          <div className="pc-eval-filters__groups">
            {FILTER_GROUPS.map((group) => (
              <fieldset key={group.heading} className="pc-eval-filters__group">
                <legend className="pc-eval-filters__group-heading">{group.heading}</legend>
                <div className="pc-eval-filters__fields">
                  {group.keys.map((key) => {
                    const field = FIELD_BY_KEY[key];
                    return (
                      <label key={field.key} className="pc-eval-filters__field">
                        <span className="pc-eval-filters__label">{field.label}</span>
                        <input
                          type="text"
                          className="pc-eval-filters__input"
                          value={filters[field.key]}
                          placeholder={field.placeholder}
                          spellCheck={false}
                          autoComplete="off"
                          onChange={(e) => onChange({ [field.key]: e.target.value })}
                        />
                      </label>
                    );
                  })}
                </div>
              </fieldset>
            ))}
          </div>

          <div className="pc-eval-filters__toggles" role="group" aria-label="Eval filter toggles">
            <button
              type="button"
              className={`pc-soundings__chip-btn${filters.firstAttemptOnly ? " pc-soundings__chip-btn--active" : ""}`}
              aria-pressed={filters.firstAttemptOnly}
              onClick={() => onChange({ firstAttemptOnly: !filters.firstAttemptOnly })}
            >
              First attempt only
            </button>
            <button
              type="button"
              className={`pc-soundings__chip-btn${filters.belowBaselineOnly ? " pc-soundings__chip-btn--active" : ""}`}
              aria-pressed={filters.belowBaselineOnly}
              onClick={() => onChange({ belowBaselineOnly: !filters.belowBaselineOnly })}
            >
              Below baseline only
            </button>
          </div>
        </div>
      )}
    </div>
  );
});
