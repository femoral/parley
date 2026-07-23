/** @vitest-environment happy-dom */
import { useRef, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ChartKey, RosterPanel } from "../src/hud/index.js";
import type { RosterGroup, RosterSearchHandle, RosterSessionOption } from "../src/hud/index.js";
import { notifyHandRolledPopoverClosed } from "../src/hud/handRolledPopover.js";
import {
  awaitingTaskIds,
  nextAwaitingId,
  useCockpitKeys,
} from "../src/app/hooks/useCockpitKeys.js";

afterEach(() => {
  cleanup();
  notifyHandRolledPopoverClosed("chart-key");
  notifyHandRolledPopoverClosed("session-find");
});

const GROUPS: RosterGroup[] = [
  {
    state: "awaiting_answer",
    tasks: [
      {
        id: "t1",
        name: "chart-the-bay",
        coat: "#10a37f",
        emblem: { kind: "glyph", char: "π" },
        faction: "Codex",
        meta: "feat/bay · t1",
      },
      {
        id: "t2",
        name: "sound-the-depths",
        coat: "#2b2b2e",
        emblem: { kind: "glyph", char: "×" },
        faction: "Grok",
        meta: "feat/depth · t2",
      },
    ],
  },
  {
    state: "running",
    tasks: [
      {
        id: "t3",
        name: "keep-sailing",
        coat: "#8a6a34",
        emblem: { kind: "glyph", char: "⚐" },
        faction: "Unaligned",
        meta: "feat/run · t3",
      },
    ],
  },
];

const INBOX = [{ id: "t1" }, { id: "t2" }];

const SESSIONS: RosterSessionOption[] = [
  {
    id: "sess-abc12345",
    handle: "chart-the-bay",
    shortRef: "sess-abc",
    label: "chart-the-bay · 2 tasks",
    count: 2,
  },
];

describe("awaitingTaskIds / nextAwaitingId pure helpers", () => {
  it("pulls ids from the fleet-wide inbox projection in its stable order", () => {
    expect(awaitingTaskIds(INBOX)).toEqual(["t1", "t2"]);
  });

  it("cycles to the next awaiting id, wrapping around", () => {
    expect(nextAwaitingId(["t1", "t2"], null)).toBe("t1");
    expect(nextAwaitingId(["t1", "t2"], "t1")).toBe("t2");
    expect(nextAwaitingId(["t1", "t2"], "t2")).toBe("t1");
    expect(nextAwaitingId(["t1", "t2"], "other")).toBe("t1");
    expect(nextAwaitingId([], "t1")).toBeNull();
  });
});

/**
 * Harness: real RosterPanel + useCockpitKeys, so `/` opens Find and guards
 * against typing-in-search can be asserted against a real input.
 */
function KeysHarness({
  groups = GROUPS,
  inbox = INBOX,
  selectedSessionId = null as string | null,
  initialTaskId = null as string | null,
  onToggleSoundings,
  onSelectTask,
  withChartKey = false,
}: {
  groups?: RosterGroup[];
  inbox?: readonly { id: string }[];
  selectedSessionId?: string | null;
  initialTaskId?: string | null;
  onToggleSoundings?: () => void;
  onSelectTask?: (id: string, options?: { tab?: string }) => void;
  /** Mount ChartKey so hand-rolled popover Esc can be tested against selection. */
  withChartKey?: boolean;
}) {
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(initialTaskId);
  const rosterRef = useRef<RosterSearchHandle | null>(null);
  const selectTask = (id: string, options?: { tab?: string }) => {
    setSelectedTaskId(id);
    onSelectTask?.(id, options);
  };
  useCockpitKeys({
    rosterRef,
    inbox,
    selectedTaskId,
    selectTask,
    clearTask: () => setSelectedTaskId(null),
    toggleSoundings: onToggleSoundings,
  });
  return (
    <div>
      <span data-testid="selected">{selectedTaskId ?? "none"}</span>
      {withChartKey ? <ChartKey /> : null}
      <RosterPanel
        groups={groups}
        sessions={SESSIONS}
        selectedSessionId={selectedSessionId}
        onSelectSession={() => {}}
        searchSessions={async () => []}
        selectedTaskId={selectedTaskId}
        onSelectTask={setSelectedTaskId}
        totalTasks={3}
        activeTasks={3}
        searchRef={rosterRef}
      />
    </div>
  );
}

describe("useCockpitKeys window keydown accelerators", () => {
  it("n selects the next awaiting_answer task, cycling", () => {
    render(<KeysHarness />);
    expect(screen.getByTestId("selected").textContent).toBe("none");

    act(() => {
      fireEvent.keyDown(window, { key: "n" });
    });
    expect(screen.getByTestId("selected").textContent).toBe("t1");

    act(() => {
      fireEvent.keyDown(window, { key: "n" });
    });
    expect(screen.getByTestId("selected").textContent).toBe("t2");

    act(() => {
      fireEvent.keyDown(window, { key: "n" });
    });
    expect(screen.getByTestId("selected").textContent).toBe("t1");
  });

  it("n reaches an inbox flag outside the active session-filtered roster", () => {
    const filteredGroups: RosterGroup[] = [
      {
        state: "running",
        tasks: GROUPS[1]!.tasks,
      },
    ];
    render(
      <KeysHarness
        groups={filteredGroups}
        inbox={[{ id: "flag-in-other-session" }]}
        selectedSessionId="sess-abc12345"
      />,
    );

    act(() => {
      fireEvent.keyDown(window, { key: "n" });
    });

    expect(screen.getByTestId("selected").textContent).toBe("flag-in-other-session");
  });

  it("n lands the inspector on Q&A (passes { tab: 'qa' })", () => {
    const calls: Array<{ id: string; options?: { tab?: string } }> = [];
    render(
      <KeysHarness
        onSelectTask={(id, options) => {
          calls.push({ id, options });
        }}
      />,
    );

    act(() => {
      fireEvent.keyDown(window, { key: "n" });
    });
    expect(screen.getByTestId("selected").textContent).toBe("t1");
    expect(calls).toEqual([{ id: "t1", options: { tab: "qa" } }]);

    act(() => {
      fireEvent.keyDown(window, { key: "n" });
    });
    expect(calls[1]).toEqual({ id: "t2", options: { tab: "qa" } });
  });

  it("Escape clears the task selection when no popover is open", () => {
    render(<KeysHarness initialTaskId="t1" />);
    expect(screen.getByTestId("selected").textContent).toBe("t1");

    act(() => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    expect(screen.getByTestId("selected").textContent).toBe("none");
  });

  it("m toggles Soundings when toggleSoundings is provided", () => {
    let toggles = 0;
    render(<KeysHarness onToggleSoundings={() => { toggles += 1; }} />);

    act(() => {
      fireEvent.keyDown(window, { key: "m" });
    });
    expect(toggles).toBe(1);

    act(() => {
      fireEvent.keyDown(window, { key: "M" });
    });
    expect(toggles).toBe(2);
  });

  it("/ opens the session search and focuses the Find input", () => {
    render(<KeysHarness />);
    expect(screen.queryByLabelText("Find tasks or sessions")).toBeNull();

    act(() => {
      fireEvent.keyDown(window, { key: "/" });
    });
    const input = screen.getByLabelText("Find tasks or sessions") as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(document.activeElement).toBe(input);
  });

  it("ignores accelerators while typing in the search input", () => {
    render(<KeysHarness />);

    act(() => {
      fireEvent.keyDown(window, { key: "/" });
    });
    const input = screen.getByLabelText("Find tasks or sessions");
    expect(document.activeElement).toBe(input);

    // Typing "n" into the search field must not cycle tasks.
    act(() => {
      fireEvent.keyDown(input, { key: "n" });
    });
    expect(screen.getByTestId("selected").textContent).toBe("none");

    // Escape while search is open closes search, does not clear selection
    // (and there is none to clear — assert selection stays none after open).
    act(() => {
      fireEvent.keyDown(input, { key: "Escape" });
    });
    // SessionSearch listens on document; fire there too to mirror real events.
    act(() => {
      fireEvent.keyDown(document, { key: "Escape" });
    });
    expect(screen.queryByLabelText("Find tasks or sessions")).toBeNull();
    expect(screen.getByTestId("selected").textContent).toBe("none");
  });

  it("ignores accelerators when a modifier is held", () => {
    render(<KeysHarness />);
    act(() => {
      fireEvent.keyDown(window, { key: "n", ctrlKey: true });
      fireEvent.keyDown(window, { key: "n", metaKey: true });
      fireEvent.keyDown(window, { key: "n", altKey: true });
      fireEvent.keyDown(window, { key: "/", ctrlKey: true });
    });
    expect(screen.getByTestId("selected").textContent).toBe("none");
    expect(screen.queryByLabelText("Find tasks or sessions")).toBeNull();
  });

  it("n is a no-op when there are no awaiting tasks", () => {
    const onlyRunning: RosterGroup[] = [
      {
        state: "running",
        tasks: [
          {
            id: "t3",
            name: "keep-sailing",
            coat: "#8a6a34",
            emblem: { kind: "glyph", char: "⚐" },
            faction: "Unaligned",
            meta: "feat/run · t3",
          },
        ],
      },
    ];
    render(<KeysHarness groups={onlyRunning} inbox={[]} />);
    act(() => {
      fireEvent.keyDown(window, { key: "n" });
    });
    expect(screen.getByTestId("selected").textContent).toBe("none");
  });

  it("Escape clears selection once the last hand-rolled popover closes", () => {
    render(<KeysHarness initialTaskId="t1" />);
    expect(screen.getByTestId("selected").textContent).toBe("t1");

    // Open Find — Esc should close it, not clear the task.
    act(() => {
      fireEvent.keyDown(window, { key: "/" });
    });
    expect(screen.getByLabelText("Find tasks or sessions")).toBeTruthy();
    act(() => {
      fireEvent.keyDown(document, { key: "Escape" });
    });
    expect(screen.queryByLabelText("Find tasks or sessions")).toBeNull();
    expect(screen.getByTestId("selected").textContent).toBe("t1");

    // With no popover open, Esc clears the selection.
    act(() => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    expect(screen.getByTestId("selected").textContent).toBe("none");
  });

  it("click inside open ChartKey then Esc closes popover and keeps task selection", () => {
    // Regression: bus used to clear openPopover on any document mousedown,
    // so a click inside Chart key + Esc also cleared the inspector selection.
    render(<KeysHarness initialTaskId="t1" withChartKey />);
    expect(screen.getByTestId("selected").textContent).toBe("t1");

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /Chart key/ }));
    });
    const panel = screen.getByRole("region", { name: "Chart key" });
    expect(panel).toBeTruthy();

    act(() => {
      fireEvent.pointerDown(panel);
      fireEvent.mouseDown(panel);
    });
    // Still open after an inside click.
    expect(screen.getByRole("region", { name: "Chart key" })).toBeTruthy();

    // Esc closes Chart key only — selection must survive (useCockpitKeys
    // sees isAnyHandRolledPopoverOpen and returns early). One event bubbles
    // document → window so the WeakSet dismissal mark is shared.
    act(() => {
      fireEvent.keyDown(document, { key: "Escape" });
    });
    expect(screen.queryByRole("region", { name: "Chart key" })).toBeNull();
    expect(screen.getByTestId("selected").textContent).toBe("t1");

    // Second Esc (no popover) clears selection as usual.
    act(() => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    expect(screen.getByTestId("selected").textContent).toBe("none");
  });
});
