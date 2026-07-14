/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { RosterPanel } from "../src/hud/index.js";
import type { RosterGroup, RosterSessionOption } from "../src/hud/index.js";

afterEach(cleanup);

const GROUPS: RosterGroup[] = [
  {
    state: "awaiting_answer",
    tasks: [
      {
        id: "t1",
        name: "chart-the-bay",
        coat: "#10a37f",
        emblem: { kind: "svg", viewBox: "0 0 24 24", path: "M12 2 L20 7 V17 L12 22 L4 17 V7 Z" },
        meta: "feat/bay · t1",
      },
    ],
  },
  {
    state: "running",
    tasks: [
      {
        id: "t2",
        name: "sound-the-depths",
        coat: "#2b2b2e",
        emblem: { kind: "svg", viewBox: "0 0 24 24", path: "M5 4 L19 20 M19 4 L5 20" },
        meta: "feat/depth · t2",
      },
    ],
  },
  {
    state: "failed",
    tasks: [
      {
        id: "t3",
        name: "lost-at-sea",
        coat: "#8a6a34",
        emblem: { kind: "glyph", char: "⚐" },
        meta: "feat/lost · t3",
      },
    ],
  },
];

const SESSIONS: RosterSessionOption[] = [{ id: "sess-abc12345", label: "sess-abc1", count: 2 }];

function baseProps() {
  return {
    groups: GROUPS,
    sessions: SESSIONS,
    selectedSessionId: null,
    onSelectSession: vi.fn(),
    searchSessions: vi.fn(async () => []),
    selectedTaskId: null,
    onSelectTask: vi.fn(),
    totalTasks: 3,
    activeTasks: 2,
  };
}

describe("RosterPanel renders groups it is given, in attention order (#66)", () => {
  it("labels each non-empty group by its state's manifest label and lists its tasks", () => {
    render(<RosterPanel {...baseProps()} />);
    expect(screen.getByText("AWAITING")).toBeTruthy();
    expect(screen.getByText("RUNNING")).toBeTruthy();
    expect(screen.getByText("FAILED")).toBeTruthy();
    expect(screen.getByText("chart-the-bay")).toBeTruthy();
    expect(screen.getByText("sound-the-depths")).toBeTruthy();
    expect(screen.getByText("lost-at-sea")).toBeTruthy();
  });

  it("omits empty groups entirely", () => {
    render(<RosterPanel {...baseProps()} />);
    expect(screen.queryByText("STALLED")).toBeNull();
    expect(screen.queryByText("PENDING")).toBeNull();
    expect(screen.queryByText("COMPLETED")).toBeNull();
    expect(screen.queryByText("CANCELLED")).toBeNull();
  });

  it("shows the quiet-cove empty state with no groups", () => {
    render(<RosterPanel {...baseProps()} groups={[]} sessions={[]} totalTasks={0} activeTasks={0} />);
    expect(screen.getByText(/The cove is quiet/)).toBeTruthy();
  });
});

describe("RosterPanel row selection (#66)", () => {
  it("calls onSelectTask when a row is clicked", () => {
    const onSelectTask = vi.fn();
    render(<RosterPanel {...baseProps()} onSelectTask={onSelectTask} />);
    fireEvent.click(screen.getByText("chart-the-bay"));
    expect(onSelectTask).toHaveBeenCalledWith("t1");
  });

  it("marks the selected row pressed", () => {
    render(<RosterPanel {...baseProps()} selectedTaskId="t2" />);
    const row = screen.getByText("sound-the-depths").closest("button");
    expect(row?.getAttribute("aria-pressed")).toBe("true");
    const other = screen.getByText("chart-the-bay").closest("button");
    expect(other?.getAttribute("aria-pressed")).toBe("false");
  });

  it("renders rows as native buttons (keyboard/AT semantics for free)", () => {
    render(<RosterPanel {...baseProps()} />);
    const row = screen.getByText("chart-the-bay").closest("button")!;
    expect(row.tagName).toBe("BUTTON");
    expect(row.getAttribute("type")).toBe("button");
  });
});

describe("RosterPanel session selector (#66)", () => {
  it("renders a chip per distinct orchestrator session plus an all-sessions chip", () => {
    render(<RosterPanel {...baseProps()} />);
    expect(screen.getByRole("button", { name: /All hands/ })).toBeTruthy();
    expect(screen.getByText("sess-abc1")).toBeTruthy();
  });

  it("calls onSelectSession with the session id when a chip is clicked", () => {
    const onSelectSession = vi.fn();
    render(<RosterPanel {...baseProps()} onSelectSession={onSelectSession} />);
    fireEvent.click(screen.getByText("sess-abc1").closest("button")!);
    expect(onSelectSession).toHaveBeenCalledWith("sess-abc12345");
  });

  it("marks the active session pressed", () => {
    render(<RosterPanel {...baseProps()} selectedSessionId="sess-abc12345" />);
    expect(screen.getByRole("button", { name: /All hands/ }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByText("sess-abc1").closest("button")?.getAttribute("aria-pressed")).toBe("true");
  });

  it("renders no session strip when there are no sessions", () => {
    render(<RosterPanel {...baseProps()} sessions={[]} />);
    expect(screen.queryByRole("group", { name: "Orchestrator sessions" })).toBeNull();
  });

  it("labels the session strip as a group of buttons", () => {
    render(<RosterPanel {...baseProps()} />);
    expect(screen.getByRole("group", { name: "Orchestrator sessions" })).toBeTruthy();
  });

  it("opens session search and selects a hit like a chip click (#88)", async () => {
    const onSelectSession = vi.fn();
    const searchSessions = vi.fn(async () => [
      { id: "sess-old-history", label: "sess-old", taskCount: 3, lastActivityAt: "2020-01-01T00:00:00.000Z" },
    ]);
    render(
      <RosterPanel
        {...baseProps()}
        onSelectSession={onSelectSession}
        searchSessions={searchSessions}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Search sessions" }));
    const input = screen.getByLabelText("Session id");
    fireEvent.change(input, { target: { value: "old" } });
    // Debounced lookup — wait for the hit to appear.
    expect(await screen.findByText("sess-old")).toBeTruthy();
    expect(searchSessions).toHaveBeenCalledWith("old");
    fireEvent.click(screen.getByText("sess-old"));
    expect(onSelectSession).toHaveBeenCalledWith("sess-old-history");
  });
});

describe("RosterPanel state treatment (#66)", () => {
  it("carries the beacon flag on awaiting rows only", () => {
    render(<RosterPanel {...baseProps()} />);
    const awaitingRow = screen.getByText("chart-the-bay").closest("button")!;
    expect(awaitingRow.textContent).toContain("🚩");
    const runningRow = screen.getByText("sound-the-depths").closest("button")!;
    expect(runningRow.textContent).not.toContain("🚩");
  });

  it("dims terminal rows per the manifest's quiet-history treatment", () => {
    render(<RosterPanel {...baseProps()} />);
    const failedRow = screen.getByText("lost-at-sea").closest("button")!;
    expect(failedRow.style.opacity).toBe("0.62");
    const awaitingRow = screen.getByText("chart-the-bay").closest("button")!;
    expect(awaitingRow.style.opacity).toBe("");
  });
});
