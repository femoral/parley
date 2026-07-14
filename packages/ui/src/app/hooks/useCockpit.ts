import { useCallback, useEffect, useMemo, useState } from "react";
import { ParleyClient } from "@useparley/core";
import type { HealthView, InspectorTask } from "../../hud/types.js";
import { formatClock, formatUptime } from "./format.js";
import { useHealth } from "./useHealth.js";
import { projectInspector } from "./inspector.js";
import { projectRoster } from "./roster.js";
import { useLogTail } from "./useLogTail.js";
import { useSettings, type SettingsView } from "./useSettings.js";
import { useSnapshot, type SnapshotView } from "./useSnapshot.js";
import { useTaskDetail } from "./useTaskDetail.js";

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
  /**
   * Live snapshot with roster groups already filtered by the selected session
   * (#76). Health/scene/inbox counts stay fleet-wide; only `groups` and the
   * roster footer totals reflect the session chip.
   */
  snapshot: SnapshotView;
  roster: RosterSelection;
  /** Wall-clock `HH:MM` for the day chip. */
  clock: string;
  /** Days the cove has been open (flavour: real elapsed days, min 1). */
  day: number;
  /**
   * The single v1 write (#67): `POST /tasks/:ref/answer`. Rejects with the
   * daemon's error on failure — the inbox card catches it and stays put; on
   * success the state flip arrives over SSE and `useSnapshot` re-projects the
   * task out of the inbox, no reload.
   */
  answerTask: (id: string, text: string) => Promise<void>;
  /** The selected task's inspector payload (#68), or `null` with no selection. */
  inspector: InspectorTask | null;
  /** Persisted cockpit preferences (#70): ornaments, kit band, log follow. */
  settings: SettingsView;
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
  const live = useSnapshot(client);
  const settings = useSettings();
  const [now, setNow] = useState(() => Date.now());
  // useState setters are identity-stable, so hud components (memoized against
  // the cockpit's one-second clock re-render) can take them as props directly.
  // Single source of truth for session filter + future scene camera cue (#76).
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const selectTask: (id: string) => void = setSelectedTaskId;
  // Re-selecting the active session is a no-op; only "All hands" (null) deselects.
  const selectSession = useCallback((id: string | null) => {
    setSelectedSessionId((prev) => (prev === id ? prev : id));
  }, []);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // If the selected session disappears from the snapshot (tasks pruned), fall
  // back to "All hands" rather than showing a permanently empty filtered list.
  useEffect(() => {
    if (selectedSessionId === null) return;
    if (!live.sessions.some((session) => session.id === selectedSessionId)) {
      setSelectedSessionId(null);
    }
  }, [selectedSessionId, live.sessions]);

  // Filter groups at derivation time so header counts match filtered contents.
  // Health totals stay fleet-wide (unfiltered `live`); the roster list/footer
  // use the session-scoped projection.
  const filteredRoster = useMemo(
    () =>
      selectedSessionId === null
        ? null
        : projectRoster(live.tasks, selectedSessionId),
    [live.tasks, selectedSessionId],
  );

  const snapshot: SnapshotView = useMemo(() => {
    if (filteredRoster === null) return live;
    return {
      ...live,
      groups: filteredRoster.groups,
      totalTasks: filteredRoster.totalTasks,
      activeTasks: filteredRoster.activeTasks,
    };
  }, [live, filteredRoster]);

  const origin = typeof window !== "undefined" ? window.location : undefined;
  const healthView: HealthView = {
    online: health.online,
    version: health.version,
    pid: health.pid,
    host: origin?.hostname || "127.0.0.1",
    port: origin?.port || "—",
    uptime: health.startedAt !== null ? formatUptime(now - health.startedAt) : "",
    // Fleet-wide counts — never scoped to the selected session chip.
    activeAgents: live.activeTasks,
    totalTasks: live.totalTasks,
    durableSessions: live.durableSessions,
  };

  const day =
    health.startedAt !== null
      ? Math.max(1, Math.floor((now - health.startedAt) / 86_400_000) + 1)
      : 1;

  const roster: RosterSelection = { selectedSessionId, selectedTaskId, selectSession, selectTask };

  // Q&A history is durable on the server (#79) and rides `useTaskDetail`'s
  // response — no client-side accumulation. The single write stays a plain
  // POST; the next detail poll (or reselect) rehydrates the answered turn.
  const answerTask = useCallback(
    async (id: string, text: string): Promise<void> => {
      await client.answer(id, text);
    },
    [client],
  );

  const detail = useTaskDetail(client, selectedTaskId);
  const logs = useLogTail(client, selectedTaskId, settings.followLogs);
  // Memoized so the one-second clock tick doesn't mint a fresh InspectorTask
  // (the memoized Inspector would re-render its whole tab body every second).
  // The id guard drops one frame of stale detail when the selection changes
  // (useTaskDetail resets in an effect, i.e. after this render already ran).
  const inspector: InspectorTask | null = useMemo(
    () =>
      detail && detail.task.task_id === selectedTaskId
        ? projectInspector(detail, logs)
        : null,
    [detail, logs, selectedTaskId],
  );

  return {
    health: healthView,
    snapshot,
    roster,
    clock: formatClock(new Date(now)),
    day,
    answerTask,
    inspector,
    settings,
  };
}
