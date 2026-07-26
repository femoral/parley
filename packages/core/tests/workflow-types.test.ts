/**
 * #231 — port type grammar, structural/nominal comparison, compatibility.
 */
import { describe, expect, it } from "vitest";
import {
  applyFanOutCollection,
  checkCompatibility,
  formatPortType,
  isSyntacticUrl,
  parsePortType,
  portTypesEqual,
  type NamedTypeDecl,
  type PortType,
} from "../src/workflow/types.js";

const named: Record<string, NamedTypeDecl> = {
  verdict: { kind: "enum", values: ["approve", "changes_requested"] },
  source: {
    kind: "schema",
    path: "types/source.schema.json",
    schema: { type: "object" },
  },
  validation: {
    kind: "schema",
    path: "types/validation.schema.json",
    schema: { type: "object" },
  },
};

function t(s: string): PortType {
  return parsePortType(s, named);
}

describe("parsePortType — six atoms", () => {
  it("parses text, url, file, dir", () => {
    expect(t("text")).toEqual({ kind: "text" });
    expect(t("url")).toEqual({ kind: "url" });
    expect(t("file")).toEqual({ kind: "file" });
    expect(t("dir")).toEqual({ kind: "dir" });
  });

  it("parses a named enum", () => {
    expect(t("verdict")).toEqual({
      kind: "enum",
      name: "verdict",
      values: ["approve", "changes_requested"],
    });
  });

  it("parses a named schema", () => {
    expect(t("source")).toEqual({
      kind: "schema",
      name: "source",
      path: "types/source.schema.json",
      schema: { type: "object" },
    });
  });

  it("rejects number and bool", () => {
    expect(() => t("number")).toThrow(/not an atom/);
    expect(() => t("bool")).toThrow(/not an atom/);
    expect(() => t("boolean")).toThrow(/not an atom/);
  });

  it("rejects unknown named types", () => {
    expect(() => t("nope")).toThrow(/unknown named type/);
  });
});

describe("parsePortType — containers and nesting", () => {
  it("parses T[]", () => {
    expect(t("text[]")).toEqual({ kind: "array", element: { kind: "text" } });
    expect(t("source[]")).toEqual({
      kind: "array",
      element: {
        kind: "schema",
        name: "source",
        path: "types/source.schema.json",
        schema: { type: "object" },
      },
    });
  });

  it("parses dict<string, V>", () => {
    expect(t("dict<string, text>")).toEqual({
      kind: "dict",
      value: { kind: "text" },
    });
    expect(t("dict<string, verdict>")).toEqual({
      kind: "dict",
      value: {
        kind: "enum",
        name: "verdict",
        values: ["approve", "changes_requested"],
      },
    });
  });

  it("parses nested dict<string, source[]>", () => {
    expect(t("dict<string, source[]>")).toEqual({
      kind: "dict",
      value: {
        kind: "array",
        element: {
          kind: "schema",
          name: "source",
          path: "types/source.schema.json",
          schema: { type: "object" },
        },
      },
    });
  });

  it("parses deeper nesting dict<string, text[]>[]", () => {
    expect(formatPortType(t("dict<string, text[]>[]"))).toBe(
      "dict<string, text[]>[]",
    );
  });

  it("rejects non-string dict keys", () => {
    expect(() => parsePortType("dict<text, text>", named)).toThrow(/string/);
  });
});

describe("portTypesEqual — structural containers, nominal atoms", () => {
  it("equates identical builtins and containers", () => {
    expect(portTypesEqual(t("text"), t("text"))).toBe(true);
    expect(portTypesEqual(t("text[]"), t("text[]"))).toBe(true);
    expect(portTypesEqual(t("dict<string, text>"), t("dict<string, text>"))).toBe(
      true,
    );
  });

  it("compares containers structurally", () => {
    expect(portTypesEqual(t("text[]"), t("url[]"))).toBe(false);
    expect(
      portTypesEqual(t("dict<string, source[]>"), t("dict<string, source[]>")),
    ).toBe(true);
  });

  it("compares named atoms nominally (same schema bytes ≠ same type)", () => {
    const other: Record<string, NamedTypeDecl> = {
      ...named,
      source2: {
        kind: "schema",
        path: "types/source.schema.json",
        schema: { type: "object" }, // byte-identical body
      },
    };
    const a = parsePortType("source", other);
    const b = parsePortType("source2", other);
    expect(portTypesEqual(a, b)).toBe(false);
  });

  it("distinguishes distinct enums by name", () => {
    const reg: Record<string, NamedTypeDecl> = {
      a: { kind: "enum", values: ["x", "y"] },
      b: { kind: "enum", values: ["x", "y"] },
    };
    expect(portTypesEqual(parsePortType("a", reg), parsePortType("b", reg))).toBe(
      false,
    );
  });
});

describe("checkCompatibility — exact / fan-out / error", () => {
  it("exact match passes whole", () => {
    expect(checkCompatibility(t("text"), t("text")).outcome).toBe("exact");
    expect(checkCompatibility(t("source[]"), t("source[]")).outcome).toBe("exact");
    expect(
      checkCompatibility(t("dict<string, verdict>"), t("dict<string, verdict>"))
        .outcome,
    ).toBe("exact");
  });

  it("T[] feeding T[] is exact, not fan-out", () => {
    // The ambiguous case is not ambiguous: exact match, pass whole.
    expect(checkCompatibility(t("text[]"), t("text[]")).outcome).toBe("exact");
  });

  it("input ≡ element of upstream container ⇒ fan-out", () => {
    expect(checkCompatibility(t("text"), t("text[]"))).toEqual({
      outcome: "fan-out",
      container: "array",
    });
    expect(checkCompatibility(t("text"), t("dict<string, text>"))).toEqual({
      outcome: "fan-out",
      container: "dict",
    });
    expect(checkCompatibility(t("source"), t("source[]"))).toEqual({
      outcome: "fan-out",
      container: "array",
    });
  });

  it("anything else is an error (no coercion)", () => {
    const r = checkCompatibility(t("text[]"), t("dict<string, text>"));
    expect(r.outcome).toBe("error");
    const r2 = checkCompatibility(t("url"), t("text"));
    expect(r2.outcome).toBe("error");
    const r3 = checkCompatibility(t("verdict"), t("text"));
    expect(r3.outcome).toBe("error");
  });
});

describe("applyFanOutCollection", () => {
  it("wraps declared types by the collection container", () => {
    expect(applyFanOutCollection(t("verdict"), "dict")).toEqual(
      t("dict<string, verdict>"),
    );
    expect(applyFanOutCollection(t("source[]"), "dict")).toEqual(
      t("dict<string, source[]>"),
    );
    expect(applyFanOutCollection(t("verdict"), "array")).toEqual(t("verdict[]"));
    expect(applyFanOutCollection(t("text"), "none")).toEqual(t("text"));
  });
});

describe("isSyntacticUrl", () => {
  it("accepts absolute URLs and rejects bare strings", () => {
    expect(isSyntacticUrl("https://example.com/x")).toBe(true);
    expect(isSyntacticUrl("http://localhost:8080")).toBe(true);
    expect(isSyntacticUrl("not a url")).toBe(false);
    expect(isSyntacticUrl("")).toBe(false);
    expect(isSyntacticUrl("/relative/path")).toBe(false);
  });
});
