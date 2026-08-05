/**
 * Report schema validation + preamble summary (#236 / ADR-0016).
 */
import { describe, expect, it } from "vitest";
import {
  compileOutputPorts,
  DEFAULT_TEXT_MAX_LENGTH,
  parsePortType,
} from "@useparley/core";
import {
  DEFAULT_REPORT_SCHEMA,
  describeField,
  formatReportError,
  summarizeReportSchema,
  validateReport,
} from "../src/report.js";

describe("validateReport — default schema", () => {
  it("accepts a well-formed default report", () => {
    expect(
      validateReport({
        summary: "done",
        outcome: "success",
        files_changed: ["a.ts"],
      }),
    ).toEqual([]);
  });

  it("returns path: message violations for the bounce channel", () => {
    const errors = validateReport({ summary: "", outcome: "nope", files_changed: "x" });
    expect(errors.length).toBeGreaterThan(0);
    for (const e of errors) {
      expect(e).toMatch(/^.+: .+$/);
    }
  });

  it("DEFAULT_REPORT_SCHEMA declares explicit type on every property (#335)", () => {
    // Moonshot-flavoured providers reject tool schemas whose properties lack
    // type (enum-only is not enough). Guard the default schema shape.
    expect(DEFAULT_REPORT_SCHEMA).toMatchObject({ type: "object" });
    const props =
      typeof DEFAULT_REPORT_SCHEMA === "object" &&
      DEFAULT_REPORT_SCHEMA !== null &&
      "properties" in DEFAULT_REPORT_SCHEMA
        ? (DEFAULT_REPORT_SCHEMA.properties as Record<string, Record<string, unknown>>)
        : {};
    expect(Object.keys(props).length).toBeGreaterThan(0);
    for (const [name, prop] of Object.entries(props)) {
      expect(prop, `property ${name} must declare type`).toHaveProperty("type");
      expect(typeof prop.type).toBe("string");
    }
    expect(props.outcome).toEqual({
      type: "string",
      enum: ["success", "partial", "blocked"],
    });
  });
});

describe("validateReport — generated output-port schema", () => {
  const ports = {
    notes: {
      type: parsePortType("text", {}),
      bounds: { maxLength: 20 },
    },
    items: {
      type: parsePortType("text[]", {}),
      bounds: { maxItems: 2, maxLength: 10 },
    },
    link: { type: parsePortType("url", {}) },
  };
  const schema = compileOutputPorts(ports);

  it("enforces maxLength from port bounds", () => {
    const errors = validateReport(
      { notes: "x".repeat(21), items: ["a"], link: "https://example.com" },
      schema,
    );
    // Ajv wording: "must NOT have more than N characters"
    expect(errors.some((e) => e.includes("/notes") && e.includes("20 characters"))).toBe(
      true,
    );
  });

  it("enforces maxItems from port bounds", () => {
    const errors = validateReport(
      {
        notes: "ok",
        items: ["a", "b", "c"],
        link: "https://example.com",
      },
      schema,
    );
    expect(errors.some((e) => e.includes("/items") && e.includes("2 items"))).toBe(true);
  });

  it("rejects non-uri strings on url ports (syntactic format)", () => {
    const errors = validateReport(
      { notes: "ok", items: ["a"], link: "not-a-url" },
      schema,
    );
    expect(errors.some((e) => e.includes("/link"))).toBe(true);
  });

  it("accepts a schema-valid payload", () => {
    expect(
      validateReport(
        {
          notes: "short",
          items: ["one", "two"],
          link: "https://example.com/x",
        },
        schema,
      ),
    ).toEqual([]);
  });

  it("applies default text maxLength when bounds omit max_length", () => {
    const s = compileOutputPorts({
      body: { type: parsePortType("text", {}) },
    });
    const ok = "y".repeat(DEFAULT_TEXT_MAX_LENGTH);
    expect(validateReport({ body: ok }, s)).toEqual([]);
    const over = "y".repeat(DEFAULT_TEXT_MAX_LENGTH + 1);
    const errors = validateReport({ body: over }, s);
    expect(
      errors.some(
        (e) => e.includes("/body") && e.includes(`${DEFAULT_TEXT_MAX_LENGTH} characters`),
      ),
    ).toBe(true);
  });
});

describe("describeField — constraints and descriptions (ADR-0016)", () => {
  it("renders maxLength / maxItems / maxProperties", () => {
    expect(describeField({ type: "string", maxLength: 8000 })).toContain(
      "maxLength 8000",
    );
    expect(describeField({ type: "array", items: { type: "string" }, maxItems: 12 })).toMatch(
      /array of string.*maxItems 12/,
    );
    expect(
      describeField({
        type: "object",
        additionalProperties: { type: "string", maxLength: 300 },
        maxProperties: 8,
      }),
    ).toMatch(/maxProperties 8/);
  });

  it("renders description when present", () => {
    expect(
      describeField({ type: "string", description: "the research brief", maxLength: 100 }),
    ).toMatch(/the research brief/);
  });

  it("renders enums and maps format:uri to url", () => {
    expect(describeField({ enum: ["a", "b"] })).toBe(
      'one of "a", "b"',
    );
    expect(describeField({ type: "string", format: "uri", minLength: 1 })).toMatch(
      /url/,
    );
  });
});

describe("summarizeReportSchema", () => {
  it("includes constraints on generated port schemas", () => {
    const schema = compileOutputPorts({
      queries: {
        type: parsePortType("dict<string, text>", {}),
        bounds: { maxItems: 8, maxLength: 300 },
      },
    });
    const text = summarizeReportSchema(schema);
    expect(text).toContain("`queries`");
    expect(text).toMatch(/maxProperties 8|maxLength 300/);
  });

  it("still summarizes the default schema", () => {
    const text = summarizeReportSchema(DEFAULT_REPORT_SCHEMA);
    expect(text).toContain("summary");
    expect(text).toContain("outcome");
    expect(text).toContain("files_changed");
  });
});

describe("formatReportError", () => {
  it("produces path: message lines", () => {
    expect(formatReportError("/report", "is empty")).toBe("/report: is empty");
    expect(formatReportError("", "bad")).toBe("report: bad");
  });
});
