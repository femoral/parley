/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { RosterPanel } from "../src/hud/index.js";
import type { RosterGroup, RosterSessionOption } from "../src/hud/index.js";
import { Inspector } from "../src/hud/Inspector/index.js";
import type { InspectorRun } from "../src/hud/types.js";

afterEach(cleanup);

const SESSIONS: RosterSessionOption[] = [];

const GROUPS: RosterGroup[] = [
  {
    state: "awaiting_answer",
    runs: [
      {
        id: "r-a19c0001",
        name: "coding-2",
        attentionState: "awaiting_answer",
        runState: "blocked",
        subtitle: "rework-or-finish — held",
        meta: "pass 1 · 3 tasks · 6m",
        heldGate: true,
        pips: [
          { kind: "done" },
          { kind: "done" },
          { kind: "done" },
          { kind: "gate" },
        ],
        updatedAt: "2026-07-01T00:06:00.000Z",
        orchestratorSession: "sess-1",
      },
    ],
    tasks: [
      {
        id: "t-plain-await",
        name: "migrate the seed script",
        coat: "#d1784c",
        emblem: { kind: "glyph", char: "✳" },
        faction: "Claude",
        meta: "parley/t41 · t-plain-",
        updatedAt: "2026-07-01T00:05:00.000Z",
      },
    ],
  },
  {
    state: "running",
    runs: [
      {
        id: "r-7f3a0001",
        name: "coding-1",
        attentionState: "running",
        runState: "running",
        subtitle: "review — 1 of 3",
        meta: "pass 2 · 6 tasks · 11m",
        heldGate: false,
        pips: [
          { kind: "done" },
          { kind: "done" },
          { kind: "done" },
          { kind: "live" },
          { kind: "empty" },
        ],
        updatedAt: "2026-07-01T00:11:00.000Z",
        orchestratorSession: "sess-1",
      },
    ],
    tasks: [
      {
        id: "t-owned",
        name: "review the branch",
        coat: "#59616f",
        emblem: { kind: "glyph", char: "✦" },
        faction: "Grok",
        meta: "feat/review · t-owned",
        runChip: "r-7f3a00 · review.2.tests",
      },
      {
        id: "t-plain",
        name: "bump deps",
        coat: "#18a886",
        emblem: { kind: "glyph", char: "◈" },
        faction: "Codex",
        meta: "parley/t44 · t-plain",
      },
    ],
  },
];

function baseProps() {
  return {
    groups: GROUPS,
    sessions: SESSIONS,
    selectedSessionId: null,
    onSelectSession: vi.fn(),
    searchSessions: vi.fn(async () => []),
    selectedTaskId: null as string | null,
    onSelectTask: vi.fn(),
    selectedRunId: null as string | null,
    onSelectRun: vi.fn(),
    totalTasks: 3,
    activeTasks: 3,
  };
}

describe("RosterPanel run rows (#254)", () => {
  it("renders run peers in their attention groups beside tasks", () => {
    render(<RosterPanel {...baseProps()} />);
    expect(screen.getByRole("option", { name: /coding-2/i })).toBeTruthy();
    expect(screen.getByRole("option", { name: /coding-1/i })).toBeTruthy();
    expect(screen.getByRole("option", { name: /migrate the seed script/i })).toBeTruthy();
    expect(screen.getByRole("option", { name: /review the branch/i })).toBeTruthy();
    expect(screen.getByRole("option", { name: /bump deps/i })).toBeTruthy();
    // Group counts include runs + tasks (awaiting 2, running 3).
    expect(screen.getByRole("group", { name: /AWAITING \(2\)/i })).toBeTruthy();
    expect(screen.getByRole("group", { name: /RUNNING \(3\)/i })).toBeTruthy();
  });

  it("shows a run chip on run-owned tasks and none on plain tasks", () => {
    render(<RosterPanel {...baseProps()} />);
    expect(screen.getByText("r-7f3a00 · review.2.tests")).toBeTruthy();
    // Plain task keeps branch · id meta, not a run chip.
    expect(screen.getByText(/parley\/t44/)).toBeTruthy();
  });

  it("renders a static pip track on the run row", () => {
    const { container } = render(<RosterPanel {...baseProps()} />);
    const tracks = container.querySelectorAll(".pc-roster__pips");
    expect(tracks.length).toBe(2);
    const firstPips = tracks[0]!.querySelectorAll(".pc-roster__pip");
    expect(firstPips.length).toBe(4);
    expect(tracks[1]!.querySelectorAll(".pc-roster__pip").length).toBe(5);
  });

  it("selecting a run calls onSelectRun, not onSelectTask", () => {
    const props = baseProps();
    render(<RosterPanel {...props} />);
    fireEvent.click(screen.getByRole("option", { name: /coding-1/i }));
    expect(props.onSelectRun).toHaveBeenCalledWith("r-7f3a0001");
    expect(props.onSelectTask).not.toHaveBeenCalled();
  });

  it("marks the selected run row", () => {
    render(<RosterPanel {...baseProps()} selectedRunId="r-7f3a0001" />);
    const row = screen.getByRole("option", { name: /coding-1/i });
    expect(row.getAttribute("aria-selected")).toBe("true");
  });
});

describe("Inspector run view (#254)", () => {
  const run: InspectorRun = {
    id: "r-c04e0001",
    workflow: "research",
    workflowVersion: 1,
    runState: "blocked",
    stateLabel: "blocked · gate",
    branch: "parley/r-c04e-research",
    currentNode: "accept-sources",
    iteration: 1,
    duration: "21m 0s",
    tasksTotal: 32,
    heldGate: true,
    block: {
      reason: "gate",
      detail: "held",
      node: "accept-sources",
    },
    nodes: [
      {
        key: "scope\u00001",
        node: "scope",
        kind: "step",
        iteration: 1,
        state: "completed",
        stateLabel: "completed",
        tasksLabel: "1",
        gist: "12 queries",
        age: "18m",
        fanoutWidth: null,
        spineState: "completed",
        live: false,
        onReject: null,
      },
      {
        key: "search\u00001",
        node: "search",
        kind: "step",
        iteration: 1,
        state: "completed",
        stateLabel: "completed",
        tasksLabel: "12",
        gist: "sources 84",
        age: "14m",
        fanoutWidth: 12,
        spineState: "completed",
        live: false,
        onReject: null,
      },
      {
        key: "accept\u00001",
        node: "accept-sources",
        kind: "gate",
        iteration: 1,
        state: "waiting",
        stateLabel: "gate · held",
        tasksLabel: "—",
        gist: "Proceed to adversarial review?",
        age: "21m",
        fanoutWidth: null,
        spineState: "awaiting_answer",
        live: true,
        onReject: "funnel",
      },
    ],
  };

  it("renders one table row per (node, iteration) with polymorphic STATE", () => {
    render(<Inspector task={null} run={run} />);
    expect(screen.getByText("scope")).toBeTruthy();
    expect(screen.getByText("search")).toBeTruthy();
    expect(screen.getByText("accept-sources")).toBeTruthy();
    expect(screen.getAllByText("completed").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("gate · held")).toBeTruthy();
    expect(screen.getByText(/×12/)).toBeTruthy();
    expect(screen.getByText(/Held — awaiting the orchestrator/i)).toBeTruthy();
    // One body row per (node, iteration).
    expect(document.querySelectorAll(".pc-runview__table tbody tr")).toHaveLength(3);
    // No gate action controls.
    expect(screen.queryByRole("button", { name: /approve/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /reject/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /redirect/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /finish/i })).toBeNull();
  });
});
