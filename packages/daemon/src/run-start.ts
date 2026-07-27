/**
 * `parley run start` — create a run (ADR-0022 / #249).
 *
 * Phase 1 is fallible and side-effect-free: resolve workflow → bind/merge
 * inputs → Ajv validate → stat file/dir referents → preflight. Failure leaves
 * no run row, no workspace, no branch.
 *
 * Phase 2 commits: create workspace → insertRun → write frozen inputs → enter
 * node 1. Failure leaves a `failed` run row carrying the error (workspace may
 * remain for diagnosis).
 *
 * The fork path ({@link applyFork} in run-engine.ts) is the template for phase
 * 2: workspace, frozen inputs, insert at entry with iteration 1, enter. Start
 * is that minus inheritance, plus input binding and preflight.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  formatPortType,
  resolveWorkflow,
  type PortType,
  type WorkflowDefinition,
  type WorkflowInputPort,
  type WorkflowNode,
  type ParleyConfig,
} from "@useparley/core";
import {
  generateReportSchema,
  type OutputPortSpec,
} from "./deliverables.js";
import {
  getRun,
  insertRun,
  nextRunId,
  setRunBlockReason,
  updateRun,
  type DatabaseHandle,
  type RunRow,
} from "./db.js";
import { formatReportError, validateReport, type JsonSchema } from "./report.js";
import {
  buildAdvanceContext,
  fillStepInputs,
  findNode,
  markRunFailed,
  missingInputPorts,
  type RunDrainHost,
} from "./run-engine.js";
import { preflightRunStart } from "./run-preflight.js";
import {
  createRunCheckout,
  createRunScratchWorkspace,
  writeRunInputs,
} from "./run-workspace.js";
import { repoRoot } from "./worktree.js";

// ---------------------------------------------------------------------------
// Input binding (pure)
// ---------------------------------------------------------------------------

/**
 * True when a port accepts a scalar atom via `--input name=value`.
 * Containers (`T[]`, `dict<…>`) and named-schema ports require `--inputs`.
 */
export function isScalarInputPort(type: PortType): boolean {
  switch (type.kind) {
    case "text":
    case "url":
    case "file":
    case "dir":
    case "enum":
      return true;
    case "array":
    case "dict":
    case "schema":
      return false;
  }
}

/** One `--input name=value` flag (value is never JSON-parsed). */
export interface InputFlag {
  name: string;
  value: string;
}

export type BindRunInputsResult =
  | { ok: true; inputs: Record<string, unknown> }
  | { ok: false; error: string };

/**
 * Merge `--inputs` file object with repeated `--input name=value` flags.
 * Flag wins on name collision. All declared ports must be bound; undeclared
 * names and scalar-flag-on-container are usage errors.
 */
export function bindRunInputs(opts: {
  declared: Readonly<Record<string, WorkflowInputPort>>;
  /** Object from `--inputs <file>` (may be empty/undefined). */
  fileInputs?: Readonly<Record<string, unknown>> | null;
  /** Parsed `--input name=value` flags. */
  flagInputs?: readonly InputFlag[];
}): BindRunInputsResult {
  const declared = opts.declared;
  const declaredNames = new Set(Object.keys(declared));
  const merged: Record<string, unknown> = {};

  const file = opts.fileInputs;
  if (file !== undefined && file !== null) {
    for (const [name, value] of Object.entries(file)) {
      if (!declaredNames.has(name)) {
        return {
          ok: false,
          error: `undeclared input port ${JSON.stringify(name)} (declared: ${formatDeclared(declared)})`,
        };
      }
      merged[name] = value;
    }
  }

  for (const flag of opts.flagInputs ?? []) {
    const port = declared[flag.name];
    if (port === undefined) {
      return {
        ok: false,
        error: `undeclared input port ${JSON.stringify(flag.name)} (declared: ${formatDeclared(declared)})`,
      };
    }
    if (!isScalarInputPort(port.type)) {
      return {
        ok: false,
        error:
          `--input cannot bind ${JSON.stringify(flag.name)} ` +
          `(type ${formatPortType(port.type)}); use --inputs <file> for ` +
          `container and named-schema ports`,
      };
    }
    merged[flag.name] = flag.value;
  }

  const unbound: string[] = [];
  for (const name of declaredNames) {
    if (!(name in merged)) unbound.push(name);
  }
  if (unbound.length > 0) {
    return {
      ok: false,
      error:
        unbound.length === 1
          ? `unbound input port ${JSON.stringify(unbound[0])}`
          : `unbound input ports: ${unbound.map((n) => JSON.stringify(n)).join(", ")}`,
    };
  }

  return { ok: true, inputs: merged };
}

function formatDeclared(declared: Readonly<Record<string, WorkflowInputPort>>): string {
  const names = Object.keys(declared);
  return names.length === 0 ? "(none)" : names.map((n) => JSON.stringify(n)).join(", ");
}

/**
 * Parse a single `--input name=value` argument. The first `=` splits name from
 * value; value may contain `=`. Empty name is a usage error.
 */
export function parseInputFlag(raw: string): InputFlag | { error: string } {
  const eq = raw.indexOf("=");
  if (eq <= 0) {
    return {
      error: `--input requires name=value (got ${JSON.stringify(raw)})`,
    };
  }
  const name = raw.slice(0, eq);
  const value = raw.slice(eq + 1);
  if (name === "") {
    return { error: `--input requires a non-empty port name (got ${JSON.stringify(raw)})` };
  }
  return { name, value };
}

// ---------------------------------------------------------------------------
// Validation (Ajv + referent stat — reuse report seam)
// ---------------------------------------------------------------------------

/**
 * Two-stage validation of bound run inputs (ADR-0016 reuse):
 * 1. Compile declared input ports via {@link generateReportSchema}, Ajv shape
 *    check via {@link validateReport}.
 * 2. Stat every `file`/`dir` leaf (exists, non-empty, correct kind).
 *
 * Referents resolve against `referentRoot` (caller cwd). Absolute paths are
 * accepted as-is. Unlike report validation there is no "inside workspace"
 * bound yet — the workspace does not exist until phase 2 — so the walk is
 * the same shape/message form as the report seam without the containment
 * check.
 */
export function validateBoundRunInputs(opts: {
  declared: Readonly<Record<string, WorkflowInputPort>>;
  inputs: Readonly<Record<string, unknown>>;
  /** Resolve relative file/dir paths against this directory. */
  referentRoot: string;
}): string[] {
  const ports: Record<string, OutputPortSpec> = {};
  for (const [name, port] of Object.entries(opts.declared)) {
    ports[name] = { type: port.type, bounds: port.bounds };
  }
  const schema = generateReportSchema(ports) as JsonSchema;
  const shapeErrors = validateReport(opts.inputs, schema);
  if (shapeErrors.length > 0) return shapeErrors;

  const errors: string[] = [];
  for (const [name, port] of Object.entries(ports)) {
    walkExternalRefs(
      opts.inputs[name],
      port.type,
      `/${name}`,
      opts.referentRoot,
      errors,
    );
  }
  return errors;
}

function walkExternalRefs(
  value: unknown,
  type: PortType,
  instancePath: string,
  referentRoot: string,
  errors: string[],
): void {
  switch (type.kind) {
    case "file":
      if (typeof value === "string") {
        statExternal(value, "file", instancePath, referentRoot, errors);
      }
      return;
    case "dir":
      if (typeof value === "string") {
        statExternal(value, "dir", instancePath, referentRoot, errors);
      }
      return;
    case "array":
      if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) {
          walkExternalRefs(value[i], type.element, `${instancePath}/${i}`, referentRoot, errors);
        }
      }
      return;
    case "dict":
      if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
          const escaped = key.replace(/~/g, "~0").replace(/\//g, "~1");
          walkExternalRefs(child, type.value, `${instancePath}/${escaped}`, referentRoot, errors);
        }
      }
      return;
    default:
      return;
  }
}

function statExternal(
  rawPath: string,
  kind: "file" | "dir",
  instancePath: string,
  referentRoot: string,
  errors: string[],
): void {
  if (rawPath === "" || rawPath.includes("\0")) {
    errors.push(formatReportError(instancePath, "path must be a non-empty string"));
    return;
  }
  const resolved = path.isAbsolute(rawPath)
    ? path.resolve(rawPath)
    : path.resolve(referentRoot, rawPath);
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
      errors.push(formatReportError(instancePath, `expected a file, got ${describeStat(st)}`));
      return;
    }
    if (st.size === 0) {
      errors.push(formatReportError(instancePath, "file is empty"));
    }
    return;
  }
  if (!st.isDirectory()) {
    errors.push(formatReportError(instancePath, `expected a directory, got ${describeStat(st)}`));
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
  return "other";
}

// ---------------------------------------------------------------------------
// Base ref resolve (side-effect-free)
// ---------------------------------------------------------------------------

/** Resolve a git ref to a full commit SHA. Throws on failure. */
export function resolveBaseCommit(repo: string, baseRef: string): string {
  try {
    return execFileSync("git", ["-C", repo, "rev-parse", "--verify", `${baseRef}^{commit}`], {
      encoding: "utf8",
    }).trim();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`failed to resolve --base-ref ${JSON.stringify(baseRef)}: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// Start request / result
// ---------------------------------------------------------------------------

export interface StartRunRequest {
  /** Workflow definition id (two-layer discovery). */
  workflow: string;
  /** Object from `--inputs <file>`, if any. */
  fileInputs?: Record<string, unknown> | null;
  /** Parsed `--input name=value` flags. */
  flagInputs?: InputFlag[];
  /**
   * `--base-ref` as given. Null/omit ⇒ default `HEAD` for repo mode; scratch
   * refuses any non-empty value via preflight.
   */
  baseRef?: string | null;
  /** Caller's cwd — workflow discovery + repo root + relative path resolve. */
  cwd: string;
  /** Parley home for global workflow layer. */
  home: string;
  orchestratorSessionId?: string | null;
}

export interface StartRunHost extends RunDrainHost {
  worktreesDir: string;
  runsDir: string;
  config: ParleyConfig;
  configPath: string;
}

export type StartRunResult =
  | { kind: "ok"; run: RunRow; definition: WorkflowDefinition; entered: boolean }
  | { kind: "usage"; message: string }
  | { kind: "error"; message: string; run?: RunRow };

/**
 * Create and enter a run. Phase-1 failures return `{ kind: "usage" }` with no
 * side effects. Phase-2 failures return `{ kind: "error" }` with a `failed`
 * run row when possible.
 */
export function startRun(
  db: DatabaseHandle,
  host: StartRunHost,
  request: StartRunRequest,
): StartRunResult {
  // ── Phase 1: fallible, side-effect-free ────────────────────────────────
  const phase1 = runStartPhase1(host, request);
  if (phase1.kind !== "ok") return phase1;

  // ── Phase 2: commit ────────────────────────────────────────────────────
  return runStartPhase2(db, host, phase1);
}

export interface Phase1Ok {
  kind: "ok";
  definition: WorkflowDefinition;
  inputs: Record<string, unknown>;
  baseRef: string | null;
  baseCommit: string | null;
  repo: string | null;
  entryNode: string;
  orchestratorSessionId: string | null;
}

/**
 * Phase 1 only — exported for tests that assert no side effects on failure.
 */
export function runStartPhase1(
  host: Pick<StartRunHost, "config" | "configPath">,
  request: StartRunRequest,
): Phase1Ok | { kind: "usage"; message: string } {
  let resolved: ReturnType<typeof resolveWorkflow>;
  try {
    resolved = resolveWorkflow(request.workflow, {
      cwd: request.cwd,
      home: request.home,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { kind: "usage", message: `workflow ${JSON.stringify(request.workflow)}: ${message}` };
  }
  if (resolved === null) {
    return {
      kind: "usage",
      message: `workflow ${JSON.stringify(request.workflow)} not found`,
    };
  }
  const definition = resolved.definition;

  if (definition.nodes.length === 0) {
    return { kind: "usage", message: `workflow ${JSON.stringify(definition.id)} has no nodes` };
  }
  const entryNode = definition.nodes[0]!.id;

  const bound = bindRunInputs({
    declared: definition.inputs,
    fileInputs: request.fileInputs,
    flagInputs: request.flagInputs,
  });
  if (!bound.ok) {
    return { kind: "usage", message: bound.error };
  }

  const validationErrors = validateBoundRunInputs({
    declared: definition.inputs,
    inputs: bound.inputs,
    referentRoot: path.resolve(request.cwd),
  });
  if (validationErrors.length > 0) {
    return {
      kind: "usage",
      message: `invalid inputs: ${validationErrors.join("; ")}`,
    };
  }

  const repo =
    definition.workspace === "repo" ? repoRoot(request.cwd) : null;
  const baseRefRaw =
    request.baseRef === undefined || request.baseRef === null || request.baseRef === ""
      ? definition.workspace === "repo"
        ? "HEAD"
        : null
      : request.baseRef;

  // Preflight before base resolve so scratch --base-ref fails through the
  // existing refusal (and before any git call).
  try {
    preflightRunStart({
      definition,
      config: host.config,
      configPath: host.configPath,
      repoRoot: repo,
      baseRef: baseRefRaw,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { kind: "usage", message };
  }

  let baseCommit: string | null = null;
  if (definition.workspace === "repo") {
    if (repo === null) {
      // preflight should have refused; belt-and-braces
      return { kind: "usage", message: "workspace: repo requires a git repository" };
    }
    try {
      baseCommit = resolveBaseCommit(repo, baseRefRaw ?? "HEAD");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { kind: "usage", message };
    }
  }

  return {
    kind: "ok",
    definition,
    inputs: bound.inputs,
    baseRef: definition.workspace === "repo" ? (baseRefRaw ?? "HEAD") : null,
    baseCommit,
    repo: definition.workspace === "scratch" ? null : repo,
    entryNode,
    orchestratorSessionId: request.orchestratorSessionId ?? null,
  };
}

function runStartPhase2(
  db: DatabaseHandle,
  host: StartRunHost,
  phase1: Phase1Ok,
): StartRunResult {
  const { definition, inputs, baseRef, baseCommit, repo, entryNode } = phase1;
  const runId = nextRunId(db);
  let workspacePath: string | null = null;
  let inserted = false;

  try {
    // Create workspace first (fork template).
    if (definition.workspace === "scratch") {
      const info = createRunScratchWorkspace({
        runsDir: host.runsDir,
        runId,
      });
      workspacePath = info.path;
    } else {
      if (repo === null || repo === "") {
        throw new Error("repo-mode run has no bound repo");
      }
      const info = createRunCheckout({
        repoRoot: repo,
        worktreesDir: host.worktreesDir,
        runId,
        workflow: definition.id,
        // Prefer the frozen commit so the checkout matches base_commit.
        baseRef: baseCommit ?? baseRef ?? "HEAD",
      });
      workspacePath = info.path;
    }

    writeRunInputs(workspacePath, inputs);

    const row = insertRun(db, {
      id: runId,
      workflow: definition.id,
      version: definition.version,
      type: definition.type,
      workspace: definition.workspace,
      repo,
      state: "running",
      current_node: entryNode,
      iteration: 1,
      parent_run_id: null,
      attempt: 1,
      orchestrator_session_id: phase1.orchestratorSessionId,
      base_ref: baseRef,
      base_commit: baseCommit,
    });
    inserted = true;

    // Enter node 1 — same machinery as fork / gate verbs.
    const entry = findNode(definition, entryNode);
    if (entry === undefined) {
      throw new Error(`entry node ${JSON.stringify(entryNode)} missing from definition`);
    }
    enterFirstNode(db, host, row, definition, entry, inputs);

    const final = getRun(db, runId) ?? row;
    return {
      kind: "ok",
      run: final,
      definition,
      entered: true,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (inserted) {
      const failed = markRunFailed(db, runId, message);
      return { kind: "error", message, run: failed };
    }
    // Workspace may exist without a row — insert a failed row for diagnosis.
    try {
      const failed = insertRun(db, {
        id: runId,
        workflow: definition.id,
        version: definition.version,
        type: definition.type,
        workspace: definition.workspace,
        repo,
        state: "failed",
        current_node: entryNode,
        iteration: 1,
        orchestrator_session_id: phase1.orchestratorSessionId,
        base_ref: baseRef,
        base_commit: baseCommit,
        error: message,
        started_at: new Date().toISOString(),
      });
      updateRun(db, runId, {
        completed_at: new Date().toISOString(),
      });
      return { kind: "error", message, run: getRun(db, runId) ?? failed };
    } catch {
      return { kind: "error", message };
    }
  }
}

/**
 * Enter the first node of a freshly inserted run. Gates block; steps spawn
 * via host.onEnter (or block on unfilled inputs / spawn error).
 */
function enterFirstNode(
  db: DatabaseHandle,
  host: StartRunHost,
  run: RunRow,
  definition: WorkflowDefinition,
  entry: WorkflowNode,
  frozenInputs: Record<string, unknown>,
): void {
  if (entry.kind === "gate") {
    updateRun(db, run.id, {
      state: "blocked",
      current_node: entry.id,
      iteration: 1,
      error: `blocked (gate ${entry.id})`,
    });
    setRunBlockReason(db, run.id, "gate");
    return;
  }

  const ctx = buildAdvanceContext({
    run: getRun(db, run.id) ?? run,
    definition,
    db,
    runInputs: frozenInputs,
  });
  const missing = missingInputPorts(entry, ctx, 1, {});
  if (missing.length > 0) {
    updateRun(db, run.id, {
      state: "blocked",
      current_node: entry.id,
      iteration: 1,
      error: `blocked (unfilled inputs on ${entry.id}: ${missing.join(", ")})`,
    });
    setRunBlockReason(db, run.id, "unfilled_inputs");
    return;
  }

  const stepInputs = fillStepInputs(entry, ctx, {});
  if (host.onEnter !== undefined) {
    const err = host.onEnter({
      run: getRun(db, run.id) ?? run,
      definition,
      step: entry,
      iteration: 1,
      inputs: stepInputs,
      loopFills: {},
      note: null,
    });
    if (err !== undefined && typeof err === "object" && "error" in err) {
      updateRun(db, run.id, {
        state: "blocked",
        error: `blocked (spawn ${entry.id}): ${err.error}`,
      });
      setRunBlockReason(db, run.id, "spawn");
    }
  }
}

