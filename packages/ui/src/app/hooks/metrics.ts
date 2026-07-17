/**
 * Layer 4 — project `MetricsResponse` into plain Soundings view props (#119).
 * Keeps `@useparley/core` types out of the hud layer (contract 2).
 */
import type { MetricsGroup, MetricsGroupBy, MetricsResponse } from "@useparley/core";
import {
  formatDurationMs,
  formatEvalAvg,
  formatSuccessRate,
  formatTokenCount,
} from "./format.js";
import type {
  SoundingsEvalBucket,
  SoundingsGroupView,
  SoundingsView,
} from "../../hud/types.js";

/** Human labels for the group-by control (Cinzel chrome stays ALL-CAPS in CSS). */
export const GROUP_BY_OPTIONS: readonly { value: MetricsGroupBy; label: string }[] = [
  { value: "vendor", label: "Vendor" },
  { value: "model", label: "Model" },
  { value: "profile", label: "Profile" },
  { value: "size", label: "Size" },
  { value: "difficulty", label: "Difficulty" },
  { value: "type", label: "Type" },
];

function projectEvalBuckets(map: Record<string, { count: number; avg: number | null }>): SoundingsEvalBucket[] {
  return Object.keys(map)
    .sort((a, b) => a.localeCompare(b))
    .map((key) => {
      const e = map[key]!;
      return {
        key,
        avg: formatEvalAvg(e.avg, e.count),
        count: e.count,
      };
    });
}

export function projectMetricsGroup(group: MetricsGroup): SoundingsGroupView {
  return {
    key: group.key,
    label: group.key ?? "(none)",
    tasks: {
      total: group.tasks.total,
      done: group.tasks.completed,
      failed: group.tasks.failed,
      running: group.tasks.running,
    },
    successRate: formatSuccessRate(group.success_rate),
    successRateValue: group.success_rate,
    evals: formatEvalAvg(group.evals.avg, group.evals.count),
    tokens: {
      input: formatTokenCount(group.tokens.input),
      output: formatTokenCount(group.tokens.output),
      cached: formatTokenCount(group.tokens.cached),
    },
    duration: {
      avg: formatDurationMs(group.duration_ms.avg),
      p95: formatDurationMs(group.duration_ms.p95),
    },
    evalsBySize: projectEvalBuckets(group.evals_by_size),
    evalsByDifficulty: projectEvalBuckets(group.evals_by_difficulty),
  };
}

/**
 * Build the plain Soundings view the plate renders. Empty groups → empty
 * status once ready (not while loading). Errors preserve last groups when
 * present so a transient fault does not blank the board.
 */
export function projectSoundings(
  data: MetricsResponse | null,
  status: "idle" | "loading" | "ready" | "error",
  error: string | null,
  groupBy: MetricsGroupBy,
  sessionLabel: string,
): SoundingsView {
  const groups = data?.groups.map(projectMetricsGroup) ?? [];
  const empty = status === "ready" && groups.length === 0;
  return {
    status: empty ? "empty" : status === "idle" ? "loading" : status,
    error,
    groups,
    groupBy,
    sessionLabel,
    generatedAt: data?.generated_at ?? null,
  };
}

/**
 * Compact revision of the live task list for metrics refresh. State transitions
 * and membership changes advance the key; pure re-projection with identical
 * id/state pairs does not.
 */
export function metricsRefreshKey(
  tasks: readonly { id: string; state: string }[],
): string {
  if (tasks.length === 0) return "0";
  // Sort for stability if order is not guaranteed; snapshot emits map order.
  return tasks.map((t) => `${t.id}:${t.state}`).join("|");
}
