/** @vitest-environment happy-dom */
/**
 * #255 — deliverable treatments, purged empty state, fork vocabulary.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { DeliverableValue, RunDetailResponse } from "@useparley/core";
import {
  formatDeliverableAddress,
  formatDeliverableSize,
  formatNodeStateLabel,
  projectDeliverable,
  projectDeliverables,
  projectInspectorRun,
} from "../src/app/hooks/runs.js";
import { Inspector } from "../src/hud/index.js";
import type { InspectorRun } from "../src/hud/types.js";

afterEach(cleanup);

const HUD_CSS = readFileSync(
  resolve(
    process.cwd(),
    process.cwd().endsWith("packages/ui") ? "src/hud/hud.css" : "packages/ui/src/hud/hud.css",
  ),
  "utf8",
);

function wireValue(
  partial: Partial<DeliverableValue> &
    Pick<DeliverableValue, "deliverable_id" | "kind" | "node" | "port">,
): DeliverableValue {
  return {
    run_id: "r-c04e",
    iteration: 1,
    slot: null,
    task_id: "t1",
    type: null,
    size: null,
    created_at: "2026-07-01T00:00:00.000Z",
    purged_at: null,
    value: null,
    path: null,
    absolute_path: null,
    exists: null,
    note: null,
    ...partial,
  };
}

function baseRun(overrides: Partial<Extract<InspectorRun, { status: "ready" }>> = {}): InspectorRun {
  return {
    status: "ready",
    id: "r-c04e0001",
    workflow: "coding-1",
    workflowVersion: 1,
    runState: "completed",
    stateLabel: "completed",
    branch: null,
    currentNode: null,
    iteration: 1,
    duration: "4m",
    tasksTotal: 2,
    heldGate: false,
    block: null,
    deliverables: { status: "not_fetched" },
    nodes: [
      {
        key: "plan\u00000",
        node: "plan",
        kind: "step",
        iteration: 0,
        state: "inherited",
        stateLabel: "inherited",
        tasksLabel: "—",
        gist: "copied from parent",
        age: null,
        fanoutWidth: null,
        spineState: "cancelled",
        live: false,
        onReject: null,
      },
      {
        key: "approve-plan\u00000",
        node: "approve-plan",
        kind: "gate",
        iteration: 0,
        state: "skipped",
        stateLabel: "skipped",
        tasksLabel: "—",
        gist: "gate has no ports to inherit",
        age: null,
        fanoutWidth: null,
        spineState: "cancelled",
        live: false,
        onReject: null,
      },
      {
        key: "implement\u00001",
        node: "implement",
        kind: "step",
        iteration: 1,
        state: "completed",
        stateLabel: "completed",
        tasksLabel: "1",
        gist: "ok",
        age: "4m",
        fanoutWidth: null,
        spineState: "completed",
        live: false,
        onReject: null,
      },
    ],
    ...overrides,
  };
}

describe("projectDeliverable treatments (#255)", () => {
  it("projects inline JSON for the report well", () => {
    const v = wireValue({
      deliverable_id: "d-inline",
      kind: "inline",
      node: "funnel",
      port: "shortlist",
      type: "dict<string, source[]>",
      value: { backoff: [1, 2] },
      size: { keys: 1 },
    });
    const item = projectDeliverable(v);
    expect(item.treatment).toBe("inline");
    if (item.treatment !== "inline") throw new Error("expected inline");
    expect(item.address).toBe("funnel.1/shortlist");
    expect(item.typeLabel).toBe("dict<string, source[]>");
    expect(item.json).toContain("backoff");
    expect(item.json).toContain("1");
  });

  it("projects file/dir as reference-only with path and size", () => {
    const file = projectDeliverable(
      wireValue({
        deliverable_id: "d-file",
        kind: "file",
        node: "implement",
        port: "patch",
        iteration: 2,
        path: ".parley/tmp/implement.2/out/patch.diff",
        size: { bytes: 14_336 },
      }),
    );
    expect(file.treatment).toBe("reference");
    if (file.treatment !== "reference") throw new Error("expected reference");
    expect(file.kind).toBe("file");
    expect(file.path).toBe(".parley/tmp/implement.2/out/patch.diff");
    expect(file.sizeLabel).toMatch(/kB/);

    const dir = projectDeliverable(
      wireValue({
        deliverable_id: "d-dir",
        kind: "dir",
        node: "search",
        port: "captures",
        path: "…/out/captures/",
        size: { elements: 11 },
      }),
    );
    expect(dir.treatment).toBe("reference");
    if (dir.treatment !== "reference") throw new Error("expected reference");
    expect(dir.kind).toBe("dir");
    expect(dir.sizeLabel).toBe("11 files");
  });

  it("projects purged_at as a first-class purged treatment", () => {
    const item = projectDeliverable(
      wireValue({
        deliverable_id: "d-purged",
        kind: "inline",
        node: "search",
        port: "sources",
        value: null,
        purged_at: "2026-06-24T12:00:00Z",
        note: "purged on 2026-06-24 (run r-c04e, search.1/sources)",
      }),
    );
    expect(item.treatment).toBe("purged");
    if (item.treatment !== "purged") throw new Error("expected purged");
    expect(item.address).toBe("search.1/sources");
    expect(item.note).toMatch(/purged on 2026-06-24/);
  });

  it("distinguishes not_fetched, none, and ready", () => {
    expect(projectDeliverables(undefined).status).toBe("not_fetched");
    expect(projectDeliverables([]).status).toBe("none");
    const ready = projectDeliverables([
      wireValue({
        deliverable_id: "d1",
        kind: "inline",
        node: "a",
        port: "out",
        value: 1,
      }),
    ]);
    expect(ready.status).toBe("ready");
    if (ready.status !== "ready") throw new Error("expected ready");
    expect(ready.items).toHaveLength(1);
  });

  it("formatDeliverableAddress matches daemon form", () => {
    expect(
      formatDeliverableAddress({
        node: "search",
        port: "sources",
        iteration: 1,
        slot: "hybrid-search",
      }),
    ).toBe("search.1[hybrid-search]/sources");
    expect(formatDeliverableSize({ bytes: 500 })).toBe("500 B");
    expect(formatDeliverableSize({ bytes: 14_336 })).toMatch(/kB/);
  });
});

describe("deliverable render treatments (#255)", () => {
  it("renders inline JSON in a report-tinted well", () => {
    const run = baseRun({
      deliverables: {
        status: "ready",
        items: [
          {
            treatment: "inline",
            id: "d-inline",
            address: "funnel.1/shortlist",
            typeLabel: "dict<string, source[]>",
            json: '{\n  "backoff": [1, 2]\n}',
          },
        ],
      },
    });
    render(<Inspector task={null} run={run} />);
    const card = document.querySelector('[data-treatment="inline"]');
    expect(card).toBeTruthy();
    expect(card?.textContent).toMatch(/backoff/);
    expect(card?.querySelector(".pc-dlv__well--report")).toBeTruthy();
    // No download / open / preview controls.
    expect(screen.queryByRole("button", { name: /download|preview|open/i })).toBeNull();
  });

  it("renders file/dir with path, size, and explicit reference-only copy", () => {
    const run = baseRun({
      deliverables: {
        status: "ready",
        items: [
          {
            treatment: "reference",
            id: "d-file",
            address: "implement.2/patch",
            kind: "file",
            path: ".parley/tmp/implement.2/out/patch.diff",
            sizeLabel: "14 kB",
          },
          {
            treatment: "reference",
            id: "d-dir",
            address: "search.1/captures",
            kind: "dir",
            path: "…/out/captures/",
            sizeLabel: "11 files",
          },
        ],
      },
    });
    render(<Inspector task={null} run={run} />);
    expect(screen.getByText(/patch\.diff/)).toBeTruthy();
    expect(screen.getByText(/14 kB/)).toBeTruthy();
    expect(screen.getByText(/out\/captures/)).toBeTruthy();
    expect(screen.getByText(/11 files/)).toBeTruthy();
    const notes = screen.getAllByText(/reference only — parley never copied these bytes/i);
    expect(notes).toHaveLength(2);
    // No broken preview / download / open affordance (not even disabled).
    expect(screen.queryByRole("button", { name: /download|preview|open/i })).toBeNull();
    expect(document.querySelectorAll("[data-treatment='reference']")).toHaveLength(2);
  });

  it("renders purged as expected decay, not an error or loading state", () => {
    const run = baseRun({
      deliverables: {
        status: "ready",
        items: [
          {
            treatment: "purged",
            id: "d-purged",
            address: "search.1/sources",
            kind: "inline",
            note: "purged on 2026-06-24 (run r-c04e, search.1/sources)",
          },
        ],
      },
    });
    render(<Inspector task={null} run={run} />);
    const card = document.querySelector('[data-treatment="purged"]');
    expect(card).toBeTruthy();
    expect(card?.textContent).toMatch(/purged/i);
    expect(card?.textContent).toMatch(/search\.1\/sources/);
    expect(card?.textContent).toMatch(/Decayed past the retention clock/i);
    expect(card?.textContent).toMatch(/purged on 2026-06-24/);
    // Not error/loading vocabulary.
    expect(card?.textContent).not.toMatch(/failed to (load|fetch)|error|loading/i);
    expect(screen.queryByText(/Hailing the run/i)).toBeNull();
  });

  it("a fully-purged run still renders addresses, nodes, and iterations", () => {
    const run = baseRun({
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
          age: "30d",
          fanoutWidth: null,
          spineState: "completed",
          live: false,
          onReject: null,
        },
        {
          key: "search\u00002",
          node: "search",
          kind: "step",
          iteration: 2,
          state: "completed",
          stateLabel: "completed",
          tasksLabel: "3",
          gist: "sources",
          age: "30d",
          fanoutWidth: 3,
          spineState: "completed",
          live: false,
          onReject: null,
        },
      ],
      deliverables: {
        status: "ready",
        items: [
          {
            treatment: "purged",
            id: "d1",
            address: "scope.1/plan",
            kind: "inline",
            note: null,
          },
          {
            treatment: "purged",
            id: "d2",
            address: "search.2[q1]/sources",
            kind: "inline",
            note: null,
          },
        ],
      },
    });
    render(<Inspector task={null} run={run} />);
    // Node structure legible.
    expect(screen.getByText("scope")).toBeTruthy();
    expect(screen.getByText("search")).toBeTruthy();
    expect(document.querySelector(".pc-runview__iter")?.textContent?.trim()).toBe(".2");
    expect(screen.getByText(/×3/)).toBeTruthy();
    // Purged addresses still rendered.
    expect(screen.getByText("scope.1/plan")).toBeTruthy();
    expect(screen.getByText("search.2[q1]/sources")).toBeTruthy();
    expect(document.querySelectorAll('[data-treatment="purged"]')).toHaveLength(2);
  });

  it("omits the deliverable section when not_fetched (not a false empty)", () => {
    render(<Inspector task={null} run={baseRun({ deliverables: { status: "not_fetched" } })} />);
    expect(screen.queryByLabelText("Deliverables")).toBeNull();
    expect(screen.queryByText(/No deliverables/i)).toBeNull();
  });

  it("inline JSON well is keyboard-reachable when it scrolls", () => {
    const run = baseRun({
      deliverables: {
        status: "ready",
        items: [
          {
            treatment: "inline",
            id: "d-scroll",
            address: "funnel.1/out",
            typeLabel: null,
            json: "{\n  " + Array.from({ length: 40 }, (_, i) => `"k${i}": ${i}`).join(",\n  ") + "\n}",
          },
        ],
      },
    });
    const { container } = render(<Inspector task={null} run={run} />);
    const well = container.querySelector(".pc-dlv__well--report") as HTMLElement | null;
    expect(well).toBeTruthy();
    expect(well!.tabIndex).toBe(0);
    well!.focus();
    expect(document.activeElement).toBe(well);
  });
});

describe("fork STATE vocabulary (#255)", () => {
  it("inherited is quiet: strike-through class, no skipped cue", () => {
    render(<Inspector task={null} run={baseRun()} />);
    const inherited = document.querySelector('[data-fork="inherited"]');
    expect(inherited).toBeTruthy();
    expect(inherited?.classList.contains("pc-runview__st--inherited")).toBe(true);
    expect(inherited?.textContent).toMatch(/inherited/i);
    expect(inherited?.querySelector(".pc-runview__st-cue")).toBeNull();
    // Node name also struck on inherited rows.
    expect(document.querySelector(".pc-runview__row--inherited")).toBeTruthy();
  });

  it("skipped is loud: coral class, distinct cue, accusation note", () => {
    render(<Inspector task={null} run={baseRun()} />);
    const skipped = document.querySelector('[data-fork="skipped"]');
    expect(skipped).toBeTruthy();
    expect(skipped?.classList.contains("pc-runview__st--skipped")).toBe(true);
    expect(skipped?.textContent).toMatch(/skipped/i);
    expect(skipped?.querySelector(".pc-runview__st-cue")?.textContent).toBe("!");
    expect(screen.getByText(/human approval was discarded by this fork/i)).toBeTruthy();
  });

  it("inherited and skipped remain distinguishable with colour removed", () => {
    render(<Inspector task={null} run={baseRun()} />);
    const inherited = document.querySelector('[data-fork="inherited"]')!;
    const skipped = document.querySelector('[data-fork="skipped"]')!;

    // Non-colour carriers:
    // 1. strike-through only on inherited
    // 2. "!" cue only on skipped
    // 3. distinct marks (cancelled vs failed) in the mark slot
    // 4. data-fork attribute + distinct class names
    expect(inherited.classList.contains("pc-runview__st--inherited")).toBe(true);
    expect(skipped.classList.contains("pc-runview__st--skipped")).toBe(true);
    expect(getComputedStyle(inherited).textDecoration).toMatch(/line-through|inherit|/);
    // CSS source-of-truth: strike on inherited, not on skipped.
    expect(HUD_CSS).toMatch(
      /\.pc-runview__st--inherited\s*\{[^}]*text-decoration:\s*line-through/s,
    );
    expect(HUD_CSS).toMatch(
      /\.pc-runview__st--skipped\s*\{[^}]*text-decoration:\s*none/s,
    );
    expect(inherited.querySelector(".pc-runview__st-cue")).toBeNull();
    expect(skipped.querySelector(".pc-runview__st-cue")?.textContent).toBe("!");
    // Labels still differ as text.
    expect(inherited.textContent?.toLowerCase()).toContain("inherited");
    expect(skipped.textContent?.toLowerCase()).toContain("skipped");
    // Marks differ (cancelled ⊘ vs failed ✖) — accessible structure without hue.
    const inhMark = inherited.querySelector(".pc-runview__st-mark");
    const skMark = skipped.querySelector(".pc-runview__st-mark");
    expect(inhMark).toBeTruthy();
    expect(skMark).toBeTruthy();
    // SVG path data should not be identical when marks differ.
    expect(inhMark?.innerHTML).not.toBe(skMark?.innerHTML);
  });

  it("formatNodeStateLabel keeps inherited / skipped wire words", () => {
    expect(
      formatNodeStateLabel({
        node: "plan",
        kind: "step",
        iteration: 0,
        state: "inherited",
        tasks_settled: 0,
        tasks_total: 0,
        usage: null,
        duration_ms: null,
        fanout: null,
        tallies: {},
        counts: {},
        summary: null,
        deliverables: [],
        gist: "",
      }),
    ).toBe("inherited");
    expect(
      formatNodeStateLabel({
        node: "approve",
        kind: "gate",
        iteration: 0,
        state: "skipped",
        tasks_settled: 0,
        tasks_total: 0,
        usage: null,
        duration_ms: null,
        fanout: null,
        tallies: {},
        counts: {},
        summary: null,
        deliverables: [],
        gist: "",
      }),
    ).toBe("skipped");
  });
});

describe("projectInspectorRun deliverable honesty (#255)", () => {
  it("defaults deliverables to not_fetched when values are omitted", () => {
    const detail: RunDetailResponse = {
      run: {
        run_id: "r1",
        workflow: "w",
        workflow_version: 1,
        orchestrator_session_id: null,
        state: "completed",
        block: null,
        current_node: null,
        iteration: 1,
        parent_run_id: null,
        attempt: 1,
        tasks_settled: 0,
        tasks_total: 0,
        usage: { input_tokens: 0, output_tokens: 0 },
        duration_ms: 0,
        branch: null,
        worktree: null,
        created_at: "2026-07-01T00:00:00.000Z",
        updated_at: "2026-07-01T00:00:00.000Z",
        completed_at: null,
        purged_at: null,
        workspace: "repo",
        type: "feature",
        repo: null,
        error: null,
        track_bound: 1,
      },
      block: null,
      nodes: [],
    };
    const view = projectInspectorRun(detail);
    expect(view.status).toBe("ready");
    if (view.status !== "ready") throw new Error("expected ready");
    expect(view.deliverables.status).toBe("not_fetched");
  });

  it("projects provided values into ready items", () => {
    const detail: RunDetailResponse = {
      run: {
        run_id: "r1",
        workflow: "w",
        workflow_version: 1,
        orchestrator_session_id: null,
        state: "completed",
        block: null,
        current_node: null,
        iteration: 1,
        parent_run_id: null,
        attempt: 1,
        tasks_settled: 0,
        tasks_total: 0,
        usage: { input_tokens: 0, output_tokens: 0 },
        duration_ms: 0,
        branch: null,
        worktree: null,
        created_at: "2026-07-01T00:00:00.000Z",
        updated_at: "2026-07-01T00:00:00.000Z",
        completed_at: null,
        purged_at: null,
        workspace: "repo",
        type: "feature",
        repo: null,
        error: null,
        track_bound: 1,
      },
      block: null,
      nodes: [],
    };
    const view = projectInspectorRun(detail, Date.now(), [
      wireValue({
        deliverable_id: "d1",
        kind: "inline",
        node: "a",
        port: "out",
        value: { ok: true },
      }),
    ]);
    expect(view.status).toBe("ready");
    if (view.status !== "ready") throw new Error("expected ready");
    expect(view.deliverables.status).toBe("ready");
    if (view.deliverables.status !== "ready") throw new Error("expected ready items");
    expect(view.deliverables.items[0]?.treatment).toBe("inline");
  });
});
