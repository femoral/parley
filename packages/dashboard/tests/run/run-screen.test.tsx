/** @vitest-environment happy-dom */
/**
 * Run detail screen unit tests — fork vocabulary, views, gate read-only, neuter.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type {
  NodeProjection,
  RunBlock,
  RunDetailResponse,
  RunSummary,
  TaskEnvelope,
} from "@useparley/core";
import { RunScreen } from "../../src/screens/run/RunScreen.js";
import type { ScreenMountProps } from "../../src/screens/types.js";
import { envelope } from "../fixtures.js";

const runId = "run-test-00123456";

function makeRun(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    run_id: runId,
    workflow: "console-gate",
    workflow_version: 1,
    orchestrator_session_id: "orch",
    state: "blocked",
    block: {
      reason: "gate",
      node: "approve",
      iteration: 1,
      detail: "awaiting orchestrator",
      verbs: ["approve", "reject", "redirect", "finish"],
    },
    current_node: "approve",
    iteration: 1,
    parent_run_id: null,
    attempt: 1,
    tasks_settled: 1,
    tasks_total: 1,
    usage: { input_tokens: 100, output_tokens: 40 },
    duration_ms: 12_000,
    branch: "parley/rtest-console-gate",
    worktree: "/tmp/worktrees/console-gate",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:01:00.000Z",
    completed_at: null,
    purged_at: null,
    workspace: "repo",
    type: "other",
    repo: "/tmp/repo",
    error: null,
    ...overrides,
  };
}

function makeNode(
  partial: Partial<NodeProjection> & Pick<NodeProjection, "node" | "state">,
): NodeProjection {
  return {
    kind: "step",
    iteration: 1,
    tasks_settled: 1,
    tasks_total: 1,
    usage: { input_tokens: 10, output_tokens: 5 },
    duration_ms: 1000,
    fanout: null,
    tallies: {},
    counts: {},
    summary: null,
    deliverables: [],
    gist: "work",
    ...partial,
  };
}

function gateHeldDetail(): RunDetailResponse {
  return {
    run: makeRun(),
    block: makeRun().block as RunBlock,
    nodes: [
      makeNode({
        node: "plan",
        state: "completed",
        deliverables: ["d-plan"],
        gist: "brief → plan",
      }),
      makeNode({
        node: "approve",
        kind: "gate",
        state: "waiting",
        tasks_settled: 0,
        tasks_total: 0,
        on_reject: "finish",
        question: "Approve?",
        gist: "gate held — awaiting the orchestrating agent",
      }),
      makeNode({
        node: "done",
        state: "pending",
        tasks_settled: 0,
        tasks_total: 0,
        gist: "not entered",
      }),
    ],
  };
}

function forkedDetail(): RunDetailResponse {
  return {
    run: makeRun({
      state: "running",
      block: null,
      parent_run_id: "run-parent-aaaa",
      attempt: 2,
      current_node: "done",
    }),
    block: null,
    nodes: [
      makeNode({
        node: "plan",
        state: "inherited",
        iteration: 0,
        tasks_settled: 0,
        tasks_total: 0,
        gist: "inherited",
      }),
      makeNode({
        node: "approve",
        kind: "gate",
        state: "skipped",
        iteration: 0,
        tasks_settled: 0,
        tasks_total: 0,
        gist: "skipped on fork",
      }),
      makeNode({
        node: "done",
        state: "running",
        iteration: 1,
        gist: "re-entry work",
      }),
    ],
  };
}

function fanOutDetail(): RunDetailResponse {
  return {
    run: makeRun({
      state: "running",
      block: null,
      current_node: "review",
      workflow: "fan-out-demo",
    }),
    block: null,
    nodes: [
      makeNode({ node: "plan", state: "completed", gist: "scoped" }),
      makeNode({
        node: "review",
        state: "running",
        fanout: {
          kind: "slots",
          over: null,
          width: 3,
          failed: [],
          success: null,
        },
        tasks_settled: 1,
        tasks_total: 3,
        gist: "fan-out 3 slots",
      }),
    ],
  };
}

function failedDetail(): RunDetailResponse {
  return {
    run: makeRun({
      state: "failed",
      block: null,
      current_node: "plan",
      error: "synthetic failure",
      worktree: null,
    }),
    block: null,
    nodes: [
      makeNode({
        node: "plan",
        state: "failed",
        gist: "vendor fatal",
      }),
    ],
  };
}

/** Controllable mock for data-layer hooks used by RunScreen. */
const mockState = {
  detail: gateHeldDetail() as RunDetailResponse | null,
  tasks: [] as TaskEnvelope[],
  summaries: [] as RunSummary[],
  runsError: null as string | null,
  runsStatus: "online" as "connecting" | "online" | "offline",
  ready: true,
  connected: true,
  healthOnline: true,
  streamLostSince: null as number | null,
};

vi.mock("../../src/data/index.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/data/index.js")>(
    "../../src/data/index.js",
  );
  return {
    ...actual,
    useSnapshot: () => ({
      tasks: mockState.tasks,
      seq: 1,
      connected: mockState.connected,
      ready: mockState.ready,
      streamLostSince: mockState.streamLostSince,
      totalTasks: mockState.tasks.length,
      activeTasks: mockState.tasks.filter((t) => t.state === "running").length,
    }),
    useHealth: () => ({
      status: mockState.healthOnline ? "online" : "offline",
      online: mockState.healthOnline,
      version: "0.0.0-test",
      pid: 1,
      startedAt: Date.now() - 60_000,
      uptimeMs: 60_000,
    }),
    useRuns: () => ({
      summaries: mockState.summaries,
      details: mockState.detail
        ? new Map([[mockState.detail.run.run_id, mockState.detail]])
        : new Map(),
      status: mockState.runsStatus,
      error: mockState.runsError,
    }),
    useNodeTasks: () => ({
      status: "ready" as const,
      data: null,
      runTasks: mockState.tasks.filter((t) => t.run_id === runId),
      error: null,
    }),
    useHonesty: actual.useHonesty,
  };
});

vi.mock("../../src/screens/run/useDeliverableValues.js", () => ({
  useDeliverableValues: () => ({
    rows: [],
    loading: false,
    panelLabel: "none",
    panelStatus: "none",
  }),
}));

function mount(selectedRunId: string | null = runId) {
  const props: ScreenMountProps = {
    screen: "run",
    navigate: vi.fn(),
    selectedTaskId: null,
    setSelectedTaskId: vi.fn(),
    selectedRunId,
    setSelectedRunId: vi.fn(),
  };
  return render(<RunScreen {...props} />);
}

afterEach(() => {
  cleanup();
  mockState.detail = gateHeldDetail();
  mockState.tasks = [];
  mockState.summaries = [makeRun()];
  mockState.runsError = null;
  mockState.runsStatus = "online";
  mockState.ready = true;
  mockState.connected = true;
  mockState.healthOnline = true;
  mockState.streamLostSince = null;
});

describe("RunScreen", () => {
  it("renders gate-held run with read-only verb notice and block banner", () => {
    mockState.detail = gateHeldDetail();
    mockState.summaries = [makeRun()];
    mockState.tasks = [
      envelope({
        task_id: "t-plan",
        state: "completed",
        run_id: runId,
        node: "plan",
        iteration: 1,
      }),
    ];
    mount();
    expect(screen.getByTestId("screen-run")).toBeTruthy();
    expect(screen.getByTestId("run-state-chip").textContent).toMatch(/GATE HELD|BLOCKED/);
    expect(screen.getByTestId("run-block").getAttribute("data-reason")).toBe("gate");
    expect(screen.getByTestId("run-view-switch").textContent).toMatch(/approve/);
    expect(screen.getByTestId("run-view-switch").textContent).toMatch(/read-only|orchestrating/);
    // No mutating controls.
    expect(screen.queryByRole("button", { name: /approve/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /reject/i })).toBeNull();
  });

  it("renders pipeline / iteration grid / node table views", () => {
    mockState.detail = gateHeldDetail();
    mockState.summaries = [makeRun()];
    mount();
    expect(screen.getByTestId("run-pipeline")).toBeTruthy();
    fireEvent.click(screen.getByTestId("run-view-grid"));
    expect(screen.getByTestId("run-iteration-grid")).toBeTruthy();
    fireEvent.click(screen.getByTestId("run-view-table"));
    expect(screen.getByTestId("run-node-table")).toBeTruthy();
  });

  it("renders fork inherited vs skipped distinctly (shape + label)", () => {
    mockState.detail = forkedDetail();
    mockState.summaries = [forkedDetail().run];
    mount();
    fireEvent.click(screen.getByTestId("run-view-table"));
    const table = screen.getByTestId("run-node-table");
    const inherited = table.querySelector('[data-fork="inherited"]');
    const skipped = table.querySelector('[data-fork="skipped"]');
    expect(inherited).toBeTruthy();
    expect(skipped).toBeTruthy();
    expect(inherited?.textContent).toMatch(/inherited/i);
    expect(skipped?.textContent).toMatch(/skipped/i);
    // STATE column names the state (not the no-data glyph) — MED N2
    expect(inherited?.querySelector(".pc-run__state-label")?.textContent).toMatch(
      /INHERITED/,
    );
    expect(skipped?.querySelector(".pc-run__state-label")?.textContent).toMatch(
      /SKIPPED/,
    );
    // Struck name on inherited
    expect(inherited?.querySelector(".pc-run__node-name--struck")).toBeTruthy();
    // Loud badge on skipped in NODE column (not hue-only)
    expect(skipped?.querySelector(".pc-run__fork-badge--skipped")).toBeTruthy();
  });

  it("renders fan-out width as ×N on pipeline cards", () => {
    mockState.detail = fanOutDetail();
    mockState.summaries = [fanOutDetail().run];
    mount();
    const pipe = screen.getByTestId("run-pipeline");
    expect(pipe.textContent).toMatch(/×3|fan-out 3/);
  });

  it("renders failed run state", () => {
    mockState.detail = failedDetail();
    mockState.summaries = [failedDetail().run];
    mount();
    expect(screen.getByTestId("run-state-chip").textContent).toMatch(/FAILED/);
  });

  it("renders run workspace path", () => {
    mockState.detail = gateHeldDetail();
    mockState.summaries = [makeRun()];
    mount();
    const ws = screen.getByTestId("run-workspace");
    expect(ws.textContent).toMatch(/worktrees|console-gate/);
  });

  it("shows empty honesty when no runs", () => {
    mockState.detail = null;
    mockState.summaries = [];
    mockState.tasks = [];
    mockState.runsError = null;
    mockState.runsStatus = "online";
    mount(null);
    expect(screen.getByTestId("screen-run").getAttribute("data-honesty")).toBe("empty");
    expect(screen.getByText(/No runs/i)).toBeTruthy();
  });

  it("GET /runs error is panel-error, never the No-runs empty shell (REQUIRED #1)", () => {
    mockState.detail = null;
    mockState.summaries = [];
    mockState.tasks = [];
    mockState.runsError = "GET /runs failed with status 500";
    mockState.runsStatus = "online";
    mount(null);
    const root = screen.getByTestId("screen-run");
    expect(root.getAttribute("data-honesty")).toBe("panel-error");
    expect(screen.getByTestId("run-error-shell")).toBeTruthy();
    expect(screen.getByTestId("run-error-shell").textContent).toMatch(
      /Run detail error/,
    );
    expect(screen.getByTestId("run-error-shell").textContent).toMatch(
      /GET \/runs failed/,
    );
    // Must NOT be byte-identical to empty.
    expect(screen.queryByText(/^No runs$/i)).toBeNull();
    expect(root.textContent).not.toMatch(/Start a workflow with/);
  });

  it("renders wire block.verbs, not the static full GATE_VERBS list (REQUIRED #4)", () => {
    const d = failedDetail();
    // Simulate parked failed-as-blocked with only redirect/finish (like r3).
    d.run.state = "blocked";
    d.run.block = {
      reason: "unknown",
      node: "plan",
      iteration: 1,
      detail: "blocked (all — NOT MET, 0 of 1)",
      verbs: ["redirect", "finish"],
    };
    d.block = d.run.block;
    mockState.detail = d;
    mockState.summaries = [d.run];
    mount();
    const verbs = screen.getByTestId("run-block-verbs").textContent ?? "";
    expect(verbs).toMatch(/redirect/);
    expect(verbs).toMatch(/finish/);
    expect(verbs).not.toMatch(/approve/);
    expect(verbs).not.toMatch(/reject/);
  });

  it("renders run.error for a failed run (REQUIRED #14)", () => {
    const d = failedDetail();
    d.run.error = "synthetic vendor failure (verify)";
    mockState.detail = d;
    mockState.summaries = [d.run];
    mount();
    expect(screen.getByTestId("run-failed").textContent).toMatch(/synthetic vendor failure/);
  });

  it("shows fork markers in iteration grid including iter 0 (REQUIRED #3)", () => {
    mockState.detail = forkedDetail();
    mockState.summaries = [forkedDetail().run];
    mount();
    fireEvent.click(screen.getByTestId("run-view-grid"));
    const grid = screen.getByTestId("run-iteration-grid");
    expect(grid.querySelectorAll('[data-fork="inherited"]').length).toBeGreaterThan(0);
    expect(grid.querySelectorAll('[data-fork="skipped"]').length).toBeGreaterThan(0);
    expect(grid.textContent).toMatch(/fork · 0|fork/);
    // Grid cells name the state (INHERITED / SKIPPED) — MED N2
    expect(
      grid.querySelector('[data-fork="inherited"] .pc-run__state-label')?.textContent,
    ).toMatch(/INHERITED/);
    expect(
      grid.querySelector('[data-fork="skipped"] .pc-run__state-label')?.textContent,
    ).toMatch(/SKIPPED/);
  });

  it("pipeline cue says wrapped without claiming a fixed row size (MED N1)", () => {
    const nodes = Array.from({ length: 8 }, (_, i) =>
      makeNode({ node: `step-${i}`, state: "completed" }),
    );
    mockState.detail = {
      run: makeRun({ state: "running", block: null }),
      block: null,
      nodes,
    };
    mockState.summaries = [mockState.detail.run];
    mount();
    const cue = screen.getByTestId("pipeline-scroll-cue");
    expect(cue.textContent).toMatch(/8 nodes · wrapped/);
    expect(cue.textContent).not.toMatch(/rows of/);
  });

  it("offline status shows Daemon offline even when error is set (N3)", () => {
    mockState.detail = null;
    mockState.summaries = [];
    mockState.tasks = [];
    mockState.runsError = "fetch failed";
    mockState.runsStatus = "offline";
    mount(null);
    const root = screen.getByTestId("screen-run");
    expect(root.getAttribute("data-honesty")).toBe("offline");
    expect(screen.getByTestId("run-error-shell").textContent).toMatch(/Daemon offline/);
  });

  it("keeps run outputs outside the view switch (REQUIRED #10)", () => {
    mockState.detail = gateHeldDetail();
    mockState.summaries = [makeRun()];
    mount();
    expect(screen.getByTestId("run-outputs")).toBeTruthy();
    fireEvent.click(screen.getByTestId("run-view-grid"));
    expect(screen.getByTestId("run-outputs")).toBeTruthy();
    fireEvent.click(screen.getByTestId("run-view-table"));
    expect(screen.getByTestId("run-outputs")).toBeTruthy();
  });

  it("workspace path appears once (REQUIRED #12)", () => {
    mockState.detail = gateHeldDetail();
    mockState.summaries = [makeRun()];
    mount();
    const ws = screen.getAllByTestId("run-workspace");
    expect(ws).toHaveLength(1);
  });

  it("neuter: breaking detail wiring surfaces error, restore recovers", () => {
    mockState.detail = null;
    mockState.summaries = [makeRun()];
    mockState.runsError = "forced wiring break";
    mockState.runsStatus = "online";
    const { rerender } = mount();
    expect(screen.getByTestId("screen-run").getAttribute("data-honesty")).toBe("panel-error");
    expect(screen.getByText("forced wiring break")).toBeTruthy();

    mockState.detail = gateHeldDetail();
    mockState.runsError = null;
    const props: ScreenMountProps = {
      screen: "run",
      navigate: vi.fn(),
      selectedTaskId: null,
      setSelectedTaskId: vi.fn(),
      selectedRunId: runId,
      setSelectedRunId: vi.fn(),
    };
    rerender(<RunScreen {...props} />);
    expect(screen.getByTestId("run-header")).toBeTruthy();
    expect(screen.getByTestId("run-pipeline")).toBeTruthy();
  });

  it("lists whole-run tasks via run_id filter", () => {
    mockState.detail = gateHeldDetail();
    mockState.summaries = [makeRun()];
    mockState.tasks = [
      envelope({
        task_id: "t-a",
        state: "completed",
        run_id: runId,
        node: "plan",
        iteration: 1,
        vendor: "fake",
        model: "fake-model",
      }),
      envelope({
        task_id: "t-other",
        state: "running",
        run_id: "other-run",
        node: "x",
        iteration: 1,
      }),
    ];
    mount();
    const panel = screen.getByTestId("run-tasks");
    expect(within(panel).getByText(/t-a|plan/)).toBeTruthy();
    expect(panel.textContent).not.toMatch(/t-other/);
  });
});
