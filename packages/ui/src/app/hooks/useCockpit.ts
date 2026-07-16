import { useCallback, useEffect, useMemo, useState } from "react";
import { ParleyClient } from "@useparley/core";
import type { HealthView, InspectorTask, RosterSessionSearchHit } from "../../hud/types.js";
import { formatClock, formatUptime } from "./format.js";
import { useHealth } from "./useHealth.js";
import { projectInspector } from "./inspector.js";
import { projectRoster, shortId } from "./roster.js";
import { useLogTail } from "./useLogTail.js";
import { useSettings, type SettingsView } from "./useSettings.js";
import { useSnapshot, type SnapshotView } from "./useSnapshot.js";
import { useTaskDetail } from "./useTaskDetail.js";

/** Base browser tab title — matches `packages/ui/index.html`. Keep in one place. */
export const COCKPIT_DOCUMENT_TITLE = "Parley Cove — parley cockpit";

/**
 * How long the snapshot stream and/or health must stay bad before the shell
 * treats the chart as stale. A single SSE hiccup or health blip must not flash
 * the band or freeze ships.
 */
export const CHART_STALE_DEBOUNCE_MS = 4000;

/** Tab title with an optional inbox badge: `(N) Parley Cove — parley cockpit`. */
export function formatCockpitDocumentTitle(awaitingCount: number): string {
  return awaitingCount > 0 ? `(${awaitingCount}) ${COCKPIT_DOCUMENT_TITLE}` : COCKPIT_DOCUMENT_TITLE;
}

/**
 * Debounced chart-staleness: true when the snapshot stream is disconnected or
 * health is unreachable, only after {@link CHART_STALE_DEBOUNCE_MS} of continuous
 * failure. Clears immediately when both signals recover.
 */
export function useChartStale(
  streamConnected: boolean,
  healthOnline: boolean,
  debounceMs: number = CHART_STALE_DEBOUNCE_MS,
): boolean {
  const rawStale = !streamConnected || !healthOnline;
  const [stale, setStale] = useState(false);

  useEffect(() => {
    if (!rawStale) {
      setStale(false);
      return;
    }
    const id = setTimeout(() => setStale(true), debounceMs);
    return () => clearTimeout(id);
  }, [rawStale, debounceMs]);

  return stale;
}

/** SSR-safe `document.title` sync for the inbox awaiting count. */
export function useCockpitDocumentTitle(awaitingCount: number): void {
  useEffect(() => {
    if (typeof document === "undefined") return;
    document.title = formatCockpitDocumentTitle(awaitingCount);
    return () => {
      document.title = COCKPIT_DOCUMENT_TITLE;
    };
  }, [awaitingCount]);
}

/** The roster's selection state — which orchestrator session and task are
 * active (#66). Lives in the app layer: hud rows/selectors take the current
 * selection and an `onSelect*` callback as plain props and never own it.
 * Plain setter semantics — re-selecting the active session is a no-op; the
 * "All hands" chip (passing `null`) is the one deselect affordance. Task
 * rows only select; {@link clearTask} (Escape accelerator) deselects. */
export interface RosterSelection {
  selectedSessionId: string | null;
  selectedTaskId: string | null;
  selectSession: (id: string | null) => void;
  selectTask: (id: string) => void;
  /** Clear the selected task (Escape accelerator; inspector shows empty state). */
  clearTask: () => void;
  /**
   * Look up historical orchestrator sessions by id substring (#88). Read-only
   * — selection of a hit goes through {@link selectSession}.
   */
  searchSessions: (query: string) => Promise<RosterSessionSearchHit[]>;
}

export interface CockpitView {
  health: HealthView;
  /**
   * Live snapshot with roster groups already filtered by the selected session
   * (#76). Health/scene/inbox counts stay fleet-wide; only `groups` and the
   * roster footer totals reflect the session chip. Session chips are the
   * recent-N subset (#88); older sessions come from {@link RosterSelection.searchSessions}.
   */
  snapshot: SnapshotView;
  roster: RosterSelection;
  /** Wall-clock `HH:MM` for the day chip. */
  clock: string;
  /** Daemon uptime in whole days (min 1) — day chip's "days at sea". */
  day: number;
  /** The selected task's inspector payload (#68), or `null` with no selection. */
  inspector: InspectorTask | null;
  /** Persisted cockpit preferences (#70): ornaments, kit band, log follow. */
  settings: SettingsView;
  /**
   * Debounced chart honesty signal: snapshot stream lost and/or health
   * unreachable for {@link CHART_STALE_DEBOUNCE_MS}. Drives the stale band and
   * scene animation pause — not the immediate HealthPanel OFFLINE chip.
   */
  chartStale: boolean;
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
  const chartStale = useChartStale(live.connected, health.online);
  // Inbox count is the awaiting_answer (and any other question-bearing) tally.
  useCockpitDocumentTitle(live.inbox.length);
  const [now, setNow] = useState(() => Date.now());
  // useState setters are identity-stable, so hud components (memoized against
  // the cockpit's one-second clock re-render) can take them as props directly.
  // Single source of truth for session filter + future scene camera cue (#76).
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  // useState setters are identity-stable — safe as memoized-hud props.
  const selectTask: (id: string) => void = setSelectedTaskId;
  const clearTask = useCallback(() => {
    setSelectedTaskId(null);
  }, []);
  // Re-selecting the active session is a no-op; only "All hands" (null) deselects.
  const selectSession = useCallback((id: string | null) => {
    setSelectedSessionId((prev) => (prev === id ? prev : id));
  }, []);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // If the selected session has no tasks left in the live fleet at all, fall
  // back to "All hands". A session outside the recent chip cap (search pick)
  // stays selected while it still has tasks — chips alone are not the source
  // of truth for validity (#88).
  useEffect(() => {
    if (selectedSessionId === null) return;
    const stillPresent = live.tasks.some(
      (task) => task.orchestratorSession === selectedSessionId,
    );
    if (!stillPresent) setSelectedSessionId(null);
  }, [selectedSessionId, live.tasks]);

  // Filter groups + cap/pin session chips at derivation time so header counts
  // match filtered contents and a search-selected session stays visible (#76/#88).
  // Health totals stay fleet-wide (unfiltered `live`); the roster list/footer
  // use the session-scoped projection.
  const filteredRoster = useMemo(
    () => projectRoster(live.tasks, selectedSessionId),
    [live.tasks, selectedSessionId],
  );

  const snapshot: SnapshotView = useMemo(
    () => ({
      ...live,
      groups: filteredRoster.groups,
      sessions: filteredRoster.sessions,
      totalTasks: filteredRoster.totalTasks,
      activeTasks: filteredRoster.activeTasks,
    }),
    [live, filteredRoster],
  );

  // Historical session lookup for the roster search affordance (#88). Read-only.
  const searchSessions = useCallback(
    async (query: string): Promise<RosterSessionSearchHit[]> => {
      const { sessions } = await client.listSessions(query);
      return sessions.map((s) => ({
        id: s.id,
        label: shortId(s.id),
        taskCount: s.task_count,
        lastActivityAt: s.last_activity_at,
      }));
    },
    [client],
  );

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

  const roster: RosterSelection = {
    selectedSessionId,
    selectedTaskId,
    selectSession,
    selectTask,
    clearTask,
    searchSessions,
  };

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
    inspector,
    settings,
    chartStale,
  };
}
