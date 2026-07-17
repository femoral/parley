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
      toggleOrnaments: () => {},
      toggleShowKit: () => {},
      toggleFollowLogs: () => {},
    },
    chartStale: false,
    mode: "cove",
    setMode: cockpitState.setMode,
    toggleSoundings: () => {},
    soundings: {
      status: "loading",
      error: null,
      groups: [],
      groupBy: "vendor",
      sessionLabel: "All hands",
      generatedAt: null,
    },
    setGroupBy: () => {},
    ...overrides,
  };
}

describe("Cockpit view nav framed by Plate (#126)", () => {
  it("wraps the Cove/Soundings toggle in a standard Plate", () => {
    cockpitState.view = baseView();
    const { container } = render(<Cockpit />);
    const nav = screen.getByRole("navigation", { name: "Cockpit views" });
    expect(nav.classList.contains("pc-view-nav")).toBe(true);
    const plate = nav.closest(".pc-plate");
    expect(plate).toBeTruthy();
    // Standard variant — no premium/ember/cartouche/report modifier.
    expect(plate?.className).toBe("pc-plate");
    // Sits in the centre head with Cartouche + DayChip plates.
    expect(container.querySelector(".pc-center__head")?.contains(plate)).toBe(true);
  });

  it("keeps active state and click handling on the tabs", () => {
    cockpitState.view = baseView({ mode: "cove" });
    render(<Cockpit />);
    const cove = screen.getByRole("button", { name: "Cove" });
    const soundings = screen.getByRole("button", { name: "Soundings" });
    expect(cove.classList.contains("pc-view-nav__tab--active")).toBe(true);
    expect(cove.getAttribute("aria-current")).toBe("page");
    expect(soundings.classList.contains("pc-view-nav__tab--active")).toBe(false);
    expect(soundings.getAttribute("aria-current")).toBeNull();

    fireEvent.click(soundings);
    expect(cockpitState.setMode).toHaveBeenCalledWith("soundings");
  });
});
