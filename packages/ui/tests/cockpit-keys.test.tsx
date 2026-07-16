/** @vitest-environment happy-dom */
import { useRef, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { RosterPanel } from "../src/hud/index.js";
import type { RosterGroup, RosterSearchHandle, RosterSessionOption } from "../src/hud/index.js";
import {
  awaitingTaskIds,
  nextAwaitingId,
  useCockpitKeys,
} from "../src/app/hooks/useCockpitKeys.js";

afterEach(cleanup);

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

const SESSIONS: RosterSessionOption[] = [{ id: "sess-abc12345", label: "sess-abc1", count: 2 }];

describe("awaitingTaskIds / nextAwaitingId pure helpers", () => {
  it("pulls ids only from the awaiting_answer group in roster order", () => {
    expect(awaitingTaskIds(GROUPS)).toEqual(["t1", "t2"]);
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
  initialTaskId = null as string | null,
  onToggleSoundings,
}: {
  groups?: RosterGroup[];
  initialTaskId?: string | null;
  onToggleSoundings?: () => void;
}) {
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(initialTaskId);
  const rosterRef = useRef<RosterSearchHandle | null>(null);
  useCockpitKeys({
    rosterRef,
    groups,
    selectedTaskId,
    selectTask: setSelectedTaskId,
    clearTask: () => setSelectedTaskId(null),
    toggleSoundings: onToggleSoundings,
  });
  return (
    <div>
      <span data-testid="selected">{selectedTaskId ?? "none"}</span>
      <RosterPanel
        groups={groups}
        sessions={SESSIONS}
        selectedSessionId={null}
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
    expect(screen.queryByLabelText("Session id")).toBeNull();

    act(() => {
      fireEvent.keyDown(window, { key: "/" });
    });
    const input = screen.getByLabelText("Session id") as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(document.activeElement).toBe(input);
  });

  it("ignores accelerators while typing in the search input", () => {
    render(<KeysHarness />);

    act(() => {
      fireEvent.keyDown(window, { key: "/" });
    });
    const input = screen.getByLabelText("Session id");
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
    expect(screen.queryByLabelText("Session id")).toBeNull();
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
    expect(screen.queryByLabelText("Session id")).toBeNull();
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
    render(<KeysHarness groups={onlyRunning} />);
    act(() => {
      fireEvent.keyDown(window, { key: "n" });
    });
    expect(screen.getByTestId("selected").textContent).toBe("none");
  });
});

