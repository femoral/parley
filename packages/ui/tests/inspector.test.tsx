/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    queuePosition: null,
    blockingCap: null,
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
    attempts: [
      {
        id: "t1abcdef",
        attempt: 1,
        state: "running",
        stateLabel: "RUNNING",
        stateColor: "var(--state-running)",
        resumed: false,
        cacheBadge: null,
        score: null,
        scoreValue: null,
        baselineValue: null,
        legacy: false,
        current: true,
      },
    ],
    ...overrides,
  };
}

function openTab(label: string): void {
  fireEvent.click(screen.getByRole("tab", { name: label }));
}

/** Dispatch a Popover API `toggle` with `newState` (happy-dom may lack full popover support). */
function firePopoverToggle(el: HTMLElement, newState: "open" | "closed"): void {
  const ToggleEventCtor = (globalThis as unknown as { ToggleEvent?: typeof Event }).ToggleEvent;
  if (typeof ToggleEventCtor === "function") {
    try {
      el.dispatchEvent(
        new (ToggleEventCtor as unknown as new (
          type: string,
          init: { newState: string; oldState: string; bubbles?: boolean },
        ) => Event)("toggle", {
          newState,
          oldState: newState === "open" ? "closed" : "open",
          bubbles: true,
        }),
      );
      return;
    } catch {
      // Fall through to synthetic Event.
    }
  }
  const event = new Event("toggle", { bubbles: true });
  Object.defineProperty(event, "newState", { value: newState, enumerable: true });
  Object.defineProperty(event, "oldState", {
    value: newState === "open" ? "closed" : "open",
    enumerable: true,
  });
  el.dispatchEvent(event);
}

describe("Inspector renders a quiet placeholder with no selection (#68)", () => {
  it("shows a select-a-task prompt and no tabs when task is null", () => {
    render(<Inspector task={null} />);
    expect(screen.getByText(/Select a soul from the roster/)).toBeTruthy();
    expect(screen.queryByRole("tablist")).toBeNull();
  });

  it("shows quiet shortcut hints so the empty plate earns its footprint", () => {
    render(<Inspector task={null} />);
    const keys = screen.getByLabelText("Keyboard shortcuts");
    expect(keys).toBeTruthy();
    expect(keys.textContent).toMatch(/find session/);
    expect(keys.textContent).toMatch(/next flag that needs you/);
    expect(keys.textContent).toMatch(/toggle Soundings/);
    expect(keys.textContent).toMatch(/clear task selection/);
  });
});

describe("Inspector header (#68)", () => {
  it("shows the LOGBOOK title, task name, id, and state badge", () => {
    const { container } = render(<Inspector task={task()} />);
    expect(screen.getByText("LOGBOOK")).toBeTruthy();
    // Name and id share the header's subtitle line beneath the brass title.
    const sub = container.querySelector(".pc-inspector__name-sub");
    expect(sub?.textContent).toContain("chart-the-bay");
    expect(sub?.textContent).toContain("t1abcdef");
    expect(screen.getAllByText("RUNNING").length).toBeGreaterThanOrEqual(1);
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

  it("exposes eval feedback via a more/less disclosure (not title-only)", () => {
    const feedback = "Strong result; tighten the final summary.";
    const { container } = render(
      <Inspector task={task({ evalScore: 8, evalFeedback: feedback })} />,
    );
    const text = container.querySelector(".pc-inspector__eval-feedback-text");
    expect(text?.getAttribute("title")).toBeNull();
    const toggle = screen.getByRole("button", { name: "more" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(screen.getByRole("button", { name: "less" }).getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector(".pc-inspector__eval-feedback-text--open")).toBeTruthy();
  });

  it("omits eval feedback when absent", () => {
    render(<Inspector task={task({ evalFeedback: null })} />);
    expect(screen.queryByText("EVALUATION")).toBeNull();
  });
});

describe("Inspector never draws corner flourishes (#127)", () => {
  it("omits flourishes in the populated state", () => {
    const { container } = render(<Inspector task={task()} />);
    expect(container.querySelector(".pc-flourish")).toBeNull();
  });

  it("omits flourishes in the empty state", () => {
    const { container } = render(<Inspector task={null} />);
    expect(container.querySelector(".pc-flourish")).toBeNull();
  });
});

describe("Inspector's four tabs render per the manifest's inspector treatment (#68)", () => {
  it("opens on the Brief tab by default, showing goal/branch/model/usage", () => {
    render(<Inspector task={task()} />);
    expect(screen.getByRole("tab", { name: "BRIEF" }).getAttribute("aria-selected")).toBe("true");
    // The goal renders twice: the clamped excerpt in the well plus the full
    // text inside the "Standing Orders" popover.
    expect(screen.getAllByText("Survey the northern shoal and report depth.")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Read full orders" })).toBeTruthy();
    expect(screen.getByText("feat/bay")).toBeTruthy();
    expect(screen.getByText(/codex-5/)).toBeTruthy();
    expect(screen.getByText(/3m 41s/)).toBeTruthy();
    expect(screen.getByText(/Sandbox: workspace/)).toBeTruthy();
    expect(screen.getByText(/Network: disabled/)).toBeTruthy();
    expect(
      screen.getByText(/Parley never merges on its own — the branch waits for your orchestrator/),
    ).toBeTruthy();
  });

  it("omits Read full orders when no brief goal is filed", () => {
    render(
      <Inspector
        task={task({
          brief: {
            goal: null,
            branch: "feat/bay",
            worktree: "/parley/worktrees/t1",
            model: "codex-5",
            effort: "high",
            sandbox: "workspace",
            network: false,
            duration: "3m 41s",
            usage: "1.2k ▸ 340 tok",
          },
        })}
      />,
    );
    expect(screen.getByText("No brief on file for this voyage.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Read full orders" })).toBeNull();
    expect(screen.queryByText("Standing Orders")).toBeNull();
  });

  it("omits Read full orders when the brief goal is only whitespace", () => {
    render(
      <Inspector
        task={task({
          brief: {
            goal: "   \n\t  ",
            branch: null,
            worktree: null,
            model: null,
            effort: null,
            sandbox: null,
            network: null,
            duration: null,
            usage: null,
          },
        })}
      />,
    );
    expect(screen.queryByRole("button", { name: "Read full orders" })).toBeNull();
  });

  it("uses useId-derived popover ids (not hardcoded pc-brief-orders)", () => {
    const { container } = render(<Inspector task={task()} />);
    expect(container.querySelector("#pc-brief-orders")).toBeNull();
    const open = screen.getByRole("button", { name: "Read full orders" });
    const target = open.getAttribute("popovertarget");
    expect(target).toBeTruthy();
    expect(target).not.toBe("pc-brief-orders");
    expect(container.querySelector(`#${CSS.escape(target!)}`)).toBeTruthy();
  });

  it("moves focus into the full-orders popover on open", () => {
    const { container } = render(<Inspector task={task()} />);
    const open = screen.getByRole("button", { name: "Read full orders" });
    const target = open.getAttribute("popovertarget")!;
    const pop = container.querySelector(`#${CSS.escape(target)}`) as HTMLElement;
    expect(pop).toBeTruthy();
    expect(pop.getAttribute("tabindex")).toBe("-1");

    // happy-dom may not fully implement Popover API open — dispatch the
    // toggle event the component listens for (newState: open).
    open.focus();
    expect(document.activeElement).toBe(open);
    firePopoverToggle(pop, "open");
    expect(document.activeElement).toBe(pop);
  });

  it("moves focus into the full-report popover on open", () => {
    const { container } = render(
      <Inspector
        task={task({
          state: "completed",
          report: {
            outcome: "success",
            summary: "Charted the bay end to end.",
            files: [],
          },
        })}
      />,
    );
    openTab("REPORT");
    const open = screen.getByRole("button", { name: "Read full report" });
    const target = open.getAttribute("popovertarget")!;
    const pop = container.querySelector(`#${CSS.escape(target)}`) as HTMLElement;
    expect(pop.getAttribute("tabindex")).toBe("-1");

    open.focus();
    firePopoverToggle(pop, "open");
    expect(document.activeElement).toBe(pop);
  });

  it("scrolls the inspector into view with block:start when openSeq advances", () => {
    const scrollIntoView = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrollIntoView;
    try {
      const { rerender } = render(<Inspector task={task()} openSeq={1} />);
      expect(scrollIntoView).toHaveBeenCalled();
      const firstCall = scrollIntoView.mock.calls.at(-1)?.[0] as ScrollIntoViewOptions;
      // block:"start" pins the LOGBOOK header at the top of the rail (not a
      // bottom-edge sliver from block:"nearest").
      expect(firstCall).toMatchObject({ block: "start" });
      expect(["smooth", "auto"]).toContain(firstCall.behavior);

      scrollIntoView.mockClear();
      rerender(<Inspector task={task()} openSeq={2} />);
      expect(scrollIntoView).toHaveBeenCalled();
      const secondCall = scrollIntoView.mock.calls.at(-1)?.[0] as ScrollIntoViewOptions;
      expect(secondCall).toMatchObject({ block: "start" });
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  it("does not scroll when there is no selected task", () => {
    const scrollIntoView = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrollIntoView;
    try {
      render(<Inspector task={null} openSeq={3} />);
      expect(scrollIntoView).not.toHaveBeenCalled();
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  it("moves focus to the LOGBOOK heading when openSeq advances", async () => {
    const scrollIntoView = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrollIntoView;
    try {
      const { rerender } = render(<Inspector task={task()} openSeq={1} />);
      const heading = screen.getByRole("heading", { name: "LOGBOOK" });
      expect(heading.getAttribute("tabindex")).toBe("-1");
      // Focus is deferred to rAF so the heading lands after scroll.
      await waitFor(() => {
        expect(document.activeElement).toBe(heading);
      });

      // Re-open (same task, new seq) re-applies focus.
      const outside = document.createElement("button");
      document.body.appendChild(outside);
      outside.focus();
      expect(document.activeElement).toBe(outside);
      rerender(<Inspector task={task()} openSeq={2} />);
      await waitFor(() => {
        expect(document.activeElement).toBe(
          screen.getByRole("heading", { name: "LOGBOOK" }),
        );
      });
      outside.remove();
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  it("does not steal focus from a text field when openSeq advances", async () => {
    const scrollIntoView = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrollIntoView;
    try {
      const input = document.createElement("input");
      input.type = "text";
      document.body.appendChild(input);
      input.focus();
      expect(document.activeElement).toBe(input);

      render(<Inspector task={task()} openSeq={5} />);
      // Let rAF settle if any were scheduled for focus.
      await new Promise((r) => requestAnimationFrame(() => r(undefined)));
      await new Promise((r) => requestAnimationFrame(() => r(undefined)));
      expect(document.activeElement).toBe(input);
      input.remove();
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  it("renders the attempt-lineage timeline with badges and scores (#166)", () => {
    render(
      <Inspector
        task={task({
          id: "fix1",
          attempts: [
            {
              id: "root",
              attempt: 1,
              state: "completed",
              stateLabel: "COMPLETED",
              stateColor: "var(--state-completed)",
              resumed: false,
              cacheBadge: null,
              score: "4/5",
              scoreValue: 4,
              baselineValue: 5,
              legacy: false,
              current: false,
            },
            {
              id: "fix1",
              attempt: 2,
              state: "completed",
              stateLabel: "COMPLETED",
              stateColor: "var(--state-completed)",
              resumed: true,
              cacheBadge: "cache",
              score: "9/5",
              scoreValue: 9,
              baselineValue: 5,
              legacy: false,
              current: true,
            },
          ],
        })}
      />,
    );
    const lineage = screen.getByLabelText("Attempt lineage");
    expect(lineage).toBeTruthy();
    expect(lineage.textContent).toContain("#1");
    expect(lineage.textContent).toContain("#2");
    expect(lineage.textContent).toContain("root");
    expect(lineage.textContent).toContain("fix1");
    expect(lineage.textContent).toContain("★ 4/5");
    expect(lineage.textContent).toContain("★ 9/5");
    expect(lineage.textContent).toContain("RESUMED");
    expect(lineage.textContent).toContain("CACHE");
    expect(lineage.textContent).toContain("THIS");
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

  it("offers a parley fix copy scaffold next to the failed well", () => {
    const { container } = render(
      <Inspector
        task={task({
          id: "t-failed-1",
          state: "failed",
          error: "vendor exited 1",
        })}
      />,
    );
    expect(screen.getByRole("button", { name: "Copy fix command" })).toBeTruthy();
    const scaffold = container.querySelector(".pc-brief__fix-scaffold");
    expect(scaffold?.textContent).toBe('parley fix t-failed-1 "..."');
  });

  it("opens the full log trail from the failed well", () => {
    render(
      <Inspector
        task={task({
          state: "failed",
          error: "vendor exited 1",
          logs: { lines: [{ key: 0, kind: "error", text: "diagnostic trail" }], live: false },
        })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Full trail in Logs →" }));

    expect(screen.getByRole("tab", { name: "LOGS" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("diagnostic trail")).toBeTruthy();
  });

  it("lands on the Q&A tab when initialTab is qa", () => {
    render(
      <Inspector
        task={task({
          qa: [
            {
              id: "q1",
              question: "Which bay?",
              answer: null,
              askedAt: "2026-01-01T00:00:00Z",
              answeredAt: null,
            },
          ],
        })}
        initialTab="qa"
        openSeq={1}
      />,
    );
    expect(screen.getByRole("tab", { name: "Q&A" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("Which bay?")).toBeTruthy();
  });

  it("still lets the user switch tabs after an initialTab landing", () => {
    render(<Inspector task={task()} initialTab="qa" openSeq={1} />);
    expect(screen.getByRole("tab", { name: "Q&A" }).getAttribute("aria-selected")).toBe("true");
    openTab("BRIEF");
    expect(screen.getByRole("tab", { name: "BRIEF" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("feat/bay")).toBeTruthy();
  });

  it("omits debug character counts from the GOAL well", () => {
    const { container } = render(<Inspector task={task()} />);
    expect(container.querySelector(".pc-brief__goal-count")).toBeNull();
    expect(container.textContent).not.toMatch(/\d+\s+ch\b/);
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

  it("shows Ended once the log tail is no longer live (eof), not Paused", () => {
    render(<Inspector task={task({ logs: { lines: [{ key: 0, kind: "stdout", text: "done" }], live: false } })} />);
    openTab("LOGS");
    expect(screen.getByText("Ended")).toBeTruthy();
    expect(screen.queryByText("Paused")).toBeNull();
  });

  it("switches to the Report tab and renders outcome/summary/files for a completed task", () => {
    const { container } = render(
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
    // Summary renders twice: the clamped excerpt and the "Ship's Report" popover body.
    expect(screen.getAllByText("Charted the bay end to end.").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole("button", { name: "Read full report" })).toBeTruthy();
    // useId-derived report popover id (not hardcoded pc-report-orders).
    expect(container.querySelector("#pc-report-orders")).toBeNull();
    const reportOpen = screen.getByRole("button", { name: "Read full report" });
    const reportTarget = reportOpen.getAttribute("popovertarget");
    expect(reportTarget).toBeTruthy();
    expect(reportTarget).not.toBe("pc-report-orders");
    // Neutral path listing — no "+" add/delete claim the data doesn't carry.
    expect(screen.getByText("src/chart.ts")).toBeTruthy();
    expect(screen.queryByText(/^\+\s/)).toBeNull();
    expect(screen.queryByText(/Review & plant the branch/)).toBeNull();
  });

  it("omits Read full report when the summary is empty", () => {
    render(
      <Inspector
        task={task({
          state: "completed",
          report: {
            outcome: "success",
            summary: "",
            files: [{ path: "src/chart.ts" }],
          },
        })}
      />,
    );
    openTab("REPORT");
    expect(screen.getByText("SUCCESS")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Read full report" })).toBeNull();
  });

  it("shows the manifest's empty-state copy on the Report tab when there's no report yet", () => {
    render(<Inspector task={task({ report: null })} />);
    openTab("REPORT");
    expect(screen.getByText("No report yet — this soul is still at sea.")).toBeTruthy();
  });

  it("mounts a more-below scroll cue on the inspector body for the Report tab", () => {
    const { container } = render(
      <Inspector
        task={task({
          state: "completed",
          report: {
            outcome: "success",
            summary: "Charted the bay end to end.",
            files: [
              { path: "src/a.ts" },
              { path: "src/b.ts" },
              { path: "src/c.ts" },
            ],
          },
        })}
      />,
    );
    openTab("REPORT");
    const body = container.querySelector(".pc-inspector__body") as HTMLElement;
    expect(body).toBeTruthy();
    const cue = body.querySelector(".pc-inspector__scroll-cue");
    expect(cue).toBeTruthy();
    // happy-dom has no real overflow geometry — content "fits", cue starts hidden.
    expect(cue?.classList.contains("pc-inspector__scroll-cue--hidden")).toBe(true);
    expect(cue?.textContent).toContain("More below");

    Object.defineProperty(body, "scrollHeight", { configurable: true, get: () => 800 });
    Object.defineProperty(body, "clientHeight", { configurable: true, get: () => 200 });
    Object.defineProperty(body, "scrollTop", { configurable: true, get: () => 0, set: () => {} });
    fireEvent.scroll(body);
    expect(cue?.classList.contains("pc-inspector__scroll-cue--hidden")).toBe(false);

    Object.defineProperty(body, "scrollTop", { configurable: true, get: () => 600, set: () => {} });
    fireEvent.scroll(body);
    expect(cue?.classList.contains("pc-inspector__scroll-cue--hidden")).toBe(true);
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

  it("exposes the Q&A transcript as a list with speaker+time entry labels", () => {
    const asked = new Date(2026, 0, 1, 14, 2, 0);
    const answered = new Date(2026, 0, 1, 14, 5, 0);
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
          ],
        })}
      />,
    );
    openTab("Q&A");
    const list = screen.getByRole("list", { name: "Q&A transcript" });
    expect(list).toBeTruthy();
    const items = screen.getAllByRole("listitem");
    expect(items.length).toBe(2);
    expect(items[0]!.getAttribute("aria-label")).toMatch(/^Agent,/);
    expect(items[1]!.getAttribute("aria-label")).toMatch(/^You,/);
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
