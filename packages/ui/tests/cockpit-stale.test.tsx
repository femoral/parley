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
    ...overrides,
  };
}

describe("Cockpit stale-chart band", () => {
  it("hides the stale band when chartStale is false", () => {
    cockpitState.view = baseView({ chartStale: false });
    const { container } = render(<Cockpit />);
    expect(container.querySelector(".pc-cockpit--stale")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByText(/Chart may be stale/)).toBeNull();
  });

  it("shows the brass stale band and shell class when chartStale is true", () => {
    cockpitState.view = baseView({ chartStale: true });
    const { container } = render(<Cockpit />);
    const shell = container.querySelector(".pc-cockpit");
    expect(shell?.classList.contains("pc-cockpit--stale")).toBe(true);
    expect(shell?.getAttribute("data-stale")).toBe("true");

    const band = screen.getByRole("status");
    expect(band.classList.contains("pc-stale-band")).toBe(true);
    expect(band.textContent).toMatch(/Chart may be stale — reconnecting/);
    // Glyph carries state independently of colour — the authored stalled
    // mark (SVG via Mark), not a platform emoji.
    expect(band.querySelector(".pc-stale-band__glyph svg")).toBeTruthy();
  });

  it("removes the band when chartStale clears", () => {
    cockpitState.view = baseView({ chartStale: true });
    const { rerender, container } = render(<Cockpit />);
    expect(screen.getByRole("status")).toBeTruthy();

    cockpitState.view = baseView({ chartStale: false });
    rerender(<Cockpit />);
    expect(container.querySelector(".pc-cockpit--stale")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });
});
