/**
 * Fleet KPI strip derivation — honest denominators, no invented caps.
 */
import type { RunSummary, TaskEnvelope } from "@useparley/core";
import { normalizeUsage } from "@useparley/core";
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
      ? `cap ${cap} · ${queued} queued behind`
      : queued > 0
        ? `${queued} queued · cap unknown`
        : "cap unknown";

  const advancing = input.runs.filter((r) => r.state === "running").length;
  const completed = counts.completed ?? 0;
  const failed = counts.failed ?? 0;
  const settledDenom = Math.max(1, completed + failed);
  const successPct = Math.round((completed / settledDenom) * 100);

  let sumIn = 0;
  let sumCached = 0;
  const durs: number[] = [];
  for (const t of input.tasks) {
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
  const cachedPct = sumIn > 0 ? Math.round((sumCached / sumIn) * 100) : 0;

  return [
    {
      id: "needs-orch",
      label: "needs orchestrator",
      value: String(needsOrch),
      unit: "items",
      note: `${heldGates} held gate${heldGates === 1 ? "" : "s"} · ${asks} asks · ${stalled} stalled · ${freshFailed} fresh failures`,
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
      note: "deny-by-default allowlist gates spawns",
      tone: "queued",
    },
    {
      id: "runs",
      label: "runs",
      value: String(input.runs.length),
      unit: "total",
      note: `${heldGates} held at a gate · ${advancing} advancing`,
      tone: "neutral",
    },
    {
      id: "settled",
      label: "settled 24h",
      value: `${completed} / ${failed}`,
      unit: "done / failed",
      note: `success ${successPct}%`,
      tone: "completed",
    },
    {
      id: "token-burn",
      label: "token burn",
      value: formatTokens(sumIn),
      unit: "in",
      note: `cached ${cachedPct}% · p95 ${p95 != null ? formatDur(p95) : "—"}`,
      tone: "neutral",
    },
  ];
}
