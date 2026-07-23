/** @vitest-environment happy-dom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { delegateScaffold, RosterPanel } from "../src/hud/index.js";
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
        faction: "Codex",
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
        faction: "Grok",
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
        faction: "Unaligned",
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

  it("labels each row emblem with its faction/vendor name", () => {
    render(<RosterPanel {...baseProps()} />);
    expect(screen.getByLabelText("Codex")).toBeTruthy();
    expect(screen.getByLabelText("Grok")).toBeTruthy();
    expect(screen.getByLabelText("Unaligned")).toBeTruthy();
  });

  it("omits empty groups entirely", () => {
    render(<RosterPanel {...baseProps()} />);
    expect(screen.queryByText("STALLED")).toBeNull();
    expect(screen.queryByText("PENDING")).toBeNull();
    expect(screen.queryByText("COMPLETED")).toBeNull();
    expect(screen.queryByText("CANCELLED")).toBeNull();
  });

  it("owns fleet counts in the footer (Total tasks / Active)", () => {
    const { container } = render(<RosterPanel {...baseProps()} />);
    expect(screen.getByText("Total tasks")).toBeTruthy();
    expect(screen.getByText("Active")).toBeTruthy();
    // baseProps totalTasks=3, activeTasks=2 — assert values on the footer stats only
    // (group counts and session chips also render small numerals).
    const footer = container.querySelector(".pc-roster__footer");
    expect(footer?.textContent).toMatch(/3\s*Total tasks/);
    expect(footer?.textContent).toMatch(/2\s*Active/);
  });

  it("shows the quiet-cove empty state with no groups", () => {
    render(<RosterPanel {...baseProps()} groups={[]} sessions={[]} totalTasks={0} activeTasks={0} />);
    expect(screen.getByText(/The cove is quiet/)).toBeTruthy();
    expect(screen.queryByText(/Taking soundings/)).toBeNull();
  });

  it("offers a copyable parley delegate starter in the empty state", () => {
    const { container } = render(
      <RosterPanel {...baseProps()} groups={[]} sessions={[]} totalTasks={0} activeTasks={0} />,
    );
    expect(screen.getByText(/The cove is quiet/)).toBeTruthy();
    expect(screen.getByText(/Cast off from your shell/)).toBeTruthy();
    const snippet = container.querySelector(".pc-roster__empty-snippet");
    expect(snippet?.textContent).toBe(delegateScaffold());
    expect(snippet?.textContent).toBe('parley delegate -n <name> "<goal>"');
    expect(screen.getByRole("button", { name: /Copy delegate command/i })).toBeTruthy();
  });

  it("shows taking-soundings copy before the first snapshot (connecting)", () => {
    render(
      <RosterPanel
        {...baseProps()}
        groups={[]}
        sessions={[]}
        totalTasks={0}
        activeTasks={0}
        connecting
      />,
    );
    expect(screen.getByText(/Taking soundings/)).toBeTruthy();
    expect(screen.getByText(/listening for the fleet/)).toBeTruthy();
    expect(screen.queryByText(/The cove is quiet/)).toBeNull();
    expect(screen.queryByRole("button", { name: /Copy delegate command/i })).toBeNull();
  });
});

describe("RosterPanel empty-state copy delegate scaffold", () => {
  const writeText = vi.fn(async () => undefined);

  beforeEach(() => {
    writeText.mockClear();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
  });

  it("copies a parley delegate scaffold and shows confirmation text", async () => {
    render(<RosterPanel {...baseProps()} groups={[]} sessions={[]} totalTasks={0} activeTasks={0} />);
    const copyBtn = screen.getByRole("button", { name: /Copy delegate command/i });
    fireEvent.click(copyBtn);
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('parley delegate -n <name> "<goal>"');
    });
    expect(screen.getByText("copied ✓")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Copied delegate command/i })).toBeTruthy();
  });
});

describe("RosterPanel row selection (#66)", () => {
  it("calls onSelectTask when a row is clicked", () => {
    const onSelectTask = vi.fn();
    render(<RosterPanel {...baseProps()} onSelectTask={onSelectTask} />);
    fireEvent.click(screen.getByText("chart-the-bay"));
    expect(onSelectTask).toHaveBeenCalledWith("t1");
  });

  it("marks the selected row with aria-selected", () => {
    render(<RosterPanel {...baseProps()} selectedTaskId="t2" />);
    const row = screen.getByRole("option", { name: "sound-the-depths — RUNNING" });
    expect(row.getAttribute("aria-selected")).toBe("true");
    const other = screen.getByRole("option", { name: "chart-the-bay — AWAITING" });
    expect(other.getAttribute("aria-selected")).toBe("false");
  });

  it("renders the task list as a listbox of options (roving tabindex)", () => {
    render(<RosterPanel {...baseProps()} />);
    expect(screen.getByRole("listbox", { name: "Fleet tasks" })).toBeTruthy();
    const row = screen.getByRole("option", { name: "chart-the-bay — AWAITING" });
    expect(row.getAttribute("role")).toBe("option");
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

  it("still renders All hands + Find when there are no recent session chips", () => {
    // Find must stay available for historical lookup (#88) and the `/` key.
    render(<RosterPanel {...baseProps()} sessions={[]} />);
    expect(screen.getByRole("group", { name: "Orchestrator sessions" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /All hands/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Search sessions" })).toBeTruthy();
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

  it("exposes search hits as a plain list of buttons, not a listbox", async () => {
    const searchSessions = vi.fn(async () => [
      { id: "sess-old-history", label: "sess-old", taskCount: 3, lastActivityAt: "2020-01-01T00:00:00.000Z" },
    ]);
    render(<RosterPanel {...baseProps()} searchSessions={searchSessions} />);
    fireEvent.click(screen.getByRole("button", { name: "Search sessions" }));
    const input = screen.getByLabelText("Session id");
    expect(input.getAttribute("aria-autocomplete")).toBeNull();
    fireEvent.change(input, { target: { value: "old" } });
    expect(await screen.findByText("sess-old")).toBeTruthy();

    const results = screen.getByRole("list", { name: "Matching sessions" });
    expect(results).toBeTruthy();
    // Search hits stay a plain list; the fleet task listbox is a sibling surface.
    expect(results.getAttribute("role")).toBe("list");
    expect(results.querySelector("[role='option']")).toBeNull();
    expect(results.querySelector("[role='listbox']")).toBeNull();

    const hit = screen.getByRole("button", { name: /sess-old/ });
    expect(hit.getAttribute("aria-selected")).toBeNull();
    expect(hit.closest("[role='listitem']")).toBeTruthy();
    // Results region remains a meaningful aria-controls target.
    expect(input.getAttribute("aria-controls")).toBe(results.getAttribute("id"));
  });
});

describe("RosterPanel state treatment (#66)", () => {
  it("carries the beacon mark on awaiting rows only", () => {
    render(<RosterPanel {...baseProps()} />);
    const awaitingRow = screen.getByRole("option", { name: "chart-the-bay — AWAITING" });
    expect(awaitingRow.querySelector(".pc-roster__beacon svg")).toBeTruthy();
    const runningRow = screen.getByRole("option", { name: "sound-the-depths — RUNNING" });
    expect(runningRow.querySelector(".pc-roster__beacon")).toBeNull();
  });

  it("applies archive quiet class (not opacity) on terminal rows", () => {
    render(<RosterPanel {...baseProps()} />);
    const failedRow = screen.getByRole("option", { name: "lost-at-sea — FAILED" }) as HTMLElement;
    expect(failedRow.classList.contains("pc-roster__row--quiet-archive")).toBe(true);
    expect(failedRow.style.opacity).toBe("");
    const awaitingRow = screen.getByRole("option", { name: "chart-the-bay — AWAITING" }) as HTMLElement;
    expect(awaitingRow.classList.contains("pc-roster__row--quiet-archive")).toBe(false);
    expect(awaitingRow.classList.contains("pc-roster__row--quiet-soft")).toBe(false);
  });

  it("renders a fresh failure loud (no quiet class) with a coral beacon", () => {
    const groups: RosterGroup[] = [
      {
        state: "failed",
        tasks: [
          {
            id: "t-fresh",
            name: "fresh-wreck",
            coat: "#8a6a34",
            emblem: { kind: "glyph", char: "✖" },
            faction: "Unaligned",
            meta: "feat/x · t-fresh",
            freshFailure: true,
          },
        ],
      },
    ];
    render(<RosterPanel {...baseProps()} groups={groups} totalTasks={1} activeTasks={0} />);
    const row = screen.getByRole("option", { name: "fresh-wreck — FAILED" }) as HTMLElement;
    expect(row.classList.contains("pc-roster__row--quiet-archive")).toBe(false);
    expect(row.style.opacity).toBe("");
    const beacon = row.querySelector(".pc-roster__beacon") as HTMLElement;
    expect(beacon).toBeTruthy();
    expect(beacon.style.getPropertyValue("--beacon-color")).toBe("var(--state-failed)");
  });
});

describe("RosterPanel selected-row task id copy", () => {
  const writeText = vi.fn(async () => undefined);

  beforeEach(() => {
    writeText.mockClear();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
  });

  it("shows a copy affordance only on the selected row (meta itself, not a side button)", () => {
    const { rerender } = render(<RosterPanel {...baseProps()} selectedTaskId={null} />);
    expect(screen.queryByRole("button", { name: /Copy task id/i })).toBeNull();
    rerender(<RosterPanel {...baseProps()} selectedTaskId="t2" />);
    const copyBtn = screen.getByRole("button", { name: /Copy task id/i });
    expect(copyBtn).toBeTruthy();
    // Meta line is the control — keeps full width so the id does not shrink.
    expect(copyBtn.classList.contains("pc-roster__meta")).toBe(true);
    expect(copyBtn.classList.contains("pc-roster__meta--copy")).toBe(true);
    // Only one copy control — not one per row.
    expect(screen.getAllByRole("button", { name: /Copy task id/i })).toHaveLength(1);
    // Visible meta text still present (not replaced by a bare "id" chip).
    expect(copyBtn.textContent).toMatch(/feat\/depth · t2/);
  });

  it("does not mount a separate id-copy wrap that would compete with meta ellipsis", () => {
    const { container } = render(<RosterPanel {...baseProps()} selectedTaskId="t1" />);
    expect(container.querySelector(".pc-roster__id-copy-wrap")).toBeNull();
    expect(container.querySelector(".pc-roster__id-copy")).toBeNull();
  });

  it("copies the full task id and shows confirmation", async () => {
    render(<RosterPanel {...baseProps()} selectedTaskId="t1" />);
    fireEvent.click(screen.getByRole("button", { name: /Copy task id/i }));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("t1");
    });
    expect(screen.getByText("copied ✓")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Copied task id/i })).toBeTruthy();
  });
});

describe("RosterPanel row accessible names include state", () => {
  it("composes each row's accessible name as name — state label", () => {
    render(<RosterPanel {...baseProps()} />);
    // Group headers are non-focusable; state must live on the option.
    expect(screen.getByRole("option", { name: "chart-the-bay — AWAITING" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "sound-the-depths — RUNNING" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "lost-at-sea — FAILED" })).toBeTruthy();
  });

  it("keeps the visible row name text unchanged", () => {
    render(<RosterPanel {...baseProps()} />);
    expect(screen.getByText("chart-the-bay")).toBeTruthy();
    expect(screen.getByText("lost-at-sea")).toBeTruthy();
  });
});

describe("RosterPanel listbox keyboard (roving tabindex)", () => {
  it("keeps a single tab stop among task rows", () => {
    render(<RosterPanel {...baseProps()} />);
    const options = screen.getAllByRole("option");
    const tabStops = options.filter((el) => el.getAttribute("tabindex") === "0");
    expect(tabStops).toHaveLength(1);
    // Default focus lands on the first row when nothing is selected.
    expect(tabStops[0]!.getAttribute("aria-label")).toBe("chart-the-bay — AWAITING");
    for (const el of options) {
      if (el !== tabStops[0]) expect(el.getAttribute("tabindex")).toBe("-1");
    }
  });

  it("lands the tab stop on the selected task when provided", () => {
    render(<RosterPanel {...baseProps()} selectedTaskId="t2" />);
    const focused = screen.getByRole("option", { name: "sound-the-depths — RUNNING" });
    expect(focused.getAttribute("tabindex")).toBe("0");
  });

  it("moves focus with ArrowDown / ArrowUp and wraps", () => {
    render(<RosterPanel {...baseProps()} />);
    const listbox = screen.getByRole("listbox", { name: "Fleet tasks" });
    const first = screen.getByRole("option", { name: "chart-the-bay — AWAITING" });
    first.focus();
    fireEvent.keyDown(listbox, { key: "ArrowDown" });
    expect(
      screen.getByRole("option", { name: "sound-the-depths — RUNNING" }).getAttribute("tabindex"),
    ).toBe("0");
    fireEvent.keyDown(listbox, { key: "ArrowDown" });
    expect(
      screen.getByRole("option", { name: "lost-at-sea — FAILED" }).getAttribute("tabindex"),
    ).toBe("0");
    fireEvent.keyDown(listbox, { key: "ArrowDown" });
    expect(first.getAttribute("tabindex")).toBe("0");
    fireEvent.keyDown(listbox, { key: "ArrowUp" });
    expect(
      screen.getByRole("option", { name: "lost-at-sea — FAILED" }).getAttribute("tabindex"),
    ).toBe("0");
  });

  it("jumps with Home / End", () => {
    render(<RosterPanel {...baseProps()} selectedTaskId="t2" />);
    const listbox = screen.getByRole("listbox", { name: "Fleet tasks" });
    fireEvent.keyDown(listbox, { key: "End" });
    expect(
      screen.getByRole("option", { name: "lost-at-sea — FAILED" }).getAttribute("tabindex"),
    ).toBe("0");
    fireEvent.keyDown(listbox, { key: "Home" });
    expect(
      screen.getByRole("option", { name: "chart-the-bay — AWAITING" }).getAttribute("tabindex"),
    ).toBe("0");
  });

  it("selects the focused row with Enter and Space", () => {
    const onSelectTask = vi.fn();
    render(<RosterPanel {...baseProps()} onSelectTask={onSelectTask} />);
    const listbox = screen.getByRole("listbox", { name: "Fleet tasks" });
    // Move to second row, then select.
    fireEvent.keyDown(listbox, { key: "ArrowDown" });
    fireEvent.keyDown(listbox, { key: "Enter" });
    expect(onSelectTask).toHaveBeenCalledWith("t2");
    fireEvent.keyDown(listbox, { key: " " });
    expect(onSelectTask).toHaveBeenLastCalledWith("t2");
  });

  it("leaves group headers out of the option set", () => {
    render(<RosterPanel {...baseProps()} />);
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(3);
    // Group labels remain visible but are not options.
    expect(screen.getByText("AWAITING")).toBeTruthy();
    expect(screen.getByText("AWAITING").closest("[role='option']")).toBeNull();
  });
});
