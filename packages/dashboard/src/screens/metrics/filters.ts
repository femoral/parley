/**
 * Metrics filter-bar state — Soundings capability parity, Console register.
 * Session is a scope filter (not a group_by). Workflow uses a separate wire
 * path and a reduced filter set (no vendor/model/profile).
 */
import type { RunMetricsFilters, TaskMetricsFilters } from "@useparley/core";
import type { MetricsDim } from "./project.js";

export interface MetricsFilterState {
  type: string;
  vendor: string;
  model: string;
  profile: string;
  size: string;
  difficulty: string;
  orch_harness: string;
  orch_model: string;
  orch_effort: string;
  eval_harness: string;
  eval_model: string;
  eval_effort: string;
  rubric: string;
  first_attempt: boolean;
  below_baseline: boolean;
}

export const EMPTY_FILTERS: MetricsFilterState = {
  type: "",
  vendor: "",
  model: "",
  profile: "",
  size: "",
  difficulty: "",
  orch_harness: "",
  orch_model: "",
  orch_effort: "",
  eval_harness: "",
  eval_model: "",
  eval_effort: "",
  rubric: "",
  first_attempt: false,
  below_baseline: false,
};

function setIf(out: Record<string, unknown>, key: string, value: string): void {
  const v = value.trim();
  if (v) out[key] = v;
}

/** Task metrics wire filters (session applied separately). */
export function toTaskFilters(f: MetricsFilterState): TaskMetricsFilters {
  const out: TaskMetricsFilters = {};
  setIf(out as Record<string, unknown>, "type", f.type);
  setIf(out as Record<string, unknown>, "vendor", f.vendor);
  setIf(out as Record<string, unknown>, "model", f.model);
  setIf(out as Record<string, unknown>, "profile", f.profile);
  setIf(out as Record<string, unknown>, "size", f.size);
  setIf(out as Record<string, unknown>, "difficulty", f.difficulty);
  setIf(out as Record<string, unknown>, "orch_harness", f.orch_harness);
  setIf(out as Record<string, unknown>, "orch_model", f.orch_model);
  setIf(out as Record<string, unknown>, "orch_effort", f.orch_effort);
  setIf(out as Record<string, unknown>, "eval_harness", f.eval_harness);
  setIf(out as Record<string, unknown>, "eval_model", f.eval_model);
  setIf(out as Record<string, unknown>, "eval_effort", f.eval_effort);
  setIf(out as Record<string, unknown>, "rubric", f.rubric);
  if (f.first_attempt) out.first_attempt = true;
  if (f.below_baseline) out.below_baseline = true;
  return out;
}

/** Run metrics wire filters — no vendor/model/profile. */
export function toRunFilters(f: MetricsFilterState): RunMetricsFilters {
  const out: RunMetricsFilters = {};
  setIf(out as Record<string, unknown>, "type", f.type);
  setIf(out as Record<string, unknown>, "size", f.size);
  setIf(out as Record<string, unknown>, "difficulty", f.difficulty);
  setIf(out as Record<string, unknown>, "orch_harness", f.orch_harness);
  setIf(out as Record<string, unknown>, "orch_model", f.orch_model);
  setIf(out as Record<string, unknown>, "orch_effort", f.orch_effort);
  setIf(out as Record<string, unknown>, "eval_harness", f.eval_harness);
  setIf(out as Record<string, unknown>, "eval_model", f.eval_model);
  setIf(out as Record<string, unknown>, "eval_effort", f.eval_effort);
  setIf(out as Record<string, unknown>, "rubric", f.rubric);
  if (f.first_attempt) out.first_run = true;
  if (f.below_baseline) out.below_baseline = true;
  return out;
}

export function filtersActive(f: MetricsFilterState): boolean {
  return (
    Object.entries(f).some(([k, v]) => {
      if (k === "first_attempt" || k === "below_baseline") return Boolean(v);
      return typeof v === "string" && v.trim() !== "";
    })
  );
}

export function clearFilters(): MetricsFilterState {
  return { ...EMPTY_FILTERS };
}

/** Filters that apply to the current dimension population. */
export function filterFieldsForDim(dim: MetricsDim): (keyof MetricsFilterState)[] {
  const common: (keyof MetricsFilterState)[] = [
    "type",
    "size",
    "difficulty",
    "orch_harness",
    "orch_model",
    "orch_effort",
    "eval_harness",
    "eval_model",
    "eval_effort",
    "rubric",
    "first_attempt",
    "below_baseline",
  ];
  if (dim === "workflow") return common;
  return ["vendor", "model", "profile", ...common];
}

export const FILTER_LABELS: Record<keyof MetricsFilterState, string> = {
  type: "type",
  vendor: "vendor",
  model: "model",
  profile: "profile",
  size: "size",
  difficulty: "difficulty",
  orch_harness: "orch harness",
  orch_model: "orch model",
  orch_effort: "orch effort",
  eval_harness: "judge harness",
  eval_model: "judge model",
  eval_effort: "judge effort",
  rubric: "rubric",
  first_attempt: "first attempt only",
  below_baseline: "below baseline only",
};
