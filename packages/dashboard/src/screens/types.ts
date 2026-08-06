/**
 * Shared screen identity + navigation contract for shell ↔ screen tickets.
 * See SCREENS.md for lane ownership.
 */

export type ScreenId = "fleet" | "run" | "task" | "metrics";

export const SCREEN_IDS: readonly ScreenId[] = [
  "fleet",
  "run",
  "task",
  "metrics",
] as const;

export const SCREEN_LABELS: Record<ScreenId, string> = {
  fleet: "Fleet",
  run: "Run",
  task: "Task",
  metrics: "Metrics",
};

/** Hash path → screen id. Unknown hashes fall back to fleet. */
export function parseScreenHash(hash: string): ScreenId {
  const raw = hash.replace(/^#\/?/, "").split("?")[0]?.toLowerCase() ?? "";
  if (raw === "run" || raw === "task" || raw === "metrics" || raw === "fleet") {
    return raw;
  }
  if (raw === "overview") return "fleet";
  return "fleet";
}

export function screenHash(screen: ScreenId): string {
  return `#/${screen}`;
}

export interface ScreenMountProps {
  screen: ScreenId;
  navigate: (screen: ScreenId) => void;
  selectedTaskId: string | null;
  setSelectedTaskId: (id: string | null) => void;
  selectedRunId: string | null;
  setSelectedRunId: (id: string | null) => void;
}
