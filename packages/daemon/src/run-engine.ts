/**
 * Run engine advance (ADR-0017 / #237 + #238): pure decision + port fill
 * rules + success policy / retries / gate-verb application.
 *
 * Advance order: *settled? → ports filled? → loop? → next node.*
 *
 * Drained off the existing `onSlotFreed` hook (terminal-or-stalled). Does not
 * touch `transition.ts` / ADR-0004. A run never auto-fails from ordinary
 * advance — work that goes wrong lands on `blocked`.
 */

import {
  isSettledState,
  parseFromRef,
  stepFanOutContainer,
  type WorkflowDefinition,
  type WorkflowGateNode,
  type WorkflowLoop,
  type WorkflowNode,
  type WorkflowStepNode,
} from "@useparley/core";
import {
  getRun,
  listDeliverablesForRun,
  listRuns,
  listTasksForRunNode,
  updateRun,
  type DatabaseHandle,
  type DeliverableRow,
  type RunRow,
  type RunState,
  type TaskRow,
} from "./db.js";
import {
  actionGateVerb,
  type GateVerb,
  type GateVerbDecision,
  type GateVerbRequest,
} from "./run-gates.js";
import {
  evaluateSuccessPolicy,
  planRetries,
  type PolicyTask,
  type RetryPlan,
  type SuccessPolicyResult,
} from "./run-success.js";

// ---------------------------------------------------------------------------
// Advance decision (pure)
// ---------------------------------------------------------------------------

/** Why the run cannot advance further without the orchestrator. */
export type AdvanceBlockReason =
  | "gate"
  | "loop_budget"
  | "success_policy"
  | "spawn"
  | "unfilled_inputs";

/**
 * Pure outcome of one advance evaluation for a run at its current cursor.
 *
 * Spawning tasks is the host's job: `enter` names the step + iteration to
 * open, with any `loop.with` fills already resolved. #238/#239 own how the
 * engine turns that into `delegate()` work.
 */
export type AdvanceDecision =
  /** Current step still has unsettled tasks — stay `running`. */
  | { kind: "wait" }
  /** Nothing to do (terminal run, missing definition node, empty cursor, …). */
  | { kind: "noop"; reason: string }
  /**
   * Settled step left required output holes (failed/stalled/cancelled siblings).
   * Impure drain routes this through success policy / retries
   * ({@link resolveUnfilledOutputs}) — pure advance only detects the hole.
   */
  | { kind: "unfilled_outputs"; node: string; iteration: number; missing: string[] }
  /**
   * Destination step has a `from`-wired input that cannot be resolved.
   * `from`-less ports are exempt (loop-filled by construction; ADR-0017 / #226).
   */
  | { kind: "unfilled_inputs"; node: string; iteration: number; missing: string[] }
  /** Run cursor should open this step (linear next or loop target). */
  | {
      kind: "enter";
      node: string;
      iteration: number;
      /** Resolved `loop.with` payload (port name → value); empty on linear next. */
      loopFills: Record<string, unknown>;
    }
  /**
   * Next node is a gate, or loop budget exhausted — block; verbs are #238.
   * For `loop_budget`, `loopMax` is the author-declared bound.
   */
  | {
      kind: "block";
      reason: AdvanceBlockReason;
      node: string;
      iteration: number;
      loopMax?: number;
    }
  /** No nodes remain after the current one. */
  | { kind: "complete" };

/** One task projection used by pure advance (no full TaskRow required). */
export interface AdvanceTask {
  id: string;
  state: string;
  slot: string | null;
}

/**
 * Port value index for pure evaluation. Keys are structural:
 * - run inputs: `run.<name>`
 * - node outputs: `<node>.<port>` at a specific iteration (see
 *   {@link AdvanceContext.outputAt})
 */
export interface AdvanceContext {
  run: {
    id: string;
    state: RunState;
    current_node: string | null;
    iteration: number;
  };
  definition: WorkflowDefinition;
  /** Tasks for `(current_node, run.iteration)`. Empty when none spawned yet. */
  currentTasks: readonly AdvanceTask[];
  /**
   * Run-level inputs filled at start (`run.<name>`). Persistence of these is
   * run-start's job (#239); advance only reads what the host provides.
   */
  runInputs: Readonly<Record<string, unknown>>;
  /**
   * Look up a node's output port value at a specific iteration.
   * Return `undefined` when nothing was produced (missing / purged / not completed).
   * For fan-out, return the *collected* container (dict by slot or array by index).
   */
  outputAt: (nodeId: string, port: string, iteration: number) => unknown | undefined;
  /**
   * Completed iterations of a node that produced `port`, ascending.
   * Used by accumulator ports. Empty when the node never completed that port.
   */
  completedIterations: (nodeId: string, port: string) => readonly number[];
}

/**
 * Pure advance (ADR-0017). No I/O. Caller builds {@link AdvanceContext} from
 * the DB (see {@link buildAdvanceContext}).
 *
 * Order: settled? → ports filled? → loop? → next node.
 */
export function advance(ctx: AdvanceContext): AdvanceDecision {
  if (ctx.run.state !== "running") {
    return { kind: "noop", reason: `run state is ${ctx.run.state}` };
  }
  const currentId = ctx.run.current_node;
  if (currentId === null || currentId === "") {
    return { kind: "noop", reason: "no current_node" };
  }

  const node = findNode(ctx.definition, currentId);
  if (node === undefined) {
    return { kind: "noop", reason: `unknown current_node "${currentId}"` };
  }

  // A gate is entered by advancing *to* it (block). While current is a gate
  // the run should already be blocked; if we are still "running" at a gate,
  // re-assert the block (restart / race safety).
  if (node.kind === "gate") {
    return {
      kind: "block",
      reason: "gate",
      node: node.id,
      iteration: ctx.run.iteration,
    };
  }

  // --- settled? -----------------------------------------------------------
  if (ctx.currentTasks.length === 0) {
    // Nothing spawned yet for this cursor — not our job to start node 1
    // (run-start / #239). Stay put.
    return { kind: "wait" };
  }
  if (!isStepSettled(ctx.currentTasks)) {
    return { kind: "wait" };
  }

  // --- ports filled? (outputs of the settled step) ------------------------
  // Validation lives in submit_report (#236): a `completed` task implies its
  // ports are filled. Non-completed settled siblings leave holes; #238 owns
  // success policy / escalation. We only detect the hole.
  const missingOut = missingOutputPorts(node, ctx);
  if (missingOut.length > 0) {
    return {
      kind: "unfilled_outputs",
      node: node.id,
      iteration: ctx.run.iteration,
      missing: missingOut,
    };
  }

  // --- loop? --------------------------------------------------------------
  if (node.loop !== undefined) {
    const loopDecision = evaluateLoop(node, node.loop, ctx);
    if (loopDecision !== null) return loopDecision;
  }

  // --- next node ----------------------------------------------------------
  return advanceToNext(ctx, node.id, ctx.run.iteration, {});
}

/**
 * True when every task of the step is settled (`isSettledState`, so `stalled`
 * counts). An unanswered-question death must not hang the run forever.
 */
export function isStepSettled(tasks: readonly AdvanceTask[]): boolean {
  if (tasks.length === 0) return false;
  return tasks.every((t) => isSettledState(t.state));
}

// ---------------------------------------------------------------------------
// Loop evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluate a step's loop edge. Returns a decision when the loop *fires*
 * (enter target or block on budget), or `null` when the loop does not take
 * (while false / absent → fall through to next node).
 *
 * Gate loops are not evaluated here: on a gate the orchestrator's answer is
 * the condition (#238 verbs).
 */
function evaluateLoop(
  node: WorkflowStepNode,
  loop: WorkflowLoop,
  ctx: AdvanceContext,
): AdvanceDecision | null {
  if (!loopWhileSatisfied(node, loop, ctx)) {
    return null;
  }

  // while true at this iteration
  if (ctx.run.iteration >= loop.max) {
    // Loop-budget exhaustion is an implicit gate — neither silent proceed nor
    // failure (ADR-0017).
    return {
      kind: "block",
      reason: "loop_budget",
      node: node.id,
      iteration: ctx.run.iteration,
      loopMax: loop.max,
    };
  }

  const nextIteration = ctx.run.iteration + 1;
  const loopFills = resolveLoopWith(loop, ctx);
  return enterOrBlockTarget(ctx, loop.to, nextIteration, loopFills);
}

/**
 * `while` tests a named enum output port on a step. Absent `while` means the
 * loop always wants to take (gate-style edge hanging off a step is rare; still
 * bounded by max).
 */
export function loopWhileSatisfied(
  node: WorkflowStepNode,
  loop: WorkflowLoop,
  ctx: AdvanceContext,
): boolean {
  if (loop.while === undefined) return true;
  const value = ctx.outputAt(node.id, loop.while.port, ctx.run.iteration);
  if (value === undefined) return false;
  // Enum ports are strings; fan-out collection would be a container — while
  // is authored on single-task decision steps (triage / adversarial-review).
  return value === loop.while.is;
}

function resolveLoopWith(
  loop: WorkflowLoop,
  ctx: AdvanceContext,
): Record<string, unknown> {
  const fills: Record<string, unknown> = {};
  if (loop.with === undefined) return fills;
  for (const [port, from] of Object.entries(loop.with)) {
    const value = resolveFromRefValue(from, ctx, /*accumulate*/ false);
    if (value !== undefined) fills[port] = value;
  }
  return fills;
}

// ---------------------------------------------------------------------------
// Next node / enter
// ---------------------------------------------------------------------------

function advanceToNext(
  ctx: AdvanceContext,
  afterNodeId: string,
  iteration: number,
  loopFills: Record<string, unknown>,
): AdvanceDecision {
  const next = nextNode(ctx.definition, afterNodeId);
  if (next === undefined) {
    return { kind: "complete" };
  }
  return enterOrBlockTarget(ctx, next.id, iteration, loopFills);
}

function enterOrBlockTarget(
  ctx: AdvanceContext,
  targetId: string,
  iteration: number,
  loopFills: Record<string, unknown>,
): AdvanceDecision {
  const target = findNode(ctx.definition, targetId);
  if (target === undefined) {
    return { kind: "noop", reason: `unknown target node "${targetId}"` };
  }
  if (target.kind === "gate") {
    return {
      kind: "block",
      reason: "gate",
      node: target.id,
      iteration,
    };
  }

  // ports filled? for the destination's *input* ports — from-less exempt.
  const missing = missingInputPorts(target, ctx, iteration, loopFills);
  if (missing.length > 0) {
    return {
      kind: "unfilled_inputs",
      node: target.id,
      iteration,
      missing,
    };
  }

  return {
    kind: "enter",
    node: target.id,
    iteration,
    loopFills,
  };
}

/**
 * Input ports that still have no value for a prospective enter.
 * A **`from`-less port is exempt**: loop-filled by construction; gating on it
 * deadlocks any workflow whose first node takes a loop payload (`scope.gaps`).
 * Ports listed in `loopFills` count as filled.
 */
export function missingInputPorts(
  step: WorkflowStepNode,
  ctx: AdvanceContext,
  _iteration: number,
  loopFills: Readonly<Record<string, unknown>> = {},
): string[] {
  const missing: string[] = [];
  for (const [name, port] of Object.entries(step.in)) {
    if (port.from === undefined) continue; // from-less exempt
    if (Object.prototype.hasOwnProperty.call(loopFills, name)) continue;
    const value = resolveInputPortValue(port.from, port.accumulate === true, ctx);
    if (value === undefined) missing.push(name);
  }
  return missing;
}

function missingOutputPorts(
  step: WorkflowStepNode,
  ctx: AdvanceContext,
): string[] {
  // Only require outputs when every task completed. Mixed settled states are
  // reported as missing so #238 can apply success policy.
  const allCompleted = ctx.currentTasks.every((t) => t.state === "completed");
  if (!allCompleted) {
    // Treat as a hole on every declared output — the policy layer decides.
    return Object.keys(step.out);
  }
  const missing: string[] = [];
  for (const portName of Object.keys(step.out)) {
    const v = ctx.outputAt(step.id, portName, ctx.run.iteration);
    if (v === undefined) missing.push(portName);
  }
  return missing;
}

// ---------------------------------------------------------------------------
// Port fill — most-recent vs accumulate
// ---------------------------------------------------------------------------

/**
 * Resolve an input port's filled value from a `from` ref.
 *
 * - `run.<input>` → runInputs
 * - `<node>.<port>` → most recent completed iteration, unless `accumulate`
 * - accumulate (containers only at lint time): merge all completed iterations;
 *   dict key collisions → later iteration wins; arrays concatenate in
 *   iteration order
 */
export function resolveInputPortValue(
  from: string,
  accumulate: boolean,
  ctx: AdvanceContext,
): unknown | undefined {
  return resolveFromRefValue(from, ctx, accumulate);
}

function resolveFromRefValue(
  from: string,
  ctx: AdvanceContext,
  accumulate: boolean,
): unknown | undefined {
  const parsed = parseFromRef(from);
  if (parsed === null) return undefined;
  const { left, right } = parsed;
  if (left === "run") {
    if (!Object.prototype.hasOwnProperty.call(ctx.runInputs, right)) {
      return undefined;
    }
    return ctx.runInputs[right];
  }
  if (accumulate) {
    return accumulatePort(left, right, ctx);
  }
  return mostRecentOutput(left, right, ctx);
}

/**
 * Backwards reach without accumulate: a node's **most recent completed**
 * iteration. Nothing sees further back.
 */
export function mostRecentOutput(
  nodeId: string,
  port: string,
  ctx: AdvanceContext,
): unknown | undefined {
  const iters = ctx.completedIterations(nodeId, port);
  if (iters.length === 0) return undefined;
  const latest = iters[iters.length - 1]!;
  return ctx.outputAt(nodeId, port, latest);
}

/**
 * Accumulator fill: all completed iterations, containers only by construction
 * (lint refuses scalars). Dict: later iteration wins on key collision.
 * Array: concatenate in ascending iteration order.
 */
export function accumulatePort(
  nodeId: string,
  port: string,
  ctx: AdvanceContext,
): unknown | undefined {
  const iters = ctx.completedIterations(nodeId, port);
  if (iters.length === 0) return undefined;

  let acc: unknown = undefined;
  for (const iter of iters) {
    const piece = ctx.outputAt(nodeId, port, iter);
    if (piece === undefined) continue;
    acc = mergeAccumulated(acc, piece);
  }
  return acc;
}

/**
 * Merge one iteration's value into an accumulator. Dict keys: later wins.
 * Arrays: concat. First piece seeds the accumulator as-is.
 */
export function mergeAccumulated(acc: unknown, piece: unknown): unknown {
  if (acc === undefined) return piece;
  if (Array.isArray(acc) && Array.isArray(piece)) {
    return acc.concat(piece);
  }
  if (isPlainObject(acc) && isPlainObject(piece)) {
    // Later iteration overwrites colliding keys.
    return { ...acc, ...piece };
  }
  // Type-incoherent pieces (should not happen post-lint): later wins wholesale.
  return piece;
}

/**
 * Fill every input port of a step that has a value (from wiring, accumulate,
 * or loop fills). Unfilled / from-less-empty ports are omitted — never
 * materialize a placeholder (ADR-0016 / #226).
 */
export function fillStepInputs(
  step: WorkflowStepNode,
  ctx: AdvanceContext,
  loopFills: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, port] of Object.entries(step.in)) {
    if (Object.prototype.hasOwnProperty.call(loopFills, name)) {
      out[name] = loopFills[name];
      continue;
    }
    if (port.from === undefined) continue; // unfilled loop port → omit
    const value = resolveInputPortValue(port.from, port.accumulate === true, ctx);
    if (value !== undefined) out[name] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Deliverable collection helpers (pure over rows)
// ---------------------------------------------------------------------------

/** Parse a deliverable row's stored value (inline JSON or path string). */
export function parseDeliverableValue(row: DeliverableRow): unknown {
  if (row.value === null) return undefined;
  if (row.kind === "file" || row.kind === "dir") return row.value;
  try {
    return JSON.parse(row.value) as unknown;
  } catch {
    return row.value;
  }
}

/**
 * Collect one (node, port, iteration) from deliverable rows into the value a
 * downstream port reads. Fan-out: dict keyed by slot, or array ordered by
 * slot index / insertion when slots are numeric-ish.
 */
export function collectOutputFromRows(
  rows: readonly DeliverableRow[],
  nodeId: string,
  port: string,
  iteration: number,
  fanOut: "none" | "array" | "dict",
): unknown | undefined {
  const matches = rows.filter(
    (r) =>
      r.node === nodeId &&
      r.port === port &&
      r.iteration === iteration &&
      r.purged_at === null &&
      r.value !== null,
  );
  if (matches.length === 0) return undefined;

  if (fanOut === "none") {
    return parseDeliverableValue(matches[0]!);
  }

  if (fanOut === "dict") {
    const dict: Record<string, unknown> = {};
    for (const r of matches) {
      const key = r.slot ?? "";
      if (key === "") continue;
      dict[key] = parseDeliverableValue(r);
    }
    return Object.keys(dict).length > 0 ? dict : undefined;
  }

  // array fan-out: order by numeric slot when possible, else stable by slot
  const sorted = [...matches].sort((a, b) => {
    const sa = a.slot ?? "";
    const sb = b.slot ?? "";
    const na = Number(sa);
    const nb = Number(sb);
    if (Number.isInteger(na) && Number.isInteger(nb) && String(na) === sa && String(nb) === sb) {
      return na - nb;
    }
    return sa.localeCompare(sb);
  });
  return sorted.map((r) => parseDeliverableValue(r));
}

/**
 * Completed iterations that produced `port` for `nodeId`, ascending.
 * Uses task state when provided; otherwise any non-purged deliverable row
 * counts as a completed contribution (tests / thin hosts).
 */
export function completedIterationsFromRows(
  rows: readonly DeliverableRow[],
  nodeId: string,
  port: string,
): number[] {
  const set = new Set<number>();
  for (const r of rows) {
    if (r.node !== nodeId || r.port !== port) continue;
    if (r.purged_at !== null || r.value === null) continue;
    // iteration 0 is fork inheritance — still a completed contribution
    set.add(r.iteration);
  }
  return [...set].sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// Context builder (DB → pure snapshot)
// ---------------------------------------------------------------------------

export interface BuildAdvanceContextOptions {
  run: RunRow;
  definition: WorkflowDefinition;
  /** Tasks for the current cursor; default loads from DB. */
  currentTasks?: readonly TaskRow[];
  /** All deliverables for the run; default loads from DB. */
  deliverables?: readonly DeliverableRow[];
  /** Run-level inputs (`run.<name>`). */
  runInputs?: Readonly<Record<string, unknown>>;
  db?: DatabaseHandle;
}

/**
 * Build a pure {@link AdvanceContext} from DB rows (or injected fixtures).
 */
export function buildAdvanceContext(opts: BuildAdvanceContextOptions): AdvanceContext {
  const { run, definition } = opts;
  const deliverables =
    opts.deliverables ??
    (opts.db !== undefined ? listDeliverablesForRun(opts.db, run.id) : []);

  let currentTasks: AdvanceTask[];
  if (opts.currentTasks !== undefined) {
    currentTasks = opts.currentTasks.map((t) => ({
      id: t.id,
      state: t.state,
      slot: t.slot,
    }));
  } else if (
    opts.db !== undefined &&
    run.current_node !== null &&
    run.current_node !== ""
  ) {
    currentTasks = listTasksForRunNode(
      opts.db,
      run.id,
      run.current_node,
      run.iteration,
    ).map((t) => ({ id: t.id, state: t.state, slot: t.slot }));
  } else {
    currentTasks = [];
  }

  const fanOutCache = new Map<string, "none" | "array" | "dict">();
  const fanOutOf = (nodeId: string): "none" | "array" | "dict" => {
    const cached = fanOutCache.get(nodeId);
    if (cached !== undefined) return cached;
    const n = findNode(definition, nodeId);
    let f: "none" | "array" | "dict" = "none";
    if (n !== undefined && n.kind === "step") {
      f = stepFanOutContainer(n, definition);
    }
    fanOutCache.set(nodeId, f);
    return f;
  };

  return {
    run: {
      id: run.id,
      state: run.state,
      current_node: run.current_node,
      iteration: run.iteration,
    },
    definition,
    currentTasks,
    runInputs: opts.runInputs ?? {},
    outputAt: (nodeId, port, iteration) =>
      collectOutputFromRows(deliverables, nodeId, port, iteration, fanOutOf(nodeId)),
    completedIterations: (nodeId, port) =>
      completedIterationsFromRows(deliverables, nodeId, port),
  };
}

// ---------------------------------------------------------------------------
// Apply + drain (impure, thin)
// ---------------------------------------------------------------------------

/** Result of applying one advance decision to the run row. */
export interface ApplyAdvanceResult {
  decision: AdvanceDecision;
  run: RunRow;
  /** True when the run row was mutated. */
  changed: boolean;
}

/**
 * Persist the run-row effects of a decision. Does **not** spawn tasks —
 * returns `enter` so the host can. Gate / loop-budget / success_policy /
 * spawn → `blocked`; complete → `completed`; enter → cursor move while
 * still `running` (host spawns); wait/noop → no mutation.
 *
 * `unfilled_outputs` / `unfilled_inputs` are resolved by {@link advanceRun}
 * before this is called (policy → block or continue).
 */
export function applyAdvanceDecision(
  db: DatabaseHandle,
  run: RunRow,
  decision: AdvanceDecision,
  opts?: { error?: string | null },
): ApplyAdvanceResult {
  switch (decision.kind) {
    case "block": {
      updateRun(db, run.id, {
        state: "blocked",
        current_node: decision.node,
        iteration: decision.iteration,
        error: opts?.error ?? blockErrorMessage(decision),
      });
      return { decision, run: getRun(db, run.id) ?? run, changed: true };
    }
    case "complete": {
      updateRun(db, run.id, {
        state: "completed",
        current_node: null,
        completed_at: new Date().toISOString(),
        error: null,
      });
      return { decision, run: getRun(db, run.id) ?? run, changed: true };
    }
    case "enter": {
      updateRun(db, run.id, {
        state: "running",
        current_node: decision.node,
        iteration: decision.iteration,
        error: null,
      });
      return { decision, run: getRun(db, run.id) ?? run, changed: true };
    }
    case "unfilled_inputs": {
      updateRun(db, run.id, {
        state: "blocked",
        current_node: decision.node,
        iteration: decision.iteration,
        error:
          opts?.error ??
          `blocked (unfilled inputs on ${decision.node}: ${decision.missing.join(", ")})`,
      });
      return {
        decision: {
          kind: "block",
          reason: "unfilled_inputs",
          node: decision.node,
          iteration: decision.iteration,
        },
        run: getRun(db, run.id) ?? run,
        changed: true,
      };
    }
    default:
      return { decision, run, changed: false };
  }
}

function blockErrorMessage(
  decision: Extract<AdvanceDecision, { kind: "block" }>,
): string {
  if (decision.reason === "gate") {
    return `blocked (gate ${decision.node})`;
  }
  if (decision.reason === "success_policy") {
    return `blocked (success policy on ${decision.node})`;
  }
  if (decision.reason === "spawn") {
    return `blocked (spawn ${decision.node})`;
  }
  if (decision.reason === "unfilled_inputs") {
    return `blocked (unfilled inputs on ${decision.node})`;
  }
  const max = decision.loopMax ?? decision.iteration;
  return `blocked (loop ${decision.iteration}/${max})`;
}

/**
 * Host callbacks for drain. Spawn / retries are the host's job (engine.ts
 * wires preflight + workspace + delegate). Tests inject fakes.
 */
export interface RunDrainHost {
  /** Resolve a workflow definition by id (and optional version). */
  loadDefinition(workflowId: string, version: number): WorkflowDefinition | null;
  /**
   * Called when the definition cannot be parsed (structural failure).
   * Ordinary "not found" returns null from loadDefinition without this.
   */
  onDefinitionUnparseable?(run: RunRow, error: string): void;
  /** Run-level inputs for `run.<name>` refs. */
  runInputs?(run: RunRow): Readonly<Record<string, unknown>>;
  /**
   * Report `outcome` for a completed task (`success` | `partial` | `blocked`),
   * or null when absent / port-schema report. Used by success policy.
   */
  taskOutcome?(taskId: string): string | null;
  /**
   * Called after the cursor moves to a step that needs tasks. Optional —
   * without it, drain still updates the run row (tests / early wiring).
   * Throw / return error message → run blocks with reason `spawn`.
   */
  onEnter?(args: {
    run: RunRow;
    definition: WorkflowDefinition;
    step: WorkflowStepNode;
    iteration: number;
    inputs: Record<string, unknown>;
    loopFills: Record<string, unknown>;
    /** Orchestrator note (redirect); null on ordinary advance. */
    note?: string | null;
  }): void | { error: string };
  /**
   * Spawn fresh tasks for slots that still have retry budget after a
   * task-state `failed` sibling. Return error → block (spawn).
   */
  onRetry?(args: {
    run: RunRow;
    definition: WorkflowDefinition;
    step: WorkflowStepNode;
    iteration: number;
    plans: readonly RetryPlan[];
    inputs: Record<string, unknown>;
  }): void | { error: string };
}

/**
 * Resolve `unfilled_outputs` through retries then success policy (ADR-0017).
 *
 * - Retries remaining for a `failed` slot → `{ kind: "retry", plans }`
 * - Policy met → continue as if ports filled (`continue` decision)
 * - Policy not met → block with `success_policy`
 */
export function resolveUnfilledOutputs(
  step: WorkflowStepNode,
  ctx: AdvanceContext,
  tasks: readonly PolicyTask[],
):
  | { kind: "retry"; plans: RetryPlan[] }
  | { kind: "continue"; decision: AdvanceDecision }
  | { kind: "block"; decision: Extract<AdvanceDecision, { kind: "block" }>; policy: SuccessPolicyResult } {
  const plans = planRetries(step, tasks);
  if (plans.length > 0) {
    return { kind: "retry", plans };
  }

  const policy = evaluateSuccessPolicy(step, tasks);
  if (policy.met) {
    // Ports-filled gate is satisfied under the policy — evaluate loop / next.
    return { kind: "continue", decision: advanceAfterPortsFilled(step, ctx) };
  }

  return {
    kind: "block",
    decision: {
      kind: "block",
      reason: "success_policy",
      node: step.id,
      iteration: ctx.run.iteration,
    },
    policy,
  };
}

/**
 * After a settled step whose outputs are accepted (all filled, or success
 * policy met): evaluate loop, else next node. Extracted from {@link advance}.
 */
export function advanceAfterPortsFilled(
  node: WorkflowStepNode,
  ctx: AdvanceContext,
): AdvanceDecision {
  if (node.loop !== undefined) {
    const loopDecision = evaluateLoop(node, node.loop, ctx);
    if (loopDecision !== null) return loopDecision;
  }
  return advanceToNext(ctx, node.id, ctx.run.iteration, {});
}

/**
 * Build {@link PolicyTask} rows from advance tasks + optional outcome lookup.
 */
export function toPolicyTasks(
  tasks: readonly AdvanceTask[],
  outcomeOf?: (taskId: string) => string | null,
): PolicyTask[] {
  return tasks.map((t) => ({
    id: t.id,
    state: t.state,
    slot: t.slot,
    outcome: outcomeOf?.(t.id) ?? null,
  }));
}

/**
 * Evaluate + apply advance for one run. Re-reads the run after apply so a
 * multi-step pure chain can be driven by the host (enter → spawn → settle →
 * drain again).
 *
 * Routes `unfilled_outputs` through retries / success policy before applying.
 * Never auto-fails: spawn / policy failures → `blocked`.
 */
export function advanceRun(
  db: DatabaseHandle,
  runId: string,
  host: RunDrainHost,
): ApplyAdvanceResult | null {
  const run = getRun(db, runId);
  if (run === undefined) return null;
  if (run.state !== "running") {
    return {
      decision: { kind: "noop", reason: `run state is ${run.state}` },
      run,
      changed: false,
    };
  }

  let definition: WorkflowDefinition | null;
  try {
    definition = host.loadDefinition(run.workflow, run.version);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    host.onDefinitionUnparseable?.(run, message);
    markRunFailed(db, run.id, `definition unparseable: ${message}`);
    return {
      decision: { kind: "noop", reason: "definition unparseable" },
      run: getRun(db, run.id) ?? run,
      changed: true,
    };
  }
  if (definition === null) {
    // Not found — do not auto-fail (cwd may lack the workflow until the
    // orchestrator fixes discovery). Stay put.
    return {
      decision: { kind: "noop", reason: "definition not loaded" },
      run,
      changed: false,
    };
  }

  const ctx = buildAdvanceContext({
    run,
    definition,
    db,
    runInputs: host.runInputs?.(run) ?? {},
  });
  let decision = advance(ctx);
  let policyError: string | null = null;

  // --- unfilled_outputs → retries / success policy -------------------------
  if (decision.kind === "unfilled_outputs") {
    const step = findNode(definition, decision.node);
    if (step !== undefined && step.kind === "step") {
      const policyTasks = toPolicyTasks(ctx.currentTasks, host.taskOutcome);
      const resolved = resolveUnfilledOutputs(step, ctx, policyTasks);
      if (resolved.kind === "retry") {
        const inputs = fillStepInputs(step, ctx, {});
        const err = host.onRetry?.({
          run,
          definition,
          step,
          iteration: ctx.run.iteration,
          plans: resolved.plans,
          inputs,
        });
        if (err !== undefined && typeof err === "object" && "error" in err) {
          decision = {
            kind: "block",
            reason: "spawn",
            node: step.id,
            iteration: ctx.run.iteration,
          };
          policyError = `blocked (spawn retry ${step.id}): ${err.error}`;
        } else {
          // Fresh tasks pending — stay running, wait for settle.
          return {
            decision: { kind: "wait" },
            run,
            changed: false,
          };
        }
      } else if (resolved.kind === "continue") {
        decision = resolved.decision;
      } else {
        decision = resolved.decision;
        policyError = `blocked (${resolved.policy.summary})`;
      }
    }
  }

  // Entering a target with unfilled from-wired inputs → block (fixable).
  if (decision.kind === "unfilled_inputs") {
    const applied = applyAdvanceDecision(db, run, decision);
    return applied;
  }

  const applied = applyAdvanceDecision(db, run, decision, {
    error: policyError,
  });

  if (decision.kind === "enter" && host.onEnter !== undefined) {
    const step = findNode(definition, decision.node);
    if (step !== undefined && step.kind === "step") {
      const inputs = fillStepInputs(step, ctx, decision.loopFills);
      const err = host.onEnter({
        run: applied.run,
        definition,
        step,
        iteration: decision.iteration,
        inputs,
        loopFills: decision.loopFills,
      });
      if (err !== undefined && typeof err === "object" && "error" in err) {
        // Spawn failed after cursor move — park the run for the orchestrator.
        updateRun(db, run.id, {
          state: "blocked",
          error: `blocked (spawn ${step.id}): ${err.error}`,
        });
        return {
          decision: {
            kind: "block",
            reason: "spawn",
            node: step.id,
            iteration: decision.iteration,
          },
          run: getRun(db, run.id) ?? applied.run,
          changed: true,
        };
      }
    }
  }

  return applied;
}

/**
 * Apply a gate verb to a blocked run and spawn if the decision is enter.
 * Returns an error decision without mutating when the verb is illegal.
 */
export function actionRunVerb(
  db: DatabaseHandle,
  runId: string,
  host: RunDrainHost,
  request: GateVerbRequest,
): { decision: GateVerbDecision; run: RunRow; changed: boolean } | null {
  const run = getRun(db, runId);
  if (run === undefined) return null;

  let definition: WorkflowDefinition | null;
  try {
    definition = host.loadDefinition(run.workflow, run.version);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      decision: { kind: "error", message: `definition unparseable: ${message}` },
      run,
      changed: false,
    };
  }
  if (definition === null) {
    return {
      decision: { kind: "error", message: `workflow "${run.workflow}" not found` },
      run,
      changed: false,
    };
  }

  const ctx = buildAdvanceContext({
    run: { ...run, state: "running" }, // context builder only needs cursor
    definition,
    db,
    runInputs: host.runInputs?.(run) ?? {},
  });
  // Restore blocked state for the pure verb check.
  ctx.run.state = run.state;

  const decision = actionGateVerb(run, definition, request, ctx);
  if (decision.kind === "error") {
    return { decision, run, changed: false };
  }

  if (decision.kind === "complete") {
    updateRun(db, run.id, {
      state: "completed",
      current_node: null,
      completed_at: new Date().toISOString(),
      error: null,
    });
    return { decision, run: getRun(db, run.id) ?? run, changed: true };
  }

  // enter
  const target = findNode(definition, decision.node);
  if (target === undefined) {
    return {
      decision: {
        kind: "error",
        message: `unknown target node "${decision.node}"`,
      },
      run,
      changed: false,
    };
  }

  if (target.kind === "gate") {
    updateRun(db, run.id, {
      state: "blocked",
      current_node: target.id,
      iteration: decision.iteration,
      error: `blocked (gate ${target.id})`,
    });
    return { decision, run: getRun(db, run.id) ?? run, changed: true };
  }

  // Check inputs for the destination step (from-less exempt; loopFills count).
  const missing = missingInputPorts(target, ctx, decision.iteration, decision.loopFills);
  if (missing.length > 0 && decision.via !== "redirect") {
    // Redirect may intentionally land on a node whose from-wired inputs are
    // not yet filled — still block so the orchestrator sees the hole.
    // (Redirect with a note is the repair path; #242 owns deeper re-entry.)
  }
  if (missing.length > 0) {
    updateRun(db, run.id, {
      state: "blocked",
      current_node: target.id,
      iteration: decision.iteration,
      error: `blocked (unfilled inputs on ${target.id}: ${missing.join(", ")})`,
    });
    return { decision, run: getRun(db, run.id) ?? run, changed: true };
  }

  updateRun(db, run.id, {
    state: "running",
    current_node: target.id,
    iteration: decision.iteration,
    error: null,
  });
  const updated = getRun(db, run.id) ?? run;

  if (host.onEnter !== undefined) {
    const inputs = fillStepInputs(target, ctx, decision.loopFills);
    const err = host.onEnter({
      run: updated,
      definition,
      step: target,
      iteration: decision.iteration,
      inputs,
      loopFills: decision.loopFills,
      note: decision.note,
    });
    if (err !== undefined && typeof err === "object" && "error" in err) {
      updateRun(db, run.id, {
        state: "blocked",
        error: `blocked (spawn ${target.id}): ${err.error}`,
      });
      return {
        decision,
        run: getRun(db, run.id) ?? updated,
        changed: true,
      };
    }
  }

  return { decision, run: getRun(db, run.id) ?? updated, changed: true };
}

export type { GateVerb, GateVerbDecision, GateVerbRequest, RetryPlan, SuccessPolicyResult };

/**
 * Drain every `running` run once. Re-entrancy safe. Mirrors
 * `drainConcurrencyQueue`: list → try each → stop when a full pass makes no
 * progress. Progress here means a run row mutation (block/complete/enter).
 *
 * Called from `onSlotFreed` and on daemon restart.
 */
export function drainRuns(db: DatabaseHandle, host: RunDrainHost): void {
  let progressed = true;
  while (progressed) {
    progressed = false;
    let runs: RunRow[];
    try {
      runs = listRuns(db).filter((r) => r.state === "running");
    } catch {
      return;
    }
    for (const run of runs) {
      const result = advanceRun(db, run.id, host);
      if (result?.changed) {
        progressed = true;
        // Re-list after mutation so cursor/state stays accurate.
        break;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

export function findNode(
  definition: WorkflowDefinition,
  id: string,
): WorkflowNode | undefined {
  return definition.nodes.find((n) => n.id === id);
}

export function nextNode(
  definition: WorkflowDefinition,
  afterId: string,
): WorkflowNode | undefined {
  const idx = definition.nodes.findIndex((n) => n.id === afterId);
  if (idx < 0 || idx + 1 >= definition.nodes.length) return undefined;
  return definition.nodes[idx + 1];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Type guard: decision blocks the run. */
export function isBlockDecision(
  d: AdvanceDecision,
): d is Extract<AdvanceDecision, { kind: "block" }> {
  return d.kind === "block";
}

/**
 * Structural run failure (ADR-0017): workspace gone / definition unparseable.
 * Not used by ordinary advance — a run never auto-fails from the loop.
 */
export function markRunFailed(
  db: DatabaseHandle,
  runId: string,
  error: string,
): RunRow | undefined {
  updateRun(db, runId, {
    state: "failed",
    error,
    completed_at: new Date().toISOString(),
  });
  return getRun(db, runId);
}

/** Exported for tests: gate node shape from definition. */
export type { WorkflowGateNode, WorkflowStepNode };
