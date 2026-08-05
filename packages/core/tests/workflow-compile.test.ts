/**
 * #231 — port type → JSON Schema compilation (bounds, atoms, containers).
 */
import { describe, expect, it } from "vitest";
import {
  compileOutputPorts,
  compilePortType,
} from "../src/workflow/compile.js";
import {
  DEFAULT_TEXT_MAX_LENGTH,
  parsePortType,
  type NamedTypeDecl,
} from "../src/workflow/types.js";

const named: Record<string, NamedTypeDecl> = {
  verdict: { kind: "enum", values: ["approve", "changes_requested"] },
  source: {
    kind: "schema",
    path: "types/source.schema.json",
    schema: {
      type: "object",
      required: ["url"],
      properties: { url: { type: "string", format: "uri" } },
    },
  },
};

function compile(typeStr: string, bounds?: { maxItems?: number; maxLength?: number }) {
  return compilePortType(parsePortType(typeStr, named), bounds);
}

describe("compilePortType — atoms", () => {
  it("compiles text with default maxLength", () => {
    expect(compile("text")).toEqual({
      type: "string",
      maxLength: DEFAULT_TEXT_MAX_LENGTH,
    });
  });

  it("compiles text with explicit max_length", () => {
    expect(compile("text", { maxLength: 8000 })).toEqual({
      type: "string",
      maxLength: 8000,
    });
  });

  it("compiles url as format:uri (syntactic only)", () => {
    expect(compile("url")).toEqual({
      type: "string",
      format: "uri",
      minLength: 1,
    });
  });

  it("compiles file and dir as non-empty path strings", () => {
    expect(compile("file")).toEqual({ type: "string", minLength: 1 });
    expect(compile("dir")).toEqual({ type: "string", minLength: 1 });
  });

  it("compiles named enum", () => {
    expect(compile("verdict")).toEqual({
      type: "string",
      enum: ["approve", "changes_requested"],
    });
  });

  it("embeds named schema as-is", () => {
    expect(compile("source")).toEqual({
      type: "object",
      required: ["url"],
      properties: { url: { type: "string", format: "uri" } },
    });
  });
});

describe("compilePortType — containers and bounds", () => {
  it("compiles T[] with maxItems", () => {
    expect(compile("source[]", { maxItems: 10 })).toEqual({
      type: "array",
      items: {
        type: "object",
        required: ["url"],
        properties: { url: { type: "string", format: "uri" } },
      },
      maxItems: 10,
    });
  });

  it("compiles dict with maxProperties from max_items", () => {
    expect(compile("dict<string, text>", { maxItems: 8, maxLength: 300 })).toEqual({
      type: "object",
      additionalProperties: { type: "string", maxLength: 300 },
      maxProperties: 8,
    });
  });

  it("applies maxLength to nested text under containers", () => {
    expect(compile("text[]", { maxLength: 100 })).toEqual({
      type: "array",
      items: { type: "string", maxLength: 100 },
    });
  });

  it("does not apply maxItems to nested containers (only root)", () => {
    // max_items bounds the producing port's outermost container only.
    const schema = compile("dict<string, source[]>", { maxItems: 5 });
    expect(schema.maxProperties).toBe(5);
    expect((schema.additionalProperties as Record<string, unknown>).maxItems).toBe(
      undefined,
    );
  });
});

describe("compileOutputPorts — report_schema seam", () => {
  it("builds an object schema over named output ports", () => {
    const schema = compileOutputPorts({
      verdict: { type: parsePortType("verdict", named) },
      notes: {
        type: parsePortType("text", named),
        bounds: { maxLength: 6000 },
      },
    });
    expect(schema).toEqual({
      type: "object",
      properties: {
        verdict: { type: "string", enum: ["approve", "changes_requested"] },
        notes: { type: "string", maxLength: 6000 },
      },
      required: ["verdict", "notes"],
      additionalProperties: false,
    });
  });

  it("emits explicit type on every property, including enum ports (#335)", () => {
    // Moonshot-flavoured providers reject tool schemas with enum-only properties
    // (no type keyword). Guard the compile seam so enum ports stay typed.
    const schema = compileOutputPorts({
      verdict: { type: parsePortType("verdict", named) },
      status: { type: parsePortType("verdict", named) },
      notes: { type: parsePortType("text", named) },
    });
    const props = schema.properties as Record<string, Record<string, unknown>>;
    for (const [name, prop] of Object.entries(props)) {
      expect(prop, `property ${name} must declare type`).toHaveProperty("type");
      expect(typeof prop.type).toBe("string");
    }
    expect(props.verdict.type).toBe("string");
    expect(props.verdict.enum).toEqual(["approve", "changes_requested"]);
  });
});

describe("DEFAULT_TEXT_MAX_LENGTH", () => {
  it("is a positive finite bound", () => {
    expect(DEFAULT_TEXT_MAX_LENGTH).toBe(16_384);
  });
});
