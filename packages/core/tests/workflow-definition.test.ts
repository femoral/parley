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
