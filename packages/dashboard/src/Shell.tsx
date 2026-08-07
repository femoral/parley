/**
 * Shell frame — chrome header, left/center/right content regions, footer.
 * Owns global navigation, find combobox, settings, accelerators, a11y skeleton.
 * Screen tickets mount into center (see screens/SCREENS.md).
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ParleyClient } from "@useparley/core";
import {
  ConsoleDataProvider,
  useHealth,
  useHonesty,
  usePolling,
  useRuns,
  useSnapshot,
} from "./data/index.js";
import { attentionTaskIds, countNeedsOrch } from "./chrome/attention.js";
import { FindCombobox } from "./chrome/FindCombobox.js";
import { FooterLegend } from "./chrome/FooterLegend.js";
import { formatClock } from "./chrome/format.js";
import { buildTabSubs, Header } from "./chrome/Header.js";
import {
  LeftRail,
  type StateFilterKey,
} from "./chrome/LeftRail.js";
import { RightRail } from "./chrome/RightRail.js";
import { SettingsSurface } from "./chrome/SettingsSurface.js";
import { SkipLinks } from "./chrome/SkipLinks.js";
import { loadSettings, saveSettings, type ConsoleSettings } from "./chrome/settings.js";
import { useAccelerators } from "./chrome/useAccelerators.js";
import { countNeedVerb } from "./chrome/plural.js";
import { FleetScreen } from "./screens/fleet/FleetScreen.js";
import { MetricsScreen } from "./screens/metrics/MetricsScreen.js";
import { RunScreen } from "./screens/run/RunScreen.js";
import { TaskScreen } from "./screens/task/TaskScreen.js";
import {
  parseScreenRoute,
  screenHash,
  type ScreenId,
  type ScreenMountProps,
} from "./screens/types.js";
import type { HonestyPhase } from "./data/types.js";
// Shared component styles once for the whole console (#367).
import "./components/components.css";

/** Sole app construction site for ParleyClient (#367). */
function createClient(): ParleyClient {
  return new ParleyClient({ baseUrl: "" });
}

/**
 * Announce into a polite live region with a clear→set pulse so identical
 * messages re-fire on repeated outages.
 */
function useLiveAnnouncer() {
  const [liveMessage, setLiveMessage] = useState("");
  const pulse = useRef(0);
  const announce = useCallback((msg: string) => {
    // Clear first so SR re-reads even when text matches the prior announcement.
    setLiveMessage("");
    pulse.current += 1;
    const token = pulse.current % 2 === 0 ? "\u200b" : "";
    window.setTimeout(() => setLiveMessage(`${msg}${token}`), 40);
  }, []);
  return { liveMessage, announce };
}

function initialRoute(): { screen: ScreenId; taskId: string | null; runId: string | null } {
  if (typeof window === "undefined") {
    return { screen: "fleet", taskId: null, runId: null };
  }
  const route = parseScreenRoute(window.location.hash);
  return {
    screen: route.screen,
    taskId: route.screen === "task" ? route.entityId : null,
    runId: route.screen === "run" ? route.entityId : null,
  };
}

export function Shell() {
  const client = useMemo(createClient, []);
  const boot = useMemo(initialRoute, []);
  const [screen, setScreen] = useState<ScreenId>(() => boot.screen);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(() => boot.taskId);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(() => boot.runId);
  const [settings, setSettings] = useState<ConsoleSettings>(() => loadSettings());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [clock, setClock] = useState(() => formatClock());
  const [sessionId, setSessionId] = useState("all");
  const [stateFilter, setStateFilter] = useState<StateFilterKey>("all");
  const { liveMessage, announce } = useLiveAnnouncer();
  const findRef = useRef<HTMLInputElement>(null);
  const settingsBtnRef = useRef<HTMLButtonElement>(null);
  const mainRef = useRef<HTMLDivElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const prevAttention = useRef<number | null>(null);
  const prevPhase = useRef<HonestyPhase | null>(null);
  const everLive = useRef(false);

  // One snapshot, one /runs poll cadence, one SSE stream — screens consume via context.
  const snapshot = useSnapshot(client);
  const health = useHealth(client);
  const runs = useRuns(client, { enabled: true, selectedRunId });
  const honesty = useHonesty({
    ready: snapshot.ready,
    streamConnected: snapshot.connected,
    healthOnline: health.online,
    streamLostSince: snapshot.streamLostSince,
    taskCount: snapshot.totalTasks,
  });

  const consoleData = useMemo(
    () => ({ client, snapshot, health, runs }),
    [client, snapshot, health, runs],
  );

  const attentionCount = useMemo(
    () => countNeedsOrch(snapshot.tasks, runs.summaries),
    [snapshot.tasks, runs.summaries],
  );

  // Hash ↔ screen + entity id (deep links for task/run).
  useEffect(() => {
    const onHash = (): void => {
      const route = parseScreenRoute(window.location.hash);
      setScreen(route.screen);
      if (route.screen === "task" && route.entityId) {
        setSelectedTaskId(route.entityId);
      } else if (route.screen === "run" && route.entityId) {
        setSelectedRunId(route.entityId);
      }
      // Unknown/missing entity ids leave selection as-is when the hash has no id
      // (degrades to prior screen-only behavior).
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const navigate = useCallback(
    (next: ScreenId, entityId?: string | null) => {
      setScreen(next);
      let id: string | null | undefined = entityId;
      if (id === undefined) {
        if (next === "task") id = selectedTaskId;
        else if (next === "run") id = selectedRunId;
        else id = null;
      }
      const hash = screenHash(next, id);
      if (window.location.hash !== hash) {
        window.location.hash = hash;
      }
    },
    [selectedTaskId, selectedRunId],
  );

  // Modal settings: inert siblings so zero tab stops are reachable behind.
  // useLayoutEffect so inert is removed before SettingsSurface's useEffect
  // cleanup restores focus to the trigger (child useEffect cleanups run after
  // parent layout effects when open flips false).
  useLayoutEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;
    const kids = Array.from(shell.children) as HTMLElement[];
    for (const el of kids) {
      if (el.dataset.testid === "settings-surface") continue;
      if (settingsOpen) el.setAttribute("inert", "");
      else el.removeAttribute("inert");
    }
    return () => {
      for (const el of kids) el.removeAttribute("inert");
    };
  }, [settingsOpen]);

  // Clock tick — visibility-gated so hidden tabs do not keep timers hot.
  usePolling(
    useCallback(() => {
      setClock(formatClock());
    }, []),
    { intervalMs: 1000 },
  );

  // Document title badge + live region for attention changes
  useEffect(() => {
    const base = "Parley Console";
    document.title = attentionCount > 0 ? `(${attentionCount}) ${base}` : base;
    if (prevAttention.current !== null && prevAttention.current !== attentionCount) {
      announce(
        attentionCount === 0
          ? "No items need the orchestrator"
          : countNeedVerb(attentionCount, "the orchestrator"),
      );
    }
    prevAttention.current = attentionCount;
  }, [attentionCount, announce]);

  // Honesty live announcements — both directions; skip bootstrap offline flash.
  useEffect(() => {
    const phase = honesty.phase;
    const prev = prevPhase.current;
    const isLiveish = phase === "live" || phase === "empty";

    if (isLiveish) {
      if (!everLive.current) {
        // First successful live — do not announce bootstrap offline→live.
        everLive.current = true;
        prevPhase.current = phase;
        return;
      }
      if (prev === "offline" || prev === "stale-reconnecting") {
        announce("Connection restored");
      }
      prevPhase.current = phase;
      return;
    }

    // Degradation: only after we have been live at least once.
    if (everLive.current) {
      if (phase === "offline" && prev !== "offline") {
        announce("Daemon offline");
      } else if (phase === "stale-reconnecting" && prev !== "stale-reconnecting") {
        announce("Reconnecting to daemon stream");
      }
    }
    prevPhase.current = phase;
  }, [honesty.phase, announce]);

  const onSettingsChange = useCallback((next: ConsoleSettings) => {
    setSettings(next);
    saveSettings(next);
  }, []);

  const closeOverlays = useCallback(() => {
    setSettingsOpen(false);
  }, []);

  const focusMain = useCallback(() => {
    mainRef.current?.focus();
  }, []);

  const cycleAttention = useCallback(
    (dir: 1 | -1) => {
      const ids = attentionTaskIds(snapshot.tasks);
      if (ids.length === 0) return;
      const cur = selectedTaskId ? ids.indexOf(selectedTaskId) : -1;
      let next = cur + dir;
      if (next < 0) next = ids.length - 1;
      if (next >= ids.length) next = 0;
      const id = ids[next]!;
      setSelectedTaskId(id);
      navigate("task", id);
    },
    [snapshot.tasks, selectedTaskId, navigate],
  );

  const selectTask = useCallback(
    (id: string) => {
      setSelectedTaskId(id);
      navigate("task", id);
    },
    [navigate],
  );

  const selectRun = useCallback(
    (id: string) => {
      setSelectedRunId(id);
      navigate("run", id);
    },
    [navigate],
  );

  const accelHandlers = useMemo(
    () => ({
      focusFind: () => {
        findRef.current?.focus();
        findRef.current?.select();
      },
      cycleAttention,
      navigate,
      openSettings: () => setSettingsOpen(true),
      closeOverlays,
      settingsOpen,
    }),
    [cycleAttention, navigate, closeOverlays, settingsOpen],
  );

  useAccelerators(settings, accelHandlers, findRef);

  const tabSubs = useMemo(
    () =>
      buildTabSubs({
        totalTasks: snapshot.totalTasks,
        attentionCount,
        selectedRunId,
        selectedTaskId,
        firstRunLabel: runs.summaries[0]
          ? `${runs.summaries[0].workflow} · ${runs.summaries[0].run_id.slice(0, 8)}`
          : null,
        firstTaskId: snapshot.tasks[0]?.task_id ?? null,
        honestyPhase: honesty.phase,
      }),
    [
      snapshot.totalTasks,
      snapshot.tasks,
      attentionCount,
      selectedRunId,
      selectedTaskId,
      runs.summaries,
      honesty.phase,
    ],
  );

  const mountProps: ScreenMountProps = {
    screen,
    navigate,
    selectedTaskId,
    setSelectedTaskId,
    selectedRunId,
    setSelectedRunId,
  };

  const Screen =
    screen === "run"
      ? RunScreen
      : screen === "task"
        ? TaskScreen
        : screen === "metrics"
          ? MetricsScreen
          : FleetScreen;

  // Footer doctrine (mock: "state = what a task IS · quality = how good work WAS · N unacked").
  // Full form ≥1460; compact form at 1280 floor keeps the state-vs-quality lesson visible.
  const footerNote = `state = what a task IS · quality = how good work WAS · ${attentionCount} unacked events · ${honesty.phase}`;
  const footerNoteCompact = `state=IS · quality=WAS · ${attentionCount} unacked · ${honesty.phase}`;

  return (
    <ConsoleDataProvider value={consoleData}>
      <div ref={shellRef} className="pc-shell" data-testid="shell" data-screen={screen}>
        <SkipLinks />

        <div className="pc-sr-only" aria-live="polite" aria-atomic="true" data-testid="live-region">
          {liveMessage}
        </div>

        <Header
          ref={settingsBtnRef}
          screen={screen}
          onNavigate={navigate}
          health={health}
          honesty={honesty}
          snapshot={snapshot}
          attentionCount={attentionCount}
          clock={clock}
          tabSubs={tabSubs}
          onOpenSettings={() => setSettingsOpen(true)}
          settingsOpen={settingsOpen}
        />

        <div className="pc-shell__body" data-testid="shell-body">
          <aside
            className="pc-shell__rail pc-shell__rail--left"
            aria-label="Left rail"
            data-testid="rail-left"
          >
            <div className="pc-shell__find-wrap" id="find-input-target">
              <FindCombobox
                client={client}
                tasks={snapshot.tasks}
                inputRef={findRef}
                focusAfterSelect={focusMain}
                onSelectTask={selectTask}
                onSelectSession={(_id) => {
                  navigate("fleet");
                }}
              />
            </div>
            <LeftRail
              sessionId={sessionId}
              onSessionChange={setSessionId}
              stateFilter={stateFilter}
              onStateFilterChange={setStateFilter}
            />
          </aside>

          {/*
            <main> is the landmark; tabpanel+id+tabIndex live on an inner div so
            axe aria-allowed-role is clean (role=tabpanel is not valid on <main>).
            Skip-to-main targets #main-content (the focusable tabpanel).
          */}
          <main className="pc-shell__center" data-testid="shell-center">
            <div
              ref={mainRef}
              id="main-content"
              className="pc-shell__tabpanel"
              role="tabpanel"
              tabIndex={-1}
              aria-labelledby={`pc-tab-${screen}`}
            >
              <Screen {...mountProps} />
            </div>
          </main>

          <aside
            className="pc-shell__rail pc-shell__rail--right"
            aria-label="Attention rail"
            data-testid="rail-right"
          >
            <RightRail
              sessionId={sessionId}
              stateFilter={stateFilter}
              selectedTaskId={selectedTaskId}
              selectedRunId={selectedRunId}
              onSelectTask={selectTask}
              onSelectRun={selectRun}
            />
          </aside>
        </div>

        <FooterLegend note={footerNote} noteCompact={footerNoteCompact} />

        <SettingsSurface
          open={settingsOpen}
          settings={settings}
          onChange={onSettingsChange}
          onClose={closeOverlays}
          returnFocusRef={settingsBtnRef}
        />
      </div>
    </ConsoleDataProvider>
  );
}
