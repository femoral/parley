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

/** Parsed hash route: screen + optional entity id for task/run deep links. */
export interface ScreenRoute {
  screen: ScreenId;
  /** Present for `#/task/:id` and `#/run/:id`; null otherwise. */
  entityId: string | null;
}

/**
 * Hash path → screen + optional entity id.
 * Forms: `#/fleet` | `#/metrics` | `#/task` | `#/task/:id` | `#/run` | `#/run/:id`.
 * Unknown screens fall back to fleet; unknown entity ids are still returned
 * (callers degrade selection when the entity is missing from data).
 */
export function parseScreenRoute(hash: string): ScreenRoute {
  const raw = hash.replace(/^#\/?/, "").split("?")[0] ?? "";
  const parts = raw.split("/").filter(Boolean);
  const head = (parts[0] ?? "").toLowerCase();
  const rest = parts.slice(1).join("/");
  const entityId = rest ? decodeURIComponent(rest) : null;

  if (head === "run" || head === "task") {
    return { screen: head, entityId };
  }
  if (head === "metrics") return { screen: "metrics", entityId: null };
  if (head === "fleet" || head === "overview" || head === "") {
    return { screen: "fleet", entityId: null };
  }
  return { screen: "fleet", entityId: null };
}

/** Hash path → screen id. Unknown hashes fall back to fleet. */
export function parseScreenHash(hash: string): ScreenId {
  return parseScreenRoute(hash).screen;
}

/**
 * Screen → hash. Task/run include the entity id when provided so deep links
 * restore after reload.
 */
export function screenHash(screen: ScreenId, entityId?: string | null): string {
  if ((screen === "task" || screen === "run") && entityId) {
    return `#/${screen}/${encodeURIComponent(entityId)}`;
  }
  return `#/${screen}`;
}

export interface ScreenMountProps {
  screen: ScreenId;
  /**
   * Navigate to a screen. Pass `entityId` for task/run deep links so the hash
   * carries the id (selection state alone can lag a render behind setState).
   */
  navigate: (screen: ScreenId, entityId?: string | null) => void;
  selectedTaskId: string | null;
  setSelectedTaskId: (id: string | null) => void;
  selectedRunId: string | null;
  setSelectedRunId: (id: string | null) => void;
}
