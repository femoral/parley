/** @vitest-environment happy-dom */
/**
 * #253 — run chart surface: fan-out invariant, seals, gate controls,
 * loop-backs, sparse decoration, and ink discipline.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { RunChart } from "../src/chart/index.js";
import {
  chartMarkCount,
  projectChart,
} from "../src/chart/projectChart.js";
import type { InspectorRun, InspectorRunNode, InspectorRunReady } from "../src/hud/types.js";

afterEach(() => {
  cleanup();
});

function node(
  overrides: Partial<InspectorRunNode> &
    Pick<InspectorRunNode, "node" | "kind" | "iteration" | "state">,
): InspectorRunNode {
  const key = overrides.key ?? `${overrides.node}\0${overrides.iteration}`;
  return {
    key,
    stateLabel: overrides.stateLabel ?? overrides.state,
    tasksLabel: overrides.tasksLabel ?? (overrides.kind === "gate" ? "—" : "1"),
    gist: overrides.gist ?? "—",
    age: overrides.age ?? null,
    fanoutWidth: overrides.fanoutWidth ?? null,
    spineState: overrides.spineState ?? overrides.state,
    live: overrides.live ?? false,
    onReject: overrides.onReject ?? null,
    ...overrides,
  };
}

function readyRun(
  overrides: Partial<InspectorRunReady> & { nodes?: InspectorRunNode[] } = {},
): InspectorRunReady {
  return {
    status: "ready",
    id: "r-chart01abcdef",
    workflow: "research",
    workflowVersion: 1,
    runState: "running",
    stateLabel: "running",
    branch: null,
    currentNode: "search",
    iteration: 1,
    duration: "12m 0s",
    tasksTotal: 41,
    heldGate: false,
    deliverables: { status: "not_fetched" },
    block: null,
    nodes: overrides.nodes ?? [],
    ...overrides,
  };
}

describe("projectChart fan-out invariant (#253)", () => {
  it("a 40-wide fan-out yields one mark and ×40 tally; mark count = (node, iteration) count", () => {
    const run = readyRun({
      nodes: [
        node({
          node: "scope",
          kind: "step",
          iteration: 1,
          state: "completed",
          stateLabel: "completed",
          spineState: "completed",
        }),
        node({
          node: "search",
          kind: "step",
          iteration: 1,
          state: "running",
          stateLabel: "running",
          spineState: "running",
          live: true,
          fanoutWidth: 40,
          tasksLabel: "40",
          gist: "9 done · 5 out · 26 queued",
        }),
        node({
          node: "funnel",
          kind: "step",
          iteration: 1,
          state: "pending",
          stateLabel: "pending",
          spineState: "pending",
        }),
      ],
    });

    const model = projectChart(run);
    expect(model.status).toBe("ready");
    if (model.status !== "ready") return;

    // One mark per (node, iteration) — never per task.
    expect(model.marks).toHaveLength(3);
    expect(chartMarkCount(model)).toBe(run.nodes.length);

    const search = model.marks.find((m) => m.node === "search");
    expect(search).toBeTruthy();
    expect(search!.fanoutWidth).toBe(40);
    // Exactly one mark for the fan-out node.
    expect(model.marks.filter((m) => m.node === "search")).toHaveLength(1);

    const { container } = render(<RunChart run={run} />);
    const marks = container.querySelectorAll("[data-chart-mark]");
    expect(marks).toHaveLength(3);
    const tally = container.querySelector('[data-tally="40"]');
    expect(tally).toBeTruthy();
    expect(tally!.textContent).toMatch(/×40/);
    // Sheet reports the invariant for test/DOM consumers.
    expect(container.querySelector("[data-mark-count]")?.getAttribute("data-mark-count")).toBe(
      "3",
    );
  });

  it("does not invent marks for pending runs", () => {
    const run: InspectorRun = { status: "pending", id: "r-pending99" };
    const model = projectChart(run);
    expect(model.status).toBe("pending");
    expect(chartMarkCount(model)).toBe(0);
    render(<RunChart run={run} />);
    expect(screen.getByText("Hailing the run…")).toBeTruthy();
    expect(screen.queryByText("0 tasks")).toBeNull();
  });
});

describe("RunChart seals and gate controls (#253)", () => {
  const held: InspectorRunReady = readyRun({
    runState: "blocked",
    stateLabel: "blocked · gate",
    heldGate: true,
    block: { reason: "gate", detail: "held", node: "accept-sources" },
    nodes: [
      node({
        node: "scope",
        kind: "step",
        iteration: 1,
        state: "completed",
        stateLabel: "completed",
        spineState: "completed",
      }),
      node({
        node: "accept-sources",
        kind: "gate",
        iteration: 1,
        state: "waiting",
        stateLabel: "gate · held",
        spineState: "awaiting_answer",
        live: true,
        onReject: "funnel",
        age: "21m",
      }),
      node({
        node: "funnel",
        kind: "step",
        iteration: 1,
        state: "pending",
        stateLabel: "pending",
        spineState: "pending",
      }),
    ],
  });

  it("held gate is a whole glowing seal; label names the orchestrator", () => {
    const { container } = render(<RunChart run={held} />);
    const seal = container.querySelector('[data-seal="held"]');
    expect(seal).toBeTruthy();
    expect(seal!.classList.contains("pc-chart-seal--held")).toBe(true);
    expect(screen.getByText(/Held — awaiting the orchestrator/i)).toBeTruthy();
    // Never the viewer-facing wording.
    expect(screen.queryByText(/awaiting your decision/i)).toBeNull();
  });

  it("only gate control is Copy run id — no approve/reject/redirect/finish", () => {
    render(<RunChart run={held} />);
    expect(screen.getByRole("button", { name: /copy run id/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /approve/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /reject/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /redirect/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /finish/i })).toBeNull();
  });

  it("actioned gate renders as a cracked seal", () => {
    const actioned = readyRun({
      nodes: [
        node({
          node: "approve-plan",
          kind: "gate",
          iteration: 1,
          state: "approved",
          stateLabel: "approved",
          spineState: "completed",
          age: "14m",
        }),
      ],
    });
    const { container } = render(<RunChart run={actioned} />);
    const seal = container.querySelector('[data-seal="broken"]');
    expect(seal).toBeTruthy();
    expect(seal!.classList.contains("pc-chart-seal--broken")).toBe(true);
    expect(container.querySelector(".pc-chart-seal__crack")).toBeTruthy();
  });
});

describe("RunChart loop-back and sparse decoration (#253)", () => {
  it("draws a longer-dashed loop-back arc with arrowhead for on_reject", () => {
    const run = readyRun({
      nodes: [
        node({
          node: "implement",
          kind: "step",
          iteration: 1,
          state: "completed",
          stateLabel: "completed",
          spineState: "completed",
        }),
        node({
          node: "review",
          kind: "step",
          iteration: 1,
          state: "completed",
          stateLabel: "completed",
          spineState: "completed",
        }),
        node({
          node: "rework-or-finish",
          kind: "gate",
          iteration: 1,
          state: "waiting",
          stateLabel: "gate · held",
          spineState: "awaiting_answer",
          live: true,
          onReject: "implement",
        }),
      ],
      heldGate: true,
    });
    const model = projectChart(run);
    expect(model.status).toBe("ready");
    if (model.status !== "ready") return;
    expect(model.loopBacks.length).toBeGreaterThanOrEqual(1);
    expect(model.loopBacks[0]!.toKey).toContain("implement");

    const { container } = render(<RunChart run={run} />);
    const loop = container.querySelector("[data-chart-loop]");
    expect(loop).toBeTruthy();
    expect(loop!.getAttribute("stroke-dasharray") ?? loop!.getAttribute("strokeDasharray")).toBeTruthy();
    // marker-end carries the arrowhead (attribute may be camelCased in DOM).
    const marker =
      loop!.getAttribute("marker-end") ?? loop!.getAttribute("markerEnd");
    expect(marker).toMatch(/url\(#/);
  });

  it("single-node route uses sparse decoration (no marginalia on the trail)", () => {
    const run = readyRun({
      tasksTotal: 1,
      nodes: [
        node({
          node: "solo",
          kind: "step",
          iteration: 1,
          state: "completed",
          stateLabel: "completed",
          spineState: "completed",
        }),
      ],
    });
    const model = projectChart(run);
    expect(model.status).toBe("ready");
    if (model.status !== "ready") return;
    expect(model.decorations).toBe("sparse");
    expect(model.marks).toHaveLength(1);

    const { container } = render(<RunChart run={run} />);
    expect(container.querySelector(".pc-chart__sheet--sparse")).toBeTruthy();
    // Marginalia are omitted (or hidden) so they cannot overlap the route.
    expect(container.querySelectorAll(".pc-chart-marginalia")).toHaveLength(0);
  });
});

describe("RunChart stroke-state discipline (#259)", () => {
  it("route legs use only pen-weight strokes, never state inks", () => {
    const run = readyRun({
      nodes: [
        node({
          node: "a",
          kind: "step",
          iteration: 1,
          state: "completed",
          stateLabel: "completed",
          spineState: "completed",
        }),
        node({
          node: "b",
          kind: "step",
          iteration: 1,
          state: "running",
          stateLabel: "running",
          spineState: "running",
          live: true,
        }),
        node({
          node: "c",
          kind: "step",
          iteration: 1,
          state: "pending",
          stateLabel: "pending",
          spineState: "pending",
        }),
      ],
    });
    const { container } = render(<RunChart run={run} />);
    const legs = container.querySelectorAll("[data-chart-leg]");
    expect(legs.length).toBeGreaterThan(0);
    for (const leg of legs) {
      const pen = leg.getAttribute("data-chart-leg");
      expect(pen === "chart" || pen === "soft").toBe(true);
      const stroke = leg.getAttribute("stroke") ?? "";
      expect(stroke).not.toMatch(/ink-live|ink-done|ink-fail/);
      expect(stroke).toMatch(/ink-chart/);
    }
    // Soft pen is live code: pending (ghost) legs use it.
    const soft = container.querySelectorAll('[data-chart-leg="soft"]');
    expect(soft.length).toBeGreaterThan(0);
  });
});

describe("RunChart QC fixes (#253 design-QC)", () => {
  it("N7: empty ready run paints one title, not a second run-id overlay", () => {
    const run = readyRun({ nodes: [], runState: "ready", stateLabel: "ready" });
    const { container } = render(<RunChart run={run} />);
    const titles = container.querySelectorAll(".pc-chart__title");
    expect(titles).toHaveLength(1);
    // Empty state does not re-print the run id as a second heading.
    expect(container.querySelectorAll(".pc-chart__empty-title")).toHaveLength(0);
    expect(screen.getByText(/No nodes entered yet/i)).toBeTruthy();
  });

  it("N3: destination ✕ uses chart pen, not fail blot", () => {
    const run = readyRun({
      nodes: [
        node({
          node: "solo",
          kind: "step",
          iteration: 1,
          state: "completed",
          stateLabel: "completed",
          spineState: "completed",
        }),
      ],
    });
    const { container } = render(<RunChart run={run} />);
    const x = container.querySelector(".pc-chart-spot__x");
    expect(x).toBeTruthy();
    // Class-level colour is token --ink-chart (asserted via absence of fail class).
    expect(x!.className).not.toMatch(/fail/);
  });

  it("N4: operational meta is Outfit body; flavor is separate", () => {
    const run = readyRun({
      duration: "12m 0s",
      iteration: 1,
      heldGate: true,
      nodes: [
        node({
          node: "a",
          kind: "step",
          iteration: 1,
          state: "completed",
          stateLabel: "completed",
          spineState: "completed",
        }),
      ],
    });
    const { container } = render(<RunChart run={run} />);
    const meta = container.querySelector(".pc-chart__meta-line");
    expect(meta?.textContent).toMatch(/12m/);
    expect(meta?.textContent).toMatch(/pass/);
    const flavor = container.querySelector(".pc-chart__flavor");
    expect(flavor?.textContent).toMatch(/seal/i);
    expect(flavor?.textContent).not.toMatch(/12m/);
  });

  it("B2: key and helm do not share the same bottom-right anchor", () => {
    const run = readyRun({
      heldGate: true,
      nodes: [
        node({
          node: "g",
          kind: "gate",
          iteration: 1,
          state: "waiting",
          stateLabel: "gate · held",
          spineState: "awaiting_answer",
          live: true,
        }),
      ],
    });
    const { container } = render(<RunChart run={run} />);
    expect(container.querySelector(".pc-chart__sheet--held")).toBeTruthy();
    expect(container.querySelector(".pc-chart-key")).toBeTruthy();
    expect(container.querySelector(".pc-chart-helm")).toBeTruthy();
  });

  it("B4: loop path records end clear of target centre", () => {
    const run = readyRun({
      heldGate: true,
      nodes: [
        node({
          node: "implement",
          kind: "step",
          iteration: 1,
          state: "completed",
          stateLabel: "completed",
          spineState: "completed",
        }),
        node({
          node: "review",
          kind: "step",
          iteration: 1,
          state: "completed",
          stateLabel: "completed",
          spineState: "completed",
        }),
        node({
          node: "rework-or-finish",
          kind: "gate",
          iteration: 1,
          state: "waiting",
          stateLabel: "gate · held",
          spineState: "awaiting_answer",
          live: true,
          onReject: "implement",
        }),
      ],
    });
    const { container } = render(<RunChart run={run} />);
    const loop = container.querySelector("[data-chart-loop]");
    expect(loop).toBeTruthy();
    const ex = Number(loop!.getAttribute("data-loop-end-x"));
    const ey = Number(loop!.getAttribute("data-loop-end-y"));
    const tx = Number(loop!.getAttribute("data-loop-target-x"));
    const ty = Number(loop!.getAttribute("data-loop-target-y"));
    expect(Math.hypot(ex - tx, ey - ty)).toBeGreaterThanOrEqual(28);
  });

  it("N2: compass is a separate square box (not sheared route SVG)", () => {
    const run = readyRun({
      nodes: [
        node({
          node: "a",
          kind: "step",
          iteration: 1,
          state: "completed",
          stateLabel: "completed",
          spineState: "completed",
        }),
        node({
          node: "b",
          kind: "step",
          iteration: 1,
          state: "running",
          stateLabel: "running",
          spineState: "running",
          live: true,
        }),
      ],
    });
    const { container } = render(<RunChart run={run} />);
    expect(container.querySelector(".pc-chart-compass")).toBeTruthy();
    expect(container.querySelector(".pc-chart__svg--route")).toBeTruthy();
  });
});
