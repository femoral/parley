/** @vitest-environment happy-dom */
/**
 * Shell rails (#363) — attention queue, firehose, scope/state/burn.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { projectAttentionItems } from "../../src/chrome/attentionItems.js";
import { LeftRail } from "../../src/chrome/LeftRail.js";
import { RightRail } from "../../src/chrome/RightRail.js";
import { envelope } from "../fixtures.js";
import { run } from "../fleet/fixtures.js";
import { mockClient, withConsoleData } from "../helpers/consoleData.js";

afterEach(() => {
  cleanup();
});

const NOW = Date.parse("2026-06-15T12:00:00.000Z");

const ask = envelope({
  task_id: "t-ask",
  state: "awaiting_answer",
  name: "needs-answer",
  question: "Ship it?",
  updated_at: "2026-06-15T11:00:00.000Z",
  started_at: "2026-06-15T10:00:00.000Z",
  usage: { input_tokens: 100, output_tokens: 20 },
  completed_at: null,
});

const fail = envelope({
  task_id: "t-fail",
  state: "failed",
  name: "blew-up",
  error: "boom",
  updated_at: "2026-06-15T11:50:00.000Z",
  completed_at: "2026-06-15T11:50:00.000Z",
  usage: { input_tokens: 50, output_tokens: 5 },
});

const heldRun = run({
  run_id: "run-held",
  workflow: "held-flow",
  state: "blocked",
  block: {
    reason: "gate",
    node: "review",
    iteration: 2,
    detail: null,
    verbs: ["approve", "reject"],
  },
  current_node: "review",
  iteration: 2,
  updated_at: "2026-06-15T11:10:00.000Z",
});

describe("projectAttentionItems", () => {
  it("orders by attention rank then age (gate + ask + fail)", () => {
    const items = projectAttentionItems([fail, ask], [heldRun], { nowMs: NOW });
    // Gate + ask share awaiting rank; older age first (ask 11:00 before gate 11:10).
    expect(items.map((i) => i.id)).toEqual(["t-ask", "run-held", "t-fail"]);
    expect(items.find((i) => i.kind === "gate")?.badgeLabel).toBe("GATE HELD");
  });

  it("filters by state and session", () => {
    const scoped = envelope({
      ...ask,
      task_id: "t-sess",
      orchestrator_session_id: "sess-a",
    });
    const items = projectAttentionItems([ask, scoped, fail], [], {
      nowMs: NOW,
      sessionId: "sess-a",
      stateFilter: "awaiting_answer",
    });
    expect(items.map((i) => i.id)).toEqual(["t-sess"]);
  });
});

describe("LeftRail", () => {
  it("renders scope, state filter, and token burn", () => {
    render(
      withConsoleData(
        <LeftRail
          sessionId="all"
          onSessionChange={() => undefined}
          stateFilter="all"
          onStateFilterChange={() => undefined}
          nowMs={NOW}
        />,
        {
          client: mockClient({
            listSessions: async () => ({
              sessions: [
                {
                  id: "sess-1",
                  last_activity_at: "2026-06-15T11:00:00.000Z",
                  task_count: 2,
                },
              ],
            }),
          }),
          snapshot: {
            tasks: [ask, fail],
            seq: 1,
            connected: true,
            ready: true,
            streamLostSince: null,
            totalTasks: 2,
            activeTasks: 1,
          },
        },
      ),
    );
    expect(screen.getByTestId("rail-scope")).toBeTruthy();
    expect(screen.getByTestId("rail-state-filter")).toBeTruthy();
    expect(screen.getByTestId("rail-token-burn")).toBeTruthy();
    expect(screen.getByTestId("rail-burn-bound").textContent).toMatch(/last 24h/);
    expect(screen.getByTestId("rail-state-awaiting_answer")).toBeTruthy();
  });

  it("invokes state filter change", () => {
    const onState = vi.fn();
    render(
      withConsoleData(
        <LeftRail
          sessionId="all"
          onSessionChange={() => undefined}
          stateFilter="all"
          onStateFilterChange={onState}
          nowMs={NOW}
        />,
      ),
    );
    fireEvent.click(screen.getByTestId("rail-state-failed"));
    expect(onState).toHaveBeenCalledWith("failed");
  });
});

describe("RightRail", () => {
  it("renders attention cards ordered by rank and empty firehose honesty", () => {
    const onSelectTask = vi.fn();
    const onSelectRun = vi.fn();
    render(
      withConsoleData(
        <RightRail
          sessionId="all"
          stateFilter="all"
          selectedTaskId={null}
          selectedRunId={null}
          onSelectTask={onSelectTask}
          onSelectRun={onSelectRun}
          nowMs={NOW}
        />,
        {
          snapshot: {
            tasks: [fail, ask],
            seq: 1,
            connected: true,
            ready: true,
            streamLostSince: null,
            totalTasks: 2,
            activeTasks: 1,
          },
          runs: {
            summaries: [heldRun],
            details: new Map(),
            status: "online",
            error: null,
          },
        },
      ),
    );

    expect(screen.getByTestId("rail-attention")).toBeTruthy();
    expect(screen.getByTestId("attn-gate-run-held")).toBeTruthy();
    expect(screen.getByTestId("attn-task-t-ask")).toBeTruthy();
    expect(screen.getByTestId("attn-task-t-fail")).toBeTruthy();
    expect(screen.getByTestId("attn-task-t-ask").textContent).toMatch(/Ship it/);

    // Empty firehose: not a false "no events"
    expect(screen.getByTestId("rail-firehose").textContent).toMatch(
      /No events since connect/i,
    );

    fireEvent.click(screen.getByTestId("attn-task-t-ask"));
    expect(onSelectTask).toHaveBeenCalledWith("t-ask");
    fireEvent.click(screen.getByTestId("attn-gate-run-held"));
    expect(onSelectRun).toHaveBeenCalledWith("run-held");
  });

  it("supports cards/rows density toggle", () => {
    render(
      withConsoleData(
        <RightRail
          sessionId="all"
          stateFilter="all"
          selectedTaskId={null}
          selectedRunId={null}
          onSelectTask={() => undefined}
          onSelectRun={() => undefined}
          nowMs={NOW}
        />,
        {
          snapshot: {
            tasks: [ask],
            seq: 1,
            connected: true,
            ready: true,
            streamLostSince: null,
            totalTasks: 1,
            activeTasks: 1,
          },
        },
      ),
    );
    expect(screen.getByTestId("attn-task-t-ask").getAttribute("data-variant")).toBe(
      "card",
    );
    fireEvent.click(screen.getByTestId("rail-density-rows"));
    expect(screen.getByTestId("attn-task-t-ask").getAttribute("data-variant")).toBe(
      "rows",
    );
  });
});
