/**
 * Compile a workflow port type to JSON Schema (ADR-0016 / #231).
 *
 * The port-type grammar is a strict subset of JSON Schema; the compiled form is
 * what a later issue ("generated report schema", #236) consumes. The daemon can
 * call {@link compilePortType} / {@link compileOutputPorts} per node without
 * further parsing of the type grammar.
 *
 * Bounds live on the producing port:
 * - `max_length` → `maxLength` on every `text` atom (default {@link DEFAULT_TEXT_MAX_LENGTH})
 * - `max_items`  → `maxItems` on arrays, `maxProperties` on dicts (top-level container)
 */
import type { JsonSchema } from "../contract.js";
import {
  DEFAULT_TEXT_MAX_LENGTH,
  type PortType,
} from "./types.js";

/** Bounds declared on a producing port (optional). */
export interface PortBounds {
  /** Cap on container width; applies to the port's outermost container. */
  maxItems?: number;
  /**
   * Cap on `text` atom length. When omitted, {@link DEFAULT_TEXT_MAX_LENGTH}
   * is used for every text atom under the port.
   */
  maxLength?: number;
}

/**
 * Compile one port type (+ optional bounds) to a JSON Schema object.
 * Never returns a boolean schema — callers always get an object of keywords.
 */
export function compilePortType(type: PortType, bounds: PortBounds = {}): Record<string, unknown> {
  const maxLength = bounds.maxLength ?? DEFAULT_TEXT_MAX_LENGTH;
  return compileInner(type, maxLength, bounds.maxItems, /* atRoot */ true);
}

/**
 * Compile a step's output ports into a single object schema suitable for a
 * task's `report_schema` (#236 seam). Each port becomes a required property;
 * `additionalProperties` is false so stray keys fail Ajv.
 *
 * Designed so the daemon can call this per node without re-parsing types.
 */
export function compileOutputPorts(
  ports: Readonly<Record<string, { type: PortType; bounds?: PortBounds }>>,
): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [name, port] of Object.entries(ports)) {
    properties[name] = compilePortType(port.type, port.bounds ?? {});
    required.push(name);
  }
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}

function compileInner(
  type: PortType,
  maxLength: number,
  maxItems: number | undefined,
  atRoot: boolean,
): Record<string, unknown> {
  switch (type.kind) {
    case "text":
      return {
        type: "string",
        maxLength,
      };
    case "url":
      // format:"uri" is syntactic; parley never dereferences (ADR-0016).
      return {
        type: "string",
        format: "uri",
        minLength: 1,
      };
    case "file":
    case "dir":
      // Reference atoms: a workspace-relative path string. Existence is checked
      // later by the daemon (stat), not by the schema.
      return {
        type: "string",
        minLength: 1,
      };
    case "enum":
      return {
        enum: [...type.values],
      };
    case "schema": {
      // Named schema types are opaque atoms: embed the author schema as-is.
      // When it is a boolean schema, wrap so compilePortType stays object-shaped.
      if (typeof type.schema === "boolean") {
        return type.schema ? {} : { not: {} };
      }
      return { ...type.schema };
    }
    case "array": {
      const schema: Record<string, unknown> = {
        type: "array",
        items: compileInner(type.element, maxLength, undefined, false),
      };
      if (atRoot && maxItems !== undefined) {
        schema.maxItems = maxItems;
      }
      return schema;
    }
    case "dict": {
      // dict<string, V> → object with free string keys, values of V.
      // max_items bounds key count → maxProperties (Ajv-native).
      const schema: Record<string, unknown> = {
        type: "object",
        additionalProperties: compileInner(type.value, maxLength, undefined, false),
      };
      if (atRoot && maxItems !== undefined) {
        schema.maxProperties = maxItems;
      }
      return schema;
    }
  }
}

/** Re-export for callers that only import compile. */
export type { JsonSchema };
