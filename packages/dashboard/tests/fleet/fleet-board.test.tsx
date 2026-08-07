/** @vitest-environment happy-dom */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FleetBoard } from "../../src/screens/fleet/FleetBoard.js";
import { run, runner, task } from "./fixtures.js";

afterEach(() => {
  cleanup();
});

const NOW = Date.parse("2026-06-15T12:00:00.000Z");

describe("FleetBoard", () => {
  it("renders KPI strip, attention-sorted tasks with tokens/duration, and failed run pips", () => {
    const onSelectTask = vi.fn();
    const onSelectRun = vi.fn();
    render(
      <FleetBoard
        tasks={[
          task({
            task_id: "t-done",
            state: "completed",
            name: "done-task",
            updated_at: "2026-06-15T11:00:00.000Z",
            completed_at: "2026-06-15T11:00:00.000Z",
            duration_ms: 12_000,
            usage: { input_tokens: 1500, output_tokens: 200 },
          }),
          task({
            task_id: "t-ask",
            state: "awaiting_answer",
            name: "needs-answer",
            updated_at: "2026-06-15T11:30:00.000Z",
            started_at: "2026-06-15T11:20:00.000Z",
            question: "Ship it?",
          }),
          task({
            task_id: "t-fail",
            state: "failed",
            name: "blew-up",
            updated_at: "2026-06-15T11:58:00.000Z",
            completed_at: "2026-06-15T11:58:00.000Z",
            duration_ms: 4000,
            usage: { input_tokens: 100, output_tokens: 10 },
            error: "boom",
          }),
          task({
            task_id: "t-run",
            state: "running",
            name: "in-flight",
            max_concurrent: 2,
            updated_at: "2026-06-15T11:59:00.000Z",
            started_at: "2026-06-15T11:50:00.000Z",
            usage: { input_tokens: 50, output_tokens: 5 },
          }),
        ]}
        runs={[
          run({
            run_id: "run-failed",
            state: "failed",
            track_bound: 4,
            tasks_settled: 4,
            tasks_total: 4,
            workflow: "broke-pipeline",
          }),
          run({
            run_id: "run-held",
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
            workflow: "held-flow",
          }),
        ]}
        runners={[
          runner({ name: "local-1", status: "online", vendors: ["fake", "claude"] }),
          runner({ name: "stale-1", status: "stale", vendors: ["fake"] }),
          runner({ name: "off-1", status: "offline", vendors: [] }),
        ]}
        runnersStatus="online"
        runsStatus="online"
        runsError={null}
        honestyPhase="live"
        selectedTaskId={null}
        selectedRunId={null}
        onSelectTask={onSelectTask}
        onSelectRun={onSelectRun}
        nowMs={NOW}
      />,
    );

    expect(screen.getByTestId("fleet-board")).toBeTruthy();
    expect(screen.getByTestId("fleet-kpis")).toBeTruthy();

    // Concurrency KPI with honest denominator
    const runningKpi = screen.getByTestId("fleet-kpi-running");
    expect(runningKpi.textContent).toMatch(/1\/2/);

    // Tasks attention order: ask, fail, running, completed
    const taskPanel = screen.getByTestId("fleet-tasks");
    const taskRows = within(taskPanel).getAllByRole("row").slice(1); // skip header
    const names = taskRows.map((r) => r.getAttribute("data-testid"));
    expect(names).toEqual([
      "fleet-task-t-ask",
      "fleet-task-t-fail",
      "fleet-task-t-run",
      "fleet-task-t-done",
    ]);

    // Tokens + duration present for completed task
    expect(screen.getByTestId("fleet-task-t-done").textContent).toMatch(/1\.5k▸200/);
    expect(screen.getByTestId("fleet-task-t-done").textContent).toMatch(/12s/);

    // Fresh failure note
    expect(screen.getByTestId("fleet-task-t-fail").textContent).toMatch(/fresh failure/);

    // Failed run pip track contains fail
    const pips = screen.getByTestId("fleet-pips-run-failed");
    expect(pips.getAttribute("data-pip-kinds")).toMatch(/fail/);
    expect(pips.querySelectorAll('[data-pip="fail"]').length).toBeGreaterThan(0);

    // Gate held run
    expect(screen.getByTestId("fleet-run-run-held").textContent).toMatch(/GATE HELD/);
    expect(screen.getByTestId("fleet-run-run-held").textContent).toMatch(/gate waiting/);

    // Firehose / burn no longer on the fleet center (right/left rails own them)
    expect(screen.queryByTestId("fleet-firehose")).toBeNull();
    expect(screen.queryByTestId("fleet-token-burn")).toBeNull();

    // Runners — class AND label per status (not frozen --online)
    const onlineEl = screen.getByTestId("fleet-runner-local-1");
    expect(onlineEl.querySelector(".pc-fleet-runner__status--online")).toBeTruthy();
    expect(onlineEl.textContent).toMatch(/online/);
    const staleEl = screen.getByTestId("fleet-runner-stale-1");
    expect(staleEl.querySelector(".pc-fleet-runner__status--stale")).toBeTruthy();
    expect(staleEl.textContent).toMatch(/stale/);
    const offEl = screen.getByTestId("fleet-runner-off-1");
    expect(offEl.querySelector(".pc-fleet-runner__status--offline")).toBeTruthy();
    expect(offEl.textContent).toMatch(/offline/);
    // Neuter: stale must not carry --online
    expect(staleEl.querySelector(".pc-fleet-runner__status--online")).toBeNull();

    // Roving tabindex: only one tab stop among task rows
    const tabStops = taskRows.filter((r) => r.getAttribute("tabindex") === "0");
    expect(tabStops.length).toBe(1);

    fireEvent.click(screen.getByTestId("fleet-task-t-ask"));
    expect(onSelectTask).toHaveBeenCalledWith("t-ask");
    fireEvent.click(screen.getByTestId("fleet-run-run-held"));
    expect(onSelectRun).toHaveBeenCalledWith("run-held");
  });

  it("empty fleet shows parley delegate scaffold", () => {
    render(
      <FleetBoard
        tasks={[]}
        runs={[]}
        runners={[]}
        runnersStatus="online"
        runsStatus="online"
        runsError={null}
        honestyPhase="empty"
        selectedTaskId={null}
        selectedRunId={null}
        onSelectTask={() => undefined}
        onSelectRun={() => undefined}
        nowMs={NOW}
      />,
    );
    expect(screen.getByTestId("fleet-empty")).toBeTruthy();
    expect(screen.getByTestId("fleet-delegate-scaffold").textContent).toMatch(
      /parley delegate/,
    );
  });

  it("loading state shows fleet loading copy", () => {
    render(
      <FleetBoard
        tasks={[]}
        runs={[]}
        runners={[]}
        runnersStatus="connecting"
        runsStatus="connecting"
        runsError={null}
        honestyPhase="loading"
        selectedTaskId={null}
        selectedRunId={null}
        onSelectTask={() => undefined}
        onSelectRun={() => undefined}
        nowMs={NOW}
      />,
    );
    expect(screen.getByTestId("fleet-loading").textContent).toMatch(/Loading the fleet/);
  });

  it("stale-reconnecting with zero tasks still shows empty fleet phase", () => {
    render(
      <FleetBoard
        tasks={[]}
        runs={[]}
        runners={[]}
        runnersStatus="online"
        runsStatus="online"
        runsError={null}
        honestyPhase="stale-reconnecting"
        selectedTaskId={null}
        selectedRunId={null}
        onSelectTask={() => undefined}
        onSelectRun={() => undefined}
        nowMs={NOW}
      />,
    );
    expect(screen.getByTestId("fleet-board").getAttribute("data-phase")).toBe("empty");
    expect(screen.getByTestId("fleet-empty")).toBeTruthy();
  });

  it("queued task surfaces queue context with max_concurrent denominator", () => {
    render(
      <FleetBoard
        tasks={[
          task({
            task_id: "q1",
            state: "queued",
            name: "waiting",
            queue_position: 3,
            blocking_cap: "vendor:fake",
            max_concurrent: 2,
          }),
        ]}
        runs={[]}
        runners={[]}
        runnersStatus="online"
        runsStatus="online"
        runsError={null}
        honestyPhase="live"
        selectedTaskId={null}
        selectedRunId={null}
        onSelectTask={() => undefined}
        onSelectRun={() => undefined}
        nowMs={NOW}
      />,
    );
    expect(screen.getByTestId("fleet-task-q1").textContent).toMatch(
      /QUEUED #3 · vendor:fake 2\/2/,
    );
  });
});
