/** @vitest-environment happy-dom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ParleyClient } from "@useparley/core";
import { TaskScreen, SETTINGS_SYNC_EVENT } from "../../src/screens/task/TaskScreen.js";
import type { ScreenMountProps } from "../../src/screens/types.js";
import { loadSettings, saveSettings, DEFAULT_SETTINGS } from "../../src/chrome/settings.js";
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
const mockClient = { id: "task-test-client" };

vi.mock("../../src/data/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/data/index.js")>();
  return {
    ...actual,
    useConsoleData: () => ({
      client: mockClient,
      snapshot: mockSnapshot(),
      health: {
        status: "online",
        online: true,
        version: "test",
        pid: 1,
        startedAt: Date.now(),
        uptimeMs: 1000,
      },
      runs: { summaries: [], details: new Map(), status: "online", error: null },
    }),
    useTaskDetail: (...args: unknown[]) => mockDetail(...args),
    useLogTail: (...args: unknown[]) => mockLogs(...args),
    useNodeTasks: (...args: unknown[]) => mockNodeTasks(...args),
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
  localStorage.clear();
  saveSettings({ ...DEFAULT_SETTINGS });
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

  it("renders awaiting answer as full-width ask band with scaffold", () => {
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
    const band = screen.getByTestId("task-ask-band");
    expect(band).toBeTruthy();
    expect(screen.getByTestId("task-ask-band-question").textContent).toMatch(
      /Should the scaffold|Which one/,
    );
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

  it("detail 500 never fabricates empty facts on report/eval/attempts/deliverables/qa", () => {
    // Forced detail error on a task that HAD a report — all five panels must
    // say unavailable, not invent "no report yet" / "never scored" / solo / empty chain.
    mockDetail.mockReturnValue({
      status: "error",
      data: null,
      error: "forced 500",
    });
    mockLogs.mockReturnValue({ lines: [], status: "ended" });

    render(<TaskScreen {...mountProps({ selectedTaskId: "t-had-report" })} />);

    expect(screen.getByTestId("task-report-error").textContent).toMatch(/unavailable/i);
    expect(screen.queryByTestId("task-report-empty")).toBeNull();
    expect(screen.getByTestId("task-report").textContent).not.toMatch(/No report yet/);

    expect(screen.getByTestId("task-eval-error").textContent).toMatch(/unavailable/i);
    expect(screen.queryByTestId("task-eval-empty")).toBeNull();
    expect(screen.getByTestId("task-eval").textContent).not.toMatch(/never been scored/);

    expect(screen.getByTestId("task-attempts-error").textContent).toMatch(/unavailable/i);
    expect(screen.queryByTestId("task-attempts-empty")).toBeNull();
    expect(screen.getByTestId("task-attempts").textContent).not.toMatch(/not in a fix chain/);

    expect(screen.getByTestId("task-dlv-unavailable").textContent).toMatch(/unavailable/i);
    expect(screen.queryByTestId("task-dlv-solo")).toBeNull();
    expect(screen.getByTestId("task-deliverables").textContent).not.toMatch(/Solo task/);

    expect(screen.getByTestId("task-qa-error").textContent).toMatch(/unavailable/i);
  });

  it("follow checkbox persists to settings and re-syncs same-tab", async () => {
    saveSettings({ ...DEFAULT_SETTINGS, followLogs: true });
    mockDetail.mockReturnValue({
      status: "ready",
      data: detailResponse({
        task: taskEnvelope({ task_id: "t1", state: "running" }),
      }),
      error: null,
    });
    mockLogs.mockReturnValue({ lines: [], status: "tailing" });

    render(<TaskScreen {...mountProps({ selectedTaskId: "t1" })} />);
    const box = screen.getByTestId("task-log-follow") as HTMLInputElement;
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    expect(loadSettings().followLogs).toBe(false);

    // Same-tab settings write via custom event.
    saveSettings({ ...DEFAULT_SETTINGS, followLogs: true });
    window.dispatchEvent(
      new CustomEvent(SETTINGS_SYNC_EVENT, { detail: { followLogs: true } }),
    );
    await waitFor(() => {
      expect((screen.getByTestId("task-log-follow") as HTMLInputElement).checked).toBe(
        true,
      );
    });
  });
});
