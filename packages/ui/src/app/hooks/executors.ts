/**
 * Layer 4 (hooks) — pure executor fleet projection (#324).
 *
 * Combines the daemon-local host with registered runners from `GET /runners`
 * and derives per-executor in-flight counts from live task rows (runner
 * affinity: null → daemon `local`). No React, no fetch — unit-testable with
 * hand-written fixtures.
 */
import type { RunnerListEntry, RunnerStatus } from "@useparley/core";

/**
 * Wire id for the daemon in-process executor (matches core `LOCAL_EXECUTOR_ID`
 * + GET /info). Duplicated as a string literal so the UI bundle does not need
 * a value import from `@useparley/core`'s lease module for this constant.
 */
export const LOCAL_EXECUTOR_ID = "local";

/** One executor card as the Executors panel renders it. */
export interface ExecutorCardView {
  /** Stable id: `local` for the daemon, else the runner name. */
  id: string;
  /** Display label (same as id; reserved for future friendly names). */
  label: string;
  /** Daemon host vs registered remote runner. */
  kind: "daemon" | "runner";
  /**
   * Presence: runners use wire `online`/`offline`/`stale`; the daemon card
   * follows health (online when the probe answers, offline otherwise).
   * `connecting` only while the first runners poll is unresolved and no
   * prior fleet is known.
   */
  status: RunnerStatus | "connecting";
  /** Advertised vendor ids (order preserved). Empty when unknown. */
  vendors: string[];
  /** Running tasks currently attributed to this executor. */
  inFlight: number;
  /** ISO-8601 last contact for runners; null on the daemon card. */
  lastSeen: string | null;
}

/** Task slice needed for in-flight grouping and roster attribution. */
export interface ExecutorTaskInput {
  state: string;
  /**
   * Remote runner affinity / claim name. Null/absent = daemon-local
   * (`LOCAL_EXECUTOR_ID`). From wire `TaskEnvelope.runner`.
   */
  runner?: string | null;
}

/**
 * Map a wire `runner` field onto an executor id. Null/empty → daemon `local`.
 */
export function executorIdForRunner(runner: string | null | undefined): string {
  if (runner === null || runner === undefined || runner === "") {
    return LOCAL_EXECUTOR_ID;
  }
  return runner;
}

/**
 * Human label for a task card's executor attribution (#324).
 * Always names a host: `local` for daemon execution, else the runner name.
 */
export function formatExecutorLabel(runner: string | null | undefined): string {
  return executorIdForRunner(runner);
}

/**
 * Count running tasks per executor id. Only `state === "running"` is in-flight
 * (pending/queued wait elsewhere; awaiting/stalled are not actively executing).
 * Keys are {@link LOCAL_EXECUTOR_ID} or runner names.
 */
export function countInFlightByExecutor(
  tasks: Iterable<ExecutorTaskInput>,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const task of tasks) {
    if (task.state !== "running") continue;
    const id = executorIdForRunner(task.runner);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

export interface ProjectExecutorsOptions {
  /** Registered runners from `GET /runners` (already status-derived). */
  runners: readonly RunnerListEntry[];
  /** Live tasks used for in-flight counts. */
  tasks: Iterable<ExecutorTaskInput>;
  /** Whether the last health probe reached the daemon. */
  daemonOnline: boolean;
  /**
   * Daemon-host vendor ids (from GET /info executors when available).
   * Optional — the UI often lacks a project path for /info, so vendors may
   * be empty on the local card without inventing PATH probes client-side.
   */
  daemonVendors?: readonly string[];
  /**
   * True while the first runners poll has not resolved. Surfaces a quiet
   * connecting state on the panel (not on individual runner rows once known).
   */
  connecting?: boolean;
}

/**
 * Project the fleet: daemon card first (always present), then registered
 * runners in list order (daemon already sorts by name on list). In-flight
 * counts attach from the running-task map.
 */
export function projectExecutors(options: ProjectExecutorsOptions): ExecutorCardView[] {
  const inFlight = countInFlightByExecutor(options.tasks);
  const daemonVendors = options.daemonVendors ? [...options.daemonVendors] : [];

  const daemon: ExecutorCardView = {
    id: LOCAL_EXECUTOR_ID,
    label: LOCAL_EXECUTOR_ID,
    kind: "daemon",
    status: options.connecting && !options.daemonOnline
      ? "connecting"
      : options.daemonOnline
        ? "online"
        : "offline",
    vendors: daemonVendors,
    inFlight: inFlight.get(LOCAL_EXECUTOR_ID) ?? 0,
    lastSeen: null,
  };

  const runners: ExecutorCardView[] = options.runners.map((r) => ({
    id: r.name,
    label: r.name,
    kind: "runner" as const,
    status: r.status,
    vendors: [...r.vendors],
    inFlight: inFlight.get(r.name) ?? 0,
    lastSeen: r.last_seen,
  }));

  return [daemon, ...runners];
}

/** Caps status label for a presence chip (matches HealthPanel voice). */
export function executorStatusLabel(status: ExecutorCardView["status"]): string {
  switch (status) {
    case "online":
      return "ONLINE";
    case "offline":
      return "OFFLINE";
    case "stale":
      return "STALE";
    case "connecting":
      return "HAILING…";
  }
}
