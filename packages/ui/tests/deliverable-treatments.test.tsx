/** @vitest-environment happy-dom */
/**
 * #255 — deliverable treatments, purged empty state, fork vocabulary, hook wire.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import {
  ParleyClient,
  type DeliverableValue,
  type RunDetailResponse,
  type RunsResponse,
} from "@useparley/core";
import {
  formatDeliverableAddress,
  formatDeliverableSize,
  formatNodeStateLabel,
  projectDeliverable,
  projectDeliverables,
  projectInspectorRun,
} from "../src/app/hooks/runs.js";
import {
  __resetSelectedDeliverableCacheForTests,
  useInspectorRun,
  useRuns,
} from "../src/app/hooks/useRuns.js";
import { Inspector } from "../src/hud/index.js";
import type { InspectorRun } from "../src/hud/types.js";

afterEach(() => {
  cleanup();
  __resetSelectedDeliverableCacheForTests();
});

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

  it("JSON null on a live inline port is inline, not purged (F2)", () => {
    // Daemon stores the string "null"; parseJson → null; purged_at and note stay null.
    const item = projectDeliverable(
      wireValue({
        deliverable_id: "d-null",
        kind: "inline",
        node: "opt",
        port: "maybe",
        value: null,
        purged_at: null,
        note: null,
      }),
    );
    expect(item.treatment).toBe("inline");
    if (item.treatment !== "inline") throw new Error("expected inline");
    expect(item.json).toBe("null");
  });

  it("daemon value-missing note without stamp is purged", () => {
    const item = projectDeliverable(
      wireValue({
        deliverable_id: "d-missing",
        kind: "inline",
        node: "opt",
        port: "maybe",
        value: null,
        purged_at: null,
        note: "value missing (run r-c04e, opt.1/maybe)",
      }),
    );
    expect(item.treatment).toBe("purged");
  });

  it("projects file/dir as reference-only with path, size, exists, note", () => {
    const file = projectDeliverable(
      wireValue({
        deliverable_id: "d-file",
        kind: "file",
        node: "implement",
        port: "patch",
        iteration: 2,
        path: ".parley/tmp/implement.2/out/patch.diff",
        size: { bytes: 14_336 },
        exists: true,
      }),
    );
    expect(file.treatment).toBe("reference");
    if (file.treatment !== "reference") throw new Error("expected reference");
    expect(file.kind).toBe("file");
    expect(file.path).toBe(".parley/tmp/implement.2/out/patch.diff");
    expect(file.sizeLabel).toMatch(/kB/);
    expect(file.exists).toBe(true);

    const dead = projectDeliverable(
      wireValue({
        deliverable_id: "d-dead",
        kind: "file",
        node: "bundle",
        port: "report",
        path: ".parley/tmp/bundle.1/out/report.pdf",
        exists: false,
        note: "worktree removed; file deliverables do not outlive their workspace",
      }),
    );
    expect(dead.treatment).toBe("reference");
    if (dead.treatment !== "reference") throw new Error("expected reference");
    expect(dead.exists).toBe(false);
    expect(dead.note).toMatch(/worktree removed/);

    // Dir with only inode bytes → no size claim.
    const dirBytes = projectDeliverable(
      wireValue({
        deliverable_id: "d-dir-b",
        kind: "dir",
        node: "search",
        port: "captures",
        path: "…/out/captures/",
        size: { bytes: 4096 },
        exists: true,
      }),
    );
    expect(dirBytes.treatment).toBe("reference");
    if (dirBytes.treatment !== "reference") throw new Error("expected reference");
    expect(dirBytes.sizeLabel).toBeNull();

    const dirEls = projectDeliverable(
      wireValue({
        deliverable_id: "d-dir",
        kind: "dir",
        node: "search",
        port: "captures",
        path: "…/out/captures/",
        size: { elements: 11 },
      }),
    );
    expect(dirEls.treatment).toBe("reference");
    if (dirEls.treatment !== "reference") throw new Error("expected reference");
    expect(dirEls.sizeLabel).toBe("11 items");
  });

  it("projects purged_at as a first-class purged treatment with kind + date", () => {
    const item = projectDeliverable(
      wireValue({
        deliverable_id: "d-purged",
        kind: "dir",
        node: "search",
        port: "sources",
        value: null,
        purged_at: "2026-06-24T12:00:00Z",
        note: "purged on 2026-06-24 (run r-c04e, search.1/sources)",
      }),
    );
    expect(item.treatment).toBe("purged");
    if (item.treatment !== "purged") throw new Error("expected purged");
    expect(item.kind).toBe("dir");
    expect(item.purgedAt).toBe("2026-06-24T12:00:00Z");
    expect(item.address).toBe("search.1/sources");
    expect(item.note).toMatch(/purged on 2026-06-24/);
  });

  it("distinguishes not_fetched, none, ready, and error", () => {
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

    // Full-batch failure must not read as none (empty values + failedCount).
    const fullFail = projectDeliverables([], 1);
    expect(fullFail.status).toBe("error");
    if (fullFail.status !== "error") throw new Error("expected error");
    expect(fullFail.items).toHaveLength(0);
    expect(fullFail.failedCount).toBe(1);

    // Partial failure keeps the loaded cards and reports the miss.
    const partial = projectDeliverables(
      [
        wireValue({
          deliverable_id: "d1",
          kind: "inline",
          node: "a",
          port: "out",
          value: 1,
        }),
      ],
      2,
    );
    expect(partial.status).toBe("error");
    if (partial.status !== "error") throw new Error("expected error");
    expect(partial.items).toHaveLength(1);
    expect(partial.failedCount).toBe(2);
  });

  it("formatDeliverableSize has MB step and omits dir bytes", () => {
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
    expect(formatDeliverableSize({ bytes: 5 * 1024 * 1024 })).toMatch(/MB/);
    expect(formatDeliverableSize({ bytes: 4096 }, "dir")).toBeNull();
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
            exists: true,
            note: null,
          },
          {
            treatment: "reference",
            id: "d-dir",
            address: "search.1/captures",
            kind: "dir",
            path: "…/out/captures/",
            sizeLabel: "11 items",
            exists: true,
            note: null,
          },
        ],
      },
    });
    render(<Inspector task={null} run={run} />);
    expect(screen.getByText(/patch\.diff/)).toBeTruthy();
    expect(screen.getByText(/14 kB/)).toBeTruthy();
    expect(screen.getByText(/out\/captures/)).toBeTruthy();
    // Address stays mono / correct case (F3) — not inside uppercase kind.
    const addr = document.querySelector(
      '[data-dlv-id="d-file"] .pc-dlv__address',
    ) as HTMLElement | null;
    expect(addr?.textContent).toBe("implement.2/patch");
    expect(addr?.title).toBe("implement.2/patch");
    expect(getComputedStyle(addr!).textTransform).not.toBe("uppercase");
    const notes = screen.getAllByText(/reference only — parley never copied these bytes/i);
    expect(notes).toHaveLength(2);
    expect(screen.queryByRole("button", { name: /download|preview|open/i })).toBeNull();
  });

  it("surfaces exists:false note on a dead file reference (F4)", () => {
    const run = baseRun({
      deliverables: {
        status: "ready",
        items: [
          {
            treatment: "reference",
            id: "d-dead",
            address: "bundle.1/report",
            kind: "file",
            path: ".parley/tmp/bundle.1/out/report.pdf",
            sizeLabel: null,
            exists: false,
            note: "worktree removed; file deliverables do not outlive their workspace",
          },
        ],
      },
    });
    render(<Inspector task={null} run={run} />);
    const card = document.querySelector('[data-exists="false"]');
    expect(card).toBeTruthy();
    expect(card?.textContent).toMatch(/worktree removed/i);
    expect(card?.textContent).toMatch(/reference only/i);
  });

  it("renders purged as expected decay with kind + date, not as a fourth kind", () => {
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
            purgedAt: "2026-06-24T12:00:00Z",
          },
        ],
      },
    });
    render(<Inspector task={null} run={run} />);
    const card = document.querySelector('[data-treatment="purged"]');
    expect(card).toBeTruthy();
    expect(card?.getAttribute("data-kind")).toBe("inline");
    // Kind visible; purged is a state badge.
    expect(card?.querySelector(".pc-dlv__kind")?.textContent?.toLowerCase()).toContain("inline");
    expect(card?.querySelector(".pc-dlv__state")?.textContent?.toLowerCase()).toContain("purged");
    expect(card?.textContent).toMatch(/search\.1\/sources/);
    expect(card?.textContent).toMatch(/Retention cleared this value/i);
    expect(card?.textContent).toMatch(/2026-06-24/);
    // Not error/loading vocabulary; not "the row is gone".
    expect(card?.textContent).not.toMatch(/failed to (load|fetch)|error|loading/i);
    expect(card?.textContent).not.toMatch(/the row is gone/i);
    // Per-card role=status removed (F6) — one stack-level status only.
    expect(card?.querySelector('[role="status"]')).toBeNull();
    expect(document.querySelectorAll('.pc-dlv-stack [role="status"]').length).toBe(1);
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
            purgedAt: "2026-05-01T00:00:00Z",
          },
          {
            treatment: "purged",
            id: "d2",
            address: "search.2[q1]/sources",
            kind: "file",
            note: null,
            purgedAt: "2026-05-01T00:00:00Z",
          },
        ],
      },
    });
    render(<Inspector task={null} run={run} />);
    expect(screen.getByText("scope")).toBeTruthy();
    expect(screen.getByText("search")).toBeTruthy();
    expect(document.querySelector(".pc-runview__iter")?.textContent?.trim()).toBe(".2");
    expect(screen.getByText(/×3/)).toBeTruthy();
    expect(screen.getByText("scope.1/plan")).toBeTruthy();
    expect(screen.getByText("search.2[q1]/sources")).toBeTruthy();
    expect(document.querySelectorAll('[data-treatment="purged"]')).toHaveLength(2);
    // Kinds remain distinguishable on purged cards.
    expect(document.querySelector('[data-dlv-id="d1"]')?.getAttribute("data-kind")).toBe("inline");
    expect(document.querySelector('[data-dlv-id="d2"]')?.getAttribute("data-kind")).toBe("file");
  });

  it("omits the deliverable section when not_fetched (not a false empty)", () => {
    render(<Inspector task={null} run={baseRun({ deliverables: { status: "not_fetched" } })} />);
    expect(screen.queryByLabelText("Deliverables")).toBeNull();
    expect(screen.queryByText(/No deliverables/i)).toBeNull();
  });

  it("inline JSON well is a named focusable region (F5)", () => {
    const run = baseRun({
      deliverables: {
        status: "ready",
        items: [
          {
            treatment: "inline",
            id: "d-scroll",
            address: "funnel.1/out",
            typeLabel: null,
            json:
              "{\n  " +
              Array.from({ length: 40 }, (_, i) => `"k${i}": ${i}`).join(",\n  ") +
              "\n}",
          },
        ],
      },
    });
    const { container } = render(<Inspector task={null} run={run} />);
    const well = container.querySelector(".pc-dlv__well--report") as HTMLElement | null;
    expect(well).toBeTruthy();
    expect(well!.tabIndex).toBe(0);
    expect(well!.getAttribute("role")).toBe("region");
    expect(well!.getAttribute("aria-label")).toMatch(/Inline value for funnel\.1\/out/);
    well!.focus();
    expect(document.activeElement).toBe(well);
  });

  it("purged well does not use cancelled border (F7 CSS)", () => {
    expect(HUD_CSS).toMatch(
      /\.pc-dlv__well--purged\s*\{[^}]*border-color:\s*var\(--plate-well-border\)/s,
    );
    expect(HUD_CSS).not.toMatch(
      /\.pc-dlv__well--purged\s*\{[^}]*border-color:\s*var\(--state-cancelled\)/s,
    );
  });

  it("inherited fan/iter keep --ink-muted not --ink-label (F9 CSS)", () => {
    const block = [
      ...HUD_CSS.matchAll(
        /\.pc-runview__row--inherited \.pc-runview__fan,\s*\n\.pc-runview__row--inherited \.pc-runview__iter\s*\{([^}]+)\}/g,
      ),
    ];
    expect(block.length).toBe(1);
    const css = block[0]![1];
    expect(css).toMatch(/color:\s*var\(--ink-muted\)/);
    expect(css).not.toMatch(/color:\s*var\(--ink-label\)/);
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
    expect(document.querySelector(".pc-runview__row--inherited")).toBeTruthy();
    // F8: no dead skipped row class.
    expect(document.querySelector(".pc-runview__row--skipped")).toBeNull();
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

    expect(inherited.classList.contains("pc-runview__st--inherited")).toBe(true);
    expect(skipped.classList.contains("pc-runview__st--skipped")).toBe(true);
    // CSS source-of-truth (no empty-regex assertion).
    expect(HUD_CSS).toMatch(
      /\.pc-runview__st--inherited\s*\{[^}]*text-decoration:\s*line-through/s,
    );
    expect(HUD_CSS).toMatch(
      /\.pc-runview__st--skipped\s*\{[^}]*text-decoration:\s*none/s,
    );
    expect(inherited.querySelector(".pc-runview__st-cue")).toBeNull();
    expect(skipped.querySelector(".pc-runview__st-cue")?.textContent).toBe("!");
    expect(inherited.textContent?.toLowerCase()).toContain("inherited");
    expect(skipped.textContent?.toLowerCase()).toContain("skipped");
    const inhMark = inherited.querySelector(".pc-runview__st-mark");
    const skMark = skipped.querySelector(".pc-runview__st-mark");
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
  function emptyDetail(): RunDetailResponse {
    return {
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
  }

  it("defaults deliverables to not_fetched when values are omitted", () => {
    const view = projectInspectorRun(emptyDetail());
    expect(view.status).toBe("ready");
    if (view.status !== "ready") throw new Error("expected ready");
    expect(view.deliverables.status).toBe("not_fetched");
  });

  it("projects provided values into ready items", () => {
    const view = projectInspectorRun(emptyDetail(), Date.now(), [
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

/**
 * F1 — the real hook path: useRuns fetches GET /deliverables/:id for the
 * selected run; useInspectorRun projects them. No hand-built deliverables.
 */
describe("useRuns → useInspectorRun deliverable wire (#255 F1)", () => {
  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  it("fetches deliverables for the selected run and projects an inline card", async () => {
    const runId = "r-wire01";
    const dlvId = "d-shortlist";
    const detail: RunDetailResponse = {
      run: {
        run_id: runId,
        workflow: "research",
        workflow_version: 1,
        orchestrator_session_id: "sess-1",
        state: "completed",
        block: null,
        current_node: "funnel",
        iteration: 1,
        parent_run_id: null,
        attempt: 1,
        tasks_settled: 1,
        tasks_total: 1,
        usage: { input_tokens: 10, output_tokens: 5 },
        duration_ms: 60_000,
        branch: null,
        worktree: null,
        created_at: "2026-07-01T00:00:00.000Z",
        updated_at: "2026-07-01T00:01:00.000Z",
        completed_at: "2026-07-01T00:01:00.000Z",
        purged_at: null,
        workspace: "repo",
        type: "research",
        repo: null,
        error: null,
        track_bound: 3,
      },
      block: null,
      nodes: [
        {
          node: "funnel",
          kind: "step",
          iteration: 1,
          state: "completed",
          tasks_settled: 1,
          tasks_total: 1,
          usage: null,
          duration_ms: 60_000,
          fanout: null,
          tallies: {},
          counts: {},
          summary: null,
          deliverables: [dlvId],
          gist: "shortlist ready",
        },
      ],
    };
    const listBody: RunsResponse = {
      seq: 1,
      runs: [detail.run],
    };
    const dlvBody = wireValue({
      deliverable_id: dlvId,
      run_id: runId,
      kind: "inline",
      node: "funnel",
      port: "shortlist",
      type: "dict<string, source[]>",
      value: { "rate-limits": [{ url: "…/docs/limits", tier: "primary" }] },
    });

    const hits: string[] = [];
    const fetchFn = (async (input: RequestInfo | URL) => {
      const url = String(input);
      hits.push(url);
      if (url.endsWith("/runs") || url.includes("/runs?")) {
        return jsonResponse(listBody);
      }
      if (url.includes(`/runs/${encodeURIComponent(runId)}`)) {
        return jsonResponse(detail);
      }
      if (url.includes(`/deliverables/${encodeURIComponent(dlvId)}`)) {
        return jsonResponse(dlvBody);
      }
      return jsonResponse({ error: "not found" }, 404);
    }) as typeof fetch;

    const client = new ParleyClient({ baseUrl: "", fetch: fetchFn });

    const { result } = renderHook(() => {
      const runs = useRuns(client, { selectedRunId: runId, pollMs: 60_000 });
      return useInspectorRun(runs.details, runId, Date.now());
    });

    await waitFor(() => {
      const view = result.current;
      expect(view).not.toBeNull();
      expect(view?.status).toBe("ready");
      if (view?.status !== "ready") throw new Error("expected ready");
      expect(view.deliverables.status).toBe("ready");
    });

    const view = result.current!;
    if (view.status !== "ready") throw new Error("expected ready");
    if (view.deliverables.status !== "ready") throw new Error("expected ready dlv");
    expect(view.deliverables.items).toHaveLength(1);
    expect(view.deliverables.items[0]?.treatment).toBe("inline");
    if (view.deliverables.items[0]?.treatment !== "inline") throw new Error("inline");
    expect(view.deliverables.items[0].json).toContain("rate-limits");
    expect(view.deliverables.items[0].address).toBe("funnel.1/shortlist");

    // Render through Inspector — the card is observable, not just projected.
    render(<Inspector task={null} run={view} />);
    expect(document.querySelector('[data-treatment="inline"]')?.textContent).toMatch(
      /rate-limits/,
    );
    expect(hits.some((h) => h.includes(`/deliverables/${encodeURIComponent(dlvId)}`))).toBe(
      true,
    );
  });

  it("failed GET /deliverables/:id does not claim absence", async () => {
    const runId = "r-wire-fail";
    const dlvId = "d-missing";
    const detail: RunDetailResponse = {
      run: {
        run_id: runId,
        workflow: "research",
        workflow_version: 1,
        orchestrator_session_id: "sess-1",
        state: "completed",
        block: null,
        current_node: "funnel",
        iteration: 1,
        parent_run_id: null,
        attempt: 1,
        tasks_settled: 1,
        tasks_total: 1,
        usage: { input_tokens: 0, output_tokens: 0 },
        duration_ms: 1_000,
        branch: null,
        worktree: null,
        created_at: "2026-07-01T00:00:00.000Z",
        updated_at: "2026-07-01T00:01:00.000Z",
        completed_at: "2026-07-01T00:01:00.000Z",
        purged_at: null,
        workspace: "repo",
        type: "research",
        repo: null,
        error: null,
        track_bound: 1,
      },
      block: null,
      nodes: [
        {
          node: "funnel",
          kind: "step",
          iteration: 1,
          state: "completed",
          tasks_settled: 1,
          tasks_total: 1,
          usage: null,
          duration_ms: 1_000,
          fanout: null,
          tallies: {},
          counts: {},
          summary: null,
          deliverables: [dlvId],
          gist: "shortlist ready",
        },
      ],
    };
    const listBody: RunsResponse = { seq: 1, runs: [detail.run] };

    const fetchFn = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/runs") || url.includes("/runs?")) {
        return jsonResponse(listBody);
      }
      if (url.includes(`/runs/${encodeURIComponent(runId)}`)) {
        return jsonResponse(detail);
      }
      if (url.includes(`/deliverables/${encodeURIComponent(dlvId)}`)) {
        return jsonResponse({ error: "internal" }, 500);
      }
      return jsonResponse({ error: "not found" }, 404);
    }) as typeof fetch;

    const client = new ParleyClient({ baseUrl: "", fetch: fetchFn });

    const { result } = renderHook(() => {
      const runs = useRuns(client, { selectedRunId: runId, pollMs: 60_000 });
      return useInspectorRun(runs.details, runId, Date.now());
    });

    await waitFor(() => {
      const view = result.current;
      expect(view).not.toBeNull();
      expect(view?.status).toBe("ready");
      if (view?.status !== "ready") throw new Error("expected ready");
      // Must settle as error — never "none" while node.deliverables is non-empty.
      expect(view.deliverables.status).toBe("error");
    });

    const view = result.current!;
    if (view.status !== "ready") throw new Error("expected ready");
    if (view.deliverables.status !== "error") throw new Error("expected error");
    expect(view.deliverables.failedCount).toBe(1);
    expect(view.deliverables.items).toHaveLength(0);
    // Node structure still legible.
    expect(view.nodes).toHaveLength(1);
    expect(view.nodes[0]?.node).toBe("funnel");

    render(<Inspector task={null} run={view} />);
    const stack = document.querySelector('.pc-dlv-stack');
    expect(stack?.textContent).toMatch(/Couldn't load 1 deliverable/i);
    expect(stack?.textContent).not.toMatch(/No deliverables on this run/i);
  });

  it("partial deliverable failure keeps loaded cards and reports the miss", async () => {
    const runId = "r-wire-partial";
    const okId = "d-ok";
    const badId = "d-bad";
    const detail: RunDetailResponse = {
      run: {
        run_id: runId,
        workflow: "research",
        workflow_version: 1,
        orchestrator_session_id: "sess-1",
        state: "completed",
        block: null,
        current_node: "funnel",
        iteration: 1,
        parent_run_id: null,
        attempt: 1,
        tasks_settled: 1,
        tasks_total: 1,
        usage: { input_tokens: 0, output_tokens: 0 },
        duration_ms: 1_000,
        branch: null,
        worktree: null,
        created_at: "2026-07-01T00:00:00.000Z",
        updated_at: "2026-07-01T00:01:00.000Z",
        completed_at: "2026-07-01T00:01:00.000Z",
        purged_at: null,
        workspace: "repo",
        type: "research",
        repo: null,
        error: null,
        track_bound: 1,
      },
      block: null,
      nodes: [
        {
          node: "funnel",
          kind: "step",
          iteration: 1,
          state: "completed",
          tasks_settled: 1,
          tasks_total: 1,
          usage: null,
          duration_ms: 1_000,
          fanout: null,
          tallies: {},
          counts: {},
          summary: null,
          deliverables: [okId, badId],
          gist: "mixed",
        },
      ],
    };
    const listBody: RunsResponse = { seq: 1, runs: [detail.run] };
    const okBody = wireValue({
      deliverable_id: okId,
      run_id: runId,
      kind: "inline",
      node: "funnel",
      port: "shortlist",
      value: { kept: true },
    });

    const fetchFn = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/runs") || url.includes("/runs?")) {
        return jsonResponse(listBody);
      }
      if (url.includes(`/runs/${encodeURIComponent(runId)}`)) {
        return jsonResponse(detail);
      }
      if (url.includes(`/deliverables/${encodeURIComponent(okId)}`)) {
        return jsonResponse(okBody);
      }
      if (url.includes(`/deliverables/${encodeURIComponent(badId)}`)) {
        return jsonResponse({ error: "internal" }, 500);
      }
      return jsonResponse({ error: "not found" }, 404);
    }) as typeof fetch;

    const client = new ParleyClient({ baseUrl: "", fetch: fetchFn });

    const { result } = renderHook(() => {
      const runs = useRuns(client, { selectedRunId: runId, pollMs: 60_000 });
      return useInspectorRun(runs.details, runId, Date.now());
    });

    await waitFor(() => {
      const view = result.current;
      expect(view?.status).toBe("ready");
      if (view?.status !== "ready") throw new Error("expected ready");
      expect(view.deliverables.status).toBe("error");
    });

    const view = result.current!;
    if (view.status !== "ready") throw new Error("expected ready");
    if (view.deliverables.status !== "error") throw new Error("expected error");
    expect(view.deliverables.failedCount).toBe(1);
    expect(view.deliverables.items).toHaveLength(1);
    expect(view.deliverables.items[0]?.treatment).toBe("inline");

    render(<Inspector task={null} run={view} />);
    expect(document.querySelector('[data-treatment="inline"]')?.textContent).toMatch(/kept/);
    expect(document.querySelector(".pc-dlv-stack")?.textContent).toMatch(
      /Couldn't load 1 deliverable/i,
    );
    expect(document.querySelector(".pc-dlv-stack")?.textContent).not.toMatch(
      /No deliverables on this run/i,
    );
  });

  it("genuine absence still reads as none (empty id set, no failures)", async () => {
    const runId = "r-wire-none";
    const detail: RunDetailResponse = {
      run: {
        run_id: runId,
        workflow: "research",
        workflow_version: 1,
        orchestrator_session_id: "sess-1",
        state: "completed",
        block: null,
        current_node: "funnel",
        iteration: 1,
        parent_run_id: null,
        attempt: 1,
        tasks_settled: 1,
        tasks_total: 1,
        usage: { input_tokens: 0, output_tokens: 0 },
        duration_ms: 1_000,
        branch: null,
        worktree: null,
        created_at: "2026-07-01T00:00:00.000Z",
        updated_at: "2026-07-01T00:01:00.000Z",
        completed_at: "2026-07-01T00:01:00.000Z",
        purged_at: null,
        workspace: "repo",
        type: "research",
        repo: null,
        error: null,
        track_bound: 1,
      },
      block: null,
      nodes: [
        {
          node: "funnel",
          kind: "step",
          iteration: 1,
          state: "completed",
          tasks_settled: 1,
          tasks_total: 1,
          usage: null,
          duration_ms: 1_000,
          fanout: null,
          tallies: {},
          counts: {},
          summary: null,
          deliverables: [],
          gist: "no outputs",
        },
      ],
    };
    const listBody: RunsResponse = { seq: 1, runs: [detail.run] };

    const fetchFn = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/runs") || url.includes("/runs?")) {
        return jsonResponse(listBody);
      }
      if (url.includes(`/runs/${encodeURIComponent(runId)}`)) {
        return jsonResponse(detail);
      }
      return jsonResponse({ error: "not found" }, 404);
    }) as typeof fetch;

    const client = new ParleyClient({ baseUrl: "", fetch: fetchFn });

    const { result } = renderHook(() => {
      const runs = useRuns(client, { selectedRunId: runId, pollMs: 60_000 });
      return useInspectorRun(runs.details, runId, Date.now());
    });

    await waitFor(() => {
      const view = result.current;
      expect(view?.status).toBe("ready");
      if (view?.status !== "ready") throw new Error("expected ready");
      expect(view.deliverables.status).toBe("none");
    });

    render(<Inspector task={null} run={result.current!} />);
    expect(document.querySelector(".pc-dlv-stack")?.textContent).toMatch(
      /No deliverables on this run/i,
    );
    expect(document.querySelector(".pc-dlv-stack")?.textContent).not.toMatch(
      /Couldn't load/i,
    );
  });
});
