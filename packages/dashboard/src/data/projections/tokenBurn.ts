/**
 * Client-side 24h token-burn histogram from full task envelopes.
 *
 * Wire-verification §2B: every `/tasks` envelope carries raw `usage` +
 * `cached_input_tokens` and timestamps; the client buckets by hour. No
 * time-bucketed endpoint exists — the histogram only sees tasks still in
 * retention. The retention bound is a client-side assumption unless the
 * caller supplies it explicitly (no wire endpoint exposes effective
 * `retention.days` — MED-2).
 */
import { normalizeUsage, type TaskEnvelope } from "@useparley/core";
import type {
  RetentionBoundSource,
  TokenBurnBucket,
  TokenBurnView,
} from "../types.js";

/** Wall-clock window the histogram covers. */
export const TOKEN_BURN_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Default retention bound (days). Matches core `DEFAULT_RETENTION_DAYS`.
 * Not imported from `@useparley/core/config` — that module is host-only and
 * excluded from the browser barrel the dashboard resolves. Presented with
 * `retentionSource: "default-assumed"` so screens do not treat it as fact.
 */
export const DEFAULT_RETENTION_DAYS = 30;

const HOUR_MS = 60 * 60 * 1000;

/** Floor an epoch ms to the UTC hour. */
export function hourFloorMs(ms: number): number {
  return Math.floor(ms / HOUR_MS) * HOUR_MS;
}

/**
 * Pick the best timestamp for bucketing: completion (settled work), else
 * start, else created. Missing/invalid → null (task skipped).
 */
export function taskBucketTimeMs(task: TaskEnvelope): number | null {
  for (const raw of [task.completed_at, task.started_at, task.created_at]) {
    if (raw === null || raw === undefined || raw === "") continue;
    const ms = Date.parse(raw);
    if (Number.isFinite(ms)) return ms;
  }
  return null;
}

function emptyBucket(hourStartMs: number): TokenBurnBucket {
  return { hourStartMs, input: 0, output: 0, cached: 0, tasks: 0 };
}

export interface ProjectTokenBurnOptions {
  /** Epoch ms "now"; defaults to `Date.now()`. */
  nowMs?: number;
  /**
   * Retention window in days. When omitted, {@link DEFAULT_RETENTION_DAYS}
   * is used and labeled `retentionSource: "default-assumed"`.
   */
  retentionDays?: number;
}

/**
 * Bucket task usage into 24 hourly cells ending at `nowMs`.
 * Tasks outside the 24h window or without a usable timestamp are skipped.
 * Zero-usage tasks still count in `tasks` when they fall in-window (so a
 * quiet hour is distinguishable from "no tasks retained").
 */
export function projectTokenBurn(
  tasks: readonly TaskEnvelope[],
  options: ProjectTokenBurnOptions = {},
): TokenBurnView {
  const nowMs = options.nowMs ?? Date.now();
  const explicit = options.retentionDays !== undefined;
  const retentionDays = explicit ? options.retentionDays! : DEFAULT_RETENTION_DAYS;
  const retentionSource: RetentionBoundSource = explicit ? "explicit" : "default-assumed";
  const windowStart = nowMs - TOKEN_BURN_WINDOW_MS;
  const endHour = hourFloorMs(nowMs);
  const startHour = hourFloorMs(windowStart);

  const byHour = new Map<number, TokenBurnBucket>();
  for (let h = startHour; h <= endHour; h += HOUR_MS) {
    byHour.set(h, emptyBucket(h));
  }

  let totalIn = 0;
  let totalOut = 0;
  let totalCached = 0;
  let totalTasks = 0;

  for (const task of tasks) {
    const t = taskBucketTimeMs(task);
    if (t === null || t < windowStart || t > nowMs) continue;
    const hour = hourFloorMs(t);
    let bucket = byHour.get(hour);
    if (!bucket) {
      bucket = emptyBucket(hour);
      byHour.set(hour, bucket);
    }
    const usage = task.usage ? normalizeUsage(task.usage) : null;
    const input = usage?.input ?? 0;
    const output = usage?.output ?? 0;
    const cached =
      typeof task.cached_input_tokens === "number" && Number.isFinite(task.cached_input_tokens)
        ? task.cached_input_tokens
        : (usage?.cached ?? 0);
    bucket.input += input;
    bucket.output += output;
    bucket.cached += cached;
    bucket.tasks += 1;
    totalIn += input;
    totalOut += output;
    totalCached += cached;
    totalTasks += 1;
  }

  const buckets = [...byHour.values()].sort((a, b) => a.hourStartMs - b.hourStartMs);

  return {
    buckets,
    totals: {
      input: totalIn,
      output: totalOut,
      cached: totalCached,
      tasks: totalTasks,
    },
    retentionDays,
    retentionSource,
    windowMs: TOKEN_BURN_WINDOW_MS,
    asOfMs: nowMs,
  };
}
