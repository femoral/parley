/**
 * #231 — workflow definition parse/type-check, including the three prototype drafts.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  loadWorkflowDefinition,
  parseWorkflowDefinition,
} from "../src/workflow/definition.js";
import { formatPortType } from "../src/workflow/types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const prototypeRoot = path.join(
  repoRoot,
  "docs/arch/215-workflow-definition-prototype",
);

describe("parseWorkflowDefinition — shape", () => {
  it("defaults workspace to repo", () => {
    const { definition } = parseWorkflowDefinition(
      {
        id: "mini",
        version: 1,
        type: "coding",
        inputs: { brief: { type: "text" } },
        outputs: {},
        types: {},
        nodes: [
          {
            id: "only",
            kind: "step",
            prompt: "prompts/x.md",
            in: { brief: { type: "text", from: "run.brief" } },
            out: { ok: { type: "text" } },
          },
        ],
      },
      { dir: "/tmp/mini" },
    );
    expect(definition.workspace).toBe("repo");
    expect(definition.inputs.brief?.type).toEqual({ kind: "text" });
  });

  it("warns when id mismatches directory name", () => {
    const { warnings } = parseWorkflowDefinition(
      {
        id: "wrong",
        version: 1,
        type: "coding",
        nodes: [
          {
            id: "a",
            kind: "step",
            prompt: "p.md",
            in: {},
            out: {},
          },
        ],
      },
      { dir: "/tmp/right", expectedId: "right" },
    );
    expect(warnings).toEqual([
      {
        field: "id",
        message: 'workflow.id "wrong" does not match directory name "right"',
      },
    ]);
  });

  it("rejects number/bool types and unknown named types", () => {
    expect(() =>
      parseWorkflowDefinition(
        {
          id: "x",
          version: 1,
          type: "coding",
          nodes: [
            {
              id: "a",
              kind: "step",
              prompt: "p.md",
              in: {},
              out: { n: { type: "number" } },
            },
          ],
        },
        { dir: "/tmp/x" },
      ),
    ).toThrow(/not an atom/);
  });
});

describe("prototype drafts — load + type-check", () => {
  it("parses coding-1", () => {
    const dir = path.join(prototypeRoot, "coding-1");
    const { definition, warnings } = loadWorkflowDefinition(dir);
    expect(warnings).toEqual([]);
    expect(definition.id).toBe("coding-1");
    expect(definition.workspace).toBe("repo");
    expect(definition.type).toBe("coding");
    expect(definition.nodes.map((n) => n.id)).toEqual([
      "plan",
      "approve-plan",
      "implement",
      "review",
      "triage",
    ]);
    const review = definition.nodes.find((n) => n.id === "review");
    expect(review?.kind).toBe("step");
    if (review?.kind === "step") {
      expect(Object.keys(review.slots ?? {})).toEqual([
        "correctness",
        "tests",
        "docs",
      ]);
    }
    const gate = definition.nodes.find((n) => n.id === "approve-plan");
    expect(gate?.kind).toBe("gate");
    if (gate?.kind === "gate") {
      expect(gate.on_reject).toBe("finish");
    }
    // Authored fan-out collection: review.verdict → dict for triage
    const triage = definition.nodes.find((n) => n.id === "triage");
    expect(triage?.kind).toBe("step");
    if (triage?.kind === "step") {
      expect(formatPortType(triage.in.verdicts!.type)).toBe("dict<string, verdict>");
    }
  });

  it("parses coding-2", () => {
    const dir = path.join(prototypeRoot, "coding-2");
    const { definition, warnings } = loadWorkflowDefinition(dir);
    expect(warnings).toEqual([]);
    expect(definition.id).toBe("coding-2");
    expect(definition.nodes.map((n) => n.id)).toEqual([
      "implement",
      "review",
      "triage",
      "rework-or-finish",
    ]);
    const gate = definition.nodes.find((n) => n.id === "rework-or-finish");
    expect(gate?.kind).toBe("gate");
    if (gate?.kind === "gate") {
      expect(gate.loop?.to).toBe("implement");
      expect(gate.loop?.max).toBe(2);
      // Gate loop has no while — orchestrator is the condition.
      expect(gate.loop?.while).toBeUndefined();
    }
  });

  it("parses research (scratch + schema types + data fan-out + accumulate)", () => {
    const dir = path.join(prototypeRoot, "research");
    const { definition, warnings } = loadWorkflowDefinition(dir);
    expect(warnings).toEqual([]);
    expect(definition.id).toBe("research");
    expect(definition.workspace).toBe("scratch");
    expect(definition.types.source?.kind).toBe("schema");
    expect(definition.types.validation?.kind).toBe("schema");
    expect(definition.types.verdict?.kind).toBe("enum");
    expect(definition.types.coverage?.kind).toBe("enum");

    const search = definition.nodes.find((n) => n.id === "search");
    expect(search?.kind).toBe("step");
    if (search?.kind === "step") {
      expect(search.over).toBe("query");
      expect(search.success?.min).toBe(3);
      expect(formatPortType(search.in.query!.type)).toBe("text");
      expect(search.out.sources!.bounds.maxItems).toBe(10);
    }

    const funnel = definition.nodes.find((n) => n.id === "funnel");
    expect(funnel?.kind).toBe("step");
    if (funnel?.kind === "step") {
      expect(funnel.in.harvest!.accumulate).toBe(true);
      expect(formatPortType(funnel.in.harvest!.type)).toBe("dict<string, source[]>");
    }

    const validate = definition.nodes.find((n) => n.id === "validate");
    expect(validate?.kind).toBe("step");
    if (validate?.kind === "step") {
      expect(validate.over).toBe("source");
    }

    // Schema files actually loaded
    if (definition.types.source?.kind === "schema") {
      expect(definition.types.source.schema).toMatchObject({
        type: "object",
        required: expect.arrayContaining(["url", "title", "claim"]),
      });
    }
  });
});

describe("type-check edges", () => {
  it("requires over for data fan-out", () => {
    expect(() =>
      parseWorkflowDefinition(
        {
          id: "fan",
          version: 1,
          type: "research",
          inputs: {},
          types: {},
          nodes: [
            {
              id: "producer",
              kind: "step",
              prompt: "p.md",
              in: {},
              out: { items: { type: "text[]", max_items: 5 } },
            },
            {
              id: "consumer",
              kind: "step",
              prompt: "p.md",
              // missing over: "item"
              in: { item: { type: "text", from: "producer.items" } },
              out: {},
            },
          ],
        },
        { dir: "/tmp/fan" },
      ),
    ).toThrow(/data fan-out requires over/);
  });

  it("accepts declared data fan-out", () => {
    const { definition } = parseWorkflowDefinition(
      {
        id: "fan",
        version: 1,
        type: "research",
        nodes: [
          {
            id: "producer",
            kind: "step",
            prompt: "p.md",
            in: {},
            out: { items: { type: "text[]", max_items: 5 } },
          },
          {
            id: "consumer",
            kind: "step",
            prompt: "p.md",
            over: "item",
            in: { item: { type: "text", from: "producer.items" } },
            out: { note: { type: "text" } },
          },
        ],
      },
      { dir: "/tmp/fan" },
    );
    expect(definition.nodes).toHaveLength(2);
  });

  it("rejects slots combined with over", () => {
    expect(() =>
      parseWorkflowDefinition(
        {
          id: "both",
          version: 1,
          type: "coding",
          nodes: [
            {
              id: "producer",
              kind: "step",
              prompt: "p.md",
              in: {},
              out: { items: { type: "text[]" } },
            },
            {
              id: "bad",
              kind: "step",
              prompt: "p.md",
              over: "item",
              slots: { a: {} },
              in: { item: { type: "text", from: "producer.items" } },
              out: {},
            },
          ],
        },
        { dir: "/tmp/both" },
      ),
    ).toThrow(/slots and over/);
  });
});

describe("loadWorkflowDefinition — missing files", () => {
  it("throws when workflow.json is absent", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "parley-wf-"));
    try {
      expect(() => loadWorkflowDefinition(dir)).toThrow(/cannot read/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Soft-structural mode (#248): recoverable structural failures accumulate;
 * fatal ones still throw. Default (hard) mode is unchanged.
 */
describe("parseWorkflowDefinition — softStructural", () => {
  const base = {
    id: "soft",
    version: 1,
    type: "coding",
    inputs: { brief: { type: "text" } },
    outputs: {},
    types: {},
  };

  it("default mode still throws on recoverable structural failures", () => {
    // Hard throw is the run-engine / load path contract — soft is opt-in only.
    expect(() =>
      parseWorkflowDefinition(
        {
          ...base,
          nodes: [
            {
              id: "a",
              kind: "step",
              prompt: "p.md",
              in: { b: { type: "text", from: "run.brief" } },
              out: { x: { type: "text" } },
            },
            {
              id: "a",
              kind: "step",
              prompt: "p.md",
              in: { b: { type: "text", from: "run.brief" } },
              out: { y: { type: "text" } },
            },
          ],
        },
        { dir: "/tmp/soft" },
      ),
    ).toThrow(/duplicate node id/);

    expect(() =>
      parseWorkflowDefinition(
        {
          ...base,
          nodes: [
            {
              id: "a",
              kind: "step",
              prompt: "p.md",
              in: { b: { type: "text", from: "run.brief" } },
              out: { x: { type: "text" } },
              loop: { to: "a", max: 0 },
            },
          ],
        },
        { dir: "/tmp/soft" },
      ),
    ).toThrow(/positive integer/);

    expect(() =>
      parseWorkflowDefinition(
        {
          ...base,
          nodes: [
            {
              id: "g",
              kind: "gate",
              question: "ok?",
              shows: {},
              // on_reject missing
            },
          ],
        },
        { dir: "/tmp/soft" },
      ),
    ).toThrow(/on_reject/);

    expect(() =>
      parseWorkflowDefinition(
        {
          ...base,
          nodes: [
            {
              id: "a",
              kind: "step",
              prompt: "p.md",
              in: {},
              out: { n: { type: "number" } },
            },
          ],
        },
        { dir: "/tmp/soft" },
      ),
    ).toThrow(/not an atom/);
  });

  it("loadWorkflowDefinition (engine load path) rejects structural failures", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "parley-wf-soft-"));
    try {
      fs.writeFileSync(
        path.join(dir, "workflow.json"),
        JSON.stringify({
          id: path.basename(dir),
          version: 1,
          type: "coding",
          nodes: [
            {
              id: "a",
              kind: "step",
              prompt: "p.md",
              in: {},
              out: {},
            },
            {
              id: "a",
              kind: "step",
              prompt: "p.md",
              in: {},
              out: {},
            },
          ],
        }),
      );
      expect(() => loadWorkflowDefinition(dir)).toThrow(/duplicate node id/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("collects recoverable structural errors and returns a degraded definition", () => {
    const { definition, structuralErrors } = parseWorkflowDefinition(
      {
        ...base,
        nodes: [
          {
            id: "a",
            kind: "step",
            prompt: "p.md",
            in: { b: { type: "text", from: "run.brief" } },
            out: { x: { type: "text" } },
          },
          {
            id: "a",
            kind: "step",
            prompt: "p.md",
            in: { b: { type: "text", from: "run.brief" } },
            out: { y: { type: "text" } },
          },
          {
            id: "g",
            kind: "gate",
            question: "ok?",
            shows: {},
            // missing on_reject
          },
          {
            id: "looped",
            kind: "step",
            prompt: "p.md",
            in: { b: { type: "text", from: "run.brief" } },
            out: { z: { type: "text" } },
            loop: { to: "a", max: 0 },
          },
          {
            id: "badtype",
            kind: "step",
            prompt: "p.md",
            in: {},
            out: { n: { type: "number" } },
          },
        ],
      },
      { dir: "/tmp/soft", softStructural: true, typeCheck: false },
    );

    expect(structuralErrors.length).toBeGreaterThanOrEqual(4);
    expect(structuralErrors.some((e) => /duplicate node id/.test(e.message))).toBe(true);
    expect(structuralErrors.some((e) => e.field.includes("on_reject"))).toBe(true);
    expect(structuralErrors.some((e) => e.field.includes("loop.max"))).toBe(true);
    expect(
      structuralErrors.some(
        (e) => e.field.endsWith(".type") && /not an atom|unknown/.test(e.message),
      ),
    ).toBe(true);

    // First "a" kept; duplicate dropped
    expect(definition.nodes.filter((n) => n.id === "a")).toHaveLength(1);
    // Gate present with degraded on_reject
    const gate = definition.nodes.find((n) => n.id === "g");
    expect(gate?.kind).toBe("gate");
    // Looped node still present
    expect(definition.nodes.some((n) => n.id === "looped")).toBe(true);
    // Bad-type node still present (port recovered)
    expect(definition.nodes.some((n) => n.id === "badtype")).toBe(true);
  });

  it("still throws on fatal structural failures even with softStructural", () => {
    expect(() =>
      parseWorkflowDefinition("not-an-object", {
        dir: "/tmp/soft",
        softStructural: true,
      }),
    ).toThrow(/JSON object/);

    expect(() =>
      parseWorkflowDefinition(
        { ...base, nodes: "nope" },
        { dir: "/tmp/soft", softStructural: true },
      ),
    ).toThrow(/nodes/);

    expect(() =>
      parseWorkflowDefinition(
        { ...base, nodes: [] },
        { dir: "/tmp/soft", softStructural: true },
      ),
    ).toThrow(/nodes/);
  });
});
