import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isMetricsGroupBy, ParleyClient, type MetricsGroupBy } from "@useparley/core";
import type {
  HealthView,
  InspectorRun,
  InspectorTask,
  RosterSearchHit,
  SoundingsFiltersView,
  SoundingsView,
  SoundingsViewTab,
} from "../../hud/types.js";
import type { InspectorTabKey } from "../../hud/Inspector/index.js";
import { formatClock, formatUptime } from "./format.js";
import { useHealth, type HealthStatus } from "./useHealth.js";
import { projectInspector } from "./inspector.js";
import { metricsRefreshKey, projectSoundings } from "./metrics.js";
import {
  advanceFailedObservations,
  collectSessionIdentities,
  deriveSessionIdentity,
  formatTaskCount,
  projectRoster,
  shortId,
} from "./roster.js";
import { useEvalFilters } from "./useEvalFilters.js";
import { useLogTail } from "./useLogTail.js";
import { useMetrics } from "./useMetrics.js";
import { useInspectorRun, useRuns } from "./useRuns.js";
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
export const COVE_FIRST_SEEN_STORAGE_KEY = "pc-cove-first-seen";
const DAY_MS = 86_400_000;

/** Format uptime only while a health probe confirms the daemon is online. */
export function deriveUptime(
  status: HealthStatus,
  startedAt: number | null,
  now: number,
): string {
  return status === "online" && startedAt !== null ? formatUptime(now - startedAt) : "";
}

/** Whole voyage day since this browser first saw the Cove (minimum day 1). */
export function deriveVoyageDay(firstSeenAt: number, now: number): number {
  return Math.max(1, Math.floor((now - firstSeenAt) / DAY_MS) + 1);
}

/**
 * Read the Cove's browser-local first-seen timestamp, setting it once when
 * absent. Returns null when storage is unavailable so callers can retain the
 * daemon-derived fallback as health data arrives.
 */
export function readCoveFirstSeen(now: number): number | null {
  if (typeof window === "undefined") return null;
  try {
    const stored = window.localStorage.getItem(COVE_FIRST_SEEN_STORAGE_KEY);
    if (stored !== null) {
      const parsed = Number(stored);
      if (Number.isFinite(parsed) && parsed > 0 && parsed <= now) return parsed;
    }
    window.localStorage.setItem(COVE_FIRST_SEEN_STORAGE_KEY, String(now));
    return now;
  } catch {
    return null;
  }
}

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

/**
 * Camera cue from task selection: sail the cove to the task's session region
 * without changing the roster session filter. `sessionKey` matches Scene's
 * region key (session id, or `"open-water"` for session-less tasks). `seq`
 * bumps on every select so re-selecting re-applies when the camera has moved.
 */
export interface SceneFrameIntent {
  sessionKey: string;
  seq: number;
}

/** The roster's selection state — which orchestrator session, task, and/or
 * run are active (#66 / #254). Lives in the app layer: hud rows/selectors take
 * the current selection and an `onSelect*` callback as plain props and never
 * own it. Plain setter semantics — re-selecting the active session is a no-op;
 * the "All hands" chip (passing `null`) is the one deselect affordance. Task
 * and run rows only select; {@link clearTask} (Escape accelerator) deselects
 * both. A run and a task are mutually exclusive selections. */
export interface RosterSelection {
  selectedSessionId: string | null;
  selectedTaskId: string | null;
  /** Selected run id, or null when a task (or nothing) is selected (#254). */
  selectedRunId: string | null;
  selectSession: (id: string | null) => void;
  selectTask: (id: string, options?: SelectTaskOptions) => void;
  /** Select a run peer row; clears any task selection (#254). */
  selectRun: (id: string) => void;
  /**
   * Select a task from the inbox and land the inspector on Q&A. Identity-stable
   * so memoized `InboxPanel` does not re-render every clock tick.
   */
  selectInboxTask: (id: string) => void;
  /** Clear the selected task and run (Escape; inspector shows empty state). */
  clearTask: () => void;
  /**
   * Find across the live fleet (task name / branch) and historical sessions
   * (id substring via the daemon). Task hits list first; selecting a task uses
   * {@link selectTask}, a session uses {@link selectSession}.
   */
  searchSessions: (query: string) => Promise<RosterSearchHit[]>;
  /**
   * Inspector open intent for the current selection — tab to land on plus a
   * sequence bumped every select so re-opening re-applies the tab.
   */
  inspectorIntent: { tab: InspectorTabKey; seq: number };
  /**
   * Scene camera cue from the latest {@link selectTask} — frames the task's
   * orchestrator session via the scene's manual-frame path without touching
   * {@link selectedSessionId}. `null` until the first task select.
   */
  sceneFrameIntent: SceneFrameIntent | null;
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
  /** Browser-local Cove tenure in whole days (min 1). */
  day: number;
  /** Daemon process uptime in whole days (min 1), for the day chip tooltip. */
  daemonUptimeDays: number;
  /** Fleet-wide failures carrying the roster's fresh coral treatment. */
  freshFailureTaskIds: string[];
  /** The selected task's inspector payload (#68), or `null` with no task selection. */
  inspector: InspectorTask | null;
  /**
   * The selected run's inspector payload (#254), or `null` when no run is
   * selected. Mutually exclusive with {@link inspector} at the plate.
   */
  inspectorRun: InspectorRun | null;
  /** Persisted cockpit preferences (#70): kit band, log follow. */
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
  // Session filter (roster chips) and scene camera cue (task select → sail)
  // are separate: selecting a task may reframe the cove without changing the
  // roster filter (#76 / scene-focus-steer).
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [inspectorIntent, setInspectorIntent] = useState<{
    tab: InspectorTabKey;
    seq: number;
  }>({ tab: "brief", seq: 0 });
  const [sceneFrameIntent, setSceneFrameIntent] = useState<SceneFrameIntent | null>(
    null,
  );
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
    setSelectedRunId(null);
    setInspectorIntent((prev) => ({
      tab: options?.tab ?? "brief",
      seq: prev.seq + 1,
    }));
    const task = tasksRef.current.find((t) => t.id === id);
    if (task) {
      // Cue the scene to frame this task's region. Does not touch the roster
      // session filter — only the camera sails (manual-frame in Scene).
      // "open-water" matches Scene's regionKey(null).
      const sessionKey = task.orchestratorSession ?? "open-water";
      setSceneFrameIntent((prev) => ({
        sessionKey,
        seq: (prev?.seq ?? 0) + 1,
      }));
    }
    if (task?.state === "failed") {
      setAcknowledgedFailed((prev) => {
        if (prev.has(id)) return prev;
        const next = new Set(prev);
        next.add(id);
        return next;
      });
    }
  }, []);
  const selectRun = useCallback((id: string) => {
    setSelectedRunId(id);
    setSelectedTaskId(null);
    // Centre-stage chart swap is #253 — selection still lands here so the
    // inspector run view and a future chart share one source of truth.
    setInspectorIntent((prev) => ({
      tab: "brief",
      seq: prev.seq + 1,
    }));
  }, []);
  const selectInboxTask = useCallback(
    (id: string) => {
      selectTask(id, { tab: "qa" });
    },
    [selectTask],
  );
  const clearTask = useCallback(() => {
    setSelectedTaskId(null);
    setSelectedRunId(null);
  }, []);
  // Re-selecting the active session is a no-op; only "All hands" (null) deselects.
  const selectSession = useCallback((id: string | null) => {
    setSelectedSessionId((prev) => (prev === id ? prev : id));
  }, []);

  const liveRuns = useRuns(client, { selectedRunId });

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
      projectRoster(
        live.tasks,
        selectedSessionId,
        {
          observedAt: failedObservedAt,
          acknowledged: acknowledgedFailed,
          selectedTaskId: selectedTaskId,
          now: freshnessNow,
        },
        liveRuns.runs,
      ),
    [
      live.tasks,
      selectedSessionId,
      failedObservedAt,
      acknowledgedFailed,
      selectedTaskId,
      freshnessNow,
      liveRuns.runs,
    ],
  );

  const fleetFreshFailureTaskIds = useMemo(
    () =>
      projectRoster(
        live.tasks,
        null,
        {
          observedAt: failedObservedAt,
          acknowledged: acknowledgedFailed,
          selectedTaskId,
          now: freshnessNow,
        },
        liveRuns.runs,
      ).groups.flatMap((group) =>
        group.tasks.filter((task) => task.freshFailure).map((task) => task.id),
      ),
    [
      live.tasks,
      failedObservedAt,
      acknowledgedFailed,
      selectedTaskId,
      freshnessNow,
      liveRuns.runs,
    ],
  );

  // Drop a selected run that left the fleet entirely.
  useEffect(() => {
    if (selectedRunId === null) return;
    const stillPresent = liveRuns.runs.some((r) => r.id === selectedRunId);
    if (!stillPresent) setSelectedRunId(null);
  }, [selectedRunId, liveRuns.runs]);

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

  // Fleet Find: task name/branch locally, plus historical session ids (#88).
  // Task hits list above session hits; labels reuse the same session identity.
  const searchSessions = useCallback(
    async (query: string): Promise<RosterSearchHit[]> => {
      const q = query.trim().toLowerCase();
      if (q === "") return [];

      const identities = collectSessionIdentities(live.tasks);
      const taskHits: RosterSearchHit[] = [];
      for (const task of live.tasks) {
        const nameHit = task.name.toLowerCase().includes(q);
        const branchHit = (task.branch ?? "").toLowerCase().includes(q);
        if (!nameHit && !branchHit) continue;
        taskHits.push({
          kind: "task",
          taskId: task.id,
          sessionId: task.orchestratorSession,
          name: task.name,
          branch: task.branch,
        });
      }
      // Stable order for the combobox: name then id.
      taskHits.sort((a, b) => {
        if (a.kind !== "task" || b.kind !== "task") return 0;
        const byName = a.name.localeCompare(b.name);
        return byName !== 0 ? byName : a.taskId.localeCompare(b.taskId);
      });

      const { sessions } = await client.listSessions(query);
      const sessionHits: RosterSearchHit[] = sessions.map((s) => {
        const identity =
          identities.get(s.id) ??
          deriveSessionIdentity(s.id, []);
        // Prefer live count when the session is still in the fleet; else wire.
        const taskCount =
          identities.has(s.id) ? identity.count : s.task_count;
        const handle =
          identities.has(s.id) ? identity.handle : identity.shortRef;
        const shortRef = identity.shortRef;
        const label = identities.has(s.id)
          ? identity.label
          : `${shortRef} · ${formatTaskCount(taskCount)}`;
        return {
          kind: "session" as const,
          id: s.id,
          handle,
          shortRef,
          label,
          taskCount,
          lastActivityAt: s.last_activity_at,
        };
      });

      return [...taskHits, ...sessionHits];
    },
    [client, live.tasks],
  );

  const origin = typeof window !== "undefined" ? window.location : undefined;
  const healthView: HealthView = {
    status: health.status,
    online: health.online,
    version: health.version,
    pid: health.pid,
    host: origin?.hostname || "127.0.0.1",
    port: origin?.port || "—",
    uptime: deriveUptime(health.status, health.startedAt, now),
    // Daemon-side session count only — fleet totals/active live on the roster.
    durableSessions: live.durableSessions,
  };

  const daemonUptimeDays =
    health.startedAt !== null
      ? deriveVoyageDay(health.startedAt, now)
      : 1;
  const [firstSeenAt] = useState(() => readCoveFirstSeen(now));
  const day = deriveVoyageDay(firstSeenAt ?? health.startedAt ?? now, now);

  const roster: RosterSelection = {
    selectedSessionId,
    selectedTaskId,
    selectedRunId,
    selectSession,
    selectTask,
    selectRun,
    selectInboxTask,
    clearTask,
    searchSessions,
    inspectorIntent,
    sceneFrameIntent,
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
  // Coarse clock for run node ages — inspector re-projects at 30s, not 1s.
  const inspectorRunNow = now - (now % FRESHNESS_TICK_MS);
  const inspectorRun: InspectorRun | null = useInspectorRun(
    liveRuns.details,
    selectedRunId,
    inspectorRunNow,
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
    daemonUptimeDays,
    freshFailureTaskIds: fleetFreshFailureTaskIds,
    inspector,
    inspectorRun,
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
