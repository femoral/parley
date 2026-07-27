/**
 * Workflow definition parse + type-check (ADR-0016 / #231).
 *
 * A workflow is a directory `.parley/workflows/<id>/` holding `workflow.json`
 * plus `prompts/` and `types/`. Paths inside the file are relative to it.
 *
 * This module ends at "a definition is a validated in-memory object" — no
 * engine, no runs. Full project-lint rules (forward `from`, loop wiring,
 * slots+over, mandatory `max_items` when `over`, …) belong to #232.
 */
import fs from "node:fs";
import path from "node:path";
import type { PortBounds } from "./compile.js";
import {
  applyFanOutCollection,
  checkCompatibility,
  parsePortType,
  type NamedTypeDecl,
  type PortType,
} from "./types.js";

/** Workspace mode: repo checkout + branch, or a plain scratch directory. */
export type WorkspaceMode = "repo" | "scratch";

/** A gate's mandatory author-declared reject behaviour. */
export type GateOnReject = "finish" | "reject" | string;

/** Port bounds as authored (optional integers). */
export interface AuthoredPortBounds {
  max_items?: number;
  max_length?: number;
}

/** Workflow-level input port (filled at run start). */
export interface WorkflowInputPort {
  type: PortType;
  bounds: PortBounds;
}

/** Run-level output: names an earlier node port as the run's product. */
export interface WorkflowRunOutput {
  type: PortType;
  bounds: PortBounds;
  /** Wiring: `"<node>.<port>"`. */
  from: string;
}

/** Step/gate input port. */
export interface NodeInputPort {
  type: PortType;
  bounds: PortBounds;
  /**
   * Backwards wiring: `"<node>.<port>"` or `"run.<input>"`.
   * Absent ⇒ loop-filled (empty on pass 1) or unfilled until `loop.with`.
   */
  from?: string;
  /** Accumulator: filled from all completed iterations (containers only). */
  accumulate?: boolean;
}

/** Step output port (the producing port; bounds compile into report schema). */
export interface NodeOutputPort {
  type: PortType;
  bounds: PortBounds;
}

/** Authored fan-out sibling. */
export interface WorkflowSlot {
  profile?: string;
  vendor?: string;
  model?: string;
  effort?: string;
  sandbox?: string;
  prompt_append?: string;
}

/** Loop edge hanging off a step or gate. */
export interface WorkflowLoop {
  to: string;
  max: number;
  while?: { port: string; is: string };
  with?: Record<string, string>;
}

export interface WorkflowStepNode {
  kind: "step";
  id: string;
  task_type?: string;
  profile?: string;
  vendor?: string;
  model?: string;
  effort?: string;
  sandbox?: string;
  prompt: string;
  slots?: Record<string, WorkflowSlot>;
  /** Data fan-out: name of the input port that drives width/keys. */
  over?: string;
  /**
   * Fan-out success policy (ADR-0017): `all` | `{min}` | `{required:[slots]}`.
   * Defaults at engine time: `all` for authored slots, `{min: 1}` for data.
   */
  success?: { min?: number; required?: string[] };
  retries?: number;
  in: Record<string, NodeInputPort>;
  out: Record<string, NodeOutputPort>;
  loop?: WorkflowLoop;
}

export interface WorkflowGateNode {
  kind: "gate";
  id: string;
  question: string;
  shows: Record<string, { from: string }>;
  on_reject: GateOnReject;
  loop?: WorkflowLoop;
}

export type WorkflowNode = WorkflowStepNode | WorkflowGateNode;

/**
 * Validated in-memory workflow definition.
 * `dir` is the absolute path of the workflow directory (for resolving prompts/types).
 */
export interface WorkflowDefinition {
  id: string;
  version: number;
  type: string;
  workspace: WorkspaceMode;
  description?: string;
  inputs: Record<string, WorkflowInputPort>;
  outputs: Record<string, WorkflowRunOutput>;
  types: Record<string, NamedTypeDecl>;
  nodes: WorkflowNode[];
  reentry?: string;
  /** Absolute path of the workflow directory. */
  dir: string;
}

/** Soft finding collected during parse (id/dir mismatch, …). Lint #232 extends this. */
export interface WorkflowParseWarning {
  field: string;
  message: string;
}

/**
 * Recoverable structural parse error (duplicate id, bad field shape, …).
 * Only non-empty when {@link ParseWorkflowOptions.softStructural} is on.
 */
export interface WorkflowParseError {
  field: string;
  message: string;
}

export interface ParseWorkflowResult {
  definition: WorkflowDefinition;
  warnings: WorkflowParseWarning[];
  /**
   * Recoverable structural failures collected under `softStructural: true`.
   * Always present; empty when the mode is off or nothing failed.
   */
  structuralErrors: WorkflowParseError[];
}

export interface ParseWorkflowOptions {
  /**
   * Absolute path of the workflow directory. Used to resolve `types/*.schema.json`
   * and to emit the id/directory-name mismatch warning.
   */
  dir: string;
  /**
   * Expected id from the directory basename. Defaults to `path.basename(dir)`.
   * When the file's `id` differs, a warning is recorded (rubric precedent).
   */
  expectedId?: string;
  /**
   * When true (default), type-check every `from` edge: resolve effective
   * upstream types (including fan-out collection) and run compatibility.
   */
  typeCheck?: boolean;
  /**
   * When true, **recoverable** structural problems accumulate into
   * `structuralErrors` and parsing continues with a degraded definition.
   * **Fatal** structural problems (root not an object, `nodes` not a non-empty
   * array, and their kin) still throw. Default false — the run engine and
   * every other non-lint consumer keep a hard throw on structural invalidity.
   */
  softStructural?: boolean;
}

/**
 * Parse context: soft-structural mode flag + collector.
 *
 * Failure classification is explicit here so a reader does not need to trace
 * call sites:
 *
 * - {@link fatal} — always throws. Walking further is meaningless.
 * - {@link recover} — hard mode throws; soft mode records and returns so the
 *   caller can drop/default the field and continue.
 */
interface ParseCtx {
  softStructural: boolean;
  structuralErrors: WorkflowParseError[];
  dir: string;
  warnings: WorkflowParseWarning[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Fatal structural failure — always throws (`never`). */
function fatal(field: string, message: string): never {
  throw new Error(field ? `${field}: ${message}` : message);
}

/**
 * Recoverable structural failure.
 *
 * - Hard mode (`softStructural` off): throws, same message shape as {@link fatal}.
 * - Soft mode: appends to `structuralErrors` and returns; **caller must recover**
 *   (drop the field/entry or apply a degraded default) and continue.
 */
function recover(ctx: ParseCtx, field: string, message: string): void {
  if (!ctx.softStructural) {
    fatal(field, message);
  }
  ctx.structuralErrors.push({ field, message });
}

/**
 * Parse and type-check a raw workflow.json object into a validated definition.
 * Throws a descriptive Error on hard (or non-soft) failures; soft issues go
 * into `warnings` / `structuralErrors`.
 */
export function parseWorkflowDefinition(
  raw: unknown,
  options: ParseWorkflowOptions,
): ParseWorkflowResult {
  const dir = path.resolve(options.dir);
  const expectedId = options.expectedId ?? path.basename(dir);
  const typeCheck = options.typeCheck !== false;
  const ctx: ParseCtx = {
    softStructural: options.softStructural === true,
    structuralErrors: [],
    dir,
    warnings: [],
  };

  // ── fatal: cannot walk the document at all ──────────────────────────────
  if (!isRecord(raw)) {
    fatal("", "workflow must be a JSON object");
  }

  // ── recoverable root fields ─────────────────────────────────────────────
  let id: string;
  if (typeof raw.id !== "string" || raw.id === "") {
    recover(ctx, "id", "must be a non-empty string");
    id = expectedId;
  } else {
    id = raw.id;
    if (id !== expectedId) {
      ctx.warnings.push({
        field: "id",
        message: `workflow.id "${id}" does not match directory name "${expectedId}"`,
      });
    }
  }

  let version: number;
  if (typeof raw.version !== "number" || !Number.isInteger(raw.version) || raw.version < 1) {
    recover(ctx, "version", "must be a positive integer");
    version = 1;
  } else {
    version = raw.version;
  }

  let type: string;
  if (typeof raw.type !== "string" || raw.type === "") {
    recover(ctx, "type", "must be a non-empty string");
    type = "";
  } else {
    type = raw.type;
  }

  let workspace: WorkspaceMode = "repo";
  if (raw.workspace !== undefined) {
    if (raw.workspace !== "repo" && raw.workspace !== "scratch") {
      recover(ctx, "workspace", 'must be "repo" or "scratch"');
    } else {
      workspace = raw.workspace;
    }
  }

  let description: string | undefined;
  if (raw.description !== undefined) {
    if (typeof raw.description !== "string") {
      recover(ctx, "description", "must be a string");
    } else {
      description = raw.description;
    }
  }

  const types = parseTypesBlock(ctx, raw.types);
  const namedMap = new Map(Object.entries(types));

  const inputs = parseInputPorts(ctx, raw.inputs, "inputs", namedMap);
  const outputs = parseRunOutputs(ctx, raw.outputs, "outputs", namedMap);

  // ── fatal: nodes scaffold must be walkable ──────────────────────────────
  if (!Array.isArray(raw.nodes) || raw.nodes.length === 0) {
    fatal("nodes", "must be a non-empty array");
  }

  const nodes: WorkflowNode[] = [];
  const seenNodeIds = new Set<string>();
  for (let i = 0; i < raw.nodes.length; i++) {
    const node = parseNode(ctx, raw.nodes[i], `nodes[${i}]`, namedMap);
    if (node === null) continue; // recovered: entry dropped
    if (seenNodeIds.has(node.id)) {
      // Recoverable: keep the first, drop this duplicate, keep walking.
      recover(ctx, `nodes[${i}].id`, `duplicate node id "${node.id}"`);
      continue;
    }
    seenNodeIds.add(node.id);
    nodes.push(node);
  }

  // Soft mode can drop every node; a definition with zero nodes is not useful
  // for the semantic pass either — treat as fatal once recovery finished.
  if (nodes.length === 0) {
    fatal("nodes", "must be a non-empty array");
  }

  let reentry: string | undefined;
  if (raw.reentry !== undefined) {
    if (typeof raw.reentry !== "string" || raw.reentry === "") {
      recover(ctx, "reentry", "must be a non-empty string");
    } else {
      reentry = raw.reentry;
    }
  }

  const definition: WorkflowDefinition = {
    id,
    version,
    type,
    workspace,
    description,
    inputs,
    outputs,
    types,
    nodes,
    reentry,
    dir,
  };

  if (typeCheck) {
    typeCheckDefinition(definition);
  }

  return {
    definition,
    warnings: ctx.warnings,
    structuralErrors: ctx.structuralErrors,
  };
}

/**
 * Load `workflow.json` from a workflow directory and parse it.
 */
export function loadWorkflowDefinition(dir: string): ParseWorkflowResult {
  const abs = path.resolve(dir);
  const file = path.join(abs, "workflow.json");
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`cannot read ${file}: ${msg}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`invalid JSON in ${file}: ${msg}`);
  }
  return parseWorkflowDefinition(raw, { dir: abs });
}

// ── types block ─────────────────────────────────────────────────────────────

function parseTypesBlock(
  ctx: ParseCtx,
  raw: unknown,
): Record<string, NamedTypeDecl> {
  if (raw === undefined) return {};
  if (!isRecord(raw)) {
    recover(ctx, "types", "must be an object");
    return {};
  }
  const out: Record<string, NamedTypeDecl> = {};
  for (const [name, decl] of Object.entries(raw)) {
    if (!isRecord(decl)) {
      recover(ctx, `types.${name}`, "must be an object");
      continue;
    }
    const hasEnum = decl.enum !== undefined;
    const hasSchema = decl.schema !== undefined;
    if (hasEnum === hasSchema) {
      recover(ctx, `types.${name}`, 'must declare exactly one of "enum" or "schema"');
      continue;
    }
    if (hasEnum) {
      if (!Array.isArray(decl.enum) || decl.enum.length === 0) {
        recover(ctx, `types.${name}.enum`, "must be a non-empty array of strings");
        continue;
      }
      const values: string[] = [];
      let bad = false;
      for (let i = 0; i < decl.enum.length; i++) {
        const v = decl.enum[i];
        if (typeof v !== "string" || v === "") {
          recover(ctx, `types.${name}.enum[${i}]`, "must be a non-empty string");
          bad = true;
          break;
        }
        values.push(v);
      }
      if (bad) continue;
      out[name] = { kind: "enum", values };
    } else {
      if (typeof decl.schema !== "string" || decl.schema === "") {
        recover(ctx, `types.${name}.schema`, "must be a non-empty path string");
        continue;
      }
      const schemaPath = decl.schema;
      const abs = path.resolve(ctx.dir, schemaPath);
      let schemaRaw: unknown;
      try {
        schemaRaw = JSON.parse(fs.readFileSync(abs, "utf8"));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        recover(ctx, `types.${name}.schema`, `cannot load ${schemaPath}: ${msg}`);
        continue;
      }
      if (
        typeof schemaRaw === "boolean" ||
        (typeof schemaRaw === "object" && schemaRaw !== null && !Array.isArray(schemaRaw))
      ) {
        out[name] = {
          kind: "schema",
          path: schemaPath,
          schema: schemaRaw as Record<string, unknown> | boolean,
        };
      } else {
        recover(ctx, `types.${name}.schema`, "schema file must be a JSON object or boolean");
      }
    }
  }
  return out;
}

// ── ports ───────────────────────────────────────────────────────────────────

function parseBounds(
  ctx: ParseCtx,
  raw: Record<string, unknown>,
  field: string,
): PortBounds {
  const bounds: PortBounds = {};
  if (raw.max_items !== undefined) {
    if (
      typeof raw.max_items !== "number" ||
      !Number.isInteger(raw.max_items) ||
      raw.max_items < 1
    ) {
      recover(ctx, `${field}.max_items`, "must be a positive integer");
    } else {
      bounds.maxItems = raw.max_items;
    }
  }
  if (raw.max_length !== undefined) {
    if (
      typeof raw.max_length !== "number" ||
      !Number.isInteger(raw.max_length) ||
      raw.max_length < 1
    ) {
      recover(ctx, `${field}.max_length`, "must be a positive integer");
    } else {
      bounds.maxLength = raw.max_length;
    }
  }
  return bounds;
}

/** Placeholder type used when a port's type is unresolvable under soft mode. */
const DEGRADED_TYPE: PortType = { kind: "text" };

function parseTypeField(
  ctx: ParseCtx,
  raw: Record<string, unknown>,
  field: string,
  named: ReadonlyMap<string, NamedTypeDecl>,
): PortType {
  if (typeof raw.type !== "string") {
    recover(ctx, `${field}.type`, "must be a string");
    return DEGRADED_TYPE;
  }
  try {
    return parsePortType(raw.type, named);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    recover(ctx, `${field}.type`, msg);
    return DEGRADED_TYPE;
  }
}

function parseInputPorts(
  ctx: ParseCtx,
  raw: unknown,
  field: string,
  named: ReadonlyMap<string, NamedTypeDecl>,
): Record<string, WorkflowInputPort> {
  if (raw === undefined) return {};
  if (!isRecord(raw)) {
    recover(ctx, field, "must be an object");
    return {};
  }
  const out: Record<string, WorkflowInputPort> = {};
  for (const [name, port] of Object.entries(raw)) {
    if (!isRecord(port)) {
      recover(ctx, `${field}.${name}`, "must be an object");
      continue;
    }
    out[name] = {
      type: parseTypeField(ctx, port, `${field}.${name}`, named),
      bounds: parseBounds(ctx, port, `${field}.${name}`),
    };
  }
  return out;
}

function parseRunOutputs(
  ctx: ParseCtx,
  raw: unknown,
  field: string,
  named: ReadonlyMap<string, NamedTypeDecl>,
): Record<string, WorkflowRunOutput> {
  if (raw === undefined) return {};
  if (!isRecord(raw)) {
    recover(ctx, field, "must be an object");
    return {};
  }
  const out: Record<string, WorkflowRunOutput> = {};
  for (const [name, port] of Object.entries(raw)) {
    if (!isRecord(port)) {
      recover(ctx, `${field}.${name}`, "must be an object");
      continue;
    }
    let from: string;
    if (typeof port.from !== "string" || port.from === "") {
      recover(ctx, `${field}.${name}.from`, "must be a non-empty string");
      from = "";
    } else {
      from = port.from;
    }
    out[name] = {
      type: parseTypeField(ctx, port, `${field}.${name}`, named),
      bounds: parseBounds(ctx, port, `${field}.${name}`),
      from,
    };
  }
  return out;
}

function parseNodeInputPorts(
  ctx: ParseCtx,
  raw: unknown,
  field: string,
  named: ReadonlyMap<string, NamedTypeDecl>,
): Record<string, NodeInputPort> {
  if (raw === undefined) return {};
  if (!isRecord(raw)) {
    recover(ctx, field, "must be an object");
    return {};
  }
  const out: Record<string, NodeInputPort> = {};
  for (const [name, port] of Object.entries(raw)) {
    if (!isRecord(port)) {
      recover(ctx, `${field}.${name}`, "must be an object");
      continue;
    }
    const entry: NodeInputPort = {
      type: parseTypeField(ctx, port, `${field}.${name}`, named),
      bounds: parseBounds(ctx, port, `${field}.${name}`),
    };
    if (port.from !== undefined) {
      if (typeof port.from !== "string" || port.from === "") {
        recover(ctx, `${field}.${name}.from`, "must be a non-empty string");
      } else {
        entry.from = port.from;
      }
    }
    if (port.accumulate !== undefined) {
      if (typeof port.accumulate !== "boolean") {
        recover(ctx, `${field}.${name}.accumulate`, "must be a boolean");
      } else {
        entry.accumulate = port.accumulate;
      }
    }
    out[name] = entry;
  }
  return out;
}

function parseNodeOutputPorts(
  ctx: ParseCtx,
  raw: unknown,
  field: string,
  named: ReadonlyMap<string, NamedTypeDecl>,
): Record<string, NodeOutputPort> {
  if (raw === undefined) return {};
  if (!isRecord(raw)) {
    recover(ctx, field, "must be an object");
    return {};
  }
  const out: Record<string, NodeOutputPort> = {};
  for (const [name, port] of Object.entries(raw)) {
    if (!isRecord(port)) {
      recover(ctx, `${field}.${name}`, "must be an object");
      continue;
    }
    out[name] = {
      type: parseTypeField(ctx, port, `${field}.${name}`, named),
      bounds: parseBounds(ctx, port, `${field}.${name}`),
    };
  }
  return out;
}

// ── nodes ───────────────────────────────────────────────────────────────────

/**
 * Parse one node entry. Returns null when the entry is dropped under soft mode
 * (not an object / missing id / bad kind) after recording a recoverable error.
 */
function parseNode(
  ctx: ParseCtx,
  raw: unknown,
  field: string,
  named: ReadonlyMap<string, NamedTypeDecl>,
): WorkflowNode | null {
  if (!isRecord(raw)) {
    recover(ctx, field, "must be an object");
    return null;
  }
  if (typeof raw.id !== "string" || raw.id === "") {
    recover(ctx, `${field}.id`, "must be a non-empty string");
    return null;
  }
  if (raw.kind !== "step" && raw.kind !== "gate") {
    recover(ctx, `${field}.kind`, 'must be "step" or "gate"');
    return null;
  }
  if (raw.kind === "gate") {
    return parseGate(ctx, raw, field);
  }
  return parseStep(ctx, raw, field, named);
}

function optionalString(
  ctx: ParseCtx,
  raw: Record<string, unknown>,
  key: string,
  field: string,
): string | undefined {
  if (raw[key] === undefined) return undefined;
  if (typeof raw[key] !== "string" || raw[key] === "") {
    recover(ctx, `${field}.${key}`, "must be a non-empty string");
    return undefined;
  }
  return raw[key] as string;
}

function parseLoop(
  ctx: ParseCtx,
  raw: unknown,
  field: string,
): WorkflowLoop | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) {
    recover(ctx, field, "must be an object");
    return undefined;
  }
  let to: string;
  if (typeof raw.to !== "string" || raw.to === "") {
    recover(ctx, `${field}.to`, "must be a non-empty string");
    to = "";
  } else {
    to = raw.to;
  }
  let max: number;
  if (typeof raw.max !== "number" || !Number.isInteger(raw.max) || raw.max < 1) {
    recover(ctx, `${field}.max`, "must be a positive integer");
    max = 1; // degraded default so the loop remains walkable
  } else {
    max = raw.max;
  }
  const loop: WorkflowLoop = { to, max };
  if (raw.while !== undefined) {
    if (!isRecord(raw.while)) {
      recover(ctx, `${field}.while`, "must be an object");
    } else {
      let port: string | undefined;
      let is: string | undefined;
      if (typeof raw.while.port !== "string" || raw.while.port === "") {
        recover(ctx, `${field}.while.port`, "must be a non-empty string");
      } else {
        port = raw.while.port;
      }
      if (typeof raw.while.is !== "string" || raw.while.is === "") {
        recover(ctx, `${field}.while.is`, "must be a non-empty string");
      } else {
        is = raw.while.is;
      }
      if (port !== undefined && is !== undefined) {
        loop.while = { port, is };
      }
    }
  }
  if (raw.with !== undefined) {
    if (!isRecord(raw.with)) {
      recover(ctx, `${field}.with`, "must be an object");
    } else {
      const withMap: Record<string, string> = {};
      for (const [k, v] of Object.entries(raw.with)) {
        if (typeof v !== "string" || v === "") {
          recover(ctx, `${field}.with.${k}`, "must be a non-empty string");
          continue;
        }
        withMap[k] = v;
      }
      loop.with = withMap;
    }
  }
  return loop;
}

function parseSlots(
  ctx: ParseCtx,
  raw: unknown,
  field: string,
): Record<string, WorkflowSlot> | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) {
    recover(ctx, field, "must be an object");
    return undefined;
  }
  const slots: Record<string, WorkflowSlot> = {};
  for (const [name, slot] of Object.entries(raw)) {
    if (!isRecord(slot)) {
      recover(ctx, `${field}.${name}`, "must be an object");
      continue;
    }
    const s: WorkflowSlot = {};
    for (const key of [
      "profile",
      "vendor",
      "model",
      "effort",
      "sandbox",
      "prompt_append",
    ] as const) {
      const v = optionalString(ctx, slot, key, `${field}.${name}`);
      if (v !== undefined) s[key] = v;
    }
    slots[name] = s;
  }
  return slots;
}

function parseStep(
  ctx: ParseCtx,
  raw: Record<string, unknown>,
  field: string,
  named: ReadonlyMap<string, NamedTypeDecl>,
): WorkflowStepNode {
  let prompt: string;
  if (typeof raw.prompt !== "string" || raw.prompt === "") {
    recover(ctx, `${field}.prompt`, "must be a non-empty string");
    prompt = "";
  } else {
    prompt = raw.prompt;
  }
  const step: WorkflowStepNode = {
    kind: "step",
    id: raw.id as string,
    prompt,
    in: parseNodeInputPorts(ctx, raw.in, `${field}.in`, named),
    out: parseNodeOutputPorts(ctx, raw.out, `${field}.out`, named),
  };
  for (const key of ["task_type", "profile", "vendor", "model", "effort", "sandbox"] as const) {
    const v = optionalString(ctx, raw, key, field);
    if (v !== undefined) step[key] = v;
  }
  if (raw.over !== undefined) {
    if (typeof raw.over !== "string" || raw.over === "") {
      recover(ctx, `${field}.over`, "must be a non-empty string");
    } else {
      step.over = raw.over;
    }
  }
  if (raw.retries !== undefined) {
    if (typeof raw.retries !== "number" || !Number.isInteger(raw.retries) || raw.retries < 0) {
      recover(ctx, `${field}.retries`, "must be a non-negative integer");
    } else {
      step.retries = raw.retries;
    }
  }
  if (raw.success !== undefined) {
    if (!isRecord(raw.success)) {
      recover(ctx, `${field}.success`, "must be an object");
    } else {
      const success: { min?: number; required?: string[] } = {};
      if (raw.success.min !== undefined) {
        if (
          typeof raw.success.min !== "number" ||
          !Number.isInteger(raw.success.min) ||
          raw.success.min < 0
        ) {
          recover(ctx, `${field}.success.min`, "must be a non-negative integer");
        } else {
          success.min = raw.success.min;
        }
      }
      if (raw.success.required !== undefined) {
        if (!Array.isArray(raw.success.required)) {
          recover(ctx, `${field}.success.required`, "must be an array of slot names");
        } else {
          const required: string[] = [];
          for (let i = 0; i < raw.success.required.length; i++) {
            const slot = raw.success.required[i];
            if (typeof slot !== "string" || slot === "") {
              recover(ctx, `${field}.success.required[${i}]`, "must be a non-empty string");
              continue;
            }
            required.push(slot as string);
          }
          success.required = required;
        }
      }
      if (success.min !== undefined && success.required !== undefined) {
        recover(ctx, `${field}.success`, "cannot set both min and required");
        // keep both so lint/engine can still see author intent if they re-check
      }
      step.success = success;
    }
  }
  const slots = parseSlots(ctx, raw.slots, `${field}.slots`);
  if (slots !== undefined) step.slots = slots;
  const loop = parseLoop(ctx, raw.loop, `${field}.loop`);
  if (loop !== undefined) step.loop = loop;
  return step;
}

function parseGate(
  ctx: ParseCtx,
  raw: Record<string, unknown>,
  field: string,
): WorkflowGateNode {
  let question: string;
  if (typeof raw.question !== "string" || raw.question === "") {
    recover(ctx, `${field}.question`, "must be a non-empty string");
    question = "";
  } else {
    question = raw.question;
  }

  let on_reject: GateOnReject;
  if (typeof raw.on_reject !== "string" || raw.on_reject === "") {
    recover(ctx, `${field}.on_reject`, "must be a non-empty string");
    on_reject = ""; // degraded; semantic lint also flags empty on_reject
  } else {
    on_reject = raw.on_reject;
  }

  const shows: Record<string, { from: string }> = {};
  if (!isRecord(raw.shows)) {
    recover(ctx, `${field}.shows`, "must be an object");
  } else {
    for (const [name, show] of Object.entries(raw.shows)) {
      if (!isRecord(show)) {
        recover(ctx, `${field}.shows.${name}`, "must be an object");
        continue;
      }
      if (typeof show.from !== "string" || show.from === "") {
        recover(ctx, `${field}.shows.${name}.from`, "must be a non-empty string");
        continue;
      }
      shows[name] = { from: show.from };
    }
  }

  const gate: WorkflowGateNode = {
    kind: "gate",
    id: raw.id as string,
    question,
    shows,
    on_reject,
  };
  const loop = parseLoop(ctx, raw.loop, `${field}.loop`);
  if (loop !== undefined) gate.loop = loop;
  return gate;
}

// ── type-check edges ────────────────────────────────────────────────────────

/**
 * Resolve the effective output type of `nodeId.port` after fan-out collection.
 * Returns null when the reference is unknown (reported by the caller).
 */
export function effectiveOutputType(
  definition: WorkflowDefinition,
  nodeId: string,
  portName: string,
): PortType | null {
  const node = definition.nodes.find((n) => n.id === nodeId);
  if (node === undefined || node.kind !== "step") return null;
  const port = node.out[portName];
  if (port === undefined) return null;
  return applyFanOutCollection(port.type, stepFanOutContainer(node, definition));
}

/**
 * Fan-out container for a step: authored slots → dict; data `over` → the
 * upstream container of that input; otherwise none.
 */
export function stepFanOutContainer(
  step: WorkflowStepNode,
  definition: WorkflowDefinition,
): "none" | "array" | "dict" {
  if (step.slots !== undefined && Object.keys(step.slots).length > 0) {
    return "dict";
  }
  if (step.over === undefined) return "none";
  const overPort = step.in[step.over];
  if (overPort === undefined || overPort.from === undefined) return "none";
  const resolved = resolveFromRef(definition, overPort.from);
  if (resolved === null) return "none";
  // Compatibility of overPort.type vs resolved tells us the container.
  const compat = checkCompatibility(overPort.type, resolved);
  if (compat.outcome === "fan-out") return compat.container;
  // If the upstream is already a container and exact-matches after wrapping
  // would not apply — collection still wraps by the upstream container shape
  // when over is declared. Prefer the upstream's own container kind.
  if (resolved.kind === "array") return "array";
  if (resolved.kind === "dict") return "dict";
  return "none";
}

/** Resolve `"run.<input>"` or `"<node>.<port>"` to a port type (declared/effective). */
export function resolveFromRef(
  definition: WorkflowDefinition,
  from: string,
): PortType | null {
  const dot = from.indexOf(".");
  if (dot <= 0 || dot === from.length - 1) return null;
  const left = from.slice(0, dot);
  const right = from.slice(dot + 1);
  if (left === "run") {
    const input = definition.inputs[right];
    return input?.type ?? null;
  }
  return effectiveOutputType(definition, left, right);
}

function typeCheckDefinition(definition: WorkflowDefinition): void {
  // Semantic checks always hard-throw (not soft-structural). Lint uses
  // typeCheck: false and re-runs these as multi-finding rules instead.
  // Node input edges
  for (const node of definition.nodes) {
    if (node.kind !== "step") continue;
    for (const [portName, port] of Object.entries(node.in)) {
      if (port.from === undefined) continue;
      const upstream = resolveFromRef(definition, port.from);
      if (upstream === null) {
        fatal(
          `nodes.${node.id}.in.${portName}.from`,
          `unknown reference "${port.from}"`,
        );
      }
      const compat = checkCompatibility(port.type, upstream);
      if (compat.outcome === "error") {
        fatal(
          `nodes.${node.id}.in.${portName}`,
          compat.reason + ` (from ${port.from})`,
        );
      }
      // Data fan-out must declare itself (ADR-0016). Exact match needs no over.
      if (compat.outcome === "fan-out") {
        if (node.over !== portName) {
          fatal(
            `nodes.${node.id}.in.${portName}`,
            `data fan-out requires over: "${portName}" (upstream ${port.from} is a container)`,
          );
        }
      }
    }
    // over must name an input that actually fans out
    if (node.over !== undefined) {
      const overPort = node.in[node.over];
      if (overPort === undefined) {
        fatal(`nodes.${node.id}.over`, `unknown input port "${node.over}"`);
      }
      if (overPort.from === undefined) {
        fatal(
          `nodes.${node.id}.over`,
          `port "${node.over}" has no from (cannot drive data fan-out)`,
        );
      }
      const upstream = resolveFromRef(definition, overPort.from);
      if (upstream === null) {
        fatal(
          `nodes.${node.id}.over`,
          `cannot resolve from "${overPort.from}" for over port`,
        );
      }
      const compat = checkCompatibility(overPort.type, upstream);
      if (compat.outcome !== "fan-out") {
        fatal(
          `nodes.${node.id}.over`,
          `port "${node.over}" does not fan out over its upstream (need input ≡ element of upstream container)`,
        );
      }
      if (node.slots !== undefined && Object.keys(node.slots).length > 0) {
        fatal(
          `nodes.${node.id}`,
          "slots and over cannot both be declared (authored + data fan-out)",
        );
      }
    }
  }

  // Run outputs
  for (const [name, out] of Object.entries(definition.outputs)) {
    const upstream = resolveFromRef(definition, out.from);
    if (upstream === null) {
      fatal(`outputs.${name}.from`, `unknown reference "${out.from}"`);
    }
    const compat = checkCompatibility(out.type, upstream);
    if (compat.outcome === "error") {
      fatal(`outputs.${name}`, compat.reason + ` (from ${out.from})`);
    }
    // Run outputs never fan out — exact only.
    if (compat.outcome === "fan-out") {
      fatal(
        `outputs.${name}`,
        `run output must match upstream exactly (got fan-out from ${out.from})`,
      );
    }
  }
}
