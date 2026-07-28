/** @vitest-environment happy-dom */
/**
 * H3 — scrollable containers must expose a keyboard path (WCAG 2.1.1).
 * Each overflow scrollport with no focusable descendants gets tabIndex={0}
 * and an accessible name where one was missing.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  ChartKey,
  EvalHeatmap,
  InboxPanel,
  Inspector,
  LogStream,
  ReportPanel,
  SoundingsPanel,
  projectLogbookDigest,
} from "../src/hud/index.js";
import type {
  InspectorTask,
  LogbookDigest,
  RosterGroup,
  RosterTask,
  SoundingsView,
} from "../src/hud/index.js";
import { projectHeatmap } from "../src/app/hooks/metrics.js";
import type { MetricsGroup } from "@useparley/core";
import { notifyHandRolledPopoverClosed } from "../src/hud/handRolledPopover.js";

afterEach(() => {
  cleanup();
  notifyHandRolledPopoverClosed("chart-key");
});

function expectFocusable(el: Element | null, label: string): void {
  expect(el, `${label} should exist`).toBeTruthy();
  const html = el as HTMLElement;
  expect(html.tabIndex, `${label} tabIndex`).toBe(0);
  html.focus();
  expect(document.activeElement, `${label} receives focus`).toBe(html);
}

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
      goal: "Survey the northern shoal and report depth.\n".repeat(8),
      branch: "feat/bay",
      worktree: "/parley/worktrees/t1",
      model: "codex-5",
      effort: "high",
      sandbox: "workspace",
      network: false,
      duration: "3m 41s",
      usage: "1.2k ▸ 340 tok",
    },
    logs: {
      lines: Array.from({ length: 12 }, (_, i) => ({
        key: i,
        kind: "stdout" as const,
        text: `log line ${i}`,
      })),
      status: "tailing",
    },
    report: {
      summary: "The bay is charted.\n".repeat(8),
      outcome: "success",
      files: [],
    },
    qa: [],
    attempts: [],
    ...overrides,
  };
}

function rosterTask(overrides: Partial<RosterTask> & Pick<RosterTask, "id" | "name">): RosterTask {
  return {
    coat: "#10a37f",
    emblem: { kind: "svg", viewBox: "0 0 24 24", path: "M12 2" },
    faction: "Codex",
    meta: `main · ${overrides.id.slice(0, 8)}`,
    updatedAt: "2026-07-23T11:50:00.000Z",
    ...overrides,
  };
}

function fleetDigest(): LogbookDigest {
  const groups: RosterGroup[] = [
    {
      state: "running",
      tasks: [rosterTask({ id: "run1", name: "still-sailing" })],
    },
    {
      state: "completed",
      tasks: [rosterTask({ id: "done1", name: "fresh-report" })],
    },
  ];
  return projectLogbookDigest(groups, Date.parse("2026-07-23T12:00:00.000Z"));
}

function metricsGroup(overrides: Partial<MetricsGroup> = {}): MetricsGroup {
  return {
    key: "coding",
    tasks: {
      total: 2,
      completed: 1,
      failed: 0,
      cancelled: 0,
      running: 1,
      other: 0,
    },
    success_rate: 1,
    evals: {
      count: 2,
      avg: 4.5,
      avg_baseline: 5,
      avg_delta: -0.5,
      below_baseline_rate: 0.5,
      criterion_failures: {
        "brief-implemented": { failures: 1, count: 2, rate: 0.5 },
      },
      first_attempt: {
        count: 1,
        avg: 4,
        avg_baseline: 5,
        avg_delta: -1,
        below_baseline_rate: 1,
      },
      fix: {
        count: 1,
        avg: 5,
        avg_baseline: 5,
        avg_delta: 0,
        below_baseline_rate: 0,
      },
    },
    evals_by_size: {},
    evals_by_difficulty: {},
    tokens: { input: 100, output: 50, cached: 0, tasks_reporting: 1 },
    duration_ms: {
      total: 1000,
      avg: 1000,
      p50: 1000,
      p95: 1000,
      tasks_reporting: 1,
    },
    ...overrides,
  };
}

const EMPTY_FILTERS: SoundingsView["filters"] = {
  type: "",
  vendor: "",
  model: "",
  orch_harness: "",
  orch_model: "",
  eval_harness: "",
  eval_model: "",
  rubric: "",
  firstAttemptOnly: false,
  belowBaselineOnly: false,
  active: false,
};

describe("scrollport keyboard focus (H3)", () => {
  it("LogStream body (role=log) is a tab stop", () => {
    const { container } = render(
      <LogStream
        lines={[{ key: 0, kind: "stdout", text: "ahoy" }]}
        status="tailing"
      />,
    );
    const body = container.querySelector(".pc-logstream__body");
    expectFocusable(body, ".pc-logstream__body");
    expect(body?.getAttribute("role")).toBe("log");
  });

  it("SoundingsPanel tabpanel body is a tab stop", () => {
    const soundings: SoundingsView = {
      status: "ready",
      error: null,
      groups: [],
      distribution: [],
      comparison: [],
      heatmap: { criteria: [], groups: [], cells: [], sampleEvals: 0 },
      groupBy: "vendor",
      sessionLabel: "All hands",
      generatedAt: "2026-07-16T00:00:00.000Z",
      filters: EMPTY_FILTERS,
      viewTab: "groups",
      evalPresence: "ready",
    };
    const { container } = render(
      <SoundingsPanel
        soundings={soundings}
        onGroupBy={() => {}}
        onFiltersChange={() => {}}
        onFiltersClear={() => {}}
        onViewTab={() => {}}
      />,
    );
    const body = container.querySelector(".pc-soundings__body");
    expectFocusable(body, ".pc-soundings__body");
    expect(body?.getAttribute("role")).toBe("tabpanel");
  });

  it("ChartKey popover region is a tab stop", () => {
    render(<ChartKey />);
    fireEvent.click(screen.getByRole("button", { name: /Chart key/ }));
    const pop = screen.getByRole("region", { name: "Chart key" });
    expect(pop.classList.contains("pc-chart-key__pop")).toBe(true);
    expectFocusable(pop, ".pc-chart-key__pop");
  });

  it("BriefTab full-orders body is a named focusable region", () => {
    const { container } = render(<Inspector task={task()} />);
    const body = container.querySelector(".pc-brief__orders-body");
    expectFocusable(body, ".pc-brief__orders-body");
    expect(body?.getAttribute("role")).toBe("region");
    expect(body?.getAttribute("aria-label")).toBe("Full orders");
  });

  it("BriefTab error body is a named focusable region", () => {
    const { container } = render(
      <Inspector
        task={task({
          state: "failed",
          error: "vendor exited 1: workspace sandbox denied network",
        })}
      />,
    );
    const err = container.querySelector(".pc-brief__error");
    expectFocusable(err, ".pc-brief__error");
    expect(err?.getAttribute("role")).toBe("region");
    expect(err?.getAttribute("aria-label")).toBe("Failure reason");
  });

  it("ReportPanel full-report body is a named focusable region", () => {
    const { container } = render(
      <ReportPanel
        report={{
          summary: "The bay is charted.\n".repeat(8),
          outcome: "success",
          files: [],
        }}
      />,
    );
    const body = container.querySelector(".pc-report__orders-body");
    expectFocusable(body, ".pc-report__orders-body");
    expect(body?.getAttribute("role")).toBe("region");
    expect(body?.getAttribute("aria-label")).toBe("Full report");
  });

  it("Inspector digest is a named focusable region", () => {
    const { container } = render(<Inspector task={null} digest={fleetDigest()} />);
    const digestEl = container.querySelector(".pc-inspector__digest");
    expectFocusable(digestEl, ".pc-inspector__digest");
    expect(digestEl?.getAttribute("role")).toBe("region");
    expect(digestEl?.getAttribute("aria-label")).toBe("Fleet digest");
  });

  it("InboxPanel card list is a named focusable region", () => {
    // The list is clamped and scrolls, so cards below the fold must be
    // reachable without tabbing through every card above them.
    const { container } = render(
      <InboxPanel
        tasks={[
          {
            id: "t1",
            name: "rubric-version-backfill",
            state: "awaiting_answer",
            coat: "#10a37f",
            emblem: { kind: "svg", viewBox: "0 0 24 24", path: "M12 2 L20 7 V17 L12 22 L4 17 V7 Z" },
            faction: "Codex",
            meta: "parley/t1 · t1",
            question: "Which backfill strategy?",
            updatedAt: "2026-07-23T12:00:00.000Z",
            sessionId: null,
            sessionHandle: null,
            sessionShortRef: null,
          },
        ]}
        onSelectTask={() => {}}
      />,
    );
    const list = container.querySelector(".pc-inbox__list");
    expectFocusable(list, ".pc-inbox__list");
    expect(list?.getAttribute("role")).toBe("region");
    expect(list?.getAttribute("aria-label")).toBe("Tasks needing an answer");
  });

  it("EvalHeatmap scroll container is a named focusable region", () => {
    const heatmap = projectHeatmap([metricsGroup()]);
    const { container } = render(
      <EvalHeatmap
        heatmap={heatmap}
        groupBy="type"
        evalPresence="ready"
        filtersActive={false}
        onGroupBy={() => {}}
      />,
    );
    const scroll = container.querySelector(".pc-eval-heat__scroll");
    expectFocusable(scroll, ".pc-eval-heat__scroll");
    expect(scroll?.getAttribute("role")).toBe("region");
    expect(scroll?.getAttribute("aria-label")).toBe("Heatmap grid");
  });

  it("Inspector run view table wrap is a named focusable region", () => {
    const { container } = render(
      <Inspector
        task={null}
        run={{
          status: "ready",
          id: "r-scroll01",
          workflow: "research",
          workflowVersion: 1,
          runState: "running",
          stateLabel: "running",
          branch: null,
          currentNode: "search",
          iteration: 1,
          duration: null,
          tasksTotal: 3,
          heldGate: false,
          deliverables: {
            status: "ready",
            items: [
              {
                treatment: "inline",
                id: "d-scroll-well",
                address: "funnel.1/shortlist",
                typeLabel: null,
                json:
                  "{\n  " +
                  Array.from({ length: 20 }, (_, i) => `"k${i}": ${i}`).join(",\n  ") +
                  "\n}",
              },
            ],
          },
          block: null,
          nodes: [
            {
              key: "scope\u00001",
              node: "scope",
              kind: "step",
              iteration: 1,
              state: "completed",
              stateLabel: "completed",
              tasksLabel: "1",
              gist: "ok",
              age: "2m",
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
              state: "running",
              stateLabel: "running",
              tasksLabel: "2",
              gist: "still out",
              age: "1m",
              fanoutWidth: 2,
              spineState: "running",
              live: true,
              onReject: null,
            },
          ],
        }}
      />,
    );
    const wrap = container.querySelector(".pc-runview__table-wrap");
    expectFocusable(wrap, ".pc-runview__table-wrap");
    expect(wrap?.getAttribute("role")).toBe("region");
    expect(wrap?.getAttribute("aria-label")).toBe("Run node table");

    // #255 F5 — inline deliverable report well is a named focusable scrollport.
    const dlvWell = container.querySelector(".pc-dlv__well--report");
    expectFocusable(dlvWell, ".pc-dlv__well--report");
    expect(dlvWell?.getAttribute("role")).toBe("region");
    expect(dlvWell?.getAttribute("aria-label")).toMatch(/Inline value for funnel\.1\/shortlist/);
  });
});
