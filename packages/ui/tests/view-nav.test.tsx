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
      selectSession: () => {},
      selectTask: () => {},
      clearTask: () => {},
      searchSessions: async () => [],
    },
    clock: "12:00",
    day: 1,
    inspector: null,
    settings: {
      ornaments: false,
      showKit: false,
      followLogs: true,
      shortcuts: true,
      toggleOrnaments: () => {},
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

describe("Cockpit view nav framed by Plate (#126)", () => {
  it("engraves the Cove/Soundings toggle onto the cartouche plate", () => {
    cockpitState.view = baseView();
    const { container } = render(<Cockpit />);
    const nav = screen.getByRole("navigation", { name: "Cockpit views" });
    expect(nav.classList.contains("pc-view-nav")).toBe(true);
    expect(nav.classList.contains("pc-view-nav--cartouche")).toBe(true);
    // No standalone plate of its own — it overlays the cartouche's plate via
    // the title stack (the nav is positioned on the title plate's bottom edge).
    const stack = nav.closest(".pc-center__title-stack");
    expect(stack).toBeTruthy();
    expect(stack?.querySelector(".pc-plate--cartouche")).toBeTruthy();
    // Sits in the centre head with the Cartouche + DayChip.
    expect(container.querySelector(".pc-center__head")?.contains(nav)).toBe(true);
  });

  it("keeps active state and click handling on the toggle buttons", () => {
    cockpitState.view = baseView({ mode: "cove" });
    render(<Cockpit />);
    const cove = screen.getByRole("button", { name: "Cove" });
    const soundings = screen.getByRole("button", { name: "Soundings" });
    expect(cove.classList.contains("pc-view-nav__tab--active")).toBe(true);
    expect(cove.getAttribute("aria-pressed")).toBe("true");
    expect(soundings.classList.contains("pc-view-nav__tab--active")).toBe(false);
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
