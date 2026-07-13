/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Inspector } from "../src/hud/index.js";
import type { InspectorTask } from "../src/hud/index.js";

afterEach(cleanup);

function task(overrides: Partial<InspectorTask> = {}): InspectorTask {
  return {
    id: "t1abcdef",
    name: "chart-the-bay",
    coat: "#2f5fb0",
    emblem: "⚓",
    state: "running",
    evalScore: null,
    evalFeedback: null,
    brief: {
      goal: "Survey the northern shoal and report depth.",
      branch: "feat/bay",
      worktree: "/parley/worktrees/t1",
      model: "codex-5",
      effort: "high",
      sandbox: "workspace",
      network: false,
      duration: "3m 41s",
      usage: "1.2k ▸ 340 tok",
    },
    logs: { lines: [], live: true },
    report: null,
    qa: [],
    ...overrides,
  };
}

function openTab(label: string): void {
  fireEvent.click(screen.getByRole("tab", { name: label }));
}

describe("Inspector renders a quiet placeholder with no selection (#68)", () => {
  it("shows a select-a-task prompt and no tabs when task is null", () => {
    render(<Inspector task={null} />);
    expect(screen.getByText(/Select a soul from the roster/)).toBeTruthy();
    expect(screen.queryByRole("tablist")).toBeNull();
  });
});

describe("Inspector header (#68)", () => {
  it("shows the task name, id, and state badge", () => {
    render(<Inspector task={task()} />);
    expect(screen.getByText("chart-the-bay")).toBeTruthy();
    expect(screen.getByText("t1abcdef")).toBeTruthy();
    expect(screen.getByText("RUNNING")).toBeTruthy();
  });

  it("shows an eval score badge only when present", () => {
    render(<Inspector task={task({ evalScore: 8 })} />);
    expect(screen.getByText("★ 8/10")).toBeTruthy();
  });

  it("omits the eval badge when the task hasn't been eval'd", () => {
    render(<Inspector task={task({ evalScore: null })} />);
    expect(screen.queryByText(/★/)).toBeNull();
  });
});

describe("Inspector's four tabs render per the manifest's inspector treatment (#68)", () => {
  it("opens on the Brief tab by default, showing goal/branch/model/usage", () => {
    render(<Inspector task={task()} />);
    expect(screen.getByRole("tab", { name: "BRIEF" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("Survey the northern shoal and report depth.")).toBeTruthy();
    expect(screen.getByText("feat/bay")).toBeTruthy();
    expect(screen.getByText(/codex-5/)).toBeTruthy();
    expect(screen.getByText(/3m 41s/)).toBeTruthy();
    expect(screen.getByText(/Sandbox: workspace/)).toBeTruthy();
    expect(screen.getByText(/Network: disabled/)).toBeTruthy();
    expect(screen.getByText(/parley never merges/)).toBeTruthy();
  });

  it("switches to the Logs tab and renders classified lines, live", () => {
    render(
      <Inspector
        task={task({
          logs: {
            lines: [
              { key: 0, kind: "shell", text: "ls -la" },
              { key: 1, kind: "error", text: "boom" },
            ],
            live: true,
          },
        })}
      />,
    );
    openTab("LOGS");
    expect(screen.getByText("ls -la")).toBeTruthy();
    expect(screen.getByText("boom")).toBeTruthy();
    expect(screen.getByText("Live · Follow")).toBeTruthy();
  });

  it("shows Paused once the log tail is no longer live", () => {
    render(<Inspector task={task({ logs: { lines: [{ key: 0, kind: "stdout", text: "done" }], live: false } })} />);
    openTab("LOGS");
    expect(screen.getByText("Paused")).toBeTruthy();
  });

  it("switches to the Report tab and renders outcome/summary/files for a completed task", () => {
    render(
      <Inspector
        task={task({
          state: "completed",
          report: {
            outcome: "success",
            summary: "Charted the bay end to end.",
            files: [{ path: "src/chart.ts" }],
          },
        })}
      />,
    );
    openTab("REPORT");
    expect(screen.getByText("SUCCESS")).toBeTruthy();
    expect(screen.getByText("Charted the bay end to end.")).toBeTruthy();
    expect(screen.getByText("+ src/chart.ts")).toBeTruthy();
    expect(screen.getByText(/Review & plant the branch/)).toBeTruthy();
  });

  it("shows the manifest's empty-state copy on the Report tab when there's no report yet", () => {
    render(<Inspector task={task({ report: null })} />);
    openTab("REPORT");
    expect(screen.getByText("No report yet — this soul is still at sea.")).toBeTruthy();
  });

  it("switches to the Q&A tab and renders a question/answer transcript", () => {
    render(
      <Inspector
        task={task({
          qa: [
            { question: "Which shoal?", answer: "The northern one." },
            { question: "Deep or shallow anchorage?", answer: null },
          ],
        })}
      />,
    );
    openTab("Q&A");
    expect(screen.getByText("Which shoal?")).toBeTruthy();
    expect(screen.getByText("The northern one.")).toBeTruthy();
    expect(screen.getByText("Deep or shallow anchorage?")).toBeTruthy();
  });

  it("shows the manifest's empty-state copy on the Q&A tab when no flag has been raised", () => {
    render(<Inspector task={task({ qa: [] })} />);
    openTab("Q&A");
    expect(screen.getByText("No parley yet — this soul hasn't raised a flag.")).toBeTruthy();
  });
});
