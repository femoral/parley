/** @vitest-environment happy-dom */
/**
 * #253 — centre-stage swap matrix:
 *   run selected → chart
 *   task selected → scene
 *   nothing selected → scene
 *   Soundings toggle from each of the above
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { CockpitView } from "../src/app/hooks/useCockpit.js";
import type { InspectorRun } from "../src/hud/types.js";

const cockpitState = vi.hoisted(() => ({
  view: null as CockpitView | null,
  setMode: vi.fn(),
}));

vi.mock("../src/app/hooks/index.js", () => ({
  useCockpit: () => {
    if (!cockpitState.view) throw new Error("cockpitState.view not set");
    return cockpitState.view;
  },
  useCockpitKeys: () => {},
}));

// Scene pulls canvas / layout; stub to a marker so the swap is assertable.
vi.mock("../src/scene/index.js", () => ({
  Scene: () => <div data-testid="sailing-scene">scene</div>,
}));

import { Cockpit } from "../src/app/Cockpit.js";

afterEach(() => {
  cleanup();
  cockpitState.view = null;
  cockpitState.setMode.mockReset();
});

const readyRun: InspectorRun = {
  status: "ready",
  id: "r-swap01",
  workflow: "coding",
  workflowVersion: 1,
  runState: "running",
  stateLabel: "running",
  branch: null,
  currentNode: "implement",
  iteration: 1,
  duration: null,
  tasksTotal: 2,
  heldGate: false,
  deliverables: { status: "not_fetched" },
  block: null,
  nodes: [
    {
      key: "plan\u00001",
      node: "plan",
      kind: "step",
      iteration: 1,
      state: "completed",
      stateLabel: "completed",
      tasksLabel: "1",
      gist: "ok",
      age: "4m",
      fanoutWidth: null,
      spineState: "completed",
      live: false,
      onReject: null,
    },
    {
      key: "implement\u00001",
      node: "implement",
      kind: "step",
      iteration: 1,
      state: "running",
      stateLabel: "running",
      tasksLabel: "1",
      gist: "out",
      age: "1m",
      fanoutWidth: null,
      spineState: "running",
      live: true,
      onReject: null,
    },
  ],
};

function baseView(overrides: Partial<CockpitView> = {}): CockpitView {
  return {
    health: {
      online: true,
      version: "0.0.0",
      pid: 1,
      host: "127.0.0.1",
      port: "1",
      uptime: "1m",
      durableSessions: 0,
    },
    snapshot: {
      tasks: [],
      groups: [],
      sessions: [],
      inbox: [],
      scene: { sessions: [] },
      totalTasks: 0,
      activeTasks: 0,
      durableSessions: 0,
      connected: true,
      ready: true,
      streamLostSince: null,
    },
    roster: {
      selectedSessionId: null,
      selectedTaskId: null,
      selectedRunId: null,
      selectSession: () => {},
      selectTask: () => {},
      selectRun: () => {},
      selectInboxTask: () => {},
      clearTask: () => {},
      searchSessions: async () => [],
      inspectorIntent: { tab: "brief" as const, seq: 0 },
      sceneFrameIntent: null,
    },
    clock: "12:00",
    day: 1,
    daemonUptimeDays: 1,
    freshFailureTaskIds: [],
    inspector: null,
    inspectorRun: null,
    settings: {
      showKit: false,
      followLogs: true,
      shortcuts: true,
      toggleShowKit: () => {},
      toggleFollowLogs: () => {},
      toggleShortcuts: () => {},
    },
    chartStale: false,
    mode: "cove",
    setMode: cockpitState.setMode,
    toggleSoundings: () => {},
    soundings: {
      status: "loading",
      error: null,
      groups: [],
      distribution: [],
      comparison: [],
      heatmap: { criteria: [], groups: [], cells: [], sampleEvals: 0 },
      groupBy: "vendor",
      sessionLabel: "All hands",
      generatedAt: null,
      filters: {
        type: "",
        vendor: "",
        model: "",
        orch_harness: "",
        orch_model: "",
        eval_harness: "",
        eval_model: "",
        rubric: "",
        firstAttemptOnly: false,
        belowBaselineOnly: false,
        active: false,
      },
      viewTab: "groups",
      evalPresence: "loading",
    },
    setGroupBy: () => {},
    setSoundingsFilters: () => {},
    clearSoundingsFilters: () => {},
    setSoundingsViewTab: () => {},
    ...overrides,
  };
}

function withRoster(
  view: CockpitView,
  patch: Partial<CockpitView["roster"]>,
): CockpitView {
  return {
    ...view,
    roster: { ...view.roster, ...patch },
  };
}

describe("centre-stage swap matrix (#253)", () => {
  it("nothing selected → scene", () => {
    cockpitState.view = baseView();
    const { container } = render(<Cockpit />);
    expect(screen.getByTestId("sailing-scene")).toBeTruthy();
    expect(container.querySelector('[data-testid="run-chart"]')).toBeNull();
    expect(container.querySelector(".pc-soundings-stage")).toBeNull();
    expect(
      container.querySelector('.pc-region--center[aria-label="The cove"]'),
    ).toBeTruthy();
  });

  it("task selected → scene", () => {
    cockpitState.view = withRoster(baseView(), {
      selectedTaskId: "t-abc",
      selectedRunId: null,
    });
    const { container } = render(<Cockpit />);
    expect(screen.getByTestId("sailing-scene")).toBeTruthy();
    expect(container.querySelector('[data-testid="run-chart"]')).toBeNull();
  });

  it("run selected → chart", () => {
    cockpitState.view = withRoster(
      baseView({ inspectorRun: readyRun }),
      { selectedRunId: readyRun.id, selectedTaskId: null },
    );
    const { container } = render(<Cockpit />);
    expect(container.querySelector('[data-testid="run-chart"]')).toBeTruthy();
    expect(screen.queryByTestId("sailing-scene")).toBeNull();
    expect(
      container.querySelector('.pc-region--center[aria-label="Run chart"]'),
    ).toBeTruthy();
    // Marks from the projection render on paper.
    expect(container.querySelectorAll("[data-chart-mark]").length).toBe(2);
  });

  it("run selected but detail pending → chart with honest pending state", () => {
    cockpitState.view = withRoster(baseView({ inspectorRun: null }), {
      selectedRunId: "r-notyet",
      selectedTaskId: null,
    });
    const { container } = render(<Cockpit />);
    const chart = screen.getByTestId("run-chart");
    expect(chart).toBeTruthy();
    // Chart and inspector both hail while detail arrives — assert the chart's.
    expect(chart.querySelector(".pc-chart__empty-copy")?.textContent).toMatch(
      /Hailing the run/,
    );
    expect(chart.getAttribute("data-testid")).toBe("run-chart");
    expect(container.querySelector('[data-chart-status="pending"]')).toBeTruthy();
    // No invented node count on the chart.
    expect(chart.textContent).not.toMatch(/0 tasks/);
  });

  it("Soundings toggle switches away from the scene", () => {
    cockpitState.view = baseView({ mode: "cove" });
    const { rerender, container } = render(<Cockpit />);
    expect(screen.getByTestId("sailing-scene")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Soundings" }));
    expect(cockpitState.setMode).toHaveBeenCalledWith("soundings");

    cockpitState.view = baseView({ mode: "soundings" });
    rerender(<Cockpit />);
    expect(container.querySelector(".pc-soundings-stage")).toBeTruthy();
    expect(screen.queryByTestId("sailing-scene")).toBeNull();
    expect(container.querySelector('[data-testid="run-chart"]')).toBeNull();
  });

  it("Soundings toggle switches away from the run chart", () => {
    cockpitState.view = withRoster(
      baseView({ mode: "cove", inspectorRun: readyRun }),
      { selectedRunId: readyRun.id },
    );
    const { rerender, container } = render(<Cockpit />);
    expect(container.querySelector('[data-testid="run-chart"]')).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Soundings" }));
    expect(cockpitState.setMode).toHaveBeenCalledWith("soundings");

    // Selection is still the run; Soundings still wins the centre stage.
    cockpitState.view = withRoster(
      baseView({ mode: "soundings", inspectorRun: readyRun }),
      { selectedRunId: readyRun.id },
    );
    rerender(<Cockpit />);
    expect(container.querySelector(".pc-soundings-stage")).toBeTruthy();
    expect(container.querySelector('[data-testid="run-chart"]')).toBeNull();
  });

  it("returning from Soundings restores the chart when a run is still selected", () => {
    cockpitState.view = withRoster(
      baseView({ mode: "soundings", inspectorRun: readyRun }),
      { selectedRunId: readyRun.id },
    );
    const { rerender, container } = render(<Cockpit />);
    expect(container.querySelector(".pc-soundings-stage")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Cove" }));
    expect(cockpitState.setMode).toHaveBeenCalledWith("cove");

    cockpitState.view = withRoster(
      baseView({ mode: "cove", inspectorRun: readyRun }),
      { selectedRunId: readyRun.id },
    );
    rerender(<Cockpit />);
    expect(container.querySelector('[data-testid="run-chart"]')).toBeTruthy();
    expect(screen.queryByTestId("sailing-scene")).toBeNull();
  });

  it("returning from Soundings restores the scene when nothing / a task is selected", () => {
    cockpitState.view = withRoster(baseView({ mode: "soundings" }), {
      selectedTaskId: "t-1",
      selectedRunId: null,
    });
    const { rerender } = render(<Cockpit />);

    cockpitState.view = withRoster(baseView({ mode: "cove" }), {
      selectedTaskId: "t-1",
      selectedRunId: null,
    });
    rerender(<Cockpit />);
    expect(screen.getByTestId("sailing-scene")).toBeTruthy();
  });
});
