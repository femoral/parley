/**
 * Capability-matched routing helpers (#315 / #304).
 *
 * Pure diagnosis and matching logic shared by delegate-time fail-fast and
 * claim-time selection. Executor inventory is assembled by the engine from
 * the runner registry + the daemon's own fingerprinted vendor list.
 */
import { LOCAL_EXECUTOR_ID } from "@useparley/core";

/** One known executor and the vendor ids it advertises. */
export interface ExecutorCapability {
  /** `local` or a registered runner name. */
  name: string;
  /** Advertised vendor ids (order preserved). */
  vendors: readonly string[];
  /** Derived online / offline (stale counts as offline for routing). */
  online: boolean;
  /** True for the daemon's in-process executor. */
  isLocal: boolean;
  /** Warm ranking stamp; null until first completion. */
  last_completed_at: string | null;
}

/** Outcome of matching a vendor (and optional hard affinity) against the fleet. */
export interface RoutingMatch {
  /** Executors that advertise the required vendor. */
  capable: ExecutorCapability[];
  /** Capable and currently online. */
  onlineCapable: ExecutorCapability[];
  /** Capable but offline / stale. */
  offlineCapable: ExecutorCapability[];
}

/**
 * True when `vendors` includes `vendor` (case-sensitive id match — vendor ids
 * are lower-case in adapters).
 */
export function advertisesVendor(
  vendors: readonly string[],
  vendor: string,
): boolean {
  return vendors.includes(vendor);
}

/**
 * Partition the fleet into capable / online / offline for a vendor requirement.
 * When `affinity` is set, only that named executor is considered (pin).
 */
export function matchExecutors(
  fleet: readonly ExecutorCapability[],
  vendor: string,
  affinity: string | null = null,
): RoutingMatch {
  let pool = fleet;
  if (affinity !== null && affinity !== "") {
    pool = fleet.filter((e) => e.name === affinity);
  }
  const capable = pool.filter((e) => advertisesVendor(e.vendors, vendor));
  const onlineCapable = capable.filter((e) => e.online);
  const offlineCapable = capable.filter((e) => !e.online);
  return { capable, onlineCapable, offlineCapable };
}

/**
 * Format one executor for a diagnosis line: `name=[v1, v2]` or `name=(none)`.
 */
export function formatExecutorVendors(e: ExecutorCapability): string {
  const list = e.vendors.length > 0 ? e.vendors.join(", ") : "(none)";
  const status = e.isLocal ? "" : e.online ? "" : " (offline)";
  return `${e.name}=[${list}]${status}`;
}

/**
 * Diagnosis when no registered executor (daemon included) advertises the
 * vendor — or a hard pin names an incapable executor.
 */
export function formatCapabilityDiagnosis(opts: {
  vendor: string;
  fleet: readonly ExecutorCapability[];
  affinity?: string | null;
  reason?: "no_capable" | "pin_incapable" | "timeout";
}): string {
  const known =
    opts.fleet.length > 0
      ? opts.fleet.map(formatExecutorVendors).join("; ")
      : "(no executors registered)";
  const affinity = opts.affinity !== null && opts.affinity !== undefined && opts.affinity !== ""
    ? opts.affinity
    : null;

  if (affinity !== null && (opts.reason === "pin_incapable" || opts.reason === undefined)) {
    const pinned = opts.fleet.find((e) => e.name === affinity);
    if (pinned === undefined) {
      return (
        `runner "${affinity}" has no registered capabilities for vendor "${opts.vendor}"; ` +
        `known executors: ${known}`
      );
    }
    if (!advertisesVendor(pinned.vendors, opts.vendor)) {
      const ads =
        pinned.vendors.length > 0 ? pinned.vendors.join(", ") : "(none)";
      return (
        `runner "${affinity}" cannot run vendor "${opts.vendor}" ` +
        `(advertises: ${ads}); known executors: ${known}`
      );
    }
  }

  if (opts.reason === "timeout") {
    return (
      `routing timed out waiting for a capable online executor for vendor "${opts.vendor}"; ` +
      `known executors: ${known}`
    );
  }

  return (
    `no capable executor for vendor "${opts.vendor}"; ` +
    `known executors: ${known}`
  );
}

/**
 * Visible queue reason when capable executors exist but none is online.
 * Shape: `waiting for capable runner: gpu, cpu (offline)`.
 */
export function formatWaitingReason(offlineCapable: readonly ExecutorCapability[]): string {
  const names = offlineCapable
    .filter((e) => !e.isLocal)
    .map((e) => e.name);
  // Local offline is impossible (daemon is this process); still include if present.
  if (names.length === 0) {
    const fallback = offlineCapable.map((e) => e.name);
    return `waiting for capable runner: ${fallback.join(", ") || "?"} (offline)`;
  }
  return `waiting for capable runner: ${names.join(", ")} (offline)`;
}

/**
 * Among online capable runners (non-local), pick preferred order: warmest
 * (most recent completion) first, then name ASC. Empty when no online runners.
 * Used by claim-time warm reservation (#315 F5) via the same ranking rule as
 * `preferredWarmRunner` in db.ts.
 */
export function rankOnlineRunners(
  onlineCapable: readonly ExecutorCapability[],
): ExecutorCapability[] {
  const runners = onlineCapable.filter((e) => !e.isLocal);
  return [...runners].sort((a, b) => {
    const at = a.last_completed_at ? Date.parse(a.last_completed_at) : 0;
    const bt = b.last_completed_at ? Date.parse(b.last_completed_at) : 0;
    if (at !== bt) return bt - at;
    return a.name.localeCompare(b.name);
  });
}

/**
 * Dispatch decision for a newly created (or re-offered) task.
 * - `runner`: wake lease waiters (runners preferred / pin / only capable online)
 * - `local`: offer to InProcessExecutor
 * - `wait`: set queue_reason and arm timeout
 * - `fail`: should not reach insert — diagnosis at delegate
 */
export type DispatchDecision =
  | { kind: "runner" }
  | { kind: "local" }
  | { kind: "wait"; reason: string; offlineCapable: ExecutorCapability[] }
  | { kind: "fail"; diagnosis: string };

/**
 * Decide how to hand off a task given the match against the current fleet.
 * Runners preferred over local when any capable runner is online.
 */
export function decideDispatch(
  match: RoutingMatch,
  fleet: readonly ExecutorCapability[],
  vendor: string,
  affinity: string | null,
): DispatchDecision {
  if (affinity !== null && affinity !== "") {
    if (match.capable.length === 0) {
      return {
        kind: "fail",
        diagnosis: formatCapabilityDiagnosis({
          vendor,
          fleet,
          affinity,
          reason: "pin_incapable",
        }),
      };
    }
    if (match.onlineCapable.length > 0) {
      return { kind: "runner" };
    }
    return {
      kind: "wait",
      reason: formatWaitingReason(match.offlineCapable),
      offlineCapable: match.offlineCapable,
    };
  }

  if (match.capable.length === 0) {
    return {
      kind: "fail",
      diagnosis: formatCapabilityDiagnosis({
        vendor,
        fleet,
        reason: "no_capable",
      }),
    };
  }

  const onlineRunners = match.onlineCapable.filter((e) => !e.isLocal);
  if (onlineRunners.length > 0) {
    return { kind: "runner" };
  }

  const localOnline = match.onlineCapable.find((e) => e.isLocal);
  if (localOnline !== undefined) {
    return { kind: "local" };
  }

  // Capable but all offline (local never offline while this process runs —
  // so this is runner-only capable + offline).
  return {
    kind: "wait",
    reason: formatWaitingReason(match.offlineCapable),
    offlineCapable: match.offlineCapable,
  };
}

export { LOCAL_EXECUTOR_ID };
