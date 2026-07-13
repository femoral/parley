import { useEffect, useMemo, useState } from "react";
import { ParleyClient } from "@useparley/core";
import type { HealthView } from "../../hud/types.js";
import { formatClock, formatUptime } from "./format.js";
import { useHealth } from "./useHealth.js";
import { useSnapshot, type SnapshotView } from "./useSnapshot.js";

/** The roster's selection state — which orchestrator session and task are
 * active (#66). Lives in the app layer: hud rows/selectors take the current
 * selection and an `onSelect*` callback as plain props and never own it.
 * Plain setter semantics — re-selecting the active session is a no-op; the
 * "All hands" chip (passing `null`) is the one deselect affordance. */
export interface RosterSelection {
  selectedSessionId: string | null;
  selectedTaskId: string | null;
  selectSession: (id: string | null) => void;
  selectTask: (id: string) => void;
}

export interface CockpitView {
  health: HealthView;
  snapshot: SnapshotView;
  roster: RosterSelection;
  /** Wall-clock `HH:MM` for the day chip. */
  clock: string;
  /** Days the cove has been open (flavour: real elapsed days, min 1). */
  day: number;
}

/**
 * Layer 4 (app) — the single hook the cockpit shell reads. Owns the same-origin
 * `ParleyClient` and the one-second tick, composes `useHealth` + `useSnapshot`,
 * and projects everything (including browser-origin host/port and derived
 * uptime) into the plain view objects hud renders. Keeping all `@useparley/core`
 * use behind hooks means Cockpit and every layer below take plain props
 * (component-system spec contract 4).
 */
export function useCockpit(): CockpitView {
  const client = useMemo(() => new ParleyClient({ baseUrl: "" }), []);
  const health = useHealth(client);
  const snapshot = useSnapshot(client);
  const [now, setNow] = useState(() => Date.now());
  // useState setters are identity-stable, so hud components (memoized against
  // the cockpit's one-second clock re-render) can take them as props directly.
  const [selectedSessionId, selectSession] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const selectTask: (id: string) => void = setSelectedTaskId;

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const origin = typeof window !== "undefined" ? window.location : undefined;
  const healthView: HealthView = {
    online: health.online,
    version: health.version,
    pid: health.pid,
    host: origin?.hostname || "127.0.0.1",
    port: origin?.port || "—",
    uptime: health.startedAt !== null ? formatUptime(now - health.startedAt) : "",
    activeAgents: snapshot.activeTasks,
    totalTasks: snapshot.totalTasks,
    durableSessions: snapshot.durableSessions,
  };

  const day =
    health.startedAt !== null
      ? Math.max(1, Math.floor((now - health.startedAt) / 86_400_000) + 1)
      : 1;

  const roster: RosterSelection = { selectedSessionId, selectedTaskId, selectSession, selectTask };

  return { health: healthView, snapshot, roster, clock: formatClock(new Date(now)), day };
}
