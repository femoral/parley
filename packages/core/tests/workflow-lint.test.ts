/**
 * #232 — workflow lint: rules, inferred plan, static worst case.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildInferredPlan,
  buildStaticWorstCase,
  formatInferredPlan,
  formatStaticWorstCase,
  lintWorkflow,
} from "../src/workflow/lint.js";
import { parseWorkflowDefinition } from "../src/workflow/definition.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const prototypeRoot = path.join(
  repoRoot,
  "docs/arch/215-workflow-definition-prototype",
);

function mini(nodes: unknown[], extra: Record<string, unknown> = {}) {
  return {
    id: "mini",
    version: 1,
    type: "coding",
    inputs: { brief: { type: "text" } },
    outputs: {},
    types: {},
    nodes,
    ...extra,
  };
}

function step(
  id: string,
  opts: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    kind: "step",
    prompt: "p.md",
    in: {},
    out: {},
    ...opts,
  };
}

describe("lintWorkflow — prototypes", () => {
  it("coding-1: clean plan with slots fan-out, join, and loop", () => {
    const dir = path.join(prototypeRoot, "coding-1");
    const raw = JSON.parse(
      fs.readFileSync(path.join(dir, "workflow.json"), "utf8"),
    );
    const result = lintWorkflow(raw, { dir, expectedId: "coding-1" });
    expect(result.ok).toBe(true);
    expect(result.findings.filter((f) => f.severity === "error")).toEqual([]);
    expect(result.plan).not.toBeNull();
    expect(result.plan!.fanOuts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          nodeId: "review",
          kind: "slots",
          width: 3,
        }),
      ]),
    );
    expect(result.plan!.joins.some((j) => j.nodeId === "triage")).toBe(true);
    expect(result.plan!.loops).toEqual([
      expect.objectContaining({
        nodeId: "triage",
        to: "implement",
        max: 2,
        whileIs: "changes_requested",
      }),
    ]);
    expect(result.worstCase).not.toBeNull();
    // review: width 3 × loop.max 2 = 6; implement/plan/triage also covered
    expect(result.worstCase!.maxTasks).toBeGreaterThanOrEqual(6);
    expect(result.worstCase!.maxStatusLines).toBe(5 * 2);
  });

  it("research: data fan-out widths from max_items + accumulate factor", () => {
    const dir = path.join(prototypeRoot, "research");
    const raw = JSON.parse(
      fs.readFileSync(path.join(dir, "workflow.json"), "utf8"),
    );
    const result = lintWorkflow(raw, { dir, expectedId: "research" });
    expect(result.ok).toBe(true);
    const search = result.worstCase!.steps.find((s) => s.nodeId === "search");
    expect(search).toMatchObject({
      width: 8, // scope.queries max_items
      loopMax: 2,
    });
    // search tasks = 8 × 2 = 16
    expect(search!.tasks).toBe(16);

    const validate = result.worstCase!.steps.find((s) => s.nodeId === "validate");
    expect(validate).toMatchObject({
      width: 12, // funnel.shortlist max_items
      loopMax: 2,
    });

    const plan = result.plan!;
    expect(plan.fanOuts.some((f) => f.nodeId === "search" && f.kind === "data")).toBe(
      true,
    );
    expect(plan.joins.some((j) => j.nodeId === "funnel")).toBe(true);
  });
});

describe("lintWorkflow — errors", () => {
  it("reports duplicate node id via parse failure", () => {
    const result = lintWorkflow(
      mini([
        step("a", {
          in: { b: { type: "text", from: "run.brief" } },
          out: { x: { type: "text" } },
        }),
        step("a", {
          in: { b: { type: "text", from: "run.brief" } },
          out: { x: { type: "text" } },
        }),
      ]),
      { dir: "/tmp/mini", expectedId: "mini" },
    );
    expect(result.ok).toBe(false);
    expect(result.findings.some((f) => /duplicate/i.test(f.message))).toBe(true);
  });

  it("rejects from naming an unknown or later node", () => {
    const result = lintWorkflow(
      mini([
        step("a", {
          in: { b: { type: "text", from: "run.brief" } },
          out: { x: { type: "text" } },
        }),
        step("b", {
          in: {
            t: { type: "text", from: "missing.port" },
            u: { type: "text", from: "c.x" },
          },
          out: { y: { type: "text" } },
        }),
        step("c", {
          in: { t: { type: "text", from: "a.x" } },
          out: { x: { type: "text" } },
        }),
      ]),
      { dir: "/tmp/mini", expectedId: "mini" },
    );
    expect(result.ok).toBe(false);
    const msgs = result.findings.map((f) => f.message).join("\n");
    expect(msgs).toMatch(/unknown node "missing"/);
    expect(msgs).toMatch(/later node "c"/);
  });

  it("rejects loop.to not earlier and loop.max < 1 (parse)", () => {
    const forward = lintWorkflow(
      mini([
        step("a", {
          in: { b: { type: "text", from: "run.brief" } },
          out: { x: { type: "text" } },
        }),
        step("b", {
          in: { t: { type: "text", from: "a.x" } },
          out: { y: { type: "text" } },
          loop: { to: "b", max: 2 },
        }),
      ]),
      { dir: "/tmp/mini", expectedId: "mini" },
    );
    expect(forward.ok).toBe(false);
    expect(
      forward.findings.some((f) => f.field.includes("loop.to")),
    ).toBe(true);

    const badMax = lintWorkflow(
      mini([
        step("a", {
          in: { b: { type: "text", from: "run.brief" } },
          out: { x: { type: "text" } },
          loop: { to: "a", max: 0 },
        }),
      ]),
      { dir: "/tmp/mini", expectedId: "mini" },
    );
    // max < 1 fails in the parser (structural) — one finding, no definition
    expect(badMax.ok).toBe(false);
    expect(badMax.findings.some((f) => /positive integer|max/.test(f.message))).toBe(
      true,
    );
  });

  it("rejects while on non-enum / unknown port", () => {
    const result = lintWorkflow(
      mini([
        step("a", {
          in: { b: { type: "text", from: "run.brief" } },
          out: { note: { type: "text" } },
          loop: {
            to: "a",
            max: 2,
            while: { port: "note", is: "yes" },
          },
        }),
      ]),
      { dir: "/tmp/mini", expectedId: "mini" },
    );
    expect(result.ok).toBe(false);
    expect(
      result.findings.some((f) => /while requires an enum/.test(f.message)),
    ).toBe(true);
  });

  it("rejects loop.with on a port that already has from, and from-less without with", () => {
    const result = lintWorkflow(
      {
        id: "mini",
        version: 1,
        type: "coding",
        inputs: { brief: { type: "text" } },
        types: { verdict: { enum: ["ok", "retry"] } },
        nodes: [
          step("a", {
            in: {
              brief: { type: "text", from: "run.brief" },
              // has from — loop.with must not target it
              extra: { type: "text", from: "run.brief" },
              // no from and nothing fills it
              rework: { type: "text" },
            },
            out: { v: { type: "verdict" }, note: { type: "text" } },
            loop: {
              to: "a",
              max: 2,
              while: { port: "v", is: "retry" },
              with: {
                extra: "a.note",
                // rework deliberately omitted → from-less error
              },
            },
          }),
        ],
      },
      { dir: "/tmp/mini", expectedId: "mini" },
    );
    expect(result.ok).toBe(false);
    const msgs = result.findings.map((f) => f.message).join("\n");
    expect(msgs).toMatch(/already has a from/);
    expect(msgs).toMatch(/no from and no loop\.with fills it/);
  });

  it("rejects gate declaring in/out/slots or missing on_reject", () => {
    const result = lintWorkflow(
      mini([
        {
          id: "g",
          kind: "gate",
          question: "ok?",
          shows: {},
          // on_reject missing
          in: { x: { type: "text" } },
          out: { y: { type: "text" } },
          slots: { a: {} },
        },
      ]),
      { dir: "/tmp/mini", expectedId: "mini" },
    );
    expect(result.ok).toBe(false);
    const fields = result.findings.map((f) => f.field);
    expect(fields.some((f) => f.includes("in"))).toBe(true);
    expect(fields.some((f) => f.includes("out"))).toBe(true);
    expect(fields.some((f) => f.includes("slots"))).toBe(true);
    // missing on_reject: parser throws OR we already collected gate field errors
    expect(
      result.findings.some(
        (f) => f.field.includes("on_reject") || /on_reject/.test(f.message),
      ),
    ).toBe(true);
  });

  it("rejects type-incompatible from and unresolvable types (parse)", () => {
    const result = lintWorkflow(
      mini([
        step("a", {
          in: { b: { type: "text", from: "run.brief" } },
          out: { items: { type: "text[]", max_items: 3 } },
        }),
        step("b", {
          in: { n: { type: "url", from: "a.items" } },
          out: {},
        }),
      ]),
      { dir: "/tmp/mini", expectedId: "mini" },
    );
    expect(result.ok).toBe(false);
    expect(
      result.findings.some((f) => /incompatible types/.test(f.message)),
    ).toBe(true);
  });

  it("rejects slots + over on the same step", () => {
    const result = lintWorkflow(
      mini([
        step("a", {
          in: { b: { type: "text", from: "run.brief" } },
          out: { items: { type: "text[]", max_items: 4 } },
        }),
        step("b", {
          over: "item",
          slots: { x: {} },
          in: { item: { type: "text", from: "a.items" } },
          out: { n: { type: "text" } },
        }),
      ]),
      { dir: "/tmp/mini", expectedId: "mini" },
    );
    expect(result.ok).toBe(false);
    expect(
      result.findings.some((f) => /slots and over/.test(f.message)),
    ).toBe(true);
  });

  it("rejects over without max_items on the producing container", () => {
    const result = lintWorkflow(
      mini([
        step("a", {
          in: { b: { type: "text", from: "run.brief" } },
          out: { items: { type: "text[]" } }, // no max_items
        }),
        step("b", {
          over: "item",
          in: { item: { type: "text", from: "a.items" } },
          out: { n: { type: "text" } },
        }),
      ]),
      { dir: "/tmp/mini", expectedId: "mini" },
    );
    expect(result.ok).toBe(false);
    expect(
      result.findings.some((f) => /no max_items/.test(f.message)),
    ).toBe(true);
  });

  it("rejects accumulate on a non-container port", () => {
    const result = lintWorkflow(
      mini([
        step("a", {
          in: { b: { type: "text", from: "run.brief" } },
          out: { x: { type: "text" } },
        }),
        step("b", {
          in: {
            t: { type: "text", from: "a.x", accumulate: true },
          },
          out: {},
        }),
      ]),
      { dir: "/tmp/mini", expectedId: "mini" },
    );
    expect(result.ok).toBe(false);
    expect(
      result.findings.some((f) => /accumulate is only legal on container/.test(f.message)),
    ).toBe(true);
  });

  it("rejects loop on a fanned-out step", () => {
    const result = lintWorkflow(
      {
        id: "mini",
        version: 1,
        type: "coding",
        inputs: { brief: { type: "text" } },
        types: { verdict: { enum: ["ok", "retry"] } },
        nodes: [
          step("a", {
            in: { b: { type: "text", from: "run.brief" } },
            out: { items: { type: "text[]", max_items: 3 } },
          }),
          step("b", {
            over: "item",
            in: { item: { type: "text", from: "a.items" } },
            out: { v: { type: "verdict" } },
            loop: {
              to: "a",
              max: 2,
              while: { port: "v", is: "retry" },
            },
          }),
        ],
      },
      { dir: "/tmp/mini", expectedId: "mini" },
    );
    expect(result.ok).toBe(false);
    expect(
      result.findings.some((f) => /loop is not allowed on a fanned-out/.test(f.message)),
    ).toBe(true);
  });

  it("rejects a slot vendor/model outside the allowlist", () => {
    const result = lintWorkflow(
      mini([
        step("a", {
          in: { b: { type: "text", from: "run.brief" } },
          out: { x: { type: "text" } },
          slots: {
            s1: { vendor: "codex", model: "not-a-real-model", effort: "high" },
          },
        }),
      ]),
      {
        dir: "/tmp/mini",
        expectedId: "mini",
        vendors: {
          codex: {
            models: {
              "gpt-5.1-codex": { efforts: ["high", "medium"], default: "medium" },
            },
          },
        },
        configPath: "/tmp/parley.json",
      },
    );
    expect(result.ok).toBe(false);
    expect(
      result.findings.some(
        (f) =>
          f.field.includes("slots.s1") &&
          (/not allowed|no models|not-a-real-model/.test(f.message)),
      ),
    ).toBe(true);
  });

  it("accepts a slot vendor/model on the allowlist", () => {
    const result = lintWorkflow(
      mini([
        step("a", {
          in: { b: { type: "text", from: "run.brief" } },
          out: { x: { type: "text" } },
          slots: {
            s1: { vendor: "codex", model: "gpt-5.1-codex", effort: "high" },
          },
        }),
      ]),
      {
        dir: "/tmp/mini",
        expectedId: "mini",
        vendors: {
          codex: {
            models: {
              "gpt-5.1-codex": { efforts: ["high", "medium"], default: "medium" },
            },
          },
        },
      },
    );
    expect(
      result.findings.filter((f) => f.field.includes("slots")),
    ).toEqual([]);
  });

  it("collects multiple semantic errors in one pass (does not die on first)", () => {
    const result = lintWorkflow(
      mini([
        step("a", {
          in: { b: { type: "text", from: "run.brief" } },
          out: { items: { type: "text[]" } }, // no max_items
        }),
        step("b", {
          over: "item",
          slots: { x: {} }, // slots+over
          in: {
            item: { type: "text", from: "a.items" },
            orphan: { type: "text" }, // from-less, no loop.with
          },
          out: {},
        }),
      ]),
      { dir: "/tmp/mini", expectedId: "mini" },
    );
    expect(result.ok).toBe(false);
    const msgs = result.findings.map((f) => f.message).join("\n");
    expect(msgs).toMatch(/slots and over/);
    expect(msgs).toMatch(/no max_items|no from and no loop\.with/);
    // At least two distinct error findings
    expect(result.findings.filter((f) => f.severity === "error").length).toBeGreaterThanOrEqual(
      2,
    );
  });
});

describe("lintWorkflow — warnings", () => {
  it("warns on id / directory mismatch", () => {
    const result = lintWorkflow(
      mini([
        step("a", {
          in: { b: { type: "text", from: "run.brief" } },
          out: { x: { type: "text" } },
        }),
      ]),
      { dir: "/tmp/right", expectedId: "right" },
    );
    // id is "mini" from mini() helper
    expect(
      result.findings.some(
        (f) => f.severity === "warning" && f.field === "id" && /does not match/.test(f.message),
      ),
    ).toBe(true);
  });

  it("warns on a step with no out ports", () => {
    const result = lintWorkflow(
      mini([
        step("a", {
          in: { b: { type: "text", from: "run.brief" } },
          out: {},
        }),
      ]),
      { dir: "/tmp/mini", expectedId: "mini" },
    );
    expect(
      result.findings.some(
        (f) => f.severity === "warning" && /no out ports/.test(f.message),
      ),
    ).toBe(true);
  });

  it("warns on a while case the enum can never produce", () => {
    const result = lintWorkflow(
      {
        id: "mini",
        version: 1,
        type: "coding",
        inputs: { brief: { type: "text" } },
        types: { verdict: { enum: ["ok", "retry"] } },
        nodes: [
          step("a", {
            in: {
              brief: { type: "text", from: "run.brief" },
              rework: { type: "text" },
            },
            out: { v: { type: "verdict" }, note: { type: "text" } },
            loop: {
              to: "a",
              max: 2,
              while: { port: "v", is: "nope" },
              with: { rework: "a.note" },
            },
          }),
        ],
      },
      { dir: "/tmp/mini", expectedId: "mini" },
    );
    expect(
      result.findings.some(
        (f) =>
          f.severity === "warning" &&
          /while case "nope"/.test(f.message),
      ),
    ).toBe(true);
  });

  it("warns when a plural output is never joined", () => {
    const result = lintWorkflow(
      mini([
        step("a", {
          in: { b: { type: "text", from: "run.brief" } },
          out: { items: { type: "text[]", max_items: 3 } },
        }),
        // no consumer joins a.items
      ]),
      { dir: "/tmp/mini", expectedId: "mini" },
    );
    expect(
      result.findings.some(
        (f) =>
          f.severity === "warning" &&
          /plural output/.test(f.message) &&
          /never joined/.test(f.message),
      ),
    ).toBe(true);
  });
});

describe("inferred plan + worst case formatting", () => {
  it("formats plan and worst case as multi-line text", () => {
    const dir = path.join(prototypeRoot, "coding-1");
    const { definition } = parseWorkflowDefinition(
      JSON.parse(fs.readFileSync(path.join(dir, "workflow.json"), "utf8")),
      { dir, typeCheck: false },
    );
    const plan = buildInferredPlan(definition);
    const wc = buildStaticWorstCase(definition);
    const planText = formatInferredPlan(plan);
    const wcText = formatStaticWorstCase(wc);
    expect(planText).toMatch(/inferred plan:/);
    expect(planText).toMatch(/fan-out/);
    expect(planText).toMatch(/join/);
    expect(planText).toMatch(/loop/);
    expect(wcText).toMatch(/static worst case:/);
    expect(wcText).toMatch(/max tasks:/);
    expect(wcText).toMatch(/review/);
  });

  it("multiplies width × loop.max for fanned steps inside a loop body", () => {
    const raw = {
      id: "acc",
      version: 1,
      type: "research",
      inputs: { brief: { type: "text" } },
      types: {},
      nodes: [
        step("prod", {
          in: {
            b: { type: "text", from: "run.brief" },
            rework: { type: "text" },
          },
          out: { items: { type: "text[]", max_items: 5 } },
        }),
        step("fan", {
          over: "item",
          in: {
            item: { type: "text", from: "prod.items" },
          },
          out: { n: { type: "text" } },
        }),
        step("end", {
          in: {
            notes: { type: "text[]", from: "fan.n" },
          },
          out: { done: { type: "text" } },
          loop: {
            to: "prod",
            max: 3,
            with: { rework: "end.done" },
          },
        }),
      ],
    };

    const result = lintWorkflow(raw, { dir: "/tmp/acc", expectedId: "acc" });
    const fan = result.worstCase?.steps.find((s) => s.nodeId === "fan");
    expect(fan).toBeDefined();
    // width 5 × loopMax 3 = 15
    expect(fan!.width).toBe(5);
    expect(fan!.loopMax).toBe(3);
    expect(fan!.tasks).toBe(15);
  });

  it("applies a further × loop.max when over input is accumulate on a container", () => {
    // accumulate is only legal on containers. Model a join-then-fan path where
    // the over port itself is a container element of a nested structure is not
    // how `over` works; instead, when the over port is somehow a container
    // with accumulate the factor multiplies. Here we mark accumulate on a
    // container input that is NOT the over port — the ADR factor applies only
    // to the over port. So craft over on a dict value path:
    // producer emits dict<string, text[]>; consumer over: batch where batch is
    // text[] (element of dict) — still not accumulate on container.
    //
    // Direct interpretation of the ADR: over port has accumulate:true.
    // That requires the over port type to be a container, which means the
    // upstream is a container-of-containers and fan-out peels one layer.
    const raw = {
      id: "acc2",
      version: 1,
      type: "research",
      inputs: { brief: { type: "text" } },
      types: {},
      nodes: [
        step("prod", {
          in: {
            b: { type: "text", from: "run.brief" },
            rework: { type: "text" },
          },
          // dict of batches — each value is text[]
          out: {
            batches: { type: "dict<string, text[]>", max_items: 4 },
          },
        }),
        step("fan", {
          over: "batch",
          in: {
            // batch is text[] ≡ element of dict<string, text[]>
            batch: {
              type: "text[]",
              from: "prod.batches",
              accumulate: true,
            },
          },
          out: { n: { type: "text" } },
        }),
        step("end", {
          in: { notes: { type: "text[]", from: "fan.n" } },
          out: { done: { type: "text" } },
          loop: {
            to: "prod",
            max: 3,
            with: { rework: "end.done" },
          },
        }),
      ],
    };

    const result = lintWorkflow(raw, { dir: "/tmp/acc2", expectedId: "acc2" });
    const fan = result.worstCase?.steps.find((s) => s.nodeId === "fan");
    expect(fan).toBeDefined();
    // width 4 × loopMax 3 × accumulateFactor 3 = 36
    expect(fan!.width).toBe(4);
    expect(fan!.loopMax).toBe(3);
    expect(fan!.accumulateFactor).toBe(3);
    expect(fan!.tasks).toBe(36);
    // accumulate on container is legal
    expect(
      result.findings.filter((f) => /accumulate is only legal/.test(f.message)),
    ).toEqual([]);
  });
});

describe("lintWorkflow — load from temp dir with schema types", () => {
  it("lints a workflow that references a schema file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "parley-wf-lint-"));
    try {
      fs.mkdirSync(path.join(dir, "types"));
      fs.writeFileSync(
        path.join(dir, "types", "source.schema.json"),
        JSON.stringify({
          type: "object",
          properties: { url: { type: "string" } },
          required: ["url"],
        }),
      );
      const raw = {
        id: path.basename(dir),
        version: 1,
        type: "research",
        types: { source: { schema: "types/source.schema.json" } },
        inputs: { brief: { type: "text" } },
        nodes: [
          step("a", {
            in: { b: { type: "text", from: "run.brief" } },
            out: { s: { type: "source[]", max_items: 2 } },
          }),
        ],
      };
      const result = lintWorkflow(raw, {
        dir,
        expectedId: path.basename(dir),
      });
      expect(result.definition).not.toBeNull();
      expect(result.findings.filter((f) => f.severity === "error")).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
