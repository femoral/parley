/**
 * Layer 4 — shared eval filter state for Soundings quality views (#165).
 *
 * Pure types + helpers so comparison / distribution (this issue) and the
 * follow-up heatmap / attempt-lineage views (#166) subscribe to one shape.
 * Maps onto `TaskMetricsFilters` for `GET /metrics` without pulling that type
 * into the hud layer.
 */

/** Text filter keys (empty string / omitted = no constraint). */
export const EVAL_FILTER_TEXT_KEYS = [
  "type",
  "vendor",
  "model",
  "orch_harness",
  "orch_model",
  "eval_harness",
  "eval_model",
  "rubric",
] as const;

export type EvalFilterTextKey = (typeof EVAL_FILTER_TEXT_KEYS)[number];

/**
 * Composable AND filters for quality views. Session scope lives on the roster
 * chip and is not part of this bag (callers pass it to metrics separately).
 *
 * `rubric` accepts a bare id (`coding`) or composite `id@version` (`coding@1`);
 * {@link evalFiltersToMetricsQuery} splits the version for the wire.
 */
export interface EvalFilterState {
  type: string;
  vendor: string;
  model: string;
  orch_harness: string;
  orch_model: string;
  eval_harness: string;
  eval_model: string;
  /** Rubric id, or `id@version`. */
  rubric: string;
  /** When true, only first attempts. */
  first_attempt: boolean;
  /** When true, only rubric evals with score < baseline. */
  below_baseline: boolean;
}

/** Default: no constraints. */
export function emptyEvalFilters(): EvalFilterState {
  return {
    type: "",
    vendor: "",
    model: "",
    orch_harness: "",
    orch_model: "",
    eval_harness: "",
    eval_model: "",
    rubric: "",
    first_attempt: false,
    below_baseline: false,
  };
}

/** True when any filter (text or toggle) is active. */
export function hasActiveEvalFilters(filters: EvalFilterState): boolean {
  for (const key of EVAL_FILTER_TEXT_KEYS) {
    if (filters[key].trim() !== "") return true;
  }
  return filters.first_attempt || filters.below_baseline;
}

/** Patch one or more fields; text values are stored as trimmed strings. */
export function patchEvalFilters(
  prev: EvalFilterState,
  patch: Partial<EvalFilterState>,
): EvalFilterState {
  const next: EvalFilterState = { ...prev };
  for (const key of EVAL_FILTER_TEXT_KEYS) {
    if (patch[key] !== undefined) next[key] = patch[key]!.trim();
  }
  if (patch.first_attempt !== undefined) next.first_attempt = patch.first_attempt;
  if (patch.below_baseline !== undefined) next.below_baseline = patch.below_baseline;
  return next;
}

/**
 * Parse `id@version` (version = positive integer). Bare id → version undefined.
 * Malformed `@` tails are treated as a bare id (version ignored).
 */
export function parseRubricFilter(
  raw: string,
): { rubric?: string; rubric_version?: number } {
  const s = raw.trim();
  if (s === "") return {};
  const at = s.lastIndexOf("@");
  if (at <= 0) return { rubric: s };
  const id = s.slice(0, at).trim();
  const ver = s.slice(at + 1).trim();
  if (id === "") return {};
  const n = Number(ver);
  if (ver !== "" && Number.isInteger(n) && n >= 1) {
    return { rubric: id, rubric_version: n };
  }
  // "coding@" or "coding@x" → still filter by id only.
  return { rubric: id };
}

/**
 * Wire-facing metrics query fragment (no session / group_by).
 * Only set keys the API should constrain — toggles omitted when false.
 */
export function evalFiltersToMetricsQuery(filters: EvalFilterState): {
  type?: string;
  vendor?: string;
  model?: string;
  orch_harness?: string;
  orch_model?: string;
  eval_harness?: string;
  eval_model?: string;
  rubric?: string;
  rubric_version?: number;
  first_attempt?: boolean;
  below_baseline?: boolean;
} {
  const out: ReturnType<typeof evalFiltersToMetricsQuery> = {};
  const setText = (key: EvalFilterTextKey): void => {
    if (key === "rubric") return;
    const v = filters[key].trim();
    if (v !== "") out[key] = v;
  };
  for (const key of EVAL_FILTER_TEXT_KEYS) setText(key);
  const rub = parseRubricFilter(filters.rubric);
  if (rub.rubric !== undefined) out.rubric = rub.rubric;
  if (rub.rubric_version !== undefined) out.rubric_version = rub.rubric_version;
  if (filters.first_attempt) out.first_attempt = true;
  if (filters.below_baseline) out.below_baseline = true;
  return out;
}

/**
 * Serialize filter state to URL search params (for future deep-link / #166
 * subscribers). Empty / false values are omitted.
 */
export function evalFiltersToSearchParams(filters: EvalFilterState): URLSearchParams {
  const params = new URLSearchParams();
  for (const key of EVAL_FILTER_TEXT_KEYS) {
    const v = filters[key].trim();
    if (v !== "") params.set(key, v);
  }
  if (filters.first_attempt) params.set("first_attempt", "true");
  if (filters.below_baseline) params.set("below_baseline", "true");
  return params;
}

/**
 * Parse filter state from URL search params. Unknown keys ignored; boolean
 * flags accept `true` / `1`.
 */
export function parseEvalFiltersFromSearch(params: URLSearchParams): EvalFilterState {
  const base = emptyEvalFilters();
  for (const key of EVAL_FILTER_TEXT_KEYS) {
    const v = params.get(key);
    if (v !== null && v !== "") base[key] = v.trim();
  }
  const fa = params.get("first_attempt");
  if (fa === "true" || fa === "1") base.first_attempt = true;
  const bb = params.get("below_baseline");
  if (bb === "true" || bb === "1") base.below_baseline = true;
  return base;
}

/** Human labels for filter controls (Cinzel chrome stays ALL-CAPS in CSS). */
export const EVAL_FILTER_FIELD_META: readonly {
  key: EvalFilterTextKey;
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
