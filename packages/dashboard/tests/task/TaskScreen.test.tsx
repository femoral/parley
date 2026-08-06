/** @vitest-environment happy-dom */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ParleyClient } from "@useparley/core";
import { TaskScreen } from "../../src/screens/task/TaskScreen.js";
import type { ScreenMountProps } from "../../src/screens/types.js";
import {
  churnReport,
  detailResponse,
  failedTask,
  qaOutstanding,
  taskEnvelope,
} from "./fixtures.js";

const mockDetail = vi.fn();
const mockLogs = vi.fn();
const mockSnapshot = vi.fn();
const mockNodeTasks = vi.fn();

vi.mock("../../src/data/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/data/index.js")>();
  return {
    ...actual,
    useTaskDetail: (...args: unknown[]) => mockDetail(...args),
    useLogTail: (...args: unknown[]) => mockLogs(...args),
    useSnapshot: (...args: unknown[]) => mockSnapshot(...args),
    useNodeTasks: (...args: unknown[]) => mockNodeTasks(...args),
  };
});

vi.mock("@useparley/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@useparley/core")>();
  return {
    ...actual,
    ParleyClient: class {
      constructor(_opts: { baseUrl: string }) {}
    },
  };
});

function mountProps(overrides: Partial<ScreenMountProps> = {}): ScreenMountProps {
  return {
    screen: "task",
    navigate: vi.fn(),
    selectedTaskId: null,
    setSelectedTaskId: vi.fn(),
    selectedRunId: null,
    setSelectedRunId: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  mockSnapshot.mockReturnValue({
    tasks: [],
    seq: 0,
    connected: true,
    ready: true,
    streamLostSince: null,
    totalTasks: 0,
    activeTasks: 0,
  });
  mockNodeTasks.mockReturnValue({
    status: "idle",
    data: null,
    runTasks: [],
    error: null,
  });
  mockLogs.mockReturnValue({ lines: [], status: "ended" });
  mockDetail.mockReturnValue({ status: "idle", data: null, error: null });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("TaskScreen", () => {
  it("empty selection shows delegate scaffold", () => {
    render(<TaskScreen {...mountProps()} />);
    expect(screen.getByTestId("screen-task")).toBeTruthy();
    expect(screen.getByTestId("task-delegate-scaffold").textContent).toMatch(
      /parley delegate/,
    );
  });

  it("renders completed task with churn report", async () => {
    const task = taskEnvelope({
      task_id: "t-done",
      state: "completed",
      report: churnReport(),
      completed_at: "2026-01-01T00:10:00.000Z",
    });
    mockDetail.mockReturnValue({
      status: "ready",
      data: detailResponse({ task }),
      error: null,
    });
    mockLogs.mockReturnValue({
      lines: [{ kind: "stdout", text: "done", raw: "done" }],
      status: "ended",
    });

    render(<TaskScreen {...mountProps({ selectedTaskId: "t-done" })} />);
    await waitFor(() => expect(screen.getByTestId("task-report")).toBeTruthy());
    expect(screen.getByTestId("task-report-outcome").textContent).toMatch(/SUCCESS/);
    expect(screen.getByTestId("task-body")).toBeTruthy();
    expect(screen.getAllByTestId("task-file-row").length).toBeGreaterThan(0);
  });

  it("renders failed task with why-it-failed well", () => {
    const task = failedTask();
    mockDetail.mockReturnValue({
      status: "ready",
      data: detailResponse({ task }),
      error: null,
    });
    mockLogs.mockReturnValue({ lines: [], status: "ended" });

    render(<TaskScreen {...mountProps({ selectedTaskId: task.task_id })} />);
    expect(screen.getByTestId("task-why-failed").textContent).toMatch(/AssertionError/);
    expect(screen.getByTestId("task-fix-scaffold")).toBeTruthy();
  });

  it("renders awaiting answer with answer scaffold", () => {
    const task = taskEnvelope({
      task_id: "t-ask",
      state: "awaiting_answer",
      question_id: "q-1",
      question: "Which one?",
    });
    mockDetail.mockReturnValue({
      status: "ready",
      data: detailResponse({ task, qa: qaOutstanding() }),
      error: null,
    });
    mockLogs.mockReturnValue({
      lines: [{ kind: "question", text: "ask", raw: "ask" }],
      status: "paused-by-setting",
    });

    render(<TaskScreen {...mountProps({ selectedTaskId: "t-ask" })} />);
    expect(screen.getByTestId("task-answer-scaffold").textContent).toMatch(
      /parley answer t-ask/,
    );
    expect(screen.getByTestId("task-state-chip").getAttribute("data-state")).toBe(
      "awaiting_answer",
    );
  });

  it("passes follow into useLogTail and preserves hook ownership", () => {
    mockDetail.mockReturnValue({
      status: "ready",
      data: detailResponse({
        task: taskEnvelope({ task_id: "t1", state: "running" }),
      }),
      error: null,
    });
    mockLogs.mockReturnValue({ lines: [], status: "tailing" });

    render(<TaskScreen {...mountProps({ selectedTaskId: "t1" })} />);
    expect(mockLogs).toHaveBeenCalled();
    const args = mockLogs.mock.calls[0]!;
    // client, taskId, follow
    expect(args[1]).toBe("t1");
    expect(typeof args[2]).toBe("boolean");
    expect(mockDetail).toHaveBeenCalled();
    const detailArgs = mockDetail.mock.calls[0]!;
    expect(detailArgs[1]).toBe("t1");
    // client is a ParleyClient stand-in
    expect(detailArgs[0]).toBeTruthy();
    void (detailArgs[0] as ParleyClient);
  });

  it("shows log stream drop band when unreachable", () => {
    mockDetail.mockReturnValue({
      status: "ready",
      data: detailResponse({
        task: taskEnvelope({ task_id: "t1", state: "running" }),
      }),
      error: null,
    });
    mockLogs.mockReturnValue({ lines: [], status: "unreachable" });

    render(<TaskScreen {...mountProps({ selectedTaskId: "t1" })} />);
    expect(screen.getByTestId("task-band-log-drop").textContent).toMatch(/stream dropped/i);
  });

  it("shows detail error honesty when fetch fails with no data", () => {
    mockDetail.mockReturnValue({
      status: "error",
      data: null,
      error: "forced panel error",
    });
    mockLogs.mockReturnValue({ lines: [], status: "unreachable" });

    render(<TaskScreen {...mountProps({ selectedTaskId: "t-err" })} />);
    expect(screen.getByTestId("task-band-error").textContent).toMatch(/forced panel error/);
  });
});
