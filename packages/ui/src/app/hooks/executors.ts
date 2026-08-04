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
   * prior fleet is known. When the runners probe is failing, runner cards
   * are forced to `stale` so the panel never lies about live ONLINE (#324 F2).
   */
  status: RunnerStatus | "connecting";
  /** Advertised vendor ids (order preserved). Empty when unknown / omitted. */
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
 * Human label for a task card's executor attribution (#324 F4).
 *
 * - Non-local runners always name the host (informative even in a single-runner
 *   world the UI has not yet re-listed).
 * - `local` only when {@link multiExecutor} is true — zero-runner installs must
 *   not stamp every row with noise "on local".
 * Returns null when attribution should be hidden.
 */
export function formatExecutorLabel(
  runner: string | null | undefined,
  options?: { multiExecutor?: boolean },
): string | null {
  const id = executorIdForRunner(runner);
  if (id !== LOCAL_EXECUTOR_ID) return id;
  return options?.multiExecutor ? LOCAL_EXECUTOR_ID : null;
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

/**
 * Probe lifecycle for `GET /runners` (mirrors {@link RunnersState.status}).
 * Consumed by projection so offline probes cannot leave ONLINE chips (#324 F2).
 */
export type RunnersProbeStatus = "connecting" | "online" | "offline";

export interface ProjectExecutorsOptions {
  /** Registered runners from `GET /runners` (already status-derived). */
  runners: readonly RunnerListEntry[];
  /** Live tasks used for in-flight counts. */
  tasks: Iterable<ExecutorTaskInput>;
  /** Whether the last health probe reached the daemon. */
  daemonOnline: boolean;
  /**
   * Daemon-host vendor ids when a payload carries them. Optional — the cockpit
   * has no project path for `GET /info?project=`, so callers usually omit this;
   * empty vendors are not rendered as dead chrome (#324 F3).
   */
  daemonVendors?: readonly string[];
  /**
   * True while the first runners poll has not resolved. Surfaces a quiet
   * connecting state on the panel (not on individual runner rows once known).
   */
  connecting?: boolean;
  /**
   * Full runners-probe lifecycle. When `"offline"`, last-known runner cards
   * keep their data but status is forced to `stale` so presence never claims
   * live ONLINE from a dead poll (#324 F2). Defaults to online when omitted
   * (unit tests that only care about wire status).
   */
  runnersProbe?: RunnersProbeStatus;
}

/**
 * Project the fleet: daemon card first (always present), then registered
 * runners in list order (daemon already sorts by name on list). In-flight
 * counts attach from the running-task map. When the runners probe is offline,
 * runner presence is marked stale (last-known vendors/in-flight retained).
 */
export function projectExecutors(options: ProjectExecutorsOptions): ExecutorCardView[] {
  const inFlight = countInFlightByExecutor(options.tasks);
  const daemonVendors = options.daemonVendors ? [...options.daemonVendors] : [];
  const probe = options.runnersProbe ?? "online";
  const probeStale = probe === "offline";

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
    // Dead poll: keep last-known fleet shape, never echo live ONLINE (#324 F2).
    status: probeStale ? "stale" : r.status,
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
