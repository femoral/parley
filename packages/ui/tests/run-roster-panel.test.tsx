/** @vitest-environment happy-dom */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { RosterPanel } from "../src/hud/index.js";
import type { RosterGroup, RosterSessionOption } from "../src/hud/index.js";
import { Inspector } from "../src/hud/Inspector/index.js";
import type { InspectorRun } from "../src/hud/types.js";

afterEach(cleanup);

const HUD_CSS = readFileSync(
  resolve(
    process.cwd(),
    process.cwd().endsWith("packages/ui") ? "src/hud/hud.css" : "packages/ui/src/hud/hud.css",
  ),
  "utf8",
);

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

  it("renders the full 8-char short id on an attention (held) run row", () => {
    // Attention rows carry age + beacon; the short id must not shrink away.
    render(<RosterPanel {...baseProps()} />);
    const held = screen.getByRole("option", { name: /coding-2/i });
    const idEl = held.querySelector(".pc-roster__run-id");
    expect(idEl).toBeTruthy();
    // shortRef("r-a19c0001") → "r-a19c00" (8 chars) — full id characters present.
    expect(idEl!.textContent).toBe("run r-a19c00");
  });

  it("CSS: run short-id is flex-shrink:0; name keeps ≥8ch floor", () => {
    // Same contract style as search-hit name priority — layout truth lives in CSS.
    const idBlocks = [
      ...HUD_CSS.matchAll(/\.pc-roster__run-id\s*\{([^}]+)\}/g),
    ];
    const nameBlocks = [
      ...HUD_CSS.matchAll(
        /\.pc-roster__run-head\s+\.pc-roster__name\s*\{([^}]+)\}/g,
      ),
    ];
    expect(idBlocks.length).toBeGreaterThanOrEqual(1);
    expect(nameBlocks.length).toBe(1);
    const idCss = idBlocks[idBlocks.length - 1]![1];
    const nameCss = nameBlocks[0]![1];
    expect(idCss).toMatch(/flex:\s*0\s+0\s+auto/);
    expect(idCss).not.toMatch(/min-width:\s*0/);
    expect(nameCss).toMatch(/min-width:\s*8ch/);
  });
});

describe("Inspector run view (#254)", () => {
  const run: InspectorRun = {
    status: "ready",
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

  it("fan-out tally ×N is present in the node cell accessible text", () => {
    render(<Inspector task={null} run={run} />);
    const nodes = Array.from(document.querySelectorAll(".pc-runview__node"));
    const search = nodes.find((n) => n.textContent?.includes("search"));
    expect(search).toBeTruthy();
    // Load-bearing: width is written beside the node name, not drawn.
    expect(search!.textContent).toMatch(/search/);
    expect(search!.textContent).toMatch(/×12/);
    expect(search!.querySelector(".pc-runview__fan")?.textContent?.trim()).toBe("×12");
  });

  it("iteration suffix .N is present when iteration > 1", () => {
    const multi: InspectorRun = {
      ...run,
      nodes: [
        {
          key: "review\u00002",
          node: "review",
          kind: "step",
          iteration: 2,
          state: "running",
          stateLabel: "running",
          tasksLabel: "3",
          gist: "1 of 3 still out",
          age: "4m",
          fanoutWidth: 3,
          spineState: "running",
          live: true,
          onReject: null,
        },
      ],
    };
    render(<Inspector task={null} run={multi} />);
    const cell = document.querySelector(".pc-runview__node");
    expect(cell?.textContent).toMatch(/review/);
    expect(cell?.textContent).toMatch(/×3/);
    expect(cell?.textContent).toMatch(/\.2/);
  });

  it("pending run shows hailing copy without inventing 0 tasks", () => {
    render(
      <Inspector task={null} run={{ status: "pending", id: "r-pending1" }} />,
    );
    expect(screen.getByText("Hailing the run…")).toBeTruthy();
    expect(screen.queryByText("0 tasks")).toBeNull();
    expect(screen.queryByText("No nodes entered yet.")).toBeNull();
  });

  it("CSS: table scrolls honestly — min-width, no fixed percentage clip plan", () => {
    const tableBlocks = [
      ...HUD_CSS.matchAll(/\.pc-runview__table\s*\{([^}]+)\}/g),
    ];
    expect(tableBlocks.length).toBeGreaterThanOrEqual(1);
    const tableCss = tableBlocks[tableBlocks.length - 1]![1];
    expect(tableCss).toMatch(/min-width:\s*36rem/);
    expect(tableCss).not.toMatch(/table-layout:\s*fixed/);
    // Node cells must not hard-clip (would delete ×N / .N).
    const nodeBlocks = [
      ...HUD_CSS.matchAll(/\.pc-runview__node\s*\{([^}]+)\}/g),
    ];
    const nodeCss = nodeBlocks[nodeBlocks.length - 1]![1];
    expect(nodeCss).not.toMatch(/overflow:\s*hidden/);
    expect(nodeCss).not.toMatch(/text-overflow:\s*ellipsis/);
    // Spine rail holds 18px (defect 3 win).
    expect(HUD_CSS).toMatch(
      /\.pc-runview__rail\s*\{[^}]*min-width:\s*18px/s,
    );
  });
});
