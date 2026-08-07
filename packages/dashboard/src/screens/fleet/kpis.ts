/**
 * Fleet KPI strip derivation — honest denominators, no invented caps.
 * "settled 24h" and token-burn KPI share TOKEN_BURN_WINDOW_MS with the chart.
 */
import type { RunSummary, TaskEnvelope } from "@useparley/core";
import { normalizeUsage } from "@useparley/core";
import {
  taskBucketTimeMs,
  TOKEN_BURN_WINDOW_MS,
} from "../../data/projections/tokenBurn.js";
import { countNoun } from "../../chrome/plural.js";
import { isHeldGate } from "./pips.js";
import { isFreshFailure } from "./attentionSort.js";
import { formatDur, formatTokens } from "./format.js";

export interface FleetKpi {
  id: string;
  label: string;
  value: string;
  unit: string;
  note: string;
  /** When set, numeral uses state ink; otherwise text-strong-2. */
  tone: "awaiting" | "running" | "queued" | "completed" | "neutral";
}

export interface FleetKpiInput {
  tasks: readonly TaskEnvelope[];
  runs: readonly RunSummary[];
  nowMs?: number;
}

function countByState(tasks: readonly TaskEnvelope[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const t of tasks) {
    counts[t.state] = (counts[t.state] ?? 0) + 1;
  }
  return counts;
}

/**
 * Effective concurrency cap from task envelopes.
 * Prefer max_concurrent when present; never invent a number when all null.
 */
export function deriveConcurrencyCap(
  tasks: readonly TaskEnvelope[],
): number | null {
  let found: number | null = null;
  for (const t of tasks) {
    const m = t.max_concurrent;
    if (typeof m === "number" && Number.isFinite(m) && m > 0) {
      if (found === null || m > found) found = m;
    }
  }
  return found;
}

/** Occupied running slots for the cap KPI numerator. */
export function countRunning(tasks: readonly TaskEnvelope[]): number {
  let n = 0;
  for (const t of tasks) {
    if (t.state === "running") n += 1;
  }
  return n;
}

/**
 * True when the task falls inside the wall-clock 24h window used by
 * {@link projectTokenBurn} (same bound: completed/started/created).
 */
export function inLast24h(
  task: TaskEnvelope,
  nowMs: number,
  windowMs: number = TOKEN_BURN_WINDOW_MS,
): boolean {
  const t = taskBucketTimeMs(task);
  if (t === null) return false;
  return t >= nowMs - windowMs && t <= nowMs;
}

/**
 * Settled (completed/failed) counts restricted to the last 24h.
 * Prefer completed_at; fall back to the burn bucketing timestamp.
 */
export function countSettled24h(
  tasks: readonly TaskEnvelope[],
  nowMs: number,
): { completed: number; failed: number } {
  let completed = 0;
  let failed = 0;
  const windowStart = nowMs - TOKEN_BURN_WINDOW_MS;
  for (const t of tasks) {
    if (t.state !== "completed" && t.state !== "failed") continue;
    const raw = t.completed_at ?? t.updated_at;
    let ms = raw ? Date.parse(raw) : NaN;
    if (!Number.isFinite(ms)) {
      const bucket = taskBucketTimeMs(t);
      if (bucket === null) continue;
      ms = bucket;
    }
    if (ms < windowStart || ms > nowMs) continue;
    if (t.state === "completed") completed += 1;
    else failed += 1;
  }
  return { completed, failed };
}

export function projectFleetKpis(input: FleetKpiInput): FleetKpi[] {
  const nowMs = input.nowMs ?? Date.now();
  const counts = countByState(input.tasks);
  const heldGates = input.runs.filter(
    (r) => r.state === "blocked" && isHeldGate(r.block),
  ).length;
  const asks = counts.awaiting_answer ?? 0;
  const stalled = counts.stalled ?? 0;
  const freshFailed = input.tasks.filter((t) => isFreshFailure(t, nowMs)).length;
  const needsOrch = heldGates + asks + stalled + (counts.failed ?? 0);

  const running = counts.running ?? 0;
  const queued = counts.queued ?? 0;
  const pending = counts.pending ?? 0;
  const cap = deriveConcurrencyCap(input.tasks);
  const runningValue =
    cap !== null ? `${running}/${cap}` : String(running);
  const runningNote =
    cap !== null
      ? `cap ${cap} · ${queued} queued`
      : queued > 0
        ? `${queued} queued · cap unknown`
        : "cap unknown";

  const advancing = input.runs.filter((r) => r.state === "running").length;
  // Settled + token burn: same 24h wall-clock window as the burn chart.
  const settled = countSettled24h(input.tasks, nowMs);
  const settledTotal = settled.completed + settled.failed;
  // Zero samples → "—", never invent a percent from Math.max(1, …).
  const successNote =
    settledTotal === 0
      ? "success — · last 24h"
      : `success ${Math.round((settled.completed / settledTotal) * 100)}% · last 24h`;

  let sumIn = 0;
  let sumCached = 0;
  const durs: number[] = [];
  for (const t of input.tasks) {
    if (!inLast24h(t, nowMs)) continue;
    const u = t.usage ? normalizeUsage(t.usage) : null;
    sumIn += u?.input ?? 0;
    const cached =
      typeof t.cached_input_tokens === "number" && Number.isFinite(t.cached_input_tokens)
        ? t.cached_input_tokens
        : (u?.cached ?? 0);
    sumCached += cached;
    if (typeof t.duration_ms === "number" && Number.isFinite(t.duration_ms)) {
      durs.push(t.duration_ms);
    }
  }
  durs.sort((a, b) => a - b);
  const p95 = durs.length ? durs[Math.floor(durs.length * 0.95)] ?? durs[durs.length - 1] : null;
  const cacheNote =
    sumIn > 0 ? `cache ${Math.round((sumCached / sumIn) * 100)}%` : "cache —";

  return [
    {
      id: "needs-orch",
      label: "needs orchestrator",
      value: String(needsOrch),
      unit: "items",
      note: `${heldGates} held · ${countNoun(asks, "ask")} · ${stalled} stall · ${freshFailed} fresh`,
      tone: "awaiting",
    },
    {
      id: "running",
      label: "running",
      value: runningValue,
      unit: cap !== null ? "slots" : "tasks",
      note: runningNote,
      tone: "running",
    },
    {
      id: "queued-pending",
      label: "queued / pending",
      value: `${queued} / ${pending}`,
      unit: "",
      note: queued > 0 ? `${queued} waiting on free slots` : "no waiters",
      tone: "queued",
    },
    {
      id: "runs",
      label: "runs",
      value: String(input.runs.length),
      unit: "total",
      note: `${heldGates} held · ${advancing} advancing`,
      tone: "neutral",
    },
    {
      id: "settled",
      label: "settled 24h",
      value: `${settled.completed} / ${settled.failed}`,
      unit: "done / failed",
      note: successNote,
      tone: "completed",
    },
    {
      id: "token-burn",
      label: "token burn",
      value: formatTokens(sumIn),
      unit: "in",
      note: `${cacheNote} · p95 ${p95 != null ? formatDur(p95) : "—"}`,
      tone: "neutral",
    },
  ];
}
