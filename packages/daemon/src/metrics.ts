/**
 * Task metrics aggregation (#118) — pure functions over task rows for
 * `GET /metrics` and unit tests.
 */
import type {
  MetricsDurationStats,
  MetricsEvalStats,
  MetricsGroup,
  MetricsGroupBy,
  MetricsResponse,
  MetricsTaskCounts,
  MetricsTokenTotals,
} from "@useparley/core";
import { normalizeUsage } from "@useparley/core";
import type { TaskRow } from "./db.js";
import { parseJsonColumn } from "./report.js";

const GROUP_COLUMNS: Record<MetricsGroupBy, keyof TaskRow> = {
  vendor: "vendor",
  model: "model",
  profile: "profile",
  size: "size",
  difficulty: "difficulty",
};

/** Nearest-rank percentile over a pre-sorted ascending array; null when empty. */
export function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  // Nearest-rank: rank = ceil(p/100 * n), 1-indexed → array index rank-1.
  const rank = Math.ceil((p / 100) * sorted.length);
  const idx = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[idx] ?? null;
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

function emptyEvals(): MetricsEvalStats {
  return { count: 0, avg: null };
}

function bumpEval(map: Record<string, { sum: number; count: number }>, key: string, score: number): void {
  const cur = map[key] ?? { sum: 0, count: 0 };
  cur.sum += score;
  cur.count += 1;
  map[key] = cur;
}

function finalizeEvalMap(
  map: Record<string, { sum: number; count: number }>,
): Record<string, MetricsEvalStats> {
  const out: Record<string, MetricsEvalStats> = {};
  for (const [key, { sum, count }] of Object.entries(map)) {
    out[key] = { count, avg: count === 0 ? null : sum / count };
  }
  return out;
}

interface GroupAcc {
  tasks: MetricsTaskCounts;
  evalSum: number;
  evalCount: number;
  evalsBySize: Record<string, { sum: number; count: number }>;
  evalsByDifficulty: Record<string, { sum: number; count: number }>;
  tokens: MetricsTokenTotals;
  durations: number[];
}

function emptyAcc(): GroupAcc {
  return {
    tasks: emptyTaskCounts(),
    evalSum: 0,
    evalCount: 0,
    evalsBySize: {},
    evalsByDifficulty: {},
    tokens: emptyTokens(),
    durations: [],
  };
}

function groupKeyFor(task: TaskRow, groupBy: MetricsGroupBy): string | null {
  const col = GROUP_COLUMNS[groupBy];
  const value = task[col];
  if (value === null || value === undefined || value === "") return null;
  return String(value);
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

  if (task.eval_score !== null && Number.isFinite(task.eval_score)) {
    acc.evalSum += task.eval_score;
    acc.evalCount += 1;
    if (task.size !== null && task.size !== "") {
      bumpEval(acc.evalsBySize, task.size, task.eval_score);
    }
    if (task.difficulty !== null && task.difficulty !== "") {
      bumpEval(acc.evalsByDifficulty, task.difficulty, task.eval_score);
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

function finalizeGroup(key: string | null, acc: GroupAcc): MetricsGroup {
  const decided = acc.tasks.completed + acc.tasks.failed;
  const success_rate = decided === 0 ? null : acc.tasks.completed / decided;
  const durations = [...acc.durations].sort((a, b) => a - b);
  const durationTotal = durations.reduce((s, d) => s + d, 0);
  return {
    key,
    tasks: acc.tasks,
    success_rate,
    evals: {
      count: acc.evalCount,
      avg: acc.evalCount === 0 ? null : acc.evalSum / acc.evalCount,
    },
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
 * Aggregate task rows into metrics groups. `session` of `"all"` (or null/
 * undefined) includes every task; any other string filters by
 * `orchestrator_session_id`. Groups are ordered by key (null last), stable.
 */
export function aggregateMetrics(
  tasks: readonly TaskRow[],
  options: { session?: string | null; groupBy?: MetricsGroupBy } = {},
): MetricsResponse {
  const session = options.session ?? "all";
  const groupBy: MetricsGroupBy = options.groupBy ?? "vendor";

  const filtered =
    session === "all"
      ? tasks
      : tasks.filter((t) => t.orchestrator_session_id === session);

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
