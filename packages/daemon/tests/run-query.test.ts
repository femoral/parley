/**
 * #241 / ADR-0021 — run query surface: gist assembly, one-line-per-(node,iteration),
 * purged rendering, address parse, MCP denial.
 */
import { describe, expect, it } from "vitest";
import {
  parseWorkflowDefinition,
  type WorkflowDefinition,
} from "@useparley/core";
import {
  assembleGist,
  collectNodeIterations,
  countPluralPorts,
  EXIT_DELIVERABLE_PURGED,
  looksLikeDeliverableId,
  parseDeliverableAddress,
  projectRunDetail,
  projectStepState,
  renderDeliverableBare,
  renderRunSummary,
  resolveDeliverableValue,
  tallyEnumPorts,
  toDeliverableRef,
  type QueryDeliverable,
  type QueryPort,
  type QueryTask,
} from "../src/run-query.js";
import type { RunRow } from "../src/db.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function researchDef(): WorkflowDefinition {
  return parseWorkflowDefinition(
    {
      id: "research",
      version: 1,
      type: "research",
      workspace: "scratch",
      inputs: { brief: { type: "text" } },
      outputs: { report: { type: "text", from: "adversarial-review.summary" } },
      types: {
        coverage: { enum: ["sufficient", "insufficient"] },
        verdict: { enum: ["approve", "changes_requested"] },
      },
      nodes: [
        {
          id: "scope",
          kind: "step",
          prompt: "s.md",
          in: { brief: { type: "text", from: "run.brief" } },
          out: { queries: { type: "text[]" } },
        },
        {
          id: "search",
          kind: "step",
          prompt: "se.md",
          over: "queries",
          in: { queries: { type: "text", from: "scope.queries" } },
          out: { sources: { type: "text[]" } },
        },
        {
          id: "funnel",
          kind: "step",
          prompt: "f.md",
          in: { sources: { type: "text[]", from: "search.sources" } },
          out: { shortlist: { type: "text[]" } },
        },
        {
          id: "validate",
          kind: "step",
          prompt: "v.md",
          over: "shortlist",
          in: { shortlist: { type: "text", from: "funnel.shortlist" } },
          out: { validations: { type: "text[]" } },
        },
        {
          id: "adversarial-review",
          kind: "step",
          prompt: "a.md",
          in: { shortlist: { type: "text[]", from: "funnel.shortlist" } },
          out: {
            coverage: { type: "coverage" },
            summary: { type: "text" },
          },
          loop: { to: "scope", max: 2, while: { port: "coverage", is: "insufficient" } },
        },
      ],
    },
    // typeCheck off: this fixture only needs node ids / out-port types for
    // projections; full wiring correctness is covered by definition tests.
    { dir: "/tmp/research", expectedId: "research", typeCheck: false },
  ).definition;
}

function task(
  partial: Partial<QueryTask> & Pick<QueryTask, "id" | "node" | "iteration">,
): QueryTask {
  return {
    state: "completed",
    slot: null,
    usage: JSON.stringify({ input_tokens: 1000, output_tokens: 100 }),
    report: JSON.stringify({
      summary: "child summary",
      outcome: "success",
      files_changed: [],
    }),
    started_at: "2026-07-25T09:00:00Z",
    completed_at: "2026-07-25T09:01:00Z",
    created_at: "2026-07-25T09:00:00Z",
    error: null,
    ...partial,
  };
}

function del(
  partial: Partial<QueryDeliverable> &
    Pick<QueryDeliverable, "id" | "node" | "port" | "iteration">,
): QueryDeliverable {
  return {
    run_id: "r7",
    slot: null,
    task_id: "t1",
    kind: "inline",
    value: JSON.stringify(["a", "b"]),
    created_at: "2026-07-25T09:00:00Z",
    purged_at: null,
    ...partial,
  };
}

function baseRun(over: Partial<RunRow> = {}): RunRow {
  return {
    id: "r7",
    workflow: "research",
    version: 1,
    type: "research",
    workspace: "scratch",
    repo: null,
    state: "blocked",
    current_node: "adversarial-review",
    iteration: 2,
    parent_run_id: null,
    attempt: 1,
    orchestrator_session_id: "sess-1",
    created_at: "2026-07-25T09:00:00Z",
    updated_at: "2026-07-25T09:30:00Z",
    started_at: "2026-07-25T09:00:00Z",
    completed_at: null,
    error: "blocked (loop 2/2)",
    purged_at: null,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Clause 1 — one line per (node, iteration); fan-out width free
// ---------------------------------------------------------------------------

describe("one line per (node, iteration) — fan-out width free (#241)", () => {
  it("12-wide fan-out yields the same line count as 1-wide for the same nodes×iters", () => {
    const definition = researchDef();
    // Two iterations of 5 nodes = 10 (node, iteration) rows.
    const nodes = ["scope", "search", "funnel", "validate", "adversarial-review"] as const;

    function makeTasks(fanOutWidth: number): QueryTask[] {
      const tasks: QueryTask[] = [];
      let id = 1;
      for (const iteration of [1, 2]) {
        for (const node of nodes) {
          const width = node === "search" || node === "validate" ? fanOutWidth : 1;
          for (let s = 0; s < width; s++) {
            tasks.push(
              task({
                id: `t${id++}`,
                node,
                iteration,
                slot: width > 1 ? `slot-${s}` : null,
              }),
            );
          }
        }
      }
      return tasks;
    }

    const wide12 = makeTasks(12);
    const wide1 = makeTasks(1);
    const wide40 = makeTasks(40);

    expect(wide12.length).toBe(2 * (1 + 12 + 1 + 12 + 1)); // 54
    expect(wide40.length).toBe(2 * (1 + 40 + 1 + 40 + 1)); // 166

    const keys12 = collectNodeIterations(wide12);
    const keys1 = collectNodeIterations(wide1);
    const keys40 = collectNodeIterations(wide40);

    // Bound is nodes × iterations — independent of fan-out width.
    expect(keys12.length).toBe(10);
    expect(keys1.length).toBe(10);
    expect(keys40.length).toBe(10);
    expect(keys12.length).toBe(keys40.length);

    const detail12 = projectRunDetail({
      run: baseRun(),
      tasks: wide12,
      deliverables: [],
      definition,
    });
    const detail40 = projectRunDetail({
      run: baseRun(),
      tasks: wide40,
      deliverables: [],
      definition,
    });

    expect(detail12.nodes.length).toBe(10);
    expect(detail40.nodes.length).toBe(10);

    const text12 = renderRunSummary(detail12);
    const text40 = renderRunSummary(detail40);
    // Count data lines under the NODE header (exclude header + footer).
    const dataLines = (text: string) =>
      text
        .split("\n")
        .filter((l) => /^(scope|search|funnel|validate|adversarial-review)\s/.test(l));
    expect(dataLines(text12).length).toBe(10);
    expect(dataLines(text40).length).toBe(10);
    expect(dataLines(text12).length).toBe(dataLines(text40).length);
  });
});

// ---------------------------------------------------------------------------
// Clauses 2–3 — gist: enum tally, plural count, single-task summary only
// ---------------------------------------------------------------------------

describe("gist assembly (deterministic, no inference)", () => {
  const coveragePort: QueryPort = {
    name: "coverage",
    type: { kind: "enum", name: "coverage", values: ["sufficient", "insufficient"] },
  };
  const sourcesPort: QueryPort = {
    name: "sources",
    type: { kind: "array", element: { kind: "text" } },
  };
  // Named schema — must NEVER be tallied (top-level enum only).
  const schemaPort: QueryPort = {
    name: "validation",
    type: {
      kind: "schema",
      name: "validation",
      path: "types/validation.schema.json",
      schema: {
        type: "object",
        properties: { status: { enum: ["supports", "contradicts"] } },
      },
    },
  };

  it("tallies top-level enum ports only", () => {
    const dels = [
      del({
        id: "d1",
        node: "review",
        port: "coverage",
        iteration: 1,
        value: JSON.stringify("insufficient"),
      }),
      del({
        id: "d2",
        node: "review",
        port: "coverage",
        iteration: 1,
        slot: "b",
        value: JSON.stringify("insufficient"),
      }),
      del({
        id: "d3",
        node: "review",
        port: "validation",
        iteration: 1,
        value: JSON.stringify({ status: "supports" }),
      }),
    ];
    const tallies = tallyEnumPorts([coveragePort, schemaPort], dels);
    expect(tallies).toEqual({ coverage: { insufficient: 2 } });
    expect(tallies.validation).toBeUndefined();
  });

  it("counts plural ports across siblings", () => {
    const dels = [
      del({
        id: "d1",
        node: "search",
        port: "sources",
        iteration: 1,
        slot: "a",
        value: JSON.stringify(["x", "y", "z"]),
      }),
      del({
        id: "d2",
        node: "search",
        port: "sources",
        iteration: 1,
        slot: "b",
        value: JSON.stringify(["p", "q"]),
      }),
    ];
    const counts = countPluralPorts([sourcesPort], dels);
    expect(counts).toEqual({ sources: 5 });
  });

  it("includes child summary only on single-task nodes", () => {
    const single = assembleGist({
      tallies: { coverage: { insufficient: 1 } },
      counts: {},
      summary: "Vendor self-published benchmarks only",
      tasks_settled: 1,
      tasks_total: 1,
    });
    expect(single).toContain("coverage=insufficient");
    expect(single).toContain("Vendor self-published benchmarks only");

    const multi = assembleGist({
      tallies: {},
      counts: { sources: 41 },
      summary: "should not appear",
      tasks_settled: 6,
      tasks_total: 6,
    });
    expect(multi).toBe("41 sources");
    expect(multi).not.toContain("should not appear");
  });

  it("emits n/m ok when a sibling is lost", () => {
    const gist = assembleGist({
      tallies: {},
      counts: { sources: 14 },
      summary: null,
      tasks_settled: 2,
      tasks_total: 3,
    });
    expect(gist).toBe("2/3 ok · 14 sources");
  });

  it("formats multi-value enum tallies like verdict=2 approve, 1 changes_requested", () => {
    const gist = assembleGist({
      tallies: { verdict: { approve: 2, changes_requested: 1 } },
      counts: {},
      summary: null,
      tasks_settled: 3,
      tasks_total: 3,
    });
    expect(gist).toMatch(/verdict=/);
    expect(gist).toContain("2 approve");
    expect(gist).toContain("1 changes_requested");
  });
});

// ---------------------------------------------------------------------------
// Clause 4 — polymorphic STATE
// ---------------------------------------------------------------------------

describe("polymorphic STATE", () => {
  it("projects step state from tasks", () => {
    expect(
      projectStepState([
        task({ id: "t1", node: "s", iteration: 1, state: "completed" }),
        task({ id: "t2", node: "s", iteration: 1, state: "running", slot: "b" }),
      ]),
    ).toBe("running");
    expect(
      projectStepState([
        task({ id: "t1", node: "s", iteration: 1, state: "completed" }),
        task({ id: "t2", node: "s", iteration: 1, state: "failed", slot: "b" }),
      ]),
    ).toBe("completed");
  });

  it("renders gate waiting vs step completed in the summary table", () => {
    const definition = parseWorkflowDefinition(
      {
        id: "g",
        version: 1,
        type: "other",
        workspace: "scratch",
        inputs: { brief: { type: "text" } },
        outputs: { out: { type: "text", from: "implement.report" } },
        nodes: [
          {
            id: "implement",
            kind: "step",
            prompt: "i.md",
            in: { brief: { type: "text", from: "run.brief" } },
            out: { report: { type: "text" } },
          },
          {
            id: "gate",
            kind: "gate",
            question: "Ship it?",
            shows: {},
            on_reject: "finish",
          },
        ],
      },
      { dir: "/tmp/g", expectedId: "g", typeCheck: true },
    ).definition;

    const detail = projectRunDetail({
      run: baseRun({
        id: "r6",
        workflow: "g",
        state: "blocked",
        current_node: "gate",
        iteration: 1,
        error: "blocked (gate gate)",
      }),
      tasks: [
        task({ id: "t1", node: "implement", iteration: 1, state: "completed" }),
      ],
      deliverables: [],
      definition,
    });

    const implement = detail.nodes.find((n) => n.node === "implement");
    const gate = detail.nodes.find((n) => n.node === "gate");
    expect(implement?.kind).toBe("step");
    expect(implement?.state).toBe("completed");
    expect(gate?.kind).toBe("gate");
    expect(gate?.state).toBe("waiting");
  });

  it("historical gate without a decision log is actioned, never a fabricated verb", () => {
    const definition = parseWorkflowDefinition(
      {
        id: "g",
        version: 1,
        type: "other",
        workspace: "scratch",
        inputs: { brief: { type: "text" } },
        outputs: { out: { type: "text", from: "end.report" } },
        nodes: [
          {
            id: "plan",
            kind: "step",
            prompt: "p.md",
            in: { brief: { type: "text", from: "run.brief" } },
            out: { plan: { type: "text" } },
          },
          {
            id: "approve-plan",
            kind: "gate",
            question: "Ship the plan?",
            shows: {},
            on_reject: "finish",
          },
          {
            id: "end",
            kind: "step",
            prompt: "e.md",
            in: { plan: { type: "text", from: "plan.plan" } },
            out: { report: { type: "text" } },
          },
        ],
      },
      { dir: "/tmp/g2", expectedId: "g", typeCheck: true },
    ).definition;

    // Run has moved past the gate (completed). Force the gate into the
    // (node, iteration) key set via a synthetic address row so the historical
    // path runs — there is still no decision log to read a verb from.
    const detail = projectRunDetail({
      run: baseRun({
        id: "r9",
        workflow: "g",
        state: "completed",
        current_node: null,
        iteration: 1,
        error: null,
        completed_at: "2026-07-25T10:00:00Z",
      }),
      tasks: [
        task({ id: "t1", node: "plan", iteration: 1, state: "completed" }),
        task({ id: "t2", node: "end", iteration: 1, state: "completed" }),
      ],
      deliverables: [
        // Anchor the gate into collectNodeIterations without inventing a verb.
        del({
          id: "d-gate-anchor",
          node: "approve-plan",
          port: "_visited",
          iteration: 1,
          value: null,
          purged_at: null,
        }),
      ],
      definition,
    });

    const gate = detail.nodes.find((n) => n.node === "approve-plan");
    expect(gate?.kind).toBe("gate");
    expect(gate?.state).toBe("actioned");
    // Must not claim any of the four real verbs.
    for (const verb of ["approved", "rejected", "redirected", "finished"] as const) {
      expect(gate?.state).not.toBe(verb);
    }
    expect(gate?.state).not.toBe("waiting");
    expect(gate?.state).not.toBe("skipped");
  });
});

// ---------------------------------------------------------------------------
// Clause 5 — address grammar
// ---------------------------------------------------------------------------

describe("deliverable address parsing", () => {
  it("parses node/port/iteration/slot", () => {
    expect(parseDeliverableAddress("search/sources/1/hybrid-search")).toEqual({
      runId: null,
      node: "search",
      port: "sources",
      iteration: 1,
      slot: "hybrid-search",
    });
  });

  it("parses run-prefixed slash address", () => {
    expect(parseDeliverableAddress("r7/search/sources/1")).toEqual({
      runId: "r7",
      node: "search",
      port: "sources",
      iteration: 1,
      slot: null,
    });
  });

  it("parses node.port form", () => {
    expect(parseDeliverableAddress("search.sources")).toEqual({
      runId: null,
      node: "search",
      port: "sources",
      iteration: null,
      slot: null,
    });
  });

  it("recognises opaque deliverable ids", () => {
    expect(looksLikeDeliverableId("d104")).toBe(true);
    expect(looksLikeDeliverableId("d1")).toBe(true);
    expect(looksLikeDeliverableId("search.sources")).toBe(false);
    expect(looksLikeDeliverableId("r7")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Clause 7 — purged / missing file render as decayed state
// ---------------------------------------------------------------------------

describe("purged and missing-path deliverable rendering", () => {
  it("purged inline deliverable is legible, not blank", () => {
    const v = resolveDeliverableValue({
      deliverable: del({
        id: "d004",
        node: "search",
        port: "sources",
        iteration: 1,
        slot: "hybrid-search",
        value: null,
        purged_at: "2026-06-24T12:00:00Z",
      }),
    });
    expect(v.value).toBeNull();
    expect(v.note).toMatch(/purged on 2026-06-24/);
    expect(v.note).toMatch(/search/);

    const bare = renderDeliverableBare(v);
    expect(bare.exitCode).toBe(EXIT_DELIVERABLE_PURGED);
    expect(bare.exitCode).toBe(9);
    expect(bare.stderr).toMatch(/was purged/);
    expect(bare.stderr).toMatch(/d004/);
  });

  it("pins exit code 9 as the purged-deliverable contract", () => {
    expect(EXIT_DELIVERABLE_PURGED).toBe(9);
    const bare = renderDeliverableBare(
      resolveDeliverableValue({
        deliverable: del({
          id: "d9",
          node: "search",
          port: "sources",
          iteration: 1,
          value: null,
          purged_at: "2026-07-01T00:00:00Z",
        }),
      }),
    );
    expect(bare.exitCode).toBe(EXIT_DELIVERABLE_PURGED);
    expect(bare.stdout).toBe("");
    expect(bare.stderr).toMatch(/was purged/);
  });

  it("null task_id (retention deleted producer) still renders", () => {
    const d = del({
      id: "d-null-task",
      node: "search",
      port: "sources",
      iteration: 1,
      task_id: null,
      value: JSON.stringify(["a"]),
    });
    const ref = toDeliverableRef(d);
    expect(ref.task_id).toBeNull();
    const v = resolveDeliverableValue({ deliverable: d });
    expect(v.task_id).toBeNull();
    expect(v.value).toEqual(["a"]);
    const bare = renderDeliverableBare(v);
    expect(bare.exitCode).toBe(0);
  });

  it("missing file path prints path + note, not a crash", () => {
    const v = resolveDeliverableValue({
      deliverable: {
        id: "d512",
        run_id: "r9",
        node: "bundle",
        port: "report",
        iteration: 1,
        slot: null,
        task_id: "t9",
        kind: "file",
        value: ".parley/tmp/bundle.1/out/report.pdf",
        created_at: "2026-07-25T09:00:00Z",
        purged_at: null,
      },
      workspaceRoot: "/tmp/nonexistent-workspace-xyz",
    });
    expect(v.kind).toBe("file");
    expect(v.exists).toBe(false);
    expect(v.note).toMatch(/do not outlive their workspace/);

    const bare = renderDeliverableBare(v);
    expect(bare.exitCode).toBe(0);
    expect(bare.stdout).toMatch(/report\.pdf/);
  });
});

// ---------------------------------------------------------------------------
// Clause 6 — child MCP has no run_status
// ---------------------------------------------------------------------------

describe("child MCP channel denial (clause 6)", () => {
  it("child MCP tool list does not include run_status", async () => {
    // MCP registers tools explicitly in mcp.ts — there is no auto-allowlist.
    // Regression: the only child tools remain submit_report + ask_orchestrator.
    const fs = await import("node:fs");
    const path = await import("node:path");
    const mcpSrc = fs.readFileSync(
      path.join(import.meta.dirname, "../src/mcp.ts"),
      "utf8",
    );
    // Extract registerTool("name" calls
    const names = [...mcpSrc.matchAll(/registerTool\(\s*"([^"]+)"/g)].map(
      (m) => m[1],
    );
    expect(names).toEqual(["submit_report", "ask_orchestrator"]);
    expect(names).not.toContain("run_status");
    expect(names).not.toContain("run_get");
    expect(names).not.toContain("list_runs");
  });

  it("child HTTP surface has no run query routes", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const childSrc = fs.readFileSync(
      path.join(import.meta.dirname, "../src/child.ts"),
      "utf8",
    );
    expect(childSrc).not.toMatch(/run_status|run status|\/runs/);
    // Only the three known child handlers.
    expect(childSrc).toMatch(/handleChildReport/);
    expect(childSrc).toMatch(/handleChildAsk/);
    expect(childSrc).toMatch(/handleChildTask/);
  });
});

// ---------------------------------------------------------------------------
// Port type kind helper (clause 8 relies on real kinds)
// ---------------------------------------------------------------------------

describe("inline vs file/dir kind rendering", () => {
  it("inline value serialises as JSON in bare mode", () => {
    const v = resolveDeliverableValue({
      deliverable: del({
        id: "d104",
        node: "search",
        port: "sources",
        iteration: 1,
        value: JSON.stringify([{ url: "https://example.org" }]),
      }),
    });
    expect(v.kind).toBe("inline");
    expect(Array.isArray(v.value)).toBe(true);
    const bare = renderDeliverableBare(v);
    expect(bare.exitCode).toBe(0);
    expect(JSON.parse(bare.stdout)).toEqual([{ url: "https://example.org" }]);
  });
});
