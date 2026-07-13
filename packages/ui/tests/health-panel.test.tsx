/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { HealthPanel, RosterPanel } from "../src/hud/index.js";
import type { HealthView, RosterGroup } from "../src/hud/index.js";

afterEach(cleanup);

const HEALTH: HealthView = {
  online: true,
  version: "0.0.0",
  pid: 4242,
  host: "127.0.0.1",
  port: "57123",
  uptime: "3m 41s",
  activeAgents: 2,
  totalTasks: 5,
  durableSessions: 1,
};

describe("HealthPanel renders daemon status from plain props (#65)", () => {
  it("shows status, version, pid, uptime, and task counts", () => {
    render(<HealthPanel health={HEALTH} />);
    expect(screen.getByText("HEALTHY")).toBeTruthy();
    expect(screen.getByText("v0.0.0")).toBeTruthy();
    expect(screen.getByText("4242")).toBeTruthy();
    expect(screen.getByText("3m 41s")).toBeTruthy();
    expect(screen.getByText("57123")).toBeTruthy();
    // Total tasks (5) and active/total (2 / 5) both surface.
    expect(screen.getByText("5")).toBeTruthy();
    expect(screen.getByText("2 / 5")).toBeTruthy();
  });

  it("reads OFFLINE when the daemon is unreachable", () => {
    render(<HealthPanel health={{ ...HEALTH, online: false }} />);
    expect(screen.getByText("OFFLINE")).toBeTruthy();
  });
});

describe("RosterPanel renders the groups it is given, in order", () => {
  const groups: RosterGroup[] = [
    {
      state: "awaiting_answer",
      tasks: [{ id: "t1", name: "chart-the-bay", coat: "#2f5fb0", emblem: "⚓", meta: "feat/bay · t1" }],
    },
    {
      state: "running",
      tasks: [{ id: "t2", name: "sound-the-depths", coat: "#c0392b", emblem: "⚔", meta: "feat/depth · t2" }],
    },
  ];

  it("labels each group by its state's manifest label and lists its tasks", () => {
    render(<RosterPanel groups={groups} totalTasks={2} activeTasks={2} />);
    expect(screen.getByText("AWAITING")).toBeTruthy();
    expect(screen.getByText("RUNNING")).toBeTruthy();
    expect(screen.getByText("chart-the-bay")).toBeTruthy();
    expect(screen.getByText("sound-the-depths")).toBeTruthy();
  });

  it("shows the quiet-cove empty state with no groups", () => {
    render(<RosterPanel groups={[]} totalTasks={0} activeTasks={0} />);
    expect(screen.getByText(/The cove is quiet/)).toBeTruthy();
  });
});
