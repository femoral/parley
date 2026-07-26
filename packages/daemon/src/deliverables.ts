/**
 * Deliverable machinery (ADR-0016 / #236): generated report schema, reference
 * validation, input materialization, and type-driven input rendering.
 *
 * Callable units only — the run engine (#237/#238) decides *when* to invoke
 * them. No new child verb: the child still calls `submit_report` once against
 * a schema the daemon generated from the node's output ports.
 *
 * Does **not** edit `run-workspace.ts` (sibling #235 owns that file); calls
 * {@link ensureTmpHandoff} and address helpers from `@useparley/core`.
 */

import fs from "node:fs";
import path from "node:path";
import {
  compileOutputPorts,
  formatPortType,
  formatStepAddress,
  type PortBounds,
  type PortType,
  type StepAddress,
} from "@useparley/core";
import type { DeliverableKind, NewDeliverable } from "./db.js";
import { ensureTmpHandoff } from "./run-workspace.js";
import {
  formatReportError,
  validateReport,
  type JsonSchema,
} from "./report.js";

// ---------------------------------------------------------------------------
// Generated report schema
// ---------------------------------------------------------------------------

/** One output port as handed to the report-schema compiler. */
export interface OutputPortSpec {
  type: PortType;
  bounds?: PortBounds;
}

/**
 * Generate a task's `report_schema` from its node's output ports (ADR-0016).
 * Thin wrapper over {@link compileOutputPorts} — the single compiler from #231.
 */
export function generateReportSchema(
  ports: Readonly<Record<string, OutputPortSpec>>,
): Record<string, unknown> {
  return compileOutputPorts(ports);
}

// ---------------------------------------------------------------------------
// Validation — Ajv shape + file/dir reference stat
// ---------------------------------------------------------------------------

/**
 * Full deliverable-report validation: Ajv shape check (including bounds
 * compiled into the schema) followed by a reference stat for every `file` /
 * `dir` leaf. Both failure classes return `path: message` lines for the
 * existing retryable bounce (ADR-0016 / ADR-0003).
 */
export function validateDeliverableReport(
  payload: unknown,
  ports: Readonly<Record<string, OutputPortSpec>>,
  workspaceRoot: string,
): string[] {
  const schema = generateReportSchema(ports) as JsonSchema;
  const shapeErrors = validateReport(payload, schema);
  if (shapeErrors.length > 0) return shapeErrors;
  return validatePortReferences(payload, ports, workspaceRoot);
}

/**
 * Walk a shape-valid report and stat every `file`/`dir` leaf:
 * exists, inside the workspace, non-empty. Retryable via `path: message`.
 */
export function validatePortReferences(
  payload: unknown,
  ports: Readonly<Record<string, OutputPortSpec>>,
  workspaceRoot: string,
): string[] {
  const errors: string[] = [];
  if (!isRecord(payload)) return errors;
  const root = path.resolve(workspaceRoot);
  for (const [name, port] of Object.entries(ports)) {
    walkReferences(payload[name], port.type, `/${name}`, root, errors);
  }
  return errors;
}

function walkReferences(
  value: unknown,
  type: PortType,
  instancePath: string,
  workspaceRoot: string,
  errors: string[],
): void {
  switch (type.kind) {
    case "file":
      if (typeof value === "string") {
        statReference(value, "file", instancePath, workspaceRoot, errors);
      }
      return;
    case "dir":
      if (typeof value === "string") {
        statReference(value, "dir", instancePath, workspaceRoot, errors);
      }
      return;
    case "array":
      if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) {
          walkReferences(value[i], type.element, `${instancePath}/${i}`, workspaceRoot, errors);
        }
      }
      return;
    case "dict":
      if (isRecord(value)) {
        for (const [key, child] of Object.entries(value)) {
          // JSON-pointer-ish key escape for the bounce path.
          const escaped = key.replace(/~/g, "~0").replace(/\//g, "~1");
          walkReferences(child, type.value, `${instancePath}/${escaped}`, workspaceRoot, errors);
        }
      }
      return;
    default:
      // text, url, enum, schema — no reference stat.
      return;
  }
}

/**
 * Resolve a workspace-relative (or absolute) path and assert it is a real,
 * non-empty file or directory strictly inside `workspaceRoot`.
 */
function statReference(
  rawPath: string,
  kind: "file" | "dir",
  instancePath: string,
  workspaceRoot: string,
  errors: string[],
): void {
  if (rawPath === "" || rawPath.includes("\0")) {
    errors.push(formatReportError(instancePath, "path must be a non-empty string"));
    return;
  }
  const resolved = path.isAbsolute(rawPath)
    ? path.resolve(rawPath)
    : path.resolve(workspaceRoot, rawPath);
  if (!isInsideWorkspace(resolved, workspaceRoot)) {
    errors.push(
      formatReportError(
        instancePath,
        `path must be inside the workspace (got ${JSON.stringify(rawPath)})`,
      ),
    );
    return;
  }
  let st: fs.Stats;
  try {
    st = fs.statSync(resolved);
  } catch {
    errors.push(
      formatReportError(instancePath, `${kind} does not exist: ${JSON.stringify(rawPath)}`),
    );
    return;
  }
  if (kind === "file") {
    if (!st.isFile()) {
      errors.push(
        formatReportError(instancePath, `expected a file, got ${describeStat(st)}`),
      );
      return;
    }
    if (st.size === 0) {
      errors.push(formatReportError(instancePath, "file is empty"));
    }
    return;
  }
  // dir
  if (!st.isDirectory()) {
    errors.push(
      formatReportError(instancePath, `expected a directory, got ${describeStat(st)}`),
    );
    return;
  }
  let entries: string[];
  try {
    entries = fs.readdirSync(resolved);
  } catch {
    errors.push(formatReportError(instancePath, "directory is not readable"));
    return;
  }
  if (entries.length === 0) {
    errors.push(formatReportError(instancePath, "directory is empty"));
  }
}

function describeStat(st: fs.Stats): string {
  if (st.isFile()) return "file";
  if (st.isDirectory()) return "directory";
  if (st.isSymbolicLink()) return "symlink";
  return "other";
}

/**
 * True when `resolved` is `workspaceRoot` or a path under it (no `..` escape).
 */
export function isInsideWorkspace(resolved: string, workspaceRoot: string): boolean {
  const root = path.resolve(workspaceRoot);
  const target = path.resolve(resolved);
  if (target === root) return true;
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  return target.startsWith(prefix);
}

// ---------------------------------------------------------------------------
// Record deliverable rows from an accepted report
// ---------------------------------------------------------------------------

export interface DeliverableAddressMeta {
  runId: string;
  node: string;
  iteration: number;
  slot?: string | null;
  taskId: string;
  /** Opaque id allocator (`d1`, …). */
  nextId: () => string;
}

/**
 * Build {@link NewDeliverable} rows from a shape-valid report payload.
 * Kind is read off the port type: `file`/`dir` → path reference (never
 * copied on submit); everything else is inline JSON.
 */
export function deliverablesFromReport(
  payload: Readonly<Record<string, unknown>>,
  ports: Readonly<Record<string, OutputPortSpec>>,
  meta: DeliverableAddressMeta,
): NewDeliverable[] {
  const out: NewDeliverable[] = [];
  for (const [portName, port] of Object.entries(ports)) {
    if (!(portName in payload)) continue;
    const value = payload[portName];
    const kind = deliverableKind(port.type);
    out.push({
      id: meta.nextId(),
      run_id: meta.runId,
      node: meta.node,
      port: portName,
      iteration: meta.iteration,
      slot: meta.slot ?? null,
      task_id: meta.taskId,
      kind,
      value: serializeDeliverableValue(value, kind),
    });
  }
  return out;
}

/** Map a port type's outermost atom to a deliverable kind. */
export function deliverableKind(type: PortType): DeliverableKind {
  if (type.kind === "file") return "file";
  if (type.kind === "dir") return "dir";
  return "inline";
}

function serializeDeliverableValue(value: unknown, kind: DeliverableKind): string {
  if (kind === "file" || kind === "dir") {
    return typeof value === "string" ? value : String(value);
  }
  return JSON.stringify(value);
}

// ---------------------------------------------------------------------------
// Input materialization — daemon writes `in/`, one file per port
// ---------------------------------------------------------------------------

/** One filled input port ready to materialize into the consumer workspace. */
export interface InputPortValue {
  /** Port name (becomes the filename under `in/`). */
  name: string;
  type: PortType;
  /**
   * Filled value. `undefined` / omitted ports are skipped entirely (ADR-0016:
   * unfilled ports are omitted — never materialize an empty placeholder).
   */
  value: unknown;
  /**
   * For `file`/`dir` ports: resolve relative paths against this root
   * (typically the producing task's workspace). Defaults to the consumer
   * `workspaceRoot`. Absolute paths are used as-is.
   */
  referentRoot?: string;
}

export interface MaterializeInputsOptions {
  /** Consumer workspace root (where `.parley/tmp/<address>/in` is written). */
  workspaceRoot: string;
  /** Step address string or structured coords. */
  address: StepAddress | string;
  inputs: readonly InputPortValue[];
}

export interface MaterializedInput {
  port: string;
  type: PortType;
  /** Absolute path of the written file or directory under `in/`. */
  absolutePath: string;
  /**
   * Workspace-relative path for prompt rendering
   * (`.parley/tmp/<address>/in/<port>`).
   */
  relativePath: string;
  /** How the value was written. */
  form: "inline-file" | "copied-file" | "copied-dir";
  /**
   * True when a `file`/`dir` referent was already gone — a normal condition,
   * not a crash. No bytes were written for this port.
   */
  missingReferent: boolean;
}

export interface MaterializeInputsResult {
  /** Absolute path of `in/`. */
  inDir: string;
  /** Address string used. */
  address: string;
  /** One entry per port that was considered (including missing referents). */
  ports: MaterializedInput[];
}

/**
 * Before spawn: write each filled input port into
 * `.parley/tmp/<address>/in/<port>` (ADR-0016 / ADR-0018).
 *
 * - Scalars and containers are written as a single file (text or JSON).
 * - `file`/`dir` ports are **copied on read** into the consumer workspace so
 *   ADR-0006's single writable root still stands for a cross-workspace handoff.
 * - A missing referent is recorded (`missingReferent: true`) and skipped —
 *   never throws.
 */
export function materializeInputs(opts: MaterializeInputsOptions): MaterializeInputsResult {
  const address =
    typeof opts.address === "string" ? opts.address : formatStepAddress(opts.address);
  const handoff = ensureTmpHandoff(opts.workspaceRoot, address);
  const ports: MaterializedInput[] = [];

  for (const input of opts.inputs) {
    if (input.value === undefined) continue;

    const destAbs = path.join(handoff.in, input.name);
    // Prefer POSIX-style relative paths in prompts and handoff records.
    const destRel = toWorkspaceRel(opts.workspaceRoot, destAbs);

    if (input.type.kind === "file") {
      ports.push(copyFileReferent(input, destAbs, destRel));
      continue;
    }
    if (input.type.kind === "dir") {
      ports.push(copyDirReferent(input, destAbs, destRel));
      continue;
    }

    // Scalars + containers: one file, type-driven body.
    const body = renderInputFileBody(input.type, input.value);
    fs.writeFileSync(destAbs, body.endsWith("\n") ? body : `${body}\n`);
    ports.push({
      port: input.name,
      type: input.type,
      absolutePath: destAbs,
      relativePath: destRel,
      form: "inline-file",
      missingReferent: false,
    });
  }

  return { inDir: handoff.in, address, ports };
}

function copyFileReferent(
  input: InputPortValue,
  destAbs: string,
  destRel: string,
): MaterializedInput {
  const base: MaterializedInput = {
    port: input.name,
    type: input.type,
    absolutePath: destAbs,
    relativePath: destRel,
    form: "copied-file",
    missingReferent: false,
  };
  if (typeof input.value !== "string" || input.value === "") {
    base.missingReferent = true;
    return base;
  }
  const sourceRoot = input.referentRoot;
  const source = resolveReferent(input.value, sourceRoot);
  if (source === null || !isExistingFile(source)) {
    base.missingReferent = true;
    return base;
  }
  try {
    fs.mkdirSync(path.dirname(destAbs), { recursive: true });
    fs.copyFileSync(source, destAbs);
  } catch {
    base.missingReferent = true;
  }
  return base;
}

function copyDirReferent(
  input: InputPortValue,
  destAbs: string,
  destRel: string,
): MaterializedInput {
  const base: MaterializedInput = {
    port: input.name,
    type: input.type,
    absolutePath: destAbs,
    relativePath: destRel,
    form: "copied-dir",
    missingReferent: false,
  };
  if (typeof input.value !== "string" || input.value === "") {
    base.missingReferent = true;
    return base;
  }
  const source = resolveReferent(input.value, input.referentRoot);
  if (source === null || !isExistingDir(source)) {
    base.missingReferent = true;
    return base;
  }
  try {
    fs.cpSync(source, destAbs, { recursive: true });
  } catch {
    base.missingReferent = true;
  }
  return base;
}

/**
 * Resolve a file/dir referent path. Absolute paths are used as-is. Relative
 * paths require `referentRoot` (the producing workspace). Returns null when
 * the path cannot be resolved — treated as a missing referent, not a crash.
 */
function resolveReferent(raw: string, referentRoot: string | undefined): string | null {
  if (raw === "" || raw.includes("\0")) return null;
  if (path.isAbsolute(raw)) return path.resolve(raw);
  if (referentRoot !== undefined && referentRoot !== "") {
    return path.resolve(referentRoot, raw);
  }
  return null;
}

function isExistingFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function isExistingDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Type-driven body for a non-file/dir input port written under `in/`.
 * Scalars → their string form; containers/schema → JSON.
 */
export function renderInputFileBody(type: PortType, value: unknown): string {
  switch (type.kind) {
    case "text":
    case "url":
      return typeof value === "string" ? value : String(value);
    case "enum":
      return typeof value === "string" ? value : String(value);
    case "file":
    case "dir":
      // Callers should copy, not call this — still serialize the path if asked.
      return typeof value === "string" ? value : String(value);
    case "array":
    case "dict":
    case "schema":
      return JSON.stringify(value, null, 2);
  }
}

// ---------------------------------------------------------------------------
// Type-driven `## Inputs` rendering (ADR-0016)
// ---------------------------------------------------------------------------

export interface RenderInputEntry {
  name: string;
  type: PortType;
  /**
   * Filled value. `undefined` ⇒ omit the port entirely.
   * For containers / file / dir, prefer {@link materializationPath} in the
   * rendered line; the value is only used for scalars.
   */
  value?: unknown;
  /**
   * Workspace-relative path of the materialized file (from
   * {@link materializeInputs}). Required for containers and file/dir when
   * the value was successfully written; when missing (e.g. gone referent),
   * the port is omitted.
   */
  materializationPath?: string;
  /** When true, treat as unfilled for rendering purposes. */
  missingReferent?: boolean;
}

/**
 * Render the `## Inputs` prompt section type-driven (ADR-0016):
 * - scalars (`text` / `url` / `enum`) inline
 * - containers (`T[]` / `dict` / named schema) by path
 * - `file` / `dir` by path (the copy under `in/`)
 * - unfilled ports and missing referents omitted entirely
 *
 * Returns `""` when nothing would be listed (caller skips the section).
 */
export function renderInputsSection(entries: readonly RenderInputEntry[]): string {
  const lines: string[] = [];
  for (const entry of entries) {
    if (entry.value === undefined) continue;
    if (entry.missingReferent === true) continue;

    const rendered = renderOneInput(entry);
    if (rendered === null) continue;
    lines.push(rendered);
  }
  if (lines.length === 0) return "";
  return `## Inputs\n\n${lines.join("\n")}`;
}

function renderOneInput(entry: RenderInputEntry): string | null {
  const { name, type, value, materializationPath } = entry;
  const typeLabel = formatPortType(type);

  if (isScalarAtom(type)) {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return `- \`${name}\` (${typeLabel}): ${text}`;
  }

  // Containers and file/dir: path only.
  if (materializationPath === undefined || materializationPath === "") {
    return null;
  }
  return `- \`${name}\` (${typeLabel}): see \`${materializationPath}\``;
}

function isScalarAtom(type: PortType): boolean {
  return type.kind === "text" || type.kind === "url" || type.kind === "enum";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Workspace-relative path using `/` separators (prompt- and cross-platform-friendly). */
function toWorkspaceRel(workspaceRoot: string, absolutePath: string): string {
  const rel = path.relative(path.resolve(workspaceRoot), path.resolve(absolutePath));
  return rel.split(path.sep).join("/");
}
