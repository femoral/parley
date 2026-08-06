/**
 * Shell frame — chrome header, left/center/right content regions, footer.
 * Owns global navigation, find combobox, settings, accelerators, a11y skeleton.
 * Screen tickets mount into center (see screens/SCREENS.md).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ParleyClient } from "@useparley/core";
import { useHealth, useHonesty, useRuns, useSnapshot } from "./data/index.js";
import { attentionTaskIds, countNeedsOrch } from "./chrome/attention.js";
import { FindCombobox } from "./chrome/FindCombobox.js";
import { FooterLegend } from "./chrome/FooterLegend.js";
import { formatClock } from "./chrome/format.js";
import { Header } from "./chrome/Header.js";
import { SettingsSurface } from "./chrome/SettingsSurface.js";
import { SkipLinks } from "./chrome/SkipLinks.js";
import { loadSettings, saveSettings, type ConsoleSettings } from "./chrome/settings.js";
import { useAccelerators } from "./chrome/useAccelerators.js";
import { FleetScreen } from "./screens/fleet/FleetScreen.js";
import { MetricsScreen } from "./screens/metrics/MetricsScreen.js";
import { RunScreen } from "./screens/run/RunScreen.js";
import { TaskScreen } from "./screens/task/TaskScreen.js";
import {
  parseScreenHash,
  screenHash,
  type ScreenId,
  type ScreenMountProps,
} from "./screens/types.js";

function createClient(): ParleyClient {
  return new ParleyClient({ baseUrl: "" });
}

export function Shell() {
  const client = useMemo(createClient, []);
  const snapshot = useSnapshot(client);
  const health = useHealth(client);
  const runs = useRuns(client, { enabled: true });
  const honesty = useHonesty({
    ready: snapshot.ready,
    streamConnected: snapshot.connected,
    healthOnline: health.online,
    streamLostSince: snapshot.streamLostSince,
    taskCount: snapshot.totalTasks,
  });

  const [screen, setScreen] = useState<ScreenId>(() =>
    typeof window !== "undefined" ? parseScreenHash(window.location.hash) : "fleet",
  );
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [settings, setSettings] = useState<ConsoleSettings>(() => loadSettings());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [clock, setClock] = useState(() => formatClock());
  const [liveMessage, setLiveMessage] = useState("");
  const findRef = useRef<HTMLInputElement>(null);
  const prevAttention = useRef<number | null>(null);

  const attentionCount = useMemo(
    () => countNeedsOrch(snapshot.tasks, runs.summaries),
    [snapshot.tasks, runs.summaries],
  );

  // Hash ↔ screen
  useEffect(() => {
    const onHash = (): void => setScreen(parseScreenHash(window.location.hash));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const navigate = useCallback((next: ScreenId) => {
    setScreen(next);
    const hash = screenHash(next);
    if (window.location.hash !== hash) {
      window.location.hash = hash;
    }
  }, []);

  // Clock tick
  useEffect(() => {
    const id = window.setInterval(() => setClock(formatClock()), 1000);
    return () => window.clearInterval(id);
  }, []);

  // Document title badge + live region for attention changes
  useEffect(() => {
    const base = "Parley Console";
    document.title = attentionCount > 0 ? `(${attentionCount}) ${base}` : base;
    if (prevAttention.current !== null && prevAttention.current !== attentionCount) {
      setLiveMessage(
        attentionCount === 0
          ? "No items need the orchestrator"
          : `${attentionCount} need the orchestrator`,
      );
    }
    prevAttention.current = attentionCount;
  }, [attentionCount]);

  // Honesty live announcements
  useEffect(() => {
    if (honesty.phase === "offline") {
      setLiveMessage("Daemon offline");
    } else if (honesty.phase === "stale-reconnecting") {
      setLiveMessage("Reconnecting to daemon stream");
    }
  }, [honesty.phase]);

  const onSettingsChange = useCallback((next: ConsoleSettings) => {
    setSettings(next);
    saveSettings(next);
  }, []);

  const closeOverlays = useCallback(() => {
    setSettingsOpen(false);
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
      navigate("task");
    },
    [snapshot.tasks, selectedTaskId, navigate],
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

  const tabSubs = useMemo((): Record<ScreenId, string> => {
    const tasks = snapshot.totalTasks;
    const need = attentionCount;
    const runLabel = selectedRunId
      ? selectedRunId.slice(0, 8)
      : runs.summaries[0]
        ? `${runs.summaries[0].workflow} · ${runs.summaries[0].run_id.slice(0, 8)}`
        : "no run";
    const taskLabel = selectedTaskId
      ? selectedTaskId
      : snapshot.tasks[0]
        ? snapshot.tasks[0]!.task_id
        : "no task";
    return {
      fleet: `${tasks} tasks · ${need} need action`,
      run: runLabel,
      task: taskLabel,
      metrics: honesty.phase === "live" || honesty.phase === "empty" ? "all hands" : honesty.phase,
    };
  }, [
    snapshot.totalTasks,
    snapshot.tasks,
    attentionCount,
    selectedRunId,
    selectedTaskId,
    runs.summaries,
    honesty.phase,
  ]);

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

  const footerNote = `state = what a task IS · ${attentionCount} need orch · ${honesty.phase}`;

  return (
    <div className="pc-shell" data-testid="shell" data-screen={screen}>
      <SkipLinks />

      <div className="pc-sr-only" aria-live="polite" aria-atomic="true" data-testid="live-region">
        {liveMessage}
      </div>

      <Header
        screen={screen}
        onNavigate={navigate}
        health={health}
        honesty={honesty}
        snapshot={snapshot}
        attentionCount={attentionCount}
        clock={clock}
        tabSubs={tabSubs}
        onOpenSettings={() => setSettingsOpen(true)}
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
              onSelectTask={(id) => {
                setSelectedTaskId(id);
                navigate("task");
              }}
              onSelectSession={(_id) => {
                // Session scope is a fleet-screen concern; land on fleet for now.
                navigate("fleet");
              }}
            />
          </div>
          <div className="pc-shell__rail-slot" data-testid="rail-left-slot">
            <span className="pc-shell__rail-slot-label">navigator</span>
            <span className="pc-shell__rail-slot-note">
              Scope, state filter, and list navigation land with each screen ticket.
            </span>
          </div>
        </aside>

        <main className="pc-shell__center" data-testid="shell-center" tabIndex={-1}>
          <div
            id="main-content"
            role="tabpanel"
            aria-labelledby={`pc-tab-${screen}`}
            className="pc-shell__tabpanel"
          >
            <Screen {...mountProps} />
          </div>
        </main>

        <aside
          className="pc-shell__rail pc-shell__rail--right"
          aria-label="Attention rail"
          data-testid="rail-right"
        >
          <div className="pc-shell__rail-slot" data-testid="rail-right-slot">
            <span className="pc-shell__rail-slot-label">attention · firehose</span>
            <span className="pc-shell__rail-slot-note">
              Attention queue and event firehose land with the fleet ticket.
            </span>
          </div>
        </aside>
      </div>

      <FooterLegend note={footerNote} />

      <SettingsSurface
        open={settingsOpen}
        settings={settings}
        onChange={onSettingsChange}
        onClose={closeOverlays}
      />
    </div>
  );
}
