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
    coat: "#10a37f",
    emblem: { kind: "svg", viewBox: "0 0 24 24", path: "M12 2 L20 7 V17 L12 22 L4 17 V7 Z" },
    faction: "Codex",
    state: "running",
    error: null,
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
  it("shows the ship's log kicker, task name, id, and state badge", () => {
    render(<Inspector task={task()} />);
    expect(screen.getByText("SHIP'S LOG")).toBeTruthy();
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

  it("shows eval feedback when present", () => {
    render(<Inspector task={task({ evalScore: 8, evalFeedback: "Strong result; tighten the final summary." })} />);
    expect(screen.getByText("EVALUATION")).toBeTruthy();
    expect(screen.getByText("Strong result; tighten the final summary.")).toBeTruthy();
  });

  it("omits eval feedback when absent", () => {
    render(<Inspector task={task({ evalFeedback: null })} />);
    expect(screen.queryByText("EVALUATION")).toBeNull();
  });
});

describe("Inspector's corner flourishes follow the settings bar's Ornaments toggle (#70)", () => {
  it("omits flourishes by default", () => {
    const { container } = render(<Inspector task={task()} />);
    expect(container.querySelector(".pc-flourish")).toBeNull();
  });

  it("draws all four corner flourishes when ornaments is on", () => {
    const { container } = render(<Inspector task={task()} ornaments />);
    expect(container.querySelectorAll(".pc-flourish")).toHaveLength(4);
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
    expect(
      screen.getByText(/Parley never merges on its own — the branch waits for your orchestrator/),
    ).toBeTruthy();
  });

  it("renders the failure cause at the top of Brief when the task is failed with an error", () => {
    render(
      <Inspector
        task={task({
          state: "failed",
          error: "vendor exited 1: workspace sandbox denied network",
        })}
      />,
    );
    expect(screen.getByText("WHY IT FAILED")).toBeTruthy();
    expect(screen.getByText("vendor exited 1: workspace sandbox denied network")).toBeTruthy();
  });

  it("omits the failure well when the task is not failed, even if error is set", () => {
    render(<Inspector task={task({ state: "running", error: "stale noise" })} />);
    expect(screen.queryByText("WHY IT FAILED")).toBeNull();
    expect(screen.queryByText("stale noise")).toBeNull();
  });

  it("omits the failure well when failed but error is null", () => {
    render(<Inspector task={task({ state: "failed", error: null })} />);
    expect(screen.queryByText("WHY IT FAILED")).toBeNull();
  });

  it("labels the header emblem with the faction/vendor name", () => {
    render(<Inspector task={task({ faction: "Grok", coat: "#2b2b2e" })} />);
    expect(screen.getByLabelText("Grok")).toBeTruthy();
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
    // Neutral path listing — no "+" add/delete claim the data doesn't carry.
    expect(screen.getByText("src/chart.ts")).toBeTruthy();
    expect(screen.queryByText(/^\+\s/)).toBeNull();
    expect(screen.queryByText(/Review & plant the branch/)).toBeNull();
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
            {
              id: "q1",
              question: "Which shoal?",
              answer: "The northern one.",
              askedAt: "2026-01-01T14:02:00.000Z",
              answeredAt: "2026-01-01T14:05:00.000Z",
            },
            {
              id: "q2",
              question: "Deep or shallow anchorage?",
              answer: null,
              askedAt: "2026-01-01T14:10:00.000Z",
              answeredAt: null,
            },
          ],
        })}
      />,
    );
    openTab("Q&A");
    expect(screen.getByText("Which shoal?")).toBeTruthy();
    expect(screen.getByText("The northern one.")).toBeTruthy();
    expect(screen.getByText("Deep or shallow anchorage?")).toBeTruthy();
  });

  it("renders quiet absolute HH:MM timestamps on each Q&A bubble", () => {
    // Fixed local-wall times via a known offset so the clock string is stable
    // across TZ environments: construct from Date local components.
    const asked = new Date(2026, 0, 1, 14, 2, 0);
    const answered = new Date(2026, 0, 1, 14, 5, 0);
    const outstanding = new Date(2026, 0, 1, 14, 10, 0);
    render(
      <Inspector
        task={task({
          qa: [
            {
              id: "q1",
              question: "Which shoal?",
              answer: "The northern one.",
              askedAt: asked.toISOString(),
              answeredAt: answered.toISOString(),
            },
            {
              id: "q2",
              question: "Deep or shallow anchorage?",
              answer: null,
              askedAt: outstanding.toISOString(),
              answeredAt: null,
            },
          ],
        })}
      />,
    );
    openTab("Q&A");
    const times = screen.getAllByText(/^\d{2}:\d{2}$/);
    // Question + answer on the first turn, question only on the outstanding turn.
    expect(times).toHaveLength(3);
    expect(times.map((el) => el.textContent)).toEqual(["14:02", "14:05", "14:10"]);
    // Full datetime is available on title / dateTime for stall diagnosis.
    const first = times[0] as HTMLTimeElement;
    expect(first.tagName).toBe("TIME");
    expect(first.getAttribute("dateTime")).toBe(asked.toISOString());
    expect(first.getAttribute("title")).toBeTruthy();
  });

  it("shows the manifest's empty-state copy on the Q&A tab when no flag has been raised", () => {
    render(<Inspector task={task({ qa: [] })} />);
    openTab("Q&A");
    expect(screen.getByText("No parley yet — this soul hasn't raised a flag.")).toBeTruthy();
  });
});

describe("Inspector tabs follow the WAI-ARIA APG Tabs pattern (manual activation)", () => {
  it("wires tab ids to the panel via aria-controls / aria-labelledby", () => {
    render(<Inspector task={task()} />);
    const brief = screen.getByRole("tab", { name: "BRIEF" });
    const panel = screen.getByRole("tabpanel");
    const tabId = brief.getAttribute("id");
    const panelId = panel.getAttribute("id");
    expect(tabId).toBeTruthy();
    expect(panelId).toBeTruthy();
    expect(brief.getAttribute("aria-controls")).toBe(panelId);
    expect(panel.getAttribute("aria-labelledby")).toBe(tabId);

    openTab("LOGS");
    const logs = screen.getByRole("tab", { name: "LOGS" });
    expect(screen.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe(logs.getAttribute("id"));
    expect(logs.getAttribute("aria-controls")).toBe(panelId);
  });

  it("uses roving tabindex: only the selected tab is in the tab order", () => {
    render(<Inspector task={task()} />);
    expect(screen.getByRole("tab", { name: "BRIEF" }).tabIndex).toBe(0);
    expect(screen.getByRole("tab", { name: "LOGS" }).tabIndex).toBe(-1);
    expect(screen.getByRole("tab", { name: "REPORT" }).tabIndex).toBe(-1);
    expect(screen.getByRole("tab", { name: "Q&A" }).tabIndex).toBe(-1);

    openTab("REPORT");
    expect(screen.getByRole("tab", { name: "BRIEF" }).tabIndex).toBe(-1);
    expect(screen.getByRole("tab", { name: "REPORT" }).tabIndex).toBe(0);
  });

  it("moves focus with ArrowLeft/ArrowRight (wrapping) without activating", () => {
    render(<Inspector task={task()} />);
    const brief = screen.getByRole("tab", { name: "BRIEF" });
    const logs = screen.getByRole("tab", { name: "LOGS" });
    const qa = screen.getByRole("tab", { name: "Q&A" });

    brief.focus();
    fireEvent.keyDown(brief, { key: "ArrowRight" });
    expect(document.activeElement).toBe(logs);
    expect(brief.getAttribute("aria-selected")).toBe("true");
    expect(logs.getAttribute("aria-selected")).toBe("false");

    fireEvent.keyDown(logs, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(brief);

    fireEvent.keyDown(brief, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(qa);
    expect(brief.getAttribute("aria-selected")).toBe("true");
  });

  it("jumps focus to first/last tab with Home/End", () => {
    render(<Inspector task={task()} />);
    const brief = screen.getByRole("tab", { name: "BRIEF" });
    const logs = screen.getByRole("tab", { name: "LOGS" });
    const qa = screen.getByRole("tab", { name: "Q&A" });

    brief.focus();
    fireEvent.keyDown(brief, { key: "ArrowRight" });
    expect(document.activeElement).toBe(logs);

    fireEvent.keyDown(logs, { key: "End" });
    expect(document.activeElement).toBe(qa);

    fireEvent.keyDown(qa, { key: "Home" });
    expect(document.activeElement).toBe(brief);
  });

  it("activates the focused tab on click without leaving selection on the prior tab", () => {
    render(<Inspector task={task()} />);
    const brief = screen.getByRole("tab", { name: "BRIEF" });
    const logs = screen.getByRole("tab", { name: "LOGS" });

    brief.focus();
    fireEvent.keyDown(brief, { key: "ArrowRight" });
    expect(document.activeElement).toBe(logs);
    // Manual activation: arrows only move focus; click (Enter/Space via native
    // button behavior) selects.
    fireEvent.click(logs);
    expect(logs.getAttribute("aria-selected")).toBe("true");
    expect(brief.getAttribute("aria-selected")).toBe("false");
    expect(logs.tabIndex).toBe(0);
  });
});
