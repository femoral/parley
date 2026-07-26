/**
 * Run query surface projections (ADR-0021 / #241).
 *
 * Pure helpers: gist assembly, node/run projections, text rendering, and
 * deliverable resolution. Unit-testable without a live daemon. SELECTs live
 * in `db.ts` (#241 block); HTTP wiring is in `server.ts`.
 *
 * Denied to the child MCP/HTTP channel — reviewers must not read each other.
 */

import fs from "node:fs";
import path from "node:path";
import {
  applyFanOutCollection,
  formatPortType,
  isSettledState,
  type DeliverableRef,
  type DeliverableSize,
  type DeliverableValue,
  type GateShowRef,
  type NodeDetailResponse,
  type NodeFanout,
  type NodeProjection,
  type NodeTaskRow,
  type PortType,
  type RunBlock,
  type RunBlockReason,
  type RunBlockVerb,
  type RunDetailResponse,
  type RunSummary,
  type RunUsage,
  type WorkflowDefinition,
  type WorkflowGateNode,
  type WorkflowNode,
  type WorkflowStepNode,
} from "@useparley/core";
import {
  inferBlockReason,
  verbsForBlockReason,
  type BlockReason,
} from "./run-gates.js";
import type {
  DeliverableKind,
  DeliverableRow,
  RunRow,
  TaskRow,
} from "./db.js";

// ---------------------------------------------------------------------------
// Task / report parsing helpers (pure over row fields)
// ---------------------------------------------------------------------------

/** Minimal task shape the projections need (avoids full TaskRow in unit tests). */
export interface QueryTask {
  id: string;
  state: string;
  slot: string | null;
  node: string | null;
  iteration: number | null;
  usage: string | null;
  report: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  error: string | null;
}

/** Minimal deliverable shape for pure projections. */
export interface QueryDeliverable {
  id: string;
  run_id: string;
  node: string;
  port: string;
  iteration: number;
  slot: string | null;
  /**
   * Producing task id. Null after retention purges the task while the
   * address row survives (#244 — ON DELETE SET NULL).
   */
  task_id: string | null;
  kind: DeliverableKind;
  value: string | null;
  created_at: string;
  purged_at: string | null;
}

/** Output port metadata for tally / count / kind. */
export interface QueryPort {
  name: string;
  type: PortType;
}

function parseJson(raw: string | null): unknown {
  if (raw === null || raw === undefined || raw === "") return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Parse task.usage JSON into token counts. */
export function parseTaskUsage(usageJson: string | null): RunUsage | null {
  const raw = parseJson(usageJson);
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const input = pickNumber(rec, [
    "input_tokens",
    "inputTokens",
    "input",
    "prompt_tokens",
  ]);
  const output = pickNumber(rec, [
    "output_tokens",
    "outputTokens",
    "output",
    "completion_tokens",
  ]);
  if (input === null && output === null) return null;
  return { input_tokens: input ?? 0, output_tokens: output ?? 0 };
}

function pickNumber(rec: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return null;
}

/** Child-authored `summary` from a report JSON column, if present. */
export function parseTaskSummary(reportJson: string | null): string | null {
  const raw = parseJson(reportJson);
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const summary = (raw as Record<string, unknown>).summary;
  return typeof summary === "string" && summary.trim() !== "" ? summary : null;
}

/** Sum usage across tasks. */
export function sumUsage(tasks: readonly QueryTask[]): RunUsage {
  let input = 0;
  let output = 0;
  for (const t of tasks) {
    const u = parseTaskUsage(t.usage);
    if (u) {
      input += u.input_tokens;
      output += u.output_tokens;
    }
  }
  return { input_tokens: input, output_tokens: output };
}

/** Duration spanning earliest start → latest end (or now when live). */
export function spanDurationMs(
  tasks: readonly QueryTask[],
  nowMs: number = Date.now(),
): number | null {
  if (tasks.length === 0) return null;
  let start = Infinity;
  let end = -Infinity;
  for (const t of tasks) {
    const s = Date.parse(t.started_at ?? t.created_at);
    if (Number.isFinite(s) && s < start) start = s;
    if (t.completed_at === null) {
      if (nowMs > end) end = nowMs;
    } else {
      const e = Date.parse(t.completed_at);
      if (Number.isFinite(e) && e > end) end = e;
    }
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, end - start);
}

// ---------------------------------------------------------------------------
// Block reason (wire names)
// ---------------------------------------------------------------------------

/** Map daemon block reason → wire RunBlockReason. */
export function toWireBlockReason(reason: BlockReason): RunBlockReason {
  switch (reason) {
    case "gate":
      return "gate";
    case "loop_budget":
      return "loop_exhausted";
    case "success_policy":
      return "success_policy";
    case "spawn":
      return "spawn_error";
    case "unfilled_inputs":
      return "unfilled_inputs";
    default:
      return "unknown";
  }
}

/** Parse loop max from `blocked (loop 2/2)` style error strings. */
export function parseLoopMax(error: string | null): number | null {
  if (!error) return null;
  const m = error.match(/loop\s+(\d+)\s*\/\s*(\d+)/i);
  if (m) return Number(m[2]);
  return null;
}

/**
 * Build a RunBlock from a run row + optional definition.
 * Returns null when the run is not blocked.
 */
export function buildRunBlock(
  run: Pick<RunRow, "state" | "error" | "current_node" | "iteration">,
  definition: WorkflowDefinition | null,
): RunBlock | null {
  if (run.state !== "blocked") return null;
  const internal: BlockReason = definition
    ? inferBlockReason(run, definition)
    : inferBlockReasonFromError(run.error);
  const reason = toWireBlockReason(internal);
  const verbs = verbsForBlockReason(internal) as RunBlockVerb[];
  return {
    reason,
    node: run.current_node,
    iteration: run.iteration,
    max: reason === "loop_exhausted" ? parseLoopMax(run.error) : null,
    detail: run.error,
    verbs,
  };
}

function inferBlockReasonFromError(error: string | null): BlockReason {
  const err = error ?? "";
  if (err.includes("loop ") || err.includes("loop_budget")) return "loop_budget";
  if (err.includes("success") || err.includes("slots)")) return "success_policy";
  if (err.includes("spawn")) return "spawn";
  if (err.includes("unfilled input") || err.includes("unfilled_inputs")) {
    return "unfilled_inputs";
  }
  if (err.includes("gate")) return "gate";
  return "unknown";
}

/** Compact block parenthetical for list STATE, e.g. `loop 2/2`. */
export function formatBlockParenthetical(block: RunBlock): string {
  switch (block.reason) {
    case "gate":
      return "gate";
    case "loop_exhausted": {
      const cur = block.iteration ?? "?";
      const max = block.max ?? cur;
      return `loop ${cur}/${max}`;
    }
    case "success_policy": {
      // Prefer embedded counts from error when present: `blocked (2/3 slots)`
      const detail = block.detail ?? "";
      const m = detail.match(/(\d+)\s*\/\s*(\d+)\s*slots/i);
      if (m) return `${m[1]}/${m[2]} slots`;
      return "slots";
    }
    case "spawn_error":
      return "spawn";
    case "unfilled_inputs":
      return "inputs";
    default:
      return "blocked";
  }
}

// ---------------------------------------------------------------------------
// Step state projection (polymorphic STATE — step half)
// ---------------------------------------------------------------------------

/**
 * Project a step's STATE from its tasks (CONTEXT.md: settled on
 * `isSettledState`, never terminal alone).
 */
export function projectStepState(tasks: readonly QueryTask[]): string {
  if (tasks.length === 0) return "pending";
  const unsettled = tasks.filter((t) => !isSettledState(t.state));
  if (unsettled.length > 0) {
    if (unsettled.some((t) => t.state === "awaiting_answer")) return "awaiting_answer";
    if (unsettled.some((t) => t.state === "stalled")) return "stalled";
    if (unsettled.some((t) => t.state === "running")) return "running";
    if (unsettled.some((t) => t.state === "queued")) return "queued";
    return "running";
  }
  // All settled.
  if (tasks.every((t) => t.state === "cancelled")) return "cancelled";
  if (tasks.every((t) => t.state === "failed" || t.state === "cancelled")) return "failed";
  if (tasks.some((t) => t.state === "stalled") && !tasks.some((t) => t.state === "completed")) {
    return "stalled";
  }
  return "completed";
}

// ---------------------------------------------------------------------------
// Gist — three deterministic parts (ADR-0021)
// ---------------------------------------------------------------------------

/**
 * Tally **top-level enum ports only**. Never reach inside a named schema type.
 * Returns `port → value → count`.
 */
export function tallyEnumPorts(
  ports: readonly QueryPort[],
  deliverables: readonly QueryDeliverable[],
): Record<string, Record<string, number>> {
  const tallies: Record<string, Record<string, number>> = {};
  for (const port of ports) {
    if (port.type.kind !== "enum") continue;
    const byValue: Record<string, number> = {};
    for (const d of deliverables) {
      if (d.port !== port.name) continue;
      if (d.purged_at !== null || d.value === null) continue;
      if (d.kind !== "inline") continue;
      const v = parseJson(d.value);
      if (typeof v === "string" && v !== "") {
        byValue[v] = (byValue[v] ?? 0) + 1;
      }
    }
    if (Object.keys(byValue).length > 0) {
      tallies[port.name] = byValue;
    }
  }
  return tallies;
}

/**
 * Count elements/keys of plural (array / dict) out-ports.
 * Returns `port → total count across all sibling deliverables`.
 */
export function countPluralPorts(
  ports: readonly QueryPort[],
  deliverables: readonly QueryDeliverable[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const port of ports) {
    if (port.type.kind !== "array" && port.type.kind !== "dict") continue;
    let total = 0;
    let any = false;
    for (const d of deliverables) {
      if (d.port !== port.name) continue;
      if (d.purged_at !== null || d.value === null) continue;
      if (d.kind !== "inline") continue;
      const v = parseJson(d.value);
      const n = pluralCount(v, port.type.kind);
      if (n !== null) {
        total += n;
        any = true;
      }
    }
    if (any) counts[port.name] = total;
  }
  return counts;
}

function pluralCount(value: unknown, kind: "array" | "dict"): number | null {
  if (kind === "array" && Array.isArray(value)) return value.length;
  if (
    kind === "dict" &&
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  ) {
    return Object.keys(value as object).length;
  }
  // Scalar stored under a plural port is one element (defensive).
  if (value !== null && value !== undefined) return 1;
  return null;
}

/**
 * Format the GIST column from three deterministic parts, joined by ` · `:
 * 1. enum tallies  2. plural counts  3. child summary (single-task only)
 * Plus `n/m ok` when a fan-out lost a sibling.
 */
export function assembleGist(parts: {
  tallies: Record<string, Record<string, number>>;
  counts: Record<string, number>;
  /** Child summary — only used when tasks_total === 1. */
  summary: string | null;
  tasks_settled: number;
  tasks_total: number;
  /** When true, prefer "n of m settled" for in-flight fan-outs. */
  in_flight?: boolean;
  /** Max chars for the summary fragment (line budget). */
  summaryMax?: number;
}): string {
  const fragments: string[] = [];
  const { tasks_settled, tasks_total } = parts;

  // Lost-sibling / partial progress prefix.
  if (tasks_total > 1) {
    if (parts.in_flight && tasks_settled < tasks_total) {
      fragments.push(`${tasks_settled} of ${tasks_total} settled`);
    } else if (tasks_settled < tasks_total) {
      fragments.push(`${tasks_settled}/${tasks_total} ok`);
    } else {
      // All settled: still show n/m ok when some failed (settled ≠ usable).
      // Caller passes settled counts; when equal and complete, skip unless
      // tallies/counts empty and we want a minimal marker — prototype shows
      // `6/6 ok` only when useful. We emit n/m ok only when n < m.
    }
  }

  for (const [port, byValue] of Object.entries(parts.tallies)) {
    const entries = Object.entries(byValue);
    if (entries.length === 0) continue;
    const total = entries.reduce((s, [, n]) => s + n, 0);
    if (total === 1 && entries.length === 1) {
      fragments.push(`${port}=${entries[0]![0]}`);
    } else {
      const body = entries
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([v, n]) => `${n} ${v}`)
        .join(", ");
      fragments.push(`${port}=${body}`);
    }
  }

  for (const [port, n] of Object.entries(parts.counts)) {
    fragments.push(`${n} ${port}`);
  }

  // Rule 3: child summary only on single-task nodes.
  if (tasks_total === 1 && parts.summary) {
    const max = parts.summaryMax ?? 80;
    const s =
      parts.summary.length > max
        ? `${parts.summary.slice(0, max - 1)}…`
        : parts.summary;
    fragments.push(s);
  }

  return fragments.join(" · ");
}

// ---------------------------------------------------------------------------
// Grouping — one row per (node, iteration)
// ---------------------------------------------------------------------------

export interface NodeIterationKey {
  node: string;
  iteration: number;
}

/** Distinct (node, iteration) keys from tasks + deliverables, stable order. */
export function collectNodeIterations(
  tasks: readonly QueryTask[],
  deliverables: readonly QueryDeliverable[] = [],
): NodeIterationKey[] {
  const map = new Map<string, NodeIterationKey>();
  for (const t of tasks) {
    if (t.node == null || t.iteration == null) continue;
    const k = `${t.node}\0${t.iteration}`;
    if (!map.has(k)) map.set(k, { node: t.node, iteration: t.iteration });
  }
  for (const d of deliverables) {
    const k = `${d.node}\0${d.iteration}`;
    if (!map.has(k)) map.set(k, { node: d.node, iteration: d.iteration });
  }
  return [...map.values()].sort((a, b) => {
    if (a.iteration !== b.iteration) return a.iteration - b.iteration;
    return a.node.localeCompare(b.node);
  });
}

// ---------------------------------------------------------------------------
// Node projection
// ---------------------------------------------------------------------------

export interface ProjectNodeOptions {
  nodeId: string;
  iteration: number;
  tasks: readonly QueryTask[];
  deliverables: readonly QueryDeliverable[];
  definition: WorkflowDefinition | null;
  /**
   * Gate STATE when this node is a gate. Defaults to `waiting` if the run
   * is currently parked here; otherwise `actioned` is unknown without a
   * decision log — caller may pass the verb when known.
   */
  gateState?: string | null;
  nowMs?: number;
}

/**
 * Build one NodeProjection for a (node, iteration). Pure.
 * One line in the summary regardless of fan-out width.
 */
export function projectNode(opts: ProjectNodeOptions): NodeProjection {
  const defNode = opts.definition
    ? opts.definition.nodes.find((n) => n.id === opts.nodeId)
    : undefined;
  const kind: "step" | "gate" = defNode?.kind === "gate" ? "gate" : "step";
  const tasks = opts.tasks.filter(
    (t) => t.node === opts.nodeId && t.iteration === opts.iteration,
  );
  const deliverables = opts.deliverables.filter(
    (d) => d.node === opts.nodeId && d.iteration === opts.iteration,
  );

  if (kind === "gate") {
    return projectGateNode(opts, defNode as WorkflowGateNode | undefined, tasks, deliverables);
  }
  return projectStepNode(opts, defNode as WorkflowStepNode | undefined, tasks, deliverables);
}

function projectStepNode(
  opts: ProjectNodeOptions,
  step: WorkflowStepNode | undefined,
  tasks: QueryTask[],
  deliverables: QueryDeliverable[],
): NodeProjection {
  const ports: QueryPort[] = step
    ? Object.entries(step.out).map(([name, p]) => ({ name, type: p.type }))
    : [];
  const tallies = tallyEnumPorts(ports, deliverables);
  const counts = countPluralPorts(ports, deliverables);
  const settled = tasks.filter((t) => isSettledState(t.state)).length;
  const total = tasks.length;
  const state = projectStepState(tasks);
  const inFlight = state === "running" || state === "queued" || state === "awaiting_answer";
  const summary =
    total === 1 ? parseTaskSummary(tasks[0]?.report ?? null) : null;
  const gist = assembleGist({
    tallies,
    counts,
    summary,
    tasks_settled: settled,
    tasks_total: total,
    in_flight: inFlight,
  });

  let fanout: NodeFanout | null = null;
  if (total > 1 || (step?.over !== undefined) || (step?.slots !== undefined)) {
    const failed = tasks
      .filter((t) => t.state === "failed" || t.state === "cancelled")
      .map((t) => t.slot ?? t.id);
    fanout = {
      kind: step?.over !== undefined ? "data" : "slots",
      over: step?.over ?? null,
      width: total,
      failed,
    };
  }

  const usage = total > 0 ? sumUsage(tasks) : null;
  const duration_ms = spanDurationMs(tasks, opts.nowMs);

  return {
    node: opts.nodeId,
    kind: "step",
    iteration: opts.iteration,
    state,
    tasks_settled: settled,
    tasks_total: total,
    usage,
    duration_ms,
    fanout,
    tallies,
    counts,
    summary,
    deliverables: deliverables.map((d) => d.id),
    gist,
  };
}

function projectGateNode(
  opts: ProjectNodeOptions,
  gate: WorkflowGateNode | undefined,
  tasks: QueryTask[],
  deliverables: QueryDeliverable[],
): NodeProjection {
  // Gates spawn nothing — TASKS/USAGE are empty. STATE is a real verb when
  // known, else `waiting` / `skipped` / `actioned` (honest unknown).
  const state = opts.gateState ?? "waiting";
  const question = gate?.question ?? null;
  const onReject =
    gate?.on_reject !== undefined ? String(gate.on_reject) : null;

  let gist = "";
  if (question) {
    const q =
      question.length > 48 ? `"${question.slice(0, 47)}…"` : `"${question}"`;
    if (state === "waiting") {
      gist = q;
    } else if (state === "redirected") {
      gist = `${q} -> redirect`;
    } else if (state === "actioned") {
      // No verb known — do not invent one in the gist either.
      gist = q;
    } else {
      gist = `${q} -> ${state}`;
    }
  } else if (state !== "waiting") {
    gist = state;
  }

  const shows: GateShowRef[] = [];
  if (gate) {
    for (const [name, show] of Object.entries(gate.shows)) {
      shows.push({
        name,
        from: show.from,
        deliverable_id: null,
        kind: null,
        type: null,
        size: null,
      });
    }
  }

  return {
    node: opts.nodeId,
    kind: "gate",
    iteration: opts.iteration,
    state,
    tasks_settled: 0,
    tasks_total: 0,
    usage: null,
    duration_ms: spanDurationMs(tasks, opts.nowMs),
    fanout: null,
    tallies: {},
    counts: {},
    summary: null,
    deliverables: deliverables.map((d) => d.id),
    gist,
    question,
    on_reject: onReject,
    // Real verbs only when known; actioned/waiting carry no verb answer.
    answer:
      state === "waiting" || state === "actioned" || state === "skipped"
        ? null
        : state,
    note: null,
    shows,
  };
}

/**
 * Project every (node, iteration) for a run — the summary table.
 * Bound is nodes × iterations, independent of fan-out width.
 */
export function projectRunNodes(opts: {
  tasks: readonly QueryTask[];
  deliverables: readonly QueryDeliverable[];
  definition: WorkflowDefinition | null;
  run: Pick<RunRow, "state" | "current_node" | "iteration" | "error" | "purged_at">;
  nowMs?: number;
}): NodeProjection[] {
  const keys = collectNodeIterations(opts.tasks, opts.deliverables);

  // Current waiting gate may have no tasks/deliverables.
  if (
    opts.run.state === "blocked" &&
    opts.run.current_node &&
    opts.definition
  ) {
    const n = opts.definition.nodes.find((x) => x.id === opts.run.current_node);
    if (n?.kind === "gate") {
      const k = `${opts.run.current_node}\0${opts.run.iteration}`;
      if (!keys.some((x) => `${x.node}\0${x.iteration}` === k)) {
        keys.push({
          node: opts.run.current_node,
          iteration: opts.run.iteration,
        });
      }
    }
  }

  // Stable order: by iteration, then definition order, then name.
  const order = new Map<string, number>();
  if (opts.definition) {
    opts.definition.nodes.forEach((n, i) => order.set(n.id, i));
  }
  keys.sort((a, b) => {
    if (a.iteration !== b.iteration) return a.iteration - b.iteration;
    const oa = order.get(a.node) ?? 9999;
    const ob = order.get(b.node) ?? 9999;
    if (oa !== ob) return oa - ob;
    return a.node.localeCompare(b.node);
  });

  return keys.map((key) => {
    let gateState: string | null = null;
    const defNode = opts.definition?.nodes.find((n) => n.id === key.node);
    if (defNode?.kind === "gate") {
      if (
        opts.run.state === "blocked" &&
        opts.run.current_node === key.node &&
        opts.run.iteration === key.iteration
      ) {
        gateState = "waiting";
      } else if (key.iteration === 0) {
        gateState = "skipped";
      } else {
        // Historical gate without a decision log: we know it was left, not
        // which verb. Never invent approved/rejected/redirected/finished —
        // a fabricated verb would state a false human decision (ADR-0021).
        gateState = "actioned";
      }
    }
    // Inherited steps at iteration 0 (fork marker).
    let proj = projectNode({
      nodeId: key.node,
      iteration: key.iteration,
      tasks: opts.tasks as QueryTask[],
      deliverables: opts.deliverables as QueryDeliverable[],
      definition: opts.definition,
      gateState,
      nowMs: opts.nowMs,
    });
    if (key.iteration === 0 && proj.kind === "step" && proj.tasks_total === 0) {
      proj = {
        ...proj,
        state: "inherited",
        gist: proj.gist || "inherited",
      };
    }
    if (opts.run.purged_at && proj.state !== "waiting") {
      // Purged runs keep gists; STATE reads purged when the run is decayed.
      // Per prototype: "a purged run's node rows read purged in STATE and keep
      // their gists".
      proj = { ...proj, state: "purged" };
    }
    return proj;
  });
}

// ---------------------------------------------------------------------------
// Run envelope
// ---------------------------------------------------------------------------

export interface ProjectRunOptions {
  run: RunRow;
  tasks: readonly QueryTask[];
  definition: WorkflowDefinition | null;
  /** Optional workspace paths when known. */
  branch?: string | null;
  worktree?: string | null;
  seq?: number;
  nowMs?: number;
  /** Child forks of this run (for `completed (fork rN)` list adornment). */
  childRunIds?: string[];
}

/** Build a RunSummary from a run row + its tasks. */
export function projectRunSummary(opts: ProjectRunOptions): RunSummary {
  const { run, tasks } = opts;
  const settled = tasks.filter((t) => isSettledState(t.state)).length;
  const block = buildRunBlock(run, opts.definition);
  const usage = sumUsage(tasks);
  let duration_ms: number | null = null;
  if (run.started_at || run.created_at) {
    const start = Date.parse(run.started_at ?? run.created_at);
    const end =
      run.completed_at !== null
        ? Date.parse(run.completed_at)
        : (opts.nowMs ?? Date.now());
    if (Number.isFinite(start) && Number.isFinite(end)) {
      duration_ms = Math.max(0, end - start);
    }
  }

  // When the run itself is purged, surface that in state for list rendering.
  const state: string = run.purged_at ? "purged" : run.state;

  return {
    run_id: run.id,
    workflow: run.workflow,
    workflow_version: run.version,
    orchestrator_session_id: run.orchestrator_session_id,
    state,
    block: run.state === "blocked" ? block : null,
    current_node: run.current_node,
    iteration: run.iteration,
    parent_run_id: run.parent_run_id,
    attempt: run.attempt,
    tasks_settled: settled,
    tasks_total: tasks.length,
    usage,
    duration_ms,
    branch: opts.branch ?? null,
    worktree: opts.worktree ?? null,
    created_at: run.created_at,
    updated_at: run.updated_at,
    completed_at: run.completed_at,
    purged_at: run.purged_at,
    seq: opts.seq,
    workspace: run.workspace,
    type: run.type,
    repo: run.repo,
    error: run.error,
  };
}

/** List STATE cell including block parenthetical / fork adornment. */
export function formatRunListState(
  envelope: RunSummary,
  childRunIds: string[] = [],
): string {
  if (envelope.state === "purged") return "purged";
  if (envelope.state === "blocked" && envelope.block) {
    return `blocked (${formatBlockParenthetical(envelope.block)})`;
  }
  if (envelope.state === "completed" && childRunIds.length > 0) {
    return `completed (fork ${childRunIds[0]})`;
  }
  return envelope.state;
}

// ---------------------------------------------------------------------------
// Deliverable resolution
// ---------------------------------------------------------------------------

/** Parse a stored inline value; null when purged or unparsable. */
export function parseDeliverableInlineValue(
  d: QueryDeliverable,
): unknown {
  if (d.purged_at !== null || d.value === null) return null;
  if (d.kind !== "inline") return null;
  return parseJson(d.value);
}

/** Compute a size description for display / wire. */
export function deliverableSizeOf(
  d: QueryDeliverable,
  portType: PortType | null = null,
): DeliverableSize | null {
  if (d.purged_at !== null || d.value === null) return null;
  if (d.kind === "file" || d.kind === "dir") {
    return { bytes: Buffer.byteLength(d.value, "utf8") };
  }
  const v = parseJson(d.value);
  if (v === null) return null;
  if (Array.isArray(v)) return { elements: v.length, bytes: Buffer.byteLength(d.value, "utf8") };
  if (typeof v === "object") {
    return {
      keys: Object.keys(v as object).length,
      bytes: Buffer.byteLength(d.value, "utf8"),
    };
  }
  if (typeof v === "string") {
    // Enum-typed: size is the value itself for gate shows.
    if (portType?.kind === "enum") return null;
    return { bytes: Buffer.byteLength(v, "utf8") };
  }
  return { bytes: Buffer.byteLength(d.value, "utf8") };
}

/** Build a DeliverableRef (no value). */
export function toDeliverableRef(
  d: QueryDeliverable,
  portType: PortType | null = null,
): DeliverableRef {
  return {
    deliverable_id: d.id,
    run_id: d.run_id,
    node: d.node,
    port: d.port,
    iteration: d.iteration,
    slot: d.slot,
    task_id: d.task_id,
    kind: d.kind,
    type: portType ? formatPortType(portType) : null,
    size: deliverableSizeOf(d, portType),
    created_at: d.created_at,
    purged_at: d.purged_at,
  };
}

export interface ResolveDeliverableOptions {
  deliverable: QueryDeliverable;
  portType?: PortType | null;
  /** Workspace root for resolving file/dir paths. */
  workspaceRoot?: string | null;
  /** Override clock for tests. */
  nowMs?: number;
}

/**
 * Resolve one deliverable for `parley run get`.
 * Renders purged and missing-path as legible decayed states — not errors that
 * look like bugs (ADR-0021 / #241 clause 7).
 */
export function resolveDeliverableValue(
  opts: ResolveDeliverableOptions,
): DeliverableValue {
  const d = opts.deliverable;
  const portType = opts.portType ?? null;
  const base = toDeliverableRef(d, portType);

  // Purged: address survives, value is gone.
  if (d.purged_at !== null || (d.value === null && d.kind === "inline")) {
    return {
      ...base,
      value: null,
      path: null,
      absolute_path: null,
      exists: null,
      note: d.purged_at
        ? `purged on ${d.purged_at.slice(0, 10)} (run ${d.run_id}, ${formatDeliverableAddress(d)})`
        : `value missing (run ${d.run_id}, ${formatDeliverableAddress(d)})`,
    };
  }

  if (d.kind === "file" || d.kind === "dir") {
    const stored = d.value ?? "";
    const abs = resolvePath(stored, opts.workspaceRoot ?? null);
    let exists: boolean | null = null;
    if (abs !== null) {
      try {
        const st = fs.statSync(abs);
        exists = d.kind === "dir" ? st.isDirectory() : st.isFile();
      } catch {
        exists = false;
      }
    } else {
      exists = false;
    }
    return {
      ...base,
      value: null,
      path: stored,
      absolute_path: abs,
      exists,
      note:
        exists === false
          ? "worktree removed; file deliverables do not outlive their workspace"
          : null,
      size: exists && abs ? fileSize(abs) : null,
    };
  }

  // inline
  return {
    ...base,
    value: parseJson(d.value),
    path: null,
    absolute_path: null,
    exists: null,
    note: null,
  };
}

function fileSize(abs: string): DeliverableSize | null {
  try {
    const st = fs.statSync(abs);
    return { bytes: st.size };
  } catch {
    return null;
  }
}

function resolvePath(stored: string, workspaceRoot: string | null): string | null {
  if (stored === "") return null;
  if (path.isAbsolute(stored)) return stored;
  if (workspaceRoot) return path.resolve(workspaceRoot, stored);
  return path.resolve(stored);
}

/** Human address fragment: `node.iteration[slot].port` */
export function formatDeliverableAddress(d: {
  node: string;
  port: string;
  iteration: number;
  slot: string | null;
}): string {
  const slot = d.slot ? `[${d.slot}]` : "";
  return `${d.node}.${d.iteration}${slot}/${d.port}`;
}

/**
 * Collect a fan-out port into the container the next node consumes.
 * Array fan-out → T[]; slot/dict fan-out → dict<string, T>.
 * Has no deliverable row of its own — only an address can name it.
 */
export function collectFanOutDeliverable(opts: {
  runId: string;
  node: string;
  port: string;
  iteration: number;
  siblings: readonly QueryDeliverable[];
  portType: PortType;
  fanOut: "array" | "dict";
  workspaceRoot?: string | null;
}): DeliverableValue {
  const { siblings, portType, fanOut } = opts;
  const collectedType = applyFanOutCollection(portType, fanOut);

  if (fanOut === "array") {
    const values: unknown[] = [];
    for (const d of siblings) {
      if (d.port !== opts.port) continue;
      if (d.purged_at || d.value === null) continue;
      if (d.kind === "inline") {
        values.push(parseJson(d.value));
      } else {
        values.push(d.value);
      }
    }
    return {
      deliverable_id: `${opts.runId}/${opts.node}/${opts.port}/${opts.iteration}`,
      run_id: opts.runId,
      node: opts.node,
      port: opts.port,
      iteration: opts.iteration,
      slot: null,
      task_id: "",
      kind: "inline",
      type: formatPortType(collectedType),
      size: { elements: values.length },
      created_at: siblings[0]?.created_at ?? new Date().toISOString(),
      purged_at: null,
      value: values,
      path: null,
      absolute_path: null,
      exists: null,
      note: null,
      collected: true,
    };
  }

  // dict
  const dict: Record<string, unknown> = {};
  for (const d of siblings) {
    if (d.port !== opts.port) continue;
    if (d.purged_at || d.value === null) continue;
    const key = d.slot ?? d.id;
    dict[key] = d.kind === "inline" ? parseJson(d.value) : d.value;
  }
  return {
    deliverable_id: `${opts.runId}/${opts.node}/${opts.port}/${opts.iteration}`,
    run_id: opts.runId,
    node: opts.node,
    port: opts.port,
    iteration: opts.iteration,
    slot: null,
    task_id: "",
    kind: "inline",
    type: formatPortType(collectedType),
    size: { keys: Object.keys(dict).length },
    created_at: siblings[0]?.created_at ?? new Date().toISOString(),
    purged_at: null,
    value: dict,
    path: null,
    absolute_path: null,
    exists: null,
    note: null,
    collected: true,
  };
}

// ---------------------------------------------------------------------------
// Address parsing for `parley run get`
// ---------------------------------------------------------------------------

export interface ParsedDeliverableAddress {
  runId: string | null;
  node: string;
  port: string;
  iteration: number | null;
  slot: string | null;
}

/**
 * Parse a deliverable address.
 *
 * Accepted forms:
 * - `node/port/iteration[/slot]`  (CONTEXT.md grammar)
 * - `node.port` or `node.port.iteration` or `node.port.iteration.slot`
 * - `runId/node/port[/iteration[/slot]]` when first segment looks like a run id
 * - `runId node.port…` is handled by the CLI via two positionals
 */
export function parseDeliverableAddress(raw: string): ParsedDeliverableAddress | null {
  const s = raw.trim();
  if (s === "") return null;

  // Slash form: [runId/]node/port[/iteration[/slot]]
  if (s.includes("/")) {
    const parts = s.split("/").filter((p) => p !== "");
    if (parts.length < 2) return null;
    let i = 0;
    let runId: string | null = null;
    // Run ids are `r` + digits (nextRunId).
    if (/^r\d+$/.test(parts[0]!)) {
      runId = parts[0]!;
      i = 1;
    }
    if (parts.length - i < 2) return null;
    const node = parts[i]!;
    const port = parts[i + 1]!;
    let iteration: number | null = null;
    let slot: string | null = null;
    if (parts.length - i >= 3) {
      const iterRaw = parts[i + 2]!;
      if (!/^\d+$/.test(iterRaw)) return null;
      iteration = Number(iterRaw);
    }
    if (parts.length - i >= 4) {
      slot = parts[i + 3]!;
    }
    return { runId, node, port, iteration, slot };
  }

  // Dot form: node.port[.iteration[.slot]]
  const dots = s.split(".");
  if (dots.length < 2) return null;
  const node = dots[0]!;
  const port = dots[1]!;
  let iteration: number | null = null;
  let slot: string | null = null;
  if (dots.length >= 3 && /^\d+$/.test(dots[2]!)) {
    iteration = Number(dots[2]);
    if (dots.length >= 4) slot = dots.slice(3).join(".");
  } else if (dots.length >= 3) {
    // node.port.slot (no iteration)
    slot = dots.slice(2).join(".");
  }
  return { runId: null, node, port, iteration, slot };
}

/** True when `ref` looks like an opaque deliverable id (`d1`, `d104`, …). */
export function looksLikeDeliverableId(ref: string): boolean {
  return /^d\d+$/.test(ref);
}

// ---------------------------------------------------------------------------
// Node detail
// ---------------------------------------------------------------------------

export function projectNodeDetail(opts: {
  runId: string;
  nodeId: string;
  iteration: number;
  tasks: readonly QueryTask[];
  deliverables: readonly QueryDeliverable[];
  definition: WorkflowDefinition | null;
  gateState?: string | null;
  slotFilter?: string | null;
  nowMs?: number;
}): NodeDetailResponse {
  let tasks = opts.tasks.filter(
    (t) => t.node === opts.nodeId && t.iteration === opts.iteration,
  );
  let deliverables = opts.deliverables.filter(
    (d) => d.node === opts.nodeId && d.iteration === opts.iteration,
  );
  if (opts.slotFilter !== undefined && opts.slotFilter !== null) {
    tasks = tasks.filter((t) => t.slot === opts.slotFilter);
    deliverables = deliverables.filter((d) => d.slot === opts.slotFilter);
  }

  const node = projectNode({
    nodeId: opts.nodeId,
    iteration: opts.iteration,
    tasks,
    deliverables,
    definition: opts.definition,
    gateState: opts.gateState,
    nowMs: opts.nowMs,
  });

  const step = opts.definition?.nodes.find((n) => n.id === opts.nodeId);
  const ports = new Map<string, PortType>();
  if (step?.kind === "step") {
    for (const [name, p] of Object.entries(step.out)) ports.set(name, p.type);
  }

  const taskRows: NodeTaskRow[] = tasks.map((t) => {
    const usage = parseTaskUsage(t.usage);
    const summary = parseTaskSummary(t.report);
    const duration_ms = spanDurationMs([t], opts.nowMs);
    // At this resolution one task per row — gist rule 3 applies to every line.
    const taskDels = deliverables.filter((d) => d.task_id === t.id);
    const tallies =
      step?.kind === "step"
        ? tallyEnumPorts(
            Object.entries(step.out).map(([name, p]) => ({ name, type: p.type })),
            taskDels,
          )
        : {};
    const counts =
      step?.kind === "step"
        ? countPluralPorts(
            Object.entries(step.out).map(([name, p]) => ({ name, type: p.type })),
            taskDels,
          )
        : {};
    const gist = assembleGist({
      tallies,
      counts,
      summary,
      tasks_settled: isSettledState(t.state) ? 1 : 0,
      tasks_total: 1,
    });
    return {
      slot: t.slot,
      task_id: t.id,
      state: t.state,
      usage,
      duration_ms,
      summary,
      gist: gist || summary || "-",
    };
  });

  const delRefs = deliverables.map((d) =>
    toDeliverableRef(d, ports.get(d.port) ?? null),
  );

  return {
    run_id: opts.runId,
    node,
    tasks: taskRows,
    deliverables: delRefs,
  };
}

export function projectRunDetail(opts: {
  run: RunRow;
  tasks: readonly QueryTask[];
  deliverables: readonly QueryDeliverable[];
  definition: WorkflowDefinition | null;
  branch?: string | null;
  worktree?: string | null;
  seq?: number;
  nowMs?: number;
}): RunDetailResponse {
  const runEnv = projectRunSummary({
    run: opts.run,
    tasks: opts.tasks,
    definition: opts.definition,
    branch: opts.branch,
    worktree: opts.worktree,
    seq: opts.seq,
    nowMs: opts.nowMs,
  });
  const nodes = projectRunNodes({
    tasks: opts.tasks,
    deliverables: opts.deliverables,
    definition: opts.definition,
    run: opts.run,
    nowMs: opts.nowMs,
  });
  return {
    run: runEnv,
    nodes,
    block: runEnv.block,
  };
}

// ---------------------------------------------------------------------------
// Text rendering (CLI) — pure string assembly
// ---------------------------------------------------------------------------

function pad(cells: string[], widths: number[]): string {
  return cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join("  ").trimEnd();
}

function widthsOf(header: string[], rows: string[][]): number[] {
  return header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
}

/** Compact token counts: `412.8k in/38.1k out`. */
export function formatUsageText(usage: RunUsage | null | undefined): string {
  if (!usage) return "-";
  return `${formatTokenCount(usage.input_tokens)} in/${formatTokenCount(usage.output_tokens)} out`;
}

function formatTokenCount(n: number): string {
  const k = Math.round((n / 1000) * 10) / 10;
  return `${k}k`;
}

/** `22m41s` or `4m12s...` while live. */
export function formatDurationText(
  durationMs: number | null | undefined,
  live = false,
): string {
  if (durationMs === null || durationMs === undefined) return "-";
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const formatted = `${minutes}m${String(seconds).padStart(2, "0")}s`;
  return live ? `${formatted}...` : formatted;
}

function shortSession(id: string | null): string {
  if (!id) return "-";
  return id.length > 8 ? id.slice(0, 8) : id;
}

/** Render the run list table (01-run-list.txt). */
export function renderRunList(
  runs: readonly RunSummary[],
  childMap: ReadonlyMap<string, string[]> = new Map(),
): string {
  if (runs.length === 0) return "No runs.\n";
  const header = [
    "ID",
    "SESSION",
    "WORKFLOW",
    "STATE",
    "NODE",
    "ITER",
    "TASKS",
    "USAGE",
    "DURATION",
  ];
  const rows = runs.map((r) => {
    const live = r.completed_at === null && r.state !== "purged";
    return [
      r.run_id,
      shortSession(r.orchestrator_session_id),
      r.workflow,
      formatRunListState(r, childMap.get(r.run_id) ?? []),
      r.current_node ?? "-",
      String(r.iteration),
      `${r.tasks_settled}/${r.tasks_total}`,
      formatUsageText(r.usage),
      formatDurationText(r.duration_ms, live && r.state === "running"),
    ];
  });
  const widths = widthsOf(header, rows);
  const lines = [pad(header, widths), ...rows.map((r) => pad(r, widths))];
  return `${lines.join("\n")}\n`;
}

/** Render the run summary node table (02-run-summary.txt). */
export function renderRunSummary(detail: RunDetailResponse): string {
  const r = detail.run;
  const live = r.completed_at === null && r.state !== "purged" && r.state !== "completed";
  const stateLabel =
    r.state === "blocked" && r.block
      ? `blocked (${formatBlockParenthetical(r.block)})`
      : r.state;
  const lines: string[] = [];
  lines.push(
    `RUN ${r.run_id}  ${r.workflow}@${r.workflow_version}  ${stateLabel}  iteration ${r.iteration}  ${formatDurationText(r.duration_ms, live && r.state === "running")}  ${formatUsageText(r.usage)}`,
  );
  if (r.branch) lines.push(`branch  ${r.branch}`);
  if (r.parent_run_id) lines.push(`forked  from ${r.parent_run_id}, attempt ${r.attempt}`);
  lines.push("");

  const header = ["NODE", "ITER", "STATE", "TASKS", "USAGE", "DURATION", "GIST"];
  const rows = detail.nodes.map((n) => {
    const isGate = n.kind === "gate";
    const nodeLive =
      n.state === "running" || n.state === "waiting" || n.state === "queued";
    let tasksCell = "-";
    if (!isGate) {
      if (n.tasks_total === 0) tasksCell = "0";
      else if (n.tasks_settled === n.tasks_total) tasksCell = String(n.tasks_total);
      else tasksCell = `${n.tasks_settled}/${n.tasks_total}`;
    }
    return [
      n.node,
      String(n.iteration),
      n.state,
      tasksCell,
      isGate ? "-" : formatUsageText(n.usage),
      formatDurationText(n.duration_ms, nodeLive),
      n.gist || "-",
    ];
  });

  const widths = widthsOf(header, rows);
  lines.push(pad(header, widths));
  for (const row of rows) lines.push(pad(row, widths));

  if (detail.block) {
    lines.push("");
    const b = detail.block;
    const detailText = b.detail ?? b.reason;
    lines.push(`blocked  ${detailText}`);
    if (b.verbs.length > 0) {
      lines.push(
        `verbs    ${b.verbs.map((v) => `parley run ${v} ${r.run_id}`).join(" · ")}`,
      );
    }
  }

  // Zoom hint: last non-completed node or last node.
  const zoomTarget =
    [...detail.nodes].reverse().find((n) => n.state === "running" || n.state === "waiting") ??
    detail.nodes[detail.nodes.length - 1];
  if (zoomTarget) {
    lines.push(
      `zoom     parley run status ${r.run_id} --node ${zoomTarget.node} --iteration ${zoomTarget.iteration}`,
    );
  }

  return `${lines.join("\n")}\n`;
}

/** Render node-detail zoom (04-node-detail.txt). */
export function renderNodeDetail(detail: NodeDetailResponse): string {
  const n = detail.node;
  const lines: string[] = [];
  lines.push(
    `NODE ${n.node}  (${n.kind})  run ${detail.run_id}  iteration ${n.iteration}  ${n.state}  ${n.tasks_total} tasks  ${formatUsageText(n.usage)}  ${formatDurationText(n.duration_ms, n.state === "running")}`,
  );
  if (n.fanout) {
    const over = n.fanout.over ? `, over \`${n.fanout.over}\`` : "";
    const success = n.fanout.success ? ` (${n.fanout.success})` : "";
    lines.push(
      `fan-out  ${n.fanout.kind}, ${n.fanout.width} wide${over}${success}`,
    );
  }
  if (n.kind === "gate") {
    if (n.question) lines.push(`question  ${n.question}`);
    if (n.on_reject) lines.push(`on_reject ${n.on_reject}`);
    if (n.answer) lines.push(`answered  ${n.answer}`);
  }
  lines.push("");

  if (n.kind === "step" && detail.tasks.length > 0) {
    const header = ["SLOT", "TASK", "STATE", "USAGE", "DURATION", "GIST"];
    const rows = detail.tasks.map((t) => [
      t.slot ?? "-",
      t.task_id,
      t.state,
      formatUsageText(t.usage),
      formatDurationText(t.duration_ms, t.state === "running"),
      t.gist || "-",
    ]);
    const widths = widthsOf(header, rows);
    lines.push(pad(header, widths));
    for (const row of rows) lines.push(pad(row, widths));
    lines.push("");
  }

  if (detail.deliverables.length > 0) {
    const header = ["DELIVERABLE", "PORT", "SLOT", "KIND", "TYPE", "SIZE"];
    const rows = detail.deliverables.map((d) => [
      d.deliverable_id,
      d.port,
      d.slot ?? "-",
      d.kind,
      d.type ?? "-",
      formatSizeCell(d),
    ]);
    const widths = widthsOf(header, rows);
    lines.push(pad(header, widths));
    for (const row of rows) lines.push(pad(row, widths));
  }

  if (detail.deliverables[0]) {
    lines.push("");
    lines.push(`read   parley run get ${detail.deliverables[0].deliverable_id}`);
  }
  if (detail.tasks[0]) {
    lines.push(`tasks  parley status ${detail.tasks[0].task_id}`);
  }

  return `${lines.join("\n")}\n`;
}

function formatSizeCell(d: DeliverableRef): string {
  if (d.purged_at) return "purged";
  if (!d.size) return "-";
  if (d.size.elements !== undefined) return `${d.size.elements} el`;
  if (d.size.keys !== undefined) return `${d.size.keys} keys`;
  if (d.size.bytes !== undefined) {
    if (d.size.bytes < 1024) return `${d.size.bytes} B`;
    return `${(d.size.bytes / 1024).toFixed(1)} kB`;
  }
  return "-";
}

/**
 * `parley run get` exit when the address resolves but retention purged the
 * value (`value = NULL`, `purged_at` set). Distinct from 2 usage, 3–6 watch
 * tiers, and 7–8 fix errors — scripts can branch on decay without treating
 * it as a missing id (404 → usage) or a generic failure.
 */
export const EXIT_DELIVERABLE_PURGED = 9;

/**
 * Bare-mode stdout for `parley run get` (no envelope).
 * Purged / missing file → legible decayed message on stderr path via note.
 */
export function renderDeliverableBare(v: DeliverableValue): {
  stdout: string;
  stderr: string | null;
  exitCode: number;
} {
  if (v.purged_at || (v.value === null && v.kind === "inline" && !v.collected)) {
    return {
      stdout: "",
      stderr: `error: deliverable ${v.deliverable_id} was purged${v.purged_at ? ` on ${v.purged_at.slice(0, 10)}` : ""} (run ${v.run_id}, ${v.node}.${v.iteration}${v.slot ? `[${v.slot}]` : ""}/${v.port})\n`,
      exitCode: EXIT_DELIVERABLE_PURGED,
    };
  }
  if (v.kind === "file" || v.kind === "dir") {
    const p = v.absolute_path ?? v.path ?? "";
    if (v.exists === false) {
      // Still print the path (honest location) — note explains decay.
      return {
        stdout: `${p}\n`,
        stderr: v.note ? `note: ${v.note}\n` : null,
        exitCode: 0,
      };
    }
    return { stdout: `${p}\n`, stderr: null, exitCode: 0 };
  }
  // inline / collected
  return {
    stdout: `${JSON.stringify(v.value, null, 2)}\n`,
    stderr: null,
    exitCode: 0,
  };
}

// ---------------------------------------------------------------------------
// Row adapters (TaskRow / DeliverableRow → query shapes)
// ---------------------------------------------------------------------------

export function taskRowToQuery(t: TaskRow): QueryTask {
  return {
    id: t.id,
    state: t.state,
    slot: t.slot ?? null,
    node: t.node ?? null,
    iteration: t.iteration ?? null,
    usage: t.usage,
    report: t.report,
    started_at: t.started_at,
    completed_at: t.completed_at,
    created_at: t.created_at,
    error: t.error,
  };
}

export function deliverableRowToQuery(d: DeliverableRow): QueryDeliverable {
  return {
    id: d.id,
    run_id: d.run_id,
    node: d.node,
    port: d.port,
    iteration: d.iteration,
    slot: d.slot,
    // #244 may leave task_id null after the producing task is gc'd.
    task_id: d.task_id ?? null,
    kind: d.kind,
    value: d.value,
    created_at: d.created_at,
    purged_at: d.purged_at,
  };
}

/** Look up a node in a definition. */
export function findWorkflowNode(
  definition: WorkflowDefinition | null,
  id: string,
): WorkflowNode | undefined {
  return definition?.nodes.find((n) => n.id === id);
}
