/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { CockpitView } from "../src/app/hooks/useCockpit.js";

const cockpitState = vi.hoisted(() => ({
  view: null as CockpitView | null,
}));

vi.mock("../src/app/hooks/index.js", () => ({
  useCockpit: () => {
    if (!cockpitState.view) throw new Error("cockpitState.view not set");
    return cockpitState.view;
  },
  // Keyboard accelerators are exercised in cockpit-keys.test.tsx; inert here.
  useCockpitKeys: () => {},
}));

// Scene pulls its own CSS / floating layers — keep the import real but we only
// assert on the shell band + stale class, not island geometry.
import { Cockpit } from "../src/app/Cockpit.js";

afterEach(() => {
  cleanup();
  cockpitState.view = null;
});

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
    executors: [
      {
        id: "local",
        label: "local",
        kind: "daemon",
        status: "online",
        vendors: [],
        inFlight: 0,
        lastSeen: null,
      },
    ],
    executorsConnecting: false,
    executorsStale: false,
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
    setMode: () => {},
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

describe("Cockpit stale-chart band", () => {
  it("hides the stale band when chartStale is false", () => {
    cockpitState.view = baseView({ chartStale: false });
    const { container } = render(<Cockpit />);
    expect(container.querySelector(".pc-cockpit--stale")).toBeNull();
    expect(container.querySelector(".pc-stale-band")).toBeNull();
    expect(screen.queryByText(/Chart may be stale/)).toBeNull();
  });

  it("shows the brass stale band and shell class when chartStale is true", () => {
    cockpitState.view = baseView({ chartStale: true });
    const { container } = render(<Cockpit />);
    const shell = container.querySelector(".pc-cockpit");
    expect(shell?.classList.contains("pc-cockpit--stale")).toBe(true);
    expect(shell?.getAttribute("data-stale")).toBe("true");

    // The health chip is also role="status", so target the band by class.
    const band = container.querySelector(".pc-stale-band")!;
    expect(band).toBeTruthy();
    expect(band.textContent).toMatch(/Chart may be stale — reconnecting/);
    // Glyph carries state independently of colour — the authored stalled
    // mark (SVG via Mark), not a platform emoji.
    expect(band.querySelector(".pc-stale-band__glyph svg")).toBeTruthy();
  });

  it("removes the band when chartStale clears", () => {
    cockpitState.view = baseView({ chartStale: true });
    const { rerender, container } = render(<Cockpit />);
    expect(container.querySelector(".pc-stale-band")).toBeTruthy();

    cockpitState.view = baseView({ chartStale: false });
    rerender(<Cockpit />);
    expect(container.querySelector(".pc-cockpit--stale")).toBeNull();
    expect(container.querySelector(".pc-stale-band")).toBeNull();
  });
});
