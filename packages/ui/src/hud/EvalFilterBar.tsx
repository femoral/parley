import { memo } from "react";
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
  { key: "type", label: "Type", placeholder: "coding" },
  { key: "vendor", label: "Vendor", placeholder: "codex" },
  { key: "model", label: "Model", placeholder: "…" },
  { key: "orch_harness", label: "Orch harness", placeholder: "claude" },
  { key: "orch_model", label: "Orch model", placeholder: "…" },
  { key: "eval_harness", label: "Judge", placeholder: "harness" },
  { key: "eval_model", label: "Judge model", placeholder: "…" },
  { key: "rubric", label: "Rubric", placeholder: "coding@1" },
];

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
 */
export const EvalFilterBar = memo(function EvalFilterBar({
  filters,
  onChange,
  onClear,
}: EvalFilterBarProps) {
  return (
    <div className="pc-eval-filters" role="search" aria-label="Eval filters">
      <div className="pc-eval-filters__fields">
        {TEXT_FIELDS.map((field) => (
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
        {filters.active && (
          <button
            type="button"
            className="pc-eval-filters__clear"
            onClick={onClear}
          >
            Clear filters
          </button>
        )}
      </div>
    </div>
  );
});
