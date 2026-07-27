/**
 * Task metrics aggregation (#118 / #164) and run metrics (#243 / ADR-0020) —
 * pure functions over task/run rows for `GET /metrics`, `GET /run-metrics`, and
 * unit tests. Rubric eval stats exclude legacy free scores.
 *
 * **Run metrics and task metrics are two reports that are never joined.** A run
 * has no vendor, model, or profile; comparability is an explicit non-goal
 * (shared 0–10 scale, never a shared row).
 */
import type {
  MetricsAttemptEvalSplit,
  MetricsCriterionFailureStats,
  MetricsDurationStats,
  MetricsEvalStats,
  MetricsGroup,
  MetricsGroupBy,
  MetricsResponse,
  MetricsRunLineageEvalSplit,
  MetricsTaskCounts,
  MetricsTokenTotals,
  RunMetricsCounts,
  RunMetricsEvalStats,
  RunMetricsFilters,
  RunMetricsGroup,
  RunMetricsGroupBy,
  RunMetricsResponse,
  TaskMetricsFilters,
} from "@useparley/core";
import { normalizeUsage, UNIVERSAL_NEGATIVES } from "@useparley/core";
import type { RunRow, TaskRow } from "./db.js";
import { parseJsonColumn } from "./report.js";

/**
 * Group-by columns that map 1:1 onto a TaskRow field. `rubric` is composite
 * (`id@version`) and handled separately.
 */
const GROUP_COLUMNS: Partial<Record<MetricsGroupBy, keyof TaskRow>> = {
  vendor: "vendor",
  model: "model",
  profile: "profile",
  size: "size",
  difficulty: "difficulty",
  type: "type",
  orch_harness: "orch_harness",
  orch_model: "orch_model",
  orch_effort: "orch_effort",
  eval_harness: "eval_harness",
  eval_model: "eval_model",
  eval_effort: "eval_effort",
};

/** Nearest-rank percentile over a pre-sorted ascending array; null when empty. */
export function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  // Nearest-rank: rank = ceil(p/100 * n), 1-indexed → array index rank-1.
  const rank = Math.ceil((p / 100) * sorted.length);
  const idx = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[idx] ?? null;
}

/**
 * True when the task has a structured rubric eval (#157 / #164). Legacy free
 * scores have eval_score but null rubric fields and are excluded from rubric
 * aggregations.
 */
export function isRubricEval(task: TaskRow): boolean {
  return (
    task.eval_score !== null &&
    Number.isFinite(task.eval_score) &&
    task.eval_rubric !== null &&
    task.eval_rubric !== "" &&
    task.eval_baseline !== null &&
    Number.isFinite(task.eval_baseline)
  );
}

/** True when eval_score is set without a structured rubric (pre-#157 free score). */
export function isLegacyEval(task: TaskRow): boolean {
  return (
    task.eval_score !== null &&
    Number.isFinite(task.eval_score) &&
    !isRubricEval(task)
  );
}

/** Rubric composite key `id@version` for group-by=rubric; null when unset. */
export function rubricGroupKey(task: TaskRow): string | null {
  if (task.eval_rubric === null || task.eval_rubric === "") return null;
  if (task.eval_rubric_version === null || task.eval_rubric_version === undefined) {
    return task.eval_rubric;
  }
  return `${task.eval_rubric}@${task.eval_rubric_version}`;
}

/**
 * Whether a task matches metrics/list filters (#164). Session `"all"` / omit /
 * null includes every session; other string values pin `orchestrator_session_id`.
 */
export function taskMatchesFilters(
  task: TaskRow,
  filters: TaskMetricsFilters = {},
): boolean {
  const session = filters.session;
  if (session !== undefined && session !== null && session !== "" && session !== "all") {
    if (task.orchestrator_session_id !== session) return false;
  }

  const eq = (want: string | undefined, got: string | null | undefined): boolean => {
    if (want === undefined) return true;
    return (got ?? "") === want;
  };

  if (!eq(filters.type, task.type)) return false;
  if (!eq(filters.vendor, task.vendor)) return false;
  if (!eq(filters.model, task.model)) return false;
  if (!eq(filters.profile, task.profile)) return false;
  if (!eq(filters.size, task.size)) return false;
  if (!eq(filters.difficulty, task.difficulty)) return false;
  if (!eq(filters.orch_harness, task.orch_harness)) return false;
  if (!eq(filters.orch_model, task.orch_model)) return false;
  if (!eq(filters.orch_effort, task.orch_effort)) return false;
  if (!eq(filters.eval_harness, task.eval_harness)) return false;
  if (!eq(filters.eval_model, task.eval_model)) return false;
  if (!eq(filters.eval_effort, task.eval_effort)) return false;
  if (!eq(filters.rubric, task.eval_rubric)) return false;

  if (filters.rubric_version !== undefined) {
    if (task.eval_rubric_version !== filters.rubric_version) return false;
  }

  if (filters.first_attempt === true) {
    const attempt = task.attempt ?? 1;
    if (attempt !== 1) return false;
  } else if (filters.first_attempt === false) {
    const attempt = task.attempt ?? 1;
    if (attempt <= 1) return false;
  }

  if (filters.below_baseline === true) {
    if (!isRubricEval(task)) return false;
    if (!(task.eval_score! < task.eval_baseline!)) return false;
  } else if (filters.below_baseline === false) {
    if (!isRubricEval(task)) return false;
    if (task.eval_score! < task.eval_baseline!) return false;
  }

  return true;
}

function emptyTaskCounts(): MetricsTaskCounts {
  return { total: 0, completed: 0, failed: 0, cancelled: 0, running: 0, other: 0 };
}

function emptyTokens(): MetricsTokenTotals {
  return { input: 0, output: 0, cached: 0, tasks_reporting: 0 };
}

function emptyDuration(): MetricsDurationStats {
  return { total: 0, avg: null, p50: null, p95: null, tasks_reporting: 0 };
}

function emptyAttemptSplit(): MetricsAttemptEvalSplit {
  return {
    count: 0,
    avg: null,
    avg_baseline: null,
    avg_delta: null,
    below_baseline_rate: null,
  };
}

function emptyEvals(): MetricsEvalStats {
  return {
    count: 0,
    avg: null,
    avg_baseline: null,
    avg_delta: null,
    below_baseline_rate: null,
    criterion_failures: {},
    first_attempt: emptyAttemptSplit(),
    fix: emptyAttemptSplit(),
  };
}

/** Mutable accumulator for rubric eval stats. */
interface EvalAcc {
  scoreSum: number;
  baselineSum: number;
  deltaSum: number;
  count: number;
  belowBaseline: number;
  criterion: Record<string, { failures: number; count: number }>;
  first: { scoreSum: number; baselineSum: number; deltaSum: number; count: number; below: number };
  fix: { scoreSum: number; baselineSum: number; deltaSum: number; count: number; below: number };
}

function emptyEvalAcc(): EvalAcc {
  return {
    scoreSum: 0,
    baselineSum: 0,
    deltaSum: 0,
    count: 0,
    belowBaseline: 0,
    criterion: {},
    first: { scoreSum: 0, baselineSum: 0, deltaSum: 0, count: 0, below: 0 },
    fix: { scoreSum: 0, baselineSum: 0, deltaSum: 0, count: 0, below: 0 },
  };
}

/**
 * Record one structured rubric eval into an accumulator.
 * Criterion failure: positive answer false, or negative answer true.
 * Kind is inferred from the answer alone when rubric text is unavailable:
 * we treat `false` as a failure for the frequency map when the criterion id
 * is present — but for negatives, failure is `true`. Without kind info we
 * need the answers plus a kind map.
 *
 * Convention: answers are stored as the raw boolean the judge gave. Failures
 * are computed using optional kind hints from the answers payload when we
 * know the rubric; otherwise we use a simple rule: for known universal
 * negatives and shipped criteria we detect by id prefix / known negative ids.
 *
 * Simpler contract used here: pass a `failed` map computed by the caller, or
 * compute from answers with kind=positive means fail on false, kind=negative
 * fail on true. When kind is unknown, treat answer `false` as failure (positive
 * default) — negatives always have known ids in shipped set.
 */
function accumulateRubricEval(
  acc: EvalAcc,
  task: TaskRow,
  criterionFailed: (id: string, answer: boolean) => boolean,
): void {
  const score = task.eval_score!;
  const baseline = task.eval_baseline!;
  const delta = score - baseline;
  const below = score < baseline;

  acc.scoreSum += score;
  acc.baselineSum += baseline;
  acc.deltaSum += delta;
  acc.count += 1;
  if (below) acc.belowBaseline += 1;

  const attempt = task.attempt ?? 1;
  const split = attempt <= 1 ? acc.first : acc.fix;
  split.scoreSum += score;
  split.baselineSum += baseline;
  split.deltaSum += delta;
  split.count += 1;
  if (below) split.below += 1;

  const answers = parseJsonColumn<Record<string, boolean>>(task.eval_answers ?? null);
  if (answers !== null && typeof answers === "object" && !Array.isArray(answers)) {
    for (const [id, answer] of Object.entries(answers)) {
      if (typeof answer !== "boolean") continue;
      const cur = acc.criterion[id] ?? { failures: 0, count: 0 };
      cur.count += 1;
      if (criterionFailed(id, answer)) cur.failures += 1;
      acc.criterion[id] = cur;
    }
  }
}

function finalizeAttemptSplit(s: EvalAcc["first"]): MetricsAttemptEvalSplit {
  if (s.count === 0) return emptyAttemptSplit();
  return {
    count: s.count,
    avg: s.scoreSum / s.count,
    avg_baseline: s.baselineSum / s.count,
    avg_delta: s.deltaSum / s.count,
    below_baseline_rate: s.below / s.count,
  };
}

function finalizeEvalAcc(acc: EvalAcc): MetricsEvalStats {
  if (acc.count === 0) return emptyEvals();
  const criterion_failures: Record<string, MetricsCriterionFailureStats> = {};
  for (const [id, { failures, count }] of Object.entries(acc.criterion)) {
    criterion_failures[id] = {
      failures,
      count,
      rate: count === 0 ? null : failures / count,
    };
  }
  return {
    count: acc.count,
    avg: acc.scoreSum / acc.count,
    avg_baseline: acc.baselineSum / acc.count,
    avg_delta: acc.deltaSum / acc.count,
    below_baseline_rate: acc.belowBaseline / acc.count,
    criterion_failures,
    first_attempt: finalizeAttemptSplit(acc.first),
    fix: finalizeAttemptSplit(acc.fix),
  };
}

interface GroupAcc {
  tasks: MetricsTaskCounts;
  evals: EvalAcc;
  evalsBySize: Record<string, EvalAcc>;
  evalsByDifficulty: Record<string, EvalAcc>;
  tokens: MetricsTokenTotals;
  durations: number[];
}

function emptyAcc(): GroupAcc {
  return {
    tasks: emptyTaskCounts(),
    evals: emptyEvalAcc(),
    evalsBySize: {},
    evalsByDifficulty: {},
    tokens: emptyTokens(),
    durations: [],
  };
}

/**
 * Provenance dimensions group null/blank under the explicit `"unknown"` bucket
 * so unknown sessions never contaminate per-harness/model/effort comparisons
 * (#190 / ADR-0013). Other dimensions keep a null key for "unset".
 */
const PROVENANCE_GROUP_BY = new Set<MetricsGroupBy>([
  "orch_harness",
  "orch_model",
  "orch_effort",
  "eval_harness",
  "eval_model",
  "eval_effort",
]);

function groupKeyFor(task: TaskRow, groupBy: MetricsGroupBy): string | null {
  if (groupBy === "rubric") return rubricGroupKey(task);
  const col = GROUP_COLUMNS[groupBy];
  if (col === undefined) return null;
  const value = task[col];
  if (value === null || value === undefined || value === "") {
    return PROVENANCE_GROUP_BY.has(groupBy) ? "unknown" : null;
  }
  const key = String(value);
  // Declared (template-profile) model must never share a bucket with verified
  // adapter-path values (#195 / ADR-0015). Effort is not a groupBy column;
  // model is the eval combo key.
  if (groupBy === "model" && task.model_source === "declared") {
    return `declared:${key}`;
  }
  return key;
}

/**
 * Known universal negative criterion ids — answered true ⇒ failure.
 * Everything else is treated as positive (answered false ⇒ failure). Project
 * custom negatives with new ids are a rare edge; shipped rubrics share the
 * universal trio.
 */
const KNOWN_NEGATIVE_IDS = new Set(UNIVERSAL_NEGATIVES.map((c) => c.id));

/**
 * Whether a criterion answer counts as a failure for frequency stats.
 * Negatives fail when triggered (true); positives fail when unmet (false).
 */
export function criterionAnswerFailed(id: string, answer: boolean): boolean {
  if (KNOWN_NEGATIVE_IDS.has(id)) return answer === true;
  return answer === false;
}

function accumulateTask(acc: GroupAcc, task: TaskRow): void {
  acc.tasks.total += 1;
  switch (task.state) {
    case "completed":
      acc.tasks.completed += 1;
      break;
    case "failed":
      acc.tasks.failed += 1;
      break;
    case "cancelled":
      acc.tasks.cancelled += 1;
      break;
    case "running":
      acc.tasks.running += 1;
      break;
    default:
      acc.tasks.other += 1;
      break;
  }

  // Rubric evals only — legacy free scores are excluded from all eval stats.
  if (isRubricEval(task)) {
    accumulateRubricEval(acc.evals, task, criterionAnswerFailed);
    if (task.size !== null && task.size !== "") {
      let sizeAcc = acc.evalsBySize[task.size];
      if (sizeAcc === undefined) {
        sizeAcc = emptyEvalAcc();
        acc.evalsBySize[task.size] = sizeAcc;
      }
      accumulateRubricEval(sizeAcc, task, criterionAnswerFailed);
    }
    if (task.difficulty !== null && task.difficulty !== "") {
      let diffAcc = acc.evalsByDifficulty[task.difficulty];
      if (diffAcc === undefined) {
        diffAcc = emptyEvalAcc();
        acc.evalsByDifficulty[task.difficulty] = diffAcc;
      }
      accumulateRubricEval(diffAcc, task, criterionAnswerFailed);
    }
  }

  const raw = parseJsonColumn<Record<string, number>>(task.usage);
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    const n = normalizeUsage(raw);
    if (n.input !== null || n.output !== null || n.cached !== null) {
      acc.tokens.tasks_reporting += 1;
      if (n.input !== null) acc.tokens.input += n.input;
      if (n.output !== null) acc.tokens.output += n.output;
      if (n.cached !== null) acc.tokens.cached += n.cached;
    }
  }

  // Duration only when the task has finished (completed_at set).
  if (task.completed_at !== null) {
    const start = Date.parse(task.started_at ?? task.created_at);
    const end = Date.parse(task.completed_at);
    if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
      acc.durations.push(end - start);
    }
  }
}

function finalizeEvalMap(map: Record<string, EvalAcc>): Record<string, MetricsEvalStats> {
  const out: Record<string, MetricsEvalStats> = {};
  for (const [key, acc] of Object.entries(map)) {
    out[key] = finalizeEvalAcc(acc);
  }
  return out;
}

function finalizeGroup(key: string | null, acc: GroupAcc): MetricsGroup {
  const decided = acc.tasks.completed + acc.tasks.failed;
  const success_rate = decided === 0 ? null : acc.tasks.completed / decided;
  const durations = [...acc.durations].sort((a, b) => a - b);
  const durationTotal = durations.reduce((s, d) => s + d, 0);
  return {
    key,
    tasks: acc.tasks,
    success_rate,
    evals: finalizeEvalAcc(acc.evals),
    evals_by_size: finalizeEvalMap(acc.evalsBySize),
    evals_by_difficulty: finalizeEvalMap(acc.evalsByDifficulty),
    tokens: acc.tokens,
    duration_ms: {
      total: durationTotal,
      avg: durations.length === 0 ? null : durationTotal / durations.length,
      p50: percentile(durations, 50),
      p95: percentile(durations, 95),
      tasks_reporting: durations.length,
    },
  };
}

/**
 * Aggregate task rows into metrics groups (#118 / #164).
 * Filters (session, type, provenance, rubric, first_attempt, below_baseline)
 * are applied before bucketing. Groups are ordered by key (null last), stable.
 */
export function aggregateMetrics(
  tasks: readonly TaskRow[],
  options: TaskMetricsFilters & { groupBy?: MetricsGroupBy } = {},
): MetricsResponse {
  const groupBy: MetricsGroupBy = options.groupBy ?? "vendor";
  const filters: TaskMetricsFilters = options;

  const filtered = tasks.filter((t) => taskMatchesFilters(t, filters));

  const buckets = new Map<string | null, GroupAcc>();
  for (const task of filtered) {
    const key = groupKeyFor(task, groupBy);
    let acc = buckets.get(key);
    if (acc === undefined) {
      acc = emptyAcc();
      buckets.set(key, acc);
    }
    accumulateTask(acc, task);
  }

  const keys = [...buckets.keys()].sort((a, b) => {
    if (a === null && b === null) return 0;
    if (a === null) return 1;
    if (b === null) return -1;
    return a.localeCompare(b);
  });

  const groups = keys.map((key) => finalizeGroup(key, buckets.get(key)!));
  return { groups, generated_at: new Date().toISOString() };
}

// Keep empty helpers exported for tests that want zeroed shapes.
export { emptyTaskCounts, emptyTokens, emptyDuration, emptyEvals };

// ---------------------------------------------------------------------------
// Run metrics (#243 / ADR-0020) — separate population, never joined with tasks
// ---------------------------------------------------------------------------

/**
 * Workflow composite key `id@version` for group-by=workflow; mirrors
 * {@link rubricGroupKey}. Version is author-declared (not a content hash).
 */
export function workflowGroupKey(run: RunRow): string {
  return `${run.workflow}@${run.version}`;
}

/** True when the run has a structured rubric eval. */
export function isRunRubricEval(run: RunRow): boolean {
  return (
    run.eval_score !== null &&
    Number.isFinite(run.eval_score) &&
    run.eval_rubric !== null &&
    run.eval_rubric !== "" &&
    run.eval_baseline !== null &&
    Number.isFinite(run.eval_baseline)
  );
}

/** Rubric composite key on a run row; null when unset. */
export function runRubricGroupKey(run: RunRow): string | null {
  if (run.eval_rubric === null || run.eval_rubric === "") return null;
  if (run.eval_rubric_version === null || run.eval_rubric_version === undefined) {
    return run.eval_rubric;
  }
  return `${run.eval_rubric}@${run.eval_rubric_version}`;
}

/**
 * Whether a run matches run-metrics filters (#243). Session `"all"` / omit /
 * null includes every session. `first_run: true` keeps parent_run_id-null rows;
 * `first_run: false` keeps forks only.
 */
export function runMatchesFilters(
  run: RunRow,
  filters: RunMetricsFilters = {},
): boolean {
  const session = filters.session;
  if (session !== undefined && session !== null && session !== "" && session !== "all") {
    if (run.orchestrator_session_id !== session) return false;
  }

  const eq = (want: string | undefined, got: string | null | undefined): boolean => {
    if (want === undefined) return true;
    return (got ?? "") === want;
  };

  if (!eq(filters.type, run.type)) return false;
  if (!eq(filters.size, run.size)) return false;
  if (!eq(filters.difficulty, run.difficulty)) return false;
  if (!eq(filters.orch_harness, run.orch_harness)) return false;
  if (!eq(filters.orch_model, run.orch_model)) return false;
  if (!eq(filters.orch_effort, run.orch_effort)) return false;
  if (!eq(filters.eval_harness, run.eval_harness)) return false;
  if (!eq(filters.eval_model, run.eval_model)) return false;
  if (!eq(filters.eval_effort, run.eval_effort)) return false;
  if (!eq(filters.rubric, run.eval_rubric)) return false;
  if (!eq(filters.workflow, run.workflow)) return false;

  if (filters.rubric_version !== undefined) {
    if (run.eval_rubric_version !== filters.rubric_version) return false;
  }
  if (filters.workflow_version !== undefined) {
    if (run.version !== filters.workflow_version) return false;
  }

  if (filters.first_run === true) {
    if (run.parent_run_id !== null) return false;
  } else if (filters.first_run === false) {
    if (run.parent_run_id === null) return false;
  }

  if (filters.below_baseline === true) {
    if (!isRunRubricEval(run)) return false;
    if (!(run.eval_score! < run.eval_baseline!)) return false;
  } else if (filters.below_baseline === false) {
    if (!isRunRubricEval(run)) return false;
    if (run.eval_score! < run.eval_baseline!) return false;
  }

  return true;
}

function emptyRunCounts(): RunMetricsCounts {
  return {
    total: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    running: 0,
    blocked: 0,
    other: 0,
  };
}

function emptyRunLineageSplit(): MetricsRunLineageEvalSplit {
  return {
    count: 0,
    avg: null,
    avg_baseline: null,
    avg_delta: null,
    below_baseline_rate: null,
  };
}

function emptyRunEvals(): RunMetricsEvalStats {
  return {
    count: 0,
    avg: null,
    avg_baseline: null,
    avg_delta: null,
    below_baseline_rate: null,
    criterion_failures: {},
    first_run: emptyRunLineageSplit(),
    fork: emptyRunLineageSplit(),
  };
}

/** Mutable accumulator for run-level rubric eval stats. */
interface RunEvalAcc {
  scoreSum: number;
  baselineSum: number;
  deltaSum: number;
  count: number;
  belowBaseline: number;
  criterion: Record<string, { failures: number; count: number }>;
  first: { scoreSum: number; baselineSum: number; deltaSum: number; count: number; below: number };
  fork: { scoreSum: number; baselineSum: number; deltaSum: number; count: number; below: number };
}

function emptyRunEvalAcc(): RunEvalAcc {
  return {
    scoreSum: 0,
    baselineSum: 0,
    deltaSum: 0,
    count: 0,
    belowBaseline: 0,
    criterion: {},
    first: { scoreSum: 0, baselineSum: 0, deltaSum: 0, count: 0, below: 0 },
    fork: { scoreSum: 0, baselineSum: 0, deltaSum: 0, count: 0, below: 0 },
  };
}

function accumulateRunRubricEval(acc: RunEvalAcc, run: RunRow): void {
  const score = run.eval_score!;
  const baseline = run.eval_baseline!;
  const delta = score - baseline;
  const below = score < baseline;

  acc.scoreSum += score;
  acc.baselineSum += baseline;
  acc.deltaSum += delta;
  acc.count += 1;
  if (below) acc.belowBaseline += 1;

  // first_run / fork — never first_attempt / fix (ADR-0020 / ADR-0017).
  const split = run.parent_run_id === null ? acc.first : acc.fork;
  split.scoreSum += score;
  split.baselineSum += baseline;
  split.deltaSum += delta;
  split.count += 1;
  if (below) split.below += 1;

  const answers = parseJsonColumn<Record<string, boolean>>(run.eval_answers ?? null);
  if (answers !== null && typeof answers === "object" && !Array.isArray(answers)) {
    for (const [id, answer] of Object.entries(answers)) {
      if (typeof answer !== "boolean") continue;
      const cur = acc.criterion[id] ?? { failures: 0, count: 0 };
      cur.count += 1;
      if (criterionAnswerFailed(id, answer)) cur.failures += 1;
      acc.criterion[id] = cur;
    }
  }
}

function finalizeRunLineageSplit(s: RunEvalAcc["first"]): MetricsRunLineageEvalSplit {
  if (s.count === 0) return emptyRunLineageSplit();
  return {
    count: s.count,
    avg: s.scoreSum / s.count,
    avg_baseline: s.baselineSum / s.count,
    avg_delta: s.deltaSum / s.count,
    below_baseline_rate: s.below / s.count,
  };
}

function finalizeRunEvalAcc(acc: RunEvalAcc): RunMetricsEvalStats {
  if (acc.count === 0) return emptyRunEvals();
  const criterion_failures: Record<string, MetricsCriterionFailureStats> = {};
  for (const [id, { failures, count }] of Object.entries(acc.criterion)) {
    criterion_failures[id] = {
      failures,
      count,
      rate: count === 0 ? null : failures / count,
    };
  }
  return {
    count: acc.count,
    avg: acc.scoreSum / acc.count,
    avg_baseline: acc.baselineSum / acc.count,
    avg_delta: acc.deltaSum / acc.count,
    below_baseline_rate: acc.belowBaseline / acc.count,
    criterion_failures,
    first_run: finalizeRunLineageSplit(acc.first),
    fork: finalizeRunLineageSplit(acc.fork),
  };
}

interface RunGroupAcc {
  runs: RunMetricsCounts;
  evals: RunEvalAcc;
  evalsBySize: Record<string, RunEvalAcc>;
  evalsByDifficulty: Record<string, RunEvalAcc>;
  tokens: MetricsTokenTotals;
  durations: number[];
}

function emptyRunAcc(): RunGroupAcc {
  return {
    runs: emptyRunCounts(),
    evals: emptyRunEvalAcc(),
    evalsBySize: {},
    evalsByDifficulty: {},
    tokens: emptyTokens(),
    durations: [],
  };
}

const RUN_PROVENANCE_GROUP_BY = new Set<RunMetricsGroupBy>([
  "orch_harness",
  "orch_model",
  "orch_effort",
  "eval_harness",
  "eval_model",
  "eval_effort",
]);

function runGroupKeyFor(run: RunRow, groupBy: RunMetricsGroupBy): string | null {
  if (groupBy === "workflow") return workflowGroupKey(run);
  if (groupBy === "rubric") return runRubricGroupKey(run);
  if (groupBy === "type") {
    return run.type === "" ? null : run.type;
  }
  if (groupBy === "size") {
    return run.size === null || run.size === "" ? null : run.size;
  }
  if (groupBy === "difficulty") {
    return run.difficulty === null || run.difficulty === "" ? null : run.difficulty;
  }
  // Provenance dimensions.
  const value =
    groupBy === "orch_harness"
      ? run.orch_harness
      : groupBy === "orch_model"
        ? run.orch_model
        : groupBy === "orch_effort"
          ? run.orch_effort
          : groupBy === "eval_harness"
            ? run.eval_harness
            : groupBy === "eval_model"
              ? run.eval_model
              : run.eval_effort;
  if (value === null || value === undefined || value === "") {
    return RUN_PROVENANCE_GROUP_BY.has(groupBy) ? "unknown" : null;
  }
  return String(value);
}

function accumulateRunTokens(acc: RunGroupAcc, tasks: readonly TaskRow[]): void {
  for (const task of tasks) {
    const raw = parseJsonColumn<Record<string, number>>(task.usage);
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
    const n = normalizeUsage(raw);
    if (n.input !== null || n.output !== null || n.cached !== null) {
      acc.tokens.tasks_reporting += 1;
      if (n.input !== null) acc.tokens.input += n.input;
      if (n.output !== null) acc.tokens.output += n.output;
      if (n.cached !== null) acc.tokens.cached += n.cached;
    }
  }
}

function accumulateRun(acc: RunGroupAcc, run: RunRow, tasks: readonly TaskRow[]): void {
  acc.runs.total += 1;
  switch (run.state) {
    case "completed":
      acc.runs.completed += 1;
      break;
    case "failed":
      acc.runs.failed += 1;
      break;
    case "cancelled":
      acc.runs.cancelled += 1;
      break;
    case "running":
      acc.runs.running += 1;
      break;
    case "blocked":
      acc.runs.blocked += 1;
      break;
    default:
      acc.runs.other += 1;
      break;
  }

  if (isRunRubricEval(run)) {
    accumulateRunRubricEval(acc.evals, run);
    if (run.size !== null && run.size !== "") {
      let sizeAcc = acc.evalsBySize[run.size];
      if (sizeAcc === undefined) {
        sizeAcc = emptyRunEvalAcc();
        acc.evalsBySize[run.size] = sizeAcc;
      }
      accumulateRunRubricEval(sizeAcc, run);
    }
    if (run.difficulty !== null && run.difficulty !== "") {
      let diffAcc = acc.evalsByDifficulty[run.difficulty];
      if (diffAcc === undefined) {
        diffAcc = emptyRunEvalAcc();
        acc.evalsByDifficulty[run.difficulty] = diffAcc;
      }
      accumulateRunRubricEval(diffAcc, run);
    }
  }

  accumulateRunTokens(acc, tasks);

  if (run.completed_at !== null) {
    const start = Date.parse(run.started_at ?? run.created_at);
    const end = Date.parse(run.completed_at);
    if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
      acc.durations.push(end - start);
    }
  }
}

function finalizeRunEvalMap(map: Record<string, RunEvalAcc>): Record<string, RunMetricsEvalStats> {
  const out: Record<string, RunMetricsEvalStats> = {};
  for (const [key, acc] of Object.entries(map)) {
    out[key] = finalizeRunEvalAcc(acc);
  }
  return out;
}

function finalizeRunGroup(key: string | null, acc: RunGroupAcc): RunMetricsGroup {
  const decided = acc.runs.completed + acc.runs.failed;
  const success_rate = decided === 0 ? null : acc.runs.completed / decided;
  const durations = [...acc.durations].sort((a, b) => a - b);
  const durationTotal = durations.reduce((s, d) => s + d, 0);
  // Cost per completed run: bucket total tokens ÷ completed (not a lineage
  // rollup — parent and fork each appear once in the workflow bucket).
  const tokenCost = acc.tokens.input + acc.tokens.output;
  const cost_per_completed_run =
    acc.runs.completed === 0 ? null : tokenCost / acc.runs.completed;
  return {
    key,
    runs: acc.runs,
    success_rate,
    evals: finalizeRunEvalAcc(acc.evals),
    evals_by_size: finalizeRunEvalMap(acc.evalsBySize),
    evals_by_difficulty: finalizeRunEvalMap(acc.evalsByDifficulty),
    tokens: acc.tokens,
    duration_ms: {
      total: durationTotal,
      avg: durations.length === 0 ? null : durationTotal / durations.length,
      p50: percentile(durations, 50),
      p95: percentile(durations, 95),
      tasks_reporting: durations.length,
    },
    cost_per_completed_run,
  };
}

/**
 * Aggregate run rows into metrics groups (#243 / ADR-0020).
 *
 * `tasksByRunId` supplies child-task usage for the token rollup. Tasks are
 * never mixed into group keys — only used for cost. Filters apply before
 * bucketing. Groups ordered by key (null last).
 */
export function aggregateRunMetrics(
  runs: readonly RunRow[],
  tasksByRunId: ReadonlyMap<string, readonly TaskRow[]>,
  options: RunMetricsFilters & { groupBy?: RunMetricsGroupBy } = {},
): RunMetricsResponse {
  const groupBy: RunMetricsGroupBy = options.groupBy ?? "workflow";
  const filters: RunMetricsFilters = options;

  const filtered = runs.filter((r) => runMatchesFilters(r, filters));

  const buckets = new Map<string | null, RunGroupAcc>();
  for (const run of filtered) {
    const key = runGroupKeyFor(run, groupBy);
    let acc = buckets.get(key);
    if (acc === undefined) {
      acc = emptyRunAcc();
      buckets.set(key, acc);
    }
    accumulateRun(acc, run, tasksByRunId.get(run.id) ?? []);
  }

  const keys = [...buckets.keys()].sort((a, b) => {
    if (a === null && b === null) return 0;
    if (a === null) return 1;
    if (b === null) return -1;
    return a.localeCompare(b);
  });

  const groups = keys.map((key) => finalizeRunGroup(key, buckets.get(key)!));
  return { groups, generated_at: new Date().toISOString() };
}

/** Index tasks by run_id for {@link aggregateRunMetrics}. */
export function indexTasksByRunId(tasks: readonly TaskRow[]): Map<string, TaskRow[]> {
  const map = new Map<string, TaskRow[]>();
  for (const task of tasks) {
    if (task.run_id === null || task.run_id === "") continue;
    let list = map.get(task.run_id);
    if (list === undefined) {
      list = [];
      map.set(task.run_id, list);
    }
    list.push(task);
  }
  return map;
}

export { emptyRunCounts, emptyRunEvals };
