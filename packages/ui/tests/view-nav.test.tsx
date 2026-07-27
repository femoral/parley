/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { CockpitView } from "../src/app/hooks/useCockpit.js";

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

import { Cockpit } from "../src/app/Cockpit.js";

afterEach(() => {
  cleanup();
  cockpitState.view = null;
  cockpitState.setMode.mockReset();
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

describe("Cockpit view nav (#126)", () => {
  it("centres the Cove/Soundings toggle in the footer strip", () => {
    cockpitState.view = baseView();
    const { container } = render(<Cockpit />);
    const nav = screen.getByRole("navigation", { name: "Cockpit views" });
    expect(nav.classList.contains("pc-footer-nav")).toBe(true);
    // The footer is a 1fr auto 1fr grid so the toggle stays optically centred
    // however wide the chart-key and settings groups grow — it is not engraved
    // on the cartouche, so the centre head must not contain it.
    const footer = container.querySelector(".pc-settings-row");
    expect(footer?.contains(nav)).toBe(true);
    expect(container.querySelector(".pc-center__head")?.contains(nav)).toBe(false);
  });

  it("keeps active state and click handling on the toggle buttons", () => {
    cockpitState.view = baseView({ mode: "cove" });
    render(<Cockpit />);
    const cove = screen.getByRole("button", { name: "Cove" });
    const soundings = screen.getByRole("button", { name: "Soundings" });
    expect(cove.classList.contains("pc-footer-nav__tab--active")).toBe(true);
    expect(cove.getAttribute("aria-pressed")).toBe("true");
    expect(soundings.classList.contains("pc-footer-nav__tab--active")).toBe(false);
    expect(soundings.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(soundings);
    expect(cockpitState.setMode).toHaveBeenCalledWith("soundings");
  });

  it("renders the compass rose only in Cove mode", () => {
    cockpitState.view = baseView({ mode: "cove" });
    const { container, rerender } = render(<Cockpit />);
    expect(container.querySelector(".pc-compass")).toBeTruthy();

    cockpitState.view = baseView({ mode: "soundings" });
    rerender(<Cockpit />);
    expect(container.querySelector(".pc-compass")).toBeNull();
  });
});

describe("Cockpit skip links (island tab-stop wall)", () => {
  it("offers Skip to status stack targeting the right rail after Skip to cockpit", () => {
    cockpitState.view = baseView();
    render(<Cockpit />);

    const skipCockpit = screen.getByRole("link", { name: "Skip to cockpit" });
    expect(skipCockpit.getAttribute("href")).toBe("#pc-main");
    expect(document.getElementById("pc-main")).toBeTruthy();

    const skipStatus = screen.getByRole("link", { name: "Skip to status stack" });
    expect(skipStatus.getAttribute("href")).toBe("#pc-status-stack");

    const statusStack = document.getElementById("pc-status-stack");
    expect(statusStack).toBeTruthy();
    expect(statusStack?.getAttribute("aria-label")).toBe("Status stack");
    // Focusable skip target so activating the link lands keyboard focus.
    expect(statusStack?.getAttribute("tabindex")).toBe("-1");

    // Status-stack skip comes after the main skip in tab order.
    const links = screen.getAllByRole("link");
    const cockpitIdx = links.indexOf(skipCockpit);
    const statusIdx = links.indexOf(skipStatus);
    expect(cockpitIdx).toBeGreaterThanOrEqual(0);
    expect(statusIdx).toBe(cockpitIdx + 1);
  });
});
