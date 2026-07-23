import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isMetricsGroupBy, ParleyClient, type MetricsGroupBy } from "@useparley/core";
import type {
  HealthView,
  InspectorTask,
  RosterSessionSearchHit,
  SoundingsFiltersView,
  SoundingsView,
  SoundingsViewTab,
} from "../../hud/types.js";
import type { InspectorTabKey } from "../../hud/Inspector/index.js";
import { formatClock, formatUptime } from "./format.js";
import { useHealth } from "./useHealth.js";
import { projectInspector } from "./inspector.js";
import { metricsRefreshKey, projectSoundings } from "./metrics.js";
import { advanceFailedObservations, projectRoster, shortId } from "./roster.js";
import { useEvalFilters } from "./useEvalFilters.js";
import { useLogTail } from "./useLogTail.js";
import { useMetrics } from "./useMetrics.js";
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

/**
 * Granularity of the failed-freshness decay clock. Coarse on purpose: the
 * 5-minute freshness window only needs to expire within ~30s, and quantizing
 * keeps the roster projection's identity stable across one-second clock ticks.
 */
export const FRESHNESS_TICK_MS = 30_000;

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

/** A wall clock that creates no React or timer work while the tab is hidden. */
export function useVisibleClock(intervalMs = 1_000): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | undefined;
    const sync = () => {
      if (interval !== undefined) clearInterval(interval);
      interval = undefined;
      if (document.hidden) return;
      setNow(Date.now());
      interval = setInterval(() => setNow(Date.now()), intervalMs);
    };
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => {
      document.removeEventListener("visibilitychange", sync);
      if (interval !== undefined) clearInterval(interval);
    };
  }, [intervalMs]);

  return now;
}

/** Options for {@link RosterSelection.selectTask}. */
export interface SelectTaskOptions {
  /** Inspector tab to land on when this selection opens. Defaults to `"brief"`. */
  tab?: InspectorTabKey;
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
  selectTask: (id: string, options?: SelectTaskOptions) => void;
  /**
   * Select a task from the inbox and land the inspector on Q&A. Identity-stable
   * so memoized `InboxPanel` does not re-render every clock tick.
   */
  selectInboxTask: (id: string) => void;
  /** Clear the selected task (Escape accelerator; inspector shows empty state). */
  clearTask: () => void;
  /**
   * Look up historical orchestrator sessions by id substring (#88). Read-only
   * — selection of a hit goes through {@link selectSession}.
   */
  searchSessions: (query: string) => Promise<RosterSessionSearchHit[]>;
  /**
   * Inspector open intent for the current selection — tab to land on plus a
   * sequence bumped every select so re-opening re-applies the tab.
   */
  inspectorIntent: { tab: InspectorTabKey; seq: number };
}

/** Which primary board the centre column shows (#119). */
export type CockpitMode = "cove" | "soundings";

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
  /** Centre-column mode: living cove scene vs Soundings metrics (#119). */
  mode: CockpitMode;
  setMode: (mode: CockpitMode) => void;
  /** Toggle Cove ↔ Soundings (`m` accelerator). */
  toggleSoundings: () => void;
  /** Projected Soundings board; only fetched while mode is `soundings`. */
  soundings: SoundingsView;
  /** Accepts wire group_by strings; invalid values are ignored. */
  setGroupBy: (groupBy: string) => void;
  /** Patch quality filters (#165); maps hud field names onto filter state. */
  setSoundingsFilters: (patch: Partial<SoundingsFiltersView>) => void;
  /** Clear quality filters. */
  clearSoundingsFilters: () => void;
  /** Switch Groups / Distribution / Comparison. */
  setSoundingsViewTab: (tab: SoundingsViewTab) => void;
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
  const now = useVisibleClock();
  // useState setters are identity-stable, so hud components (memoized against
  // the cockpit's one-second clock re-render) can take them as props directly.
  // Single source of truth for session filter + future scene camera cue (#76).
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [inspectorIntent, setInspectorIntent] = useState<{
    tab: InspectorTabKey;
    seq: number;
  }>({ tab: "brief", seq: 0 });
  // Centre mode + metrics group-by (#119) + quality filters/tabs (#165).
  // Filter state is shared so #166 heatmap/timeline can subscribe later.
  const [mode, setMode] = useState<CockpitMode>("cove");
  const [groupBy, setGroupByState] = useState<MetricsGroupBy>("vendor");
  const [viewTab, setSoundingsViewTab] = useState<SoundingsViewTab>("groups");
  const {
    filters: evalFilterState,
    setFilters: setEvalFilterState,
    clearFilters: clearSoundingsFilters,
    metricsQuery: evalMetricsQuery,
  } = useEvalFilters();
  const setGroupBy = useCallback((next: string) => {
    if (isMetricsGroupBy(next)) setGroupByState(next);
  }, []);
  const setSoundingsFilters = useCallback(
    (patch: Partial<SoundingsFiltersView>) => {
      const next: Parameters<typeof setEvalFilterState>[0] = {};
      if (patch.type !== undefined) next.type = patch.type;
      if (patch.vendor !== undefined) next.vendor = patch.vendor;
      if (patch.model !== undefined) next.model = patch.model;
      if (patch.orch_harness !== undefined) next.orch_harness = patch.orch_harness;
      if (patch.orch_model !== undefined) next.orch_model = patch.orch_model;
      if (patch.eval_harness !== undefined) next.eval_harness = patch.eval_harness;
      if (patch.eval_model !== undefined) next.eval_model = patch.eval_model;
      if (patch.rubric !== undefined) next.rubric = patch.rubric;
      if (patch.firstAttemptOnly !== undefined) next.first_attempt = patch.firstAttemptOnly;
      if (patch.belowBaselineOnly !== undefined) next.below_baseline = patch.belowBaselineOnly;
      setEvalFilterState(next);
    },
    [setEvalFilterState],
  );
  const toggleSoundings = useCallback(() => {
    setMode((prev) => (prev === "soundings" ? "cove" : "soundings"));
  }, []);
  // Failed-freshness acknowledgement: selecting a failed task marks it
  // acknowledged, but elevated rank / loud treatment hold while it stays
  // selected (projectRoster + selectedTaskId). Demotion applies on
  // deselection or 5-minute timeout. Cleared when the task leaves failed so
  // a re-failure is loud again.
  const [acknowledgedFailed, setAcknowledgedFailed] = useState<Set<string>>(
    () => new Set(),
  );
  // Observation stamps for the freshness timeout — ref so the map advances
  // during render without an extra effect tick (first paint after a failure
  // is already loud). The one-second `now` clock drives timeout decay.
  const failedObservedAtRef = useRef<ReadonlyMap<string, number>>(new Map());
  // Prior-frame task states so advanceFailedObservations can stamp `now` on a
  // live non-failed→failed transition instead of re-seeding from wire time.
  const knownTaskStatesRef = useRef<ReadonlyMap<string, string>>(new Map());
  const tasksRef = useRef(live.tasks);
  tasksRef.current = live.tasks;

  const selectTask = useCallback((id: string, options?: SelectTaskOptions) => {
    setSelectedTaskId(id);
    setInspectorIntent((prev) => ({
      tab: options?.tab ?? "brief",
      seq: prev.seq + 1,
    }));
    const task = tasksRef.current.find((t) => t.id === id);
    if (task?.state === "failed") {
      setAcknowledgedFailed((prev) => {
        if (prev.has(id)) return prev;
        const next = new Set(prev);
        next.add(id);
        return next;
      });
    }
  }, []);
  const selectInboxTask = useCallback(
    (id: string) => {
      selectTask(id, { tab: "qa" });
    },
    [selectTask],
  );
  const clearTask = useCallback(() => {
    setSelectedTaskId(null);
  }, []);
  // Re-selecting the active session is a no-op; only "All hands" (null) deselects.
  const selectSession = useCallback((id: string | null) => {
    setSelectedSessionId((prev) => (prev === id ? prev : id));
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

  // Drop acknowledgements for tasks that left failed (so a later re-failure
  // is loud again). Observation map is advanced below during render.
  useEffect(() => {
    const failedIds = new Set(
      live.tasks.filter((t) => t.state === "failed").map((t) => t.id),
    );
    setAcknowledgedFailed((prev) => {
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (failedIds.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [live.tasks]);

  // Advance failed-observation stamps once per render from the previous map.
  // Pass prior-frame states first so a live fail is stamped `now`; then
  // refresh the known-state map for the next frame.
  const failedObservedAt = advanceFailedObservations(
    live.tasks,
    failedObservedAtRef.current,
    now,
    knownTaskStatesRef.current,
  );
  failedObservedAtRef.current = failedObservedAt;
  const nextKnownStates = new Map<string, string>();
  for (const t of live.tasks) nextKnownStates.set(t.id, t.state);
  knownTaskStatesRef.current = nextKnownStates;

  // Filter groups + cap/pin session chips at derivation time so header counts
  // match filtered contents and a search-selected session stays visible (#76/#88).
  // Health totals stay fleet-wide (unfiltered `live`); the roster list/footer
  // use the session-scoped projection. Freshness is quantized to a 30s tick:
  // the 5-minute decay doesn't need 1s granularity, and depending on the raw
  // one-second clock minted fresh groups/sessions identities every tick —
  // defeating RosterPanel's memo 86 400×/day for a boundary that moves twice
  // a minute at most.
  const freshnessNow = now - (now % FRESHNESS_TICK_MS);
  const filteredRoster = useMemo(
    () =>
      projectRoster(live.tasks, selectedSessionId, {
        observedAt: failedObservedAt,
        acknowledged: acknowledgedFailed,
        selectedTaskId: selectedTaskId,
        now: freshnessNow,
      }),
    [
      live.tasks,
      selectedSessionId,
      failedObservedAt,
      acknowledgedFailed,
      selectedTaskId,
      freshnessNow,
    ],
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
    status: health.status,
    online: health.online,
    version: health.version,
    pid: health.pid,
    host: origin?.hostname || "127.0.0.1",
    port: origin?.port || "—",
    uptime: health.startedAt !== null ? formatUptime(now - health.startedAt) : "",
    // Daemon-side session count only — fleet totals/active live on the roster.
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
    selectInboxTask,
    clearTask,
    searchSessions,
    inspectorIntent,
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

  // Soundings (#119 / #165): session scope follows the roster chip; filters
  // compose AND with group_by; refreshKey advances on SSE task transitions.
  // Gate the O(n) id:state join to Soundings only — useMetrics is disabled in
  // Cove and its docs call for a stable empty string when the view is unmounted.
  const metricsSession = selectedSessionId ?? "all";
  const refreshKey = useMemo(
    () => (mode === "soundings" ? metricsRefreshKey(live.tasks) : ""),
    [live.tasks, mode],
  );
  const metrics = useMetrics(client, {
    session: metricsSession,
    groupBy,
    refreshKey,
    enabled: mode === "soundings",
    filters: evalMetricsQuery,
  });
  const sessionLabel =
    selectedSessionId === null
      ? "All hands"
      : (snapshot.sessions.find((s) => s.id === selectedSessionId)?.label ??
        shortId(selectedSessionId));
  const soundings: SoundingsView = useMemo(
    () =>
      projectSoundings(
        metrics.data,
        metrics.status,
        metrics.error,
        groupBy,
        sessionLabel,
        { filters: evalFilterState, viewTab },
      ),
    [
      metrics.data,
      metrics.status,
      metrics.error,
      groupBy,
      sessionLabel,
      evalFilterState,
      viewTab,
    ],
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
    mode,
    setMode,
    toggleSoundings,
    soundings,
    setGroupBy,
    setSoundingsFilters,
    clearSoundingsFilters,
    setSoundingsViewTab,
  };
}
