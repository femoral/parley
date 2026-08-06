/**
 * Soundings-parity filter bar — Console register treatment.
 * Text fields + boolean toggles; clear resets to empty.
 */
import { Field } from "../../components/index.js";
import {
  FILTER_LABELS,
  filterFieldsForDim,
  filtersActive,
  type MetricsFilterState,
} from "./filters.js";
import type { MetricsDim } from "./project.js";

export interface FilterBarProps {
  dim: MetricsDim;
  filters: MetricsFilterState;
  onChange: (next: MetricsFilterState) => void;
  onClear: () => void;
}

const TEXT_KEYS: (keyof MetricsFilterState)[] = [
  "type",
  "vendor",
  "model",
  "profile",
  "size",
  "difficulty",
  "orch_harness",
  "orch_model",
  "orch_effort",
  "eval_harness",
  "eval_model",
  "eval_effort",
  "rubric",
];

export function FilterBar({ dim, filters, onChange, onClear }: FilterBarProps) {
  const fields = new Set(filterFieldsForDim(dim));
  const active = filtersActive(filters);

  return (
    <div
      className="pc-metrics__filters"
      data-testid="metrics-filter-bar"
      role="search"
      aria-label="Metrics filters"
    >
      {TEXT_KEYS.filter((k) => fields.has(k)).map((key) => (
        <Field
          key={key}
          className="pc-metrics__filter-field"
          label={FILTER_LABELS[key]}
          value={filters[key] as string}
          onChange={(v) => onChange({ ...filters, [key]: v })}
          testId={`metrics-filter-${key}`}
        />
      ))}

      <div className="pc-metrics__filter-toggles">
        {fields.has("first_attempt") ? (
          <button
            type="button"
            className="pc-metrics__toggle"
            aria-pressed={filters.first_attempt}
            onClick={() =>
              onChange({ ...filters, first_attempt: !filters.first_attempt })
            }
            data-testid="metrics-filter-first-attempt"
          >
            {dim === "workflow" ? "first run only" : "first attempt only"}
          </button>
        ) : null}
        {fields.has("below_baseline") ? (
          <button
            type="button"
            className="pc-metrics__toggle"
            aria-pressed={filters.below_baseline}
            onClick={() =>
              onChange({ ...filters, below_baseline: !filters.below_baseline })
            }
            data-testid="metrics-filter-below-baseline"
          >
            below baseline only
          </button>
        ) : null}
        <button
          type="button"
          className="pc-metrics__clear"
          onClick={onClear}
          disabled={!active}
          data-testid="metrics-filter-clear"
        >
          clear
        </button>
      </div>
    </div>
  );
}
