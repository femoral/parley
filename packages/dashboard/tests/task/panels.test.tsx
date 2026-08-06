/** @vitest-environment happy-dom */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AttemptChain,
  BriefPanel,
  DeliverablesPanel,
  EvalFeedback,
  LogTailPanel,
  QaPanel,
  ReportPanel,
  WhyFailedWell,
} from "../../src/screens/task/panels.js";
import { CopyScaffold } from "../../src/screens/task/CopyScaffold.js";
import {
  attemptChain,
  awaitingTask,
  churnReport,
  evalDetail,
  failedTask,
  pathOnlyReport,
  qaOutstanding,
  taskEnvelope,
} from "./fixtures.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("WhyFailedWell + fix scaffold", () => {
  it("renders error and parley fix scaffold", () => {
    const t = failedTask();
    render(<WhyFailedWell taskId={t.task_id} error={t.error} />);
    expect(screen.getByTestId("task-why-failed").textContent).toMatch(/AssertionError/);
    expect(screen.getByTestId("task-fix-scaffold").textContent).toMatch(
      /parley fix t-fail-1/,
    );
  });

  it("renders nothing without error", () => {
    const { container } = render(<WhyFailedWell taskId="x" error={null} />);
    expect(container.textContent).toBe("");
  });
});

describe("ReportPanel file churn", () => {
  it("shows +N/−N when present and empty churn cell for path-only", () => {
    render(<ReportPanel report={churnReport()} status="ready" taskState="completed" />);
    expect(screen.getByTestId("task-report-outcome").textContent).toMatch(/SUCCESS/);
    const rows = screen.getAllByTestId("task-file-row");
    expect(rows.length).toBeGreaterThanOrEqual(3);
    const withChurn = rows.find((r) => r.getAttribute("data-has-churn") === "true");
    expect(withChurn).toBeTruthy();
    expect(within(withChurn!).getByTestId("task-file-churn").textContent).toMatch(/\+120/);
    const pathOnly = rows.find((r) => r.getAttribute("data-has-churn") === "false");
    expect(pathOnly).toBeTruthy();
    expect(within(pathOnly!).getByTestId("task-file-churn").textContent).toBe("");
  });

  it("notes honest absence for pre-churn path-only reports", () => {
    render(<ReportPanel report={pathOnlyReport()} status="ready" taskState="completed" />);
    expect(screen.getByTestId("task-report-nochurn").textContent).toMatch(/Path list only/);
    for (const cell of screen.getAllByTestId("task-file-churn")) {
      expect(cell.textContent).toBe("");
    }
  });

  it("empty report is honest", () => {
    render(<ReportPanel report={null} status="ready" taskState="running" />);
    expect(screen.getByTestId("task-report-empty").textContent).toMatch(/No report yet/);
  });
});

describe("QaPanel answer scaffold", () => {
  it("shows outstanding turn with parley answer scaffold", () => {
    render(
      <QaPanel taskId="t-ask-1" qa={qaOutstanding()} status="ready" />,
    );
    expect(screen.getByTestId("task-answer-scaffold").textContent).toMatch(
      /parley answer t-ask-1/,
    );
    expect(screen.getAllByTestId("task-qa-turn").some((el) => el.getAttribute("data-pending") === "true")).toBe(
      true,
    );
  });

  it("empty qa is honest", () => {
    render(<QaPanel taskId="t1" qa={[]} status="ready" />);
    expect(screen.getByTestId("task-qa-empty").textContent).toMatch(/No parley yet/);
  });
});

describe("AttemptChain", () => {
  it("marks current attempt and shows scores", () => {
    const chain = attemptChain("t-cur");
    render(<AttemptChain attempts={chain} currentId="t-cur" status="ready" />);
    const items = screen.getAllByTestId("task-attempt");
    expect(items).toHaveLength(2);
    expect(items[1]!.getAttribute("data-current")).toBe("true");
    expect(items[0]!.textContent).toMatch(/FAILED/);
    expect(items[0]!.textContent).toMatch(/4\.0\/5\.2/);
  });
});

describe("EvalFeedback honest empty", () => {
  it("absent eval", () => {
    render(<EvalFeedback detail={null} />);
    expect(screen.getByTestId("task-eval-empty").textContent).toMatch(/never been scored/);
  });

  it("renders score + feedback", () => {
    render(<EvalFeedback detail={evalDetail()} />);
    expect(screen.getByTestId("task-eval-score").textContent).toMatch(/7\.5/);
    expect(screen.getByTestId("task-eval-feedback").textContent).toMatch(/Solid coverage/);
  });
});

describe("LogTailPanel follow + health", () => {
  it("toggles follow without requiring remount props wipe", () => {
    const onFollow = vi.fn();
    render(
      <LogTailPanel
        lines={[{ kind: "stdout", text: "hello", raw: "hello" }]}
        status="tailing"
        follow={true}
        onFollowChange={onFollow}
        taskId="t1"
      />,
    );
    expect(screen.getByTestId("task-log-status").getAttribute("data-status")).toBe("tailing");
    fireEvent.click(screen.getByTestId("task-log-follow"));
    expect(onFollow).toHaveBeenCalledWith(false);
  });

  it("surfaces unreachable honestly", () => {
    render(
      <LogTailPanel
        lines={[]}
        status="unreachable"
        follow={true}
        onFollowChange={() => {}}
        taskId="t1"
      />,
    );
    expect(screen.getByTestId("task-log-unreachable").textContent).toMatch(/unreachable/i);
  });
});

describe("BriefPanel + long goal", () => {
  it("renders brief rows and worktree absence", () => {
    const t = taskEnvelope({ task_id: "t1", state: "running", worktree: null });
    render(
      <BriefPanel
        task={t}
        goal={"x".repeat(200)}
        status="ready"
        error={null}
      />,
    );
    expect(screen.getByTestId("task-brief").textContent).toMatch(/goal/i);
    expect(screen.getByTestId("task-worktree-absent")).toBeTruthy();
    expect(screen.getByText(/read full/i)).toBeTruthy();
  });
});

describe("DeliverablesPanel fetch states", () => {
  it("solo task → none", () => {
    render(
      <DeliverablesPanel fetchState="none" items={[]} error={null} hasRun={false} />,
    );
    expect(screen.getByTestId("task-dlv-solo")).toBeTruthy();
    expect(screen.getByTestId("task-dlv-state").getAttribute("data-state")).toBe("none");
  });

  it("error / missing-worktree / purged labels", () => {
    const { rerender } = render(
      <DeliverablesPanel fetchState="error" items={[]} error="boom" hasRun={true} />,
    );
    expect(screen.getByTestId("task-dlv-error").textContent).toMatch(/boom/);
    rerender(
      <DeliverablesPanel
        fetchState="missing-worktree"
        items={[]}
        error="worktree removed"
        hasRun={true}
      />,
    );
    expect(screen.getByTestId("task-dlv-missing-wt")).toBeTruthy();
    rerender(
      <DeliverablesPanel
        fetchState="purged"
        items={[
          {
            deliverable_id: "d1",
            run_id: "r1",
            node: "plan",
            port: "out",
            iteration: 1,
            slot: null,
            task_id: "t1",
            kind: "inline",
            type: null,
            size: null,
            created_at: "2026-01-01T00:00:00.000Z",
            purged_at: "2026-01-02T00:00:00.000Z",
          },
        ]}
        error={null}
        hasRun={true}
      />,
    );
    expect(screen.getByTestId("task-dlv-state").getAttribute("data-state")).toBe("purged");
    expect(screen.getByTestId("task-dlv-row").getAttribute("data-purged")).toBe("true");
  });
});

describe("CopyScaffold", () => {
  it("copies on click when clipboard available", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    render(<CopyScaffold text='parley answer t1 "..."' testId="sc" />);
    fireEvent.click(screen.getByRole("button"));
    await vi.waitFor(() => expect(writeText).toHaveBeenCalled());
  });
});

describe("awaiting task smoke", () => {
  it("awaiting envelope has question fields for inspector", () => {
    const t = awaitingTask();
    expect(t.state).toBe("awaiting_answer");
    expect(t.question).toBeTruthy();
  });
});
