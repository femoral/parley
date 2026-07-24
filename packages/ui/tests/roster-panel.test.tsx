/** @vitest-environment happy-dom */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { delegateScaffold, RosterPanel } from "../src/hud/index.js";
import type { RosterGroup, RosterSessionOption } from "../src/hud/index.js";

afterEach(cleanup);

// Vitest workspace cwd is the monorepo root; package-local runs use packages/ui.
// import.meta.url is not file: in happy-dom, so resolve from cwd.
const HUD_CSS = readFileSync(
  resolve(
    process.cwd(),
    process.cwd().endsWith("packages/ui") ? "src/hud/hud.css" : "packages/ui/src/hud/hud.css",
  ),
  "utf8",
);

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

const SESSIONS: RosterSessionOption[] = [
  {
    id: "sess-abc12345",
    handle: "chart-the-bay",
    shortRef: "sess-abc",
    label: "chart-the-bay · 2 tasks",
    count: 2,
  },
];

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
    expect(screen.getByRole("option", { name: /chart-the-bay/ })).toBeTruthy();
    expect(screen.getByRole("option", { name: /sound-the-depths/ })).toBeTruthy();
    expect(screen.getByRole("option", { name: /lost-at-sea/ })).toBeTruthy();
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
    expect(screen.queryByText(/Hailing the fleet/)).toBeNull();
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

  it("shows hailing copy before the first snapshot (connecting)", () => {
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
    expect(screen.getByText(/Hailing the fleet/)).toBeTruthy();
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
    fireEvent.click(screen.getByRole("option", { name: /chart-the-bay/ }));
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
    const { container } = render(<RosterPanel {...baseProps()} />);
    expect(screen.getByRole("button", { name: /All hands/ })).toBeTruthy();
    // Humane handle + mono short ref + unit count.
    expect(container.querySelector(".pc-roster__session-handle")?.textContent).toBe("chart-the-bay");
    expect(container.querySelector(".pc-roster__session-ref")?.textContent).toBe("sess-abc");
    expect(container.querySelector(".pc-roster__session-count")?.textContent).toBe("2 tasks");
  });

  it("session chip leads with human handle and keeps short ref secondary", () => {
    const { container } = render(<RosterPanel {...baseProps()} />);
    const chip = container.querySelector(".pc-roster__session-handle")?.closest("button");
    expect(chip).toBeTruthy();
    expect(chip?.querySelector(".pc-roster__session-handle")?.textContent).toBe("chart-the-bay");
    expect(chip?.querySelector(".pc-roster__session-ref")?.textContent).toBe("sess-abc");
    expect(chip?.querySelector(".pc-roster__session-count")?.textContent).toBe("2 tasks");
    expect(chip?.getAttribute("title")).toBe("sess-abc12345");
    // Full id available; short ref is mono meta tier.
    expect(container.querySelector(".pc-roster__session-ref")).toBeTruthy();
  });

  it("calls onSelectSession with the session id when a chip is clicked", () => {
    const onSelectSession = vi.fn();
    const { container } = render(
      <RosterPanel {...baseProps()} onSelectSession={onSelectSession} />,
    );
    fireEvent.click(container.querySelector(".pc-roster__session-handle")!.closest("button")!);
    expect(onSelectSession).toHaveBeenCalledWith("sess-abc12345");
  });

  it("marks the active session pressed", () => {
    const { container } = render(
      <RosterPanel {...baseProps()} selectedSessionId="sess-abc12345" />,
    );
    expect(screen.getByRole("button", { name: /All hands/ }).getAttribute("aria-pressed")).toBe("false");
    expect(
      container.querySelector(".pc-roster__session-handle")?.closest("button")?.getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("still renders All hands + Find when there are no recent session chips", () => {
    // Find must stay available for historical lookup (#88) and the `/` key.
    render(<RosterPanel {...baseProps()} sessions={[]} />);
    expect(screen.getByRole("group", { name: "Orchestrator sessions" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /All hands/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Search fleet" })).toBeTruthy();
  });

  it("labels the session strip as a group of buttons", () => {
    render(<RosterPanel {...baseProps()} />);
    expect(screen.getByRole("group", { name: "Orchestrator sessions" })).toBeTruthy();
  });

  it("opens session search and selects a hit like a chip click (#88)", async () => {
    const onSelectSession = vi.fn();
    const searchSessions = vi.fn(async () => [
      {
        kind: "session" as const,
        id: "sess-old-history",
        handle: "sess-old",
        shortRef: "sess-old",
        label: "sess-old · 3 tasks",
        taskCount: 3,
        lastActivityAt: "2020-01-01T00:00:00.000Z",
      },
    ]);
    render(
      <RosterPanel
        {...baseProps()}
        onSelectSession={onSelectSession}
        searchSessions={searchSessions}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Search fleet" }));
    const input = screen.getByLabelText("Find tasks or sessions");
    fireEvent.change(input, { target: { value: "old" } });
    // Debounced lookup — wait for the hit to appear.
    const sessionOpt = await screen.findByRole("option", { name: /sess-old/ });
    expect(sessionOpt).toBeTruthy();
    expect(searchSessions).toHaveBeenCalledWith("old");
    fireEvent.click(sessionOpt);
    expect(onSelectSession).toHaveBeenCalledWith("sess-old-history");
  });

  it("uses chart-search copy while a Find request is loading", async () => {
    const searchSessions = vi.fn(() => new Promise<never>(() => {}));
    render(<RosterPanel {...baseProps()} searchSessions={searchSessions} />);
    fireEvent.click(screen.getByRole("button", { name: "Search fleet" }));
    fireEvent.change(screen.getByLabelText("Find tasks or sessions"), {
      target: { value: "charted" },
    });
    expect(await screen.findByText("Scouring the charts…")).toBeTruthy();
    expect(screen.queryByText(/Sounding.*deep/i)).toBeNull();
  });

  it("task-name search hit selects the task (not the session)", async () => {
    const onSelectTask = vi.fn();
    const onSelectSession = vi.fn();
    const searchSessions = vi.fn(async () => [
      {
        kind: "task" as const,
        taskId: "t-auth",
        sessionId: "sess-1",
        name: "fix-auth-fanout",
        branch: "feat/auth",
      },
      {
        kind: "session" as const,
        id: "sess-1",
        handle: "fix-auth-fanout",
        shortRef: "sess-1",
        label: "fix-auth-fanout · 1 task",
        taskCount: 1,
        lastActivityAt: "2020-01-01T00:00:00.000Z",
      },
    ]);
    render(
      <RosterPanel
        {...baseProps()}
        onSelectTask={onSelectTask}
        onSelectSession={onSelectSession}
        searchSessions={searchSessions}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Search fleet" }));
    const input = screen.getByLabelText("Find tasks or sessions");
    fireEvent.change(input, { target: { value: "auth" } });
    // Task hits render above session hits; pick the task option by branch meta.
    const taskOption = await screen.findByRole("option", { name: /feat\/auth/ });
    fireEvent.click(taskOption);
    expect(onSelectTask).toHaveBeenCalledWith("t-auth");
    expect(onSelectSession).not.toHaveBeenCalled();
  });

  it("combobox keyboard: ArrowDown + Enter selects the active option", async () => {
    const onSelectTask = vi.fn();
    const searchSessions = vi.fn(async () => [
      {
        kind: "task" as const,
        taskId: "t-first",
        sessionId: "sess-1",
        name: "alpha-task",
        branch: "feat/a",
      },
      {
        kind: "task" as const,
        taskId: "t-second",
        sessionId: "sess-1",
        name: "beta-task",
        branch: "feat/b",
      },
    ]);
    render(
      <RosterPanel
        {...baseProps()}
        onSelectTask={onSelectTask}
        searchSessions={searchSessions}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Search fleet" }));
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "task" } });
    expect(await screen.findByText("alpha-task")).toBeTruthy();
    // First option is auto-active; ArrowDown moves to the second, Enter picks it.
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSelectTask).toHaveBeenCalledWith("t-second");
  });

  it("implements APG combobox semantics on the Find surface", async () => {
    const searchSessions = vi.fn(async () => [
      {
        kind: "session" as const,
        id: "sess-old-history",
        handle: "sess-old",
        shortRef: "sess-old",
        label: "sess-old · 3 tasks",
        taskCount: 3,
        lastActivityAt: "2020-01-01T00:00:00.000Z",
      },
    ]);
    render(<RosterPanel {...baseProps()} searchSessions={searchSessions} />);
    fireEvent.click(screen.getByRole("button", { name: "Search fleet" }));
    const input = screen.getByRole("combobox");
    expect(input.getAttribute("aria-autocomplete")).toBe("list");
    expect(input.getAttribute("aria-expanded")).toBe("true");
    fireEvent.change(input, { target: { value: "old" } });
    const opt = await screen.findByRole("option", { name: /sess-old/ });
    expect(opt).toBeTruthy();
    expect(opt.textContent).toMatch(/3 tasks/);

    const results = screen.getByRole("listbox", { name: "Matching tasks and sessions" });
    expect(results).toBeTruthy();
    expect(results.querySelectorAll("[role='option']").length).toBeGreaterThan(0);
    expect(input.getAttribute("aria-controls")).toBe(results.getAttribute("id"));
    expect(input.getAttribute("aria-activedescendant")).toBeTruthy();
  });

  it("announces no-results and result counts from a polite live region outside the listbox", async () => {
    const searchSessions = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          kind: "task" as const,
          taskId: "t1",
          sessionId: "sess-1",
          name: "chart-alpha",
          branch: "feat/a",
        },
        {
          kind: "task" as const,
          taskId: "t2",
          sessionId: "sess-1",
          name: "chart-beta",
          branch: "feat/b",
        },
        {
          kind: "task" as const,
          taskId: "t3",
          sessionId: "sess-1",
          name: "chart-gamma",
          branch: "feat/c",
        },
        {
          kind: "session" as const,
          id: "sess-1",
          handle: "chart-fleet",
          shortRef: "sess-1",
          label: "chart-fleet · 3 tasks",
          taskCount: 3,
          lastActivityAt: "2020-01-01T00:00:00.000Z",
        },
      ]);
    render(<RosterPanel {...baseProps()} searchSessions={searchSessions} />);
    fireEvent.click(screen.getByRole("button", { name: "Search fleet" }));
    const input = screen.getByLabelText("Find tasks or sessions");
    const listbox = screen.getByRole("listbox", { name: "Matching tasks and sessions" });
    const live = document.querySelector(".pc-roster__search-pop [aria-live='polite']");
    expect(live).toBeTruthy();
    expect(live?.getAttribute("aria-atomic")).toBe("true");
    expect(live?.classList.contains("pc-visually-hidden")).toBe(true);
    // Live region must be a sibling of the listbox, not a child.
    expect(listbox.contains(live)).toBe(false);
    expect(live?.parentElement?.contains(listbox)).toBe(true);

    fireEvent.change(input, { target: { value: "zzz-no-match" } });
    await waitFor(() => {
      expect(live?.textContent).toBe("No tasks or sessions match.");
    });
    // Visible status mirrors the announcement (live region is a second copy).
    expect(document.querySelector(".pc-roster__search-status")?.textContent).toBe(
      "No tasks or sessions match.",
    );
    // Loading copy is visible only, never the live-region message.
    expect(live?.textContent).not.toMatch(/Scouring/);

    fireEvent.change(input, { target: { value: "chart" } });
    await waitFor(() => {
      expect(live?.textContent).toBe("3 tasks, 1 session");
    });
    expect(await screen.findByRole("option", { name: /chart-alpha/ })).toBeTruthy();
  });

  it("does not announce loading status into the live region while a Find request is in flight", async () => {
    const searchSessions = vi.fn(() => new Promise<never>(() => {}));
    render(<RosterPanel {...baseProps()} searchSessions={searchSessions} />);
    fireEvent.click(screen.getByRole("button", { name: "Search fleet" }));
    const live = document.querySelector(".pc-roster__search-pop [aria-live='polite']");
    // Idle tip settles into the live region on open.
    await waitFor(() => {
      expect(live?.textContent).toBe("Type a task name, branch, or session id.");
    });
    fireEvent.change(screen.getByLabelText("Find tasks or sessions"), {
      target: { value: "charted" },
    });
    expect(await screen.findByText("Scouring the charts…")).toBeTruthy();
    // Live region holds the previous settled message — not loading flavour.
    expect(live?.textContent).toBe("Type a task name, branch, or session id.");
    expect(live?.textContent).not.toMatch(/Scouring/);
  });
});

/**
 * Find-hit name priority: the CSS selector
 * `.pc-roster__search-hit--task .pc-roster__search-hit-id` only wins if
 * RosterPanel actually paints the `--task` modifier. A prior CSS-only test
 * matched a contract that never held in the browser (meta stayed flex:0 0 auto).
 */
describe("RosterPanel task find-hit name priority", () => {
  it("renders the --task modifier and id/meta children the flex rules select", async () => {
    const searchSessions = vi.fn(async () => [
      {
        kind: "task" as const,
        taskId: "t-auth-long",
        sessionId: "sess-1",
        name: "short",
        branch: "feat/very-long-branch-name-that-should-shrink-first",
      },
    ]);
    const { container } = render(
      <RosterPanel {...baseProps()} searchSessions={searchSessions} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Search fleet" }));
    fireEvent.change(screen.getByLabelText("Find tasks or sessions"), {
      target: { value: "short" },
    });

    const taskOpt = await screen.findByRole("option", {
      name: /feat\/very-long-branch-name/,
    });
    // Markup contract the CSS depends on — without --task the flex fix is dead.
    expect(taskOpt.classList.contains("pc-roster__search-hit")).toBe(true);
    expect(taskOpt.classList.contains("pc-roster__search-hit--task")).toBe(true);
    expect(taskOpt.classList.contains("pc-roster__search-hit--session")).toBe(false);

    const nameEl = taskOpt.querySelector(".pc-roster__search-hit-id");
    const metaEl = taskOpt.querySelector(".pc-roster__search-hit-meta");
    expect(nameEl).toBeTruthy();
    expect(metaEl).toBeTruthy();
    expect(nameEl!.textContent).toBe("short");
    expect(metaEl!.textContent).toMatch(/feat\/very-long-branch/);

    // Ensure no stray duplicate hit markup under the listbox.
    const hits = container.querySelectorAll(".pc-roster__search-hit--task");
    expect(hits.length).toBe(1);
  });

  it("CSS: task name keeps ≥8ch; branch meta shrinks/ellipsizes first", () => {
    // Single consolidated rule (no append-layer override that can drift).
    const idBlocks = [
      ...HUD_CSS.matchAll(
        /\.pc-roster__search-hit--task\s+\.pc-roster__search-hit-id\s*\{([^}]+)\}/g,
      ),
    ];
    const metaBlocks = [
      ...HUD_CSS.matchAll(
        /\.pc-roster__search-hit--task\s+\.pc-roster__search-hit-meta\s*\{([^}]+)\}/g,
      ),
    ];
    expect(idBlocks.length).toBe(1);
    expect(metaBlocks.length).toBe(1);
    const idCss = idBlocks[0]![1];
    const metaCss = metaBlocks[0]![1];
    expect(idCss).toMatch(/flex:\s*0\s+1\s+auto/);
    expect(idCss).toMatch(/min-width:\s*8ch/);
    expect(metaCss).toMatch(/flex:\s*1\s+1\s+0/);
    expect(metaCss).toMatch(/min-width:\s*0/);
    expect(metaCss).toMatch(/overflow:\s*hidden/);
    expect(metaCss).toMatch(/text-overflow:\s*ellipsis/);
    expect(metaCss).toMatch(/white-space:\s*nowrap/);
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

describe("RosterPanel option has no nested interactive copy (a11y)", () => {
  it("does not mount a task-id copy button inside roster options", () => {
    render(<RosterPanel {...baseProps()} selectedTaskId="t2" />);
    // Copy moved to Inspector head — ARIA options must not nest interactive descendants.
    expect(screen.queryByRole("button", { name: /Copy task id/i })).toBeNull();
    const option = screen.getByRole("option", { name: "sound-the-depths — RUNNING" });
    expect(option.querySelector("button")).toBeNull();
  });

  it("keeps visible short-ref meta on every row without a side copy control", () => {
    const { container } = render(<RosterPanel {...baseProps()} selectedTaskId="t1" />);
    expect(container.querySelector(".pc-roster__id-copy-wrap")).toBeNull();
    expect(container.querySelector(".pc-roster__meta--copy")).toBeNull();
    // 8-char short ref is a protected flex child so ellipsis cannot eat it.
    const idChip = container.querySelector(".pc-roster__meta-id");
    expect(idChip?.textContent).toBe("t1");
  });
});

describe("RosterPanel attention-row relative age", () => {
  it("shows a quiet age on awaiting rows when updatedAt is present", () => {
    const groups: RosterGroup[] = [
      {
        state: "awaiting_answer",
        tasks: [
          {
            id: "t-age",
            name: "needs-you",
            coat: "#10a37f",
            emblem: { kind: "glyph", char: "?" },
            faction: "Codex",
            meta: "feat/age · t-age",
            // ~2 hours ago — stable for the coarse clock.
            updatedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
          },
        ],
      },
    ];
    const { container } = render(
      <RosterPanel {...baseProps()} groups={groups} totalTasks={1} activeTasks={1} />,
    );
    const age = container.querySelector(".pc-roster__age");
    expect(age?.textContent).toMatch(/^\d+h$/);
    // Age rides in the accessible name so AT hears the triage variable.
    expect(screen.getByRole("option", { name: /needs-you — AWAITING, \d+h/ })).toBeTruthy();
  });

  it("omits age on calm running rows", () => {
    const groups: RosterGroup[] = [
      {
        state: "running",
        tasks: [
          {
            id: "t-run",
            name: "sailing",
            coat: "#10a37f",
            emblem: { kind: "glyph", char: "?" },
            faction: "Codex",
            meta: "feat/run · t-run",
            updatedAt: new Date(Date.now() - 60_000).toISOString(),
          },
        ],
      },
    ];
    const { container } = render(
      <RosterPanel {...baseProps()} groups={groups} totalTasks={1} activeTasks={1} />,
    );
    expect(container.querySelector(".pc-roster__age")).toBeNull();
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
    const { container } = render(<RosterPanel {...baseProps()} />);
    const names = [...container.querySelectorAll(".pc-roster__name")].map((el) => el.textContent);
    expect(names).toContain("chart-the-bay");
    expect(names).toContain("lost-at-sea");
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
