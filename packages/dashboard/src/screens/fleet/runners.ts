/**
 * Runner status → class/label mapping. Guarded so a frozen "online" class
 * cannot silently paint stale/offline runners green (#315 class of defect).
 */
import type { RunnerListEntry } from "@useparley/core";

export type RunnerStatusUi = "online" | "stale" | "offline";

const ALLOWED: ReadonlySet<string> = new Set(["online", "stale", "offline"]);

/**
 * Normalize a wire status into a known UI token.
 * Unknown values fall back to offline (never invent online).
 */
export function normalizeRunnerStatus(
  status: string | null | undefined,
): RunnerStatusUi {
  if (status && ALLOWED.has(status)) return status as RunnerStatusUi;
  return "offline";
}

/** CSS modifier class suffix for the status chip. */
export function runnerStatusClass(status: string | null | undefined): string {
  return `pc-fleet-runner__status--${normalizeRunnerStatus(status)}`;
}

/** Visible label — always pairs with the class (state never by hue alone). */
export function runnerStatusLabel(status: string | null | undefined): string {
  return normalizeRunnerStatus(status);
}

export function runnerView(entry: RunnerListEntry): {
  name: string;
  status: RunnerStatusUi;
  statusClass: string;
  statusLabel: string;
  vendors: string[];
  lastSeen: string;
} {
  const status = normalizeRunnerStatus(entry.status);
  return {
    name: entry.name,
    status,
    statusClass: runnerStatusClass(status),
    statusLabel: runnerStatusLabel(status),
    vendors: entry.vendors,
    lastSeen: entry.last_seen,
  };
}
