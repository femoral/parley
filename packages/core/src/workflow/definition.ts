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
  success?: { min?: number };
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

export interface ParseWorkflowResult {
  definition: WorkflowDefinition;
  warnings: WorkflowParseWarning[];
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
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(field: string, message: string): never {
  throw new Error(field ? `${field}: ${message}` : message);
}

/**
 * Parse and type-check a raw workflow.json object into a validated definition.
 * Throws a descriptive Error on hard failures; soft issues go into `warnings`.
 */
export function parseWorkflowDefinition(
  raw: unknown,
  options: ParseWorkflowOptions,
): ParseWorkflowResult {
  const dir = path.resolve(options.dir);
  const expectedId = options.expectedId ?? path.basename(dir);
  const typeCheck = options.typeCheck !== false;
  const warnings: WorkflowParseWarning[] = [];

  if (!isRecord(raw)) {
    fail("", "workflow must be a JSON object");
  }

  if (typeof raw.id !== "string" || raw.id === "") {
    fail("id", "must be a non-empty string");
  }
  if (raw.id !== expectedId) {
    warnings.push({
      field: "id",
      message: `workflow.id "${raw.id}" does not match directory name "${expectedId}"`,
    });
  }

  if (typeof raw.version !== "number" || !Number.isInteger(raw.version) || raw.version < 1) {
    fail("version", "must be a positive integer");
  }
  if (typeof raw.type !== "string" || raw.type === "") {
    fail("type", "must be a non-empty string");
  }

  let workspace: WorkspaceMode = "repo";
  if (raw.workspace !== undefined) {
    if (raw.workspace !== "repo" && raw.workspace !== "scratch") {
      fail("workspace", 'must be "repo" or "scratch"');
    }
    workspace = raw.workspace;
  }

  let description: string | undefined;
  if (raw.description !== undefined) {
    if (typeof raw.description !== "string") {
      fail("description", "must be a string");
    }
    description = raw.description;
  }

  const types = parseTypesBlock(raw.types, dir);
  const namedMap = new Map(Object.entries(types));

  const inputs = parseInputPorts(raw.inputs, "inputs", namedMap);
  const outputs = parseRunOutputs(raw.outputs, "outputs", namedMap);

  if (!Array.isArray(raw.nodes) || raw.nodes.length === 0) {
    fail("nodes", "must be a non-empty array");
  }

  const nodes: WorkflowNode[] = [];
  const seenNodeIds = new Set<string>();
  for (let i = 0; i < raw.nodes.length; i++) {
    const node = parseNode(raw.nodes[i], `nodes[${i}]`, namedMap);
    if (seenNodeIds.has(node.id)) {
      fail(`nodes[${i}].id`, `duplicate node id "${node.id}"`);
    }
    seenNodeIds.add(node.id);
    nodes.push(node);
  }

  let reentry: string | undefined;
  if (raw.reentry !== undefined) {
    if (typeof raw.reentry !== "string" || raw.reentry === "") {
      fail("reentry", "must be a non-empty string");
    }
    reentry = raw.reentry;
  }

  const definition: WorkflowDefinition = {
    id: raw.id,
    version: raw.version,
    type: raw.type,
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

  return { definition, warnings };
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
  raw: unknown,
  dir: string,
): Record<string, NamedTypeDecl> {
  if (raw === undefined) return {};
  if (!isRecord(raw)) fail("types", "must be an object");
  const out: Record<string, NamedTypeDecl> = {};
  for (const [name, decl] of Object.entries(raw)) {
    if (!isRecord(decl)) fail(`types.${name}`, "must be an object");
    const hasEnum = decl.enum !== undefined;
    const hasSchema = decl.schema !== undefined;
    if (hasEnum === hasSchema) {
      fail(`types.${name}`, 'must declare exactly one of "enum" or "schema"');
    }
    if (hasEnum) {
      if (!Array.isArray(decl.enum) || decl.enum.length === 0) {
        fail(`types.${name}.enum`, "must be a non-empty array of strings");
      }
      const values: string[] = [];
      for (let i = 0; i < decl.enum.length; i++) {
        const v = decl.enum[i];
        if (typeof v !== "string" || v === "") {
          fail(`types.${name}.enum[${i}]`, "must be a non-empty string");
        }
        values.push(v);
      }
      out[name] = { kind: "enum", values };
    } else {
      if (typeof decl.schema !== "string" || decl.schema === "") {
        fail(`types.${name}.schema`, "must be a non-empty path string");
      }
      const schemaPath = decl.schema;
      const abs = path.resolve(dir, schemaPath);
      let schemaRaw: unknown;
      try {
        schemaRaw = JSON.parse(fs.readFileSync(abs, "utf8"));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        fail(`types.${name}.schema`, `cannot load ${schemaPath}: ${msg}`);
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
        fail(`types.${name}.schema`, "schema file must be a JSON object or boolean");
      }
    }
  }
  return out;
}

// ── ports ───────────────────────────────────────────────────────────────────

function parseBounds(raw: Record<string, unknown>, field: string): PortBounds {
  const bounds: PortBounds = {};
  if (raw.max_items !== undefined) {
    if (
      typeof raw.max_items !== "number" ||
      !Number.isInteger(raw.max_items) ||
      raw.max_items < 1
    ) {
      fail(`${field}.max_items`, "must be a positive integer");
    }
    bounds.maxItems = raw.max_items;
  }
  if (raw.max_length !== undefined) {
    if (
      typeof raw.max_length !== "number" ||
      !Number.isInteger(raw.max_length) ||
      raw.max_length < 1
    ) {
      fail(`${field}.max_length`, "must be a positive integer");
    }
    bounds.maxLength = raw.max_length;
  }
  return bounds;
}

function parseTypeField(
  raw: Record<string, unknown>,
  field: string,
  named: ReadonlyMap<string, NamedTypeDecl>,
): PortType {
  if (typeof raw.type !== "string") {
    fail(`${field}.type`, "must be a string");
  }
  try {
    return parsePortType(raw.type, named);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    fail(`${field}.type`, msg);
  }
}

function parseInputPorts(
  raw: unknown,
  field: string,
  named: ReadonlyMap<string, NamedTypeDecl>,
): Record<string, WorkflowInputPort> {
  if (raw === undefined) return {};
  if (!isRecord(raw)) fail(field, "must be an object");
  const out: Record<string, WorkflowInputPort> = {};
  for (const [name, port] of Object.entries(raw)) {
    if (!isRecord(port)) fail(`${field}.${name}`, "must be an object");
    out[name] = {
      type: parseTypeField(port, `${field}.${name}`, named),
      bounds: parseBounds(port, `${field}.${name}`),
    };
  }
  return out;
}

function parseRunOutputs(
  raw: unknown,
  field: string,
  named: ReadonlyMap<string, NamedTypeDecl>,
): Record<string, WorkflowRunOutput> {
  if (raw === undefined) return {};
  if (!isRecord(raw)) fail(field, "must be an object");
  const out: Record<string, WorkflowRunOutput> = {};
  for (const [name, port] of Object.entries(raw)) {
    if (!isRecord(port)) fail(`${field}.${name}`, "must be an object");
    if (typeof port.from !== "string" || port.from === "") {
      fail(`${field}.${name}.from`, "must be a non-empty string");
    }
    out[name] = {
      type: parseTypeField(port, `${field}.${name}`, named),
      bounds: parseBounds(port, `${field}.${name}`),
      from: port.from,
    };
  }
  return out;
}

function parseNodeInputPorts(
  raw: unknown,
  field: string,
  named: ReadonlyMap<string, NamedTypeDecl>,
): Record<string, NodeInputPort> {
  if (raw === undefined) return {};
  if (!isRecord(raw)) fail(field, "must be an object");
  const out: Record<string, NodeInputPort> = {};
  for (const [name, port] of Object.entries(raw)) {
    if (!isRecord(port)) fail(`${field}.${name}`, "must be an object");
    const entry: NodeInputPort = {
      type: parseTypeField(port, `${field}.${name}`, named),
      bounds: parseBounds(port, `${field}.${name}`),
    };
    if (port.from !== undefined) {
      if (typeof port.from !== "string" || port.from === "") {
        fail(`${field}.${name}.from`, "must be a non-empty string");
      }
      entry.from = port.from;
    }
    if (port.accumulate !== undefined) {
      if (typeof port.accumulate !== "boolean") {
        fail(`${field}.${name}.accumulate`, "must be a boolean");
      }
      entry.accumulate = port.accumulate;
    }
    out[name] = entry;
  }
  return out;
}

function parseNodeOutputPorts(
  raw: unknown,
  field: string,
  named: ReadonlyMap<string, NamedTypeDecl>,
): Record<string, NodeOutputPort> {
  if (raw === undefined) return {};
  if (!isRecord(raw)) fail(field, "must be an object");
  const out: Record<string, NodeOutputPort> = {};
  for (const [name, port] of Object.entries(raw)) {
    if (!isRecord(port)) fail(`${field}.${name}`, "must be an object");
    out[name] = {
      type: parseTypeField(port, `${field}.${name}`, named),
      bounds: parseBounds(port, `${field}.${name}`),
    };
  }
  return out;
}

// ── nodes ───────────────────────────────────────────────────────────────────

function parseNode(
  raw: unknown,
  field: string,
  named: ReadonlyMap<string, NamedTypeDecl>,
): WorkflowNode {
  if (!isRecord(raw)) fail(field, "must be an object");
  if (typeof raw.id !== "string" || raw.id === "") {
    fail(`${field}.id`, "must be a non-empty string");
  }
  if (raw.kind !== "step" && raw.kind !== "gate") {
    fail(`${field}.kind`, 'must be "step" or "gate"');
  }
  if (raw.kind === "gate") {
    return parseGate(raw, field);
  }
  return parseStep(raw, field, named);
}

function optionalString(
  raw: Record<string, unknown>,
  key: string,
  field: string,
): string | undefined {
  if (raw[key] === undefined) return undefined;
  if (typeof raw[key] !== "string" || raw[key] === "") {
    fail(`${field}.${key}`, "must be a non-empty string");
  }
  return raw[key] as string;
}

function parseLoop(raw: unknown, field: string): WorkflowLoop | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) fail(field, "must be an object");
  if (typeof raw.to !== "string" || raw.to === "") {
    fail(`${field}.to`, "must be a non-empty string");
  }
  if (typeof raw.max !== "number" || !Number.isInteger(raw.max) || raw.max < 1) {
    fail(`${field}.max`, "must be a positive integer");
  }
  const loop: WorkflowLoop = { to: raw.to, max: raw.max };
  if (raw.while !== undefined) {
    if (!isRecord(raw.while)) fail(`${field}.while`, "must be an object");
    if (typeof raw.while.port !== "string" || raw.while.port === "") {
      fail(`${field}.while.port`, "must be a non-empty string");
    }
    if (typeof raw.while.is !== "string" || raw.while.is === "") {
      fail(`${field}.while.is`, "must be a non-empty string");
    }
    loop.while = { port: raw.while.port, is: raw.while.is };
  }
  if (raw.with !== undefined) {
    if (!isRecord(raw.with)) fail(`${field}.with`, "must be an object");
    const withMap: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw.with)) {
      if (typeof v !== "string" || v === "") {
        fail(`${field}.with.${k}`, "must be a non-empty string");
      }
      withMap[k] = v;
    }
    loop.with = withMap;
  }
  return loop;
}

function parseSlots(
  raw: unknown,
  field: string,
): Record<string, WorkflowSlot> | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) fail(field, "must be an object");
  const slots: Record<string, WorkflowSlot> = {};
  for (const [name, slot] of Object.entries(raw)) {
    if (!isRecord(slot)) fail(`${field}.${name}`, "must be an object");
    const s: WorkflowSlot = {};
    for (const key of [
      "profile",
      "vendor",
      "model",
      "effort",
      "sandbox",
      "prompt_append",
    ] as const) {
      const v = optionalString(slot, key, `${field}.${name}`);
      if (v !== undefined) s[key] = v;
    }
    slots[name] = s;
  }
  return slots;
}

function parseStep(
  raw: Record<string, unknown>,
  field: string,
  named: ReadonlyMap<string, NamedTypeDecl>,
): WorkflowStepNode {
  if (typeof raw.prompt !== "string" || raw.prompt === "") {
    fail(`${field}.prompt`, "must be a non-empty string");
  }
  const step: WorkflowStepNode = {
    kind: "step",
    id: raw.id as string,
    prompt: raw.prompt,
    in: parseNodeInputPorts(raw.in, `${field}.in`, named),
    out: parseNodeOutputPorts(raw.out, `${field}.out`, named),
  };
  for (const key of ["task_type", "profile", "vendor", "model", "effort", "sandbox"] as const) {
    const v = optionalString(raw, key, field);
    if (v !== undefined) step[key] = v;
  }
  if (raw.over !== undefined) {
    if (typeof raw.over !== "string" || raw.over === "") {
      fail(`${field}.over`, "must be a non-empty string");
    }
    step.over = raw.over;
  }
  if (raw.retries !== undefined) {
    if (typeof raw.retries !== "number" || !Number.isInteger(raw.retries) || raw.retries < 0) {
      fail(`${field}.retries`, "must be a non-negative integer");
    }
    step.retries = raw.retries;
  }
  if (raw.success !== undefined) {
    if (!isRecord(raw.success)) fail(`${field}.success`, "must be an object");
    const success: { min?: number } = {};
    if (raw.success.min !== undefined) {
      if (
        typeof raw.success.min !== "number" ||
        !Number.isInteger(raw.success.min) ||
        raw.success.min < 0
      ) {
        fail(`${field}.success.min`, "must be a non-negative integer");
      }
      success.min = raw.success.min;
    }
    step.success = success;
  }
  const slots = parseSlots(raw.slots, `${field}.slots`);
  if (slots !== undefined) step.slots = slots;
  const loop = parseLoop(raw.loop, `${field}.loop`);
  if (loop !== undefined) step.loop = loop;
  return step;
}

function parseGate(raw: Record<string, unknown>, field: string): WorkflowGateNode {
  if (typeof raw.question !== "string" || raw.question === "") {
    fail(`${field}.question`, "must be a non-empty string");
  }
  if (typeof raw.on_reject !== "string" || raw.on_reject === "") {
    fail(`${field}.on_reject`, "must be a non-empty string");
  }
  if (!isRecord(raw.shows)) {
    fail(`${field}.shows`, "must be an object");
  }
  const shows: Record<string, { from: string }> = {};
  for (const [name, show] of Object.entries(raw.shows)) {
    if (!isRecord(show)) fail(`${field}.shows.${name}`, "must be an object");
    if (typeof show.from !== "string" || show.from === "") {
      fail(`${field}.shows.${name}.from`, "must be a non-empty string");
    }
    shows[name] = { from: show.from };
  }
  const gate: WorkflowGateNode = {
    kind: "gate",
    id: raw.id as string,
    question: raw.question,
    shows,
    on_reject: raw.on_reject,
  };
  const loop = parseLoop(raw.loop, `${field}.loop`);
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
  // Node input edges
  for (const node of definition.nodes) {
    if (node.kind !== "step") continue;
    for (const [portName, port] of Object.entries(node.in)) {
      if (port.from === undefined) continue;
      const upstream = resolveFromRef(definition, port.from);
      if (upstream === null) {
        fail(
          `nodes.${node.id}.in.${portName}.from`,
          `unknown reference "${port.from}"`,
        );
      }
      const compat = checkCompatibility(port.type, upstream);
      if (compat.outcome === "error") {
        fail(
          `nodes.${node.id}.in.${portName}`,
          compat.reason + ` (from ${port.from})`,
        );
      }
      // Data fan-out must declare itself (ADR-0016). Exact match needs no over.
      if (compat.outcome === "fan-out") {
        if (node.over !== portName) {
          fail(
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
        fail(`nodes.${node.id}.over`, `unknown input port "${node.over}"`);
      }
      if (overPort.from === undefined) {
        fail(
          `nodes.${node.id}.over`,
          `port "${node.over}" has no from (cannot drive data fan-out)`,
        );
      }
      const upstream = resolveFromRef(definition, overPort.from);
      if (upstream === null) {
        fail(
          `nodes.${node.id}.over`,
          `cannot resolve from "${overPort.from}" for over port`,
        );
      }
      const compat = checkCompatibility(overPort.type, upstream);
      if (compat.outcome !== "fan-out") {
        fail(
          `nodes.${node.id}.over`,
          `port "${node.over}" does not fan out over its upstream (need input ≡ element of upstream container)`,
        );
      }
      if (node.slots !== undefined && Object.keys(node.slots).length > 0) {
        fail(
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
      fail(`outputs.${name}.from`, `unknown reference "${out.from}"`);
    }
    const compat = checkCompatibility(out.type, upstream);
    if (compat.outcome === "error") {
      fail(`outputs.${name}`, compat.reason + ` (from ${out.from})`);
    }
    // Run outputs never fan out — exact only.
    if (compat.outcome === "fan-out") {
      fail(
        `outputs.${name}`,
        `run output must match upstream exactly (got fan-out from ${out.from})`,
      );
    }
  }
}
