/**
 * Gate verbs for a blocked run (ADR-0017 / #238).
 *
 * A gate is never acked — only actioned. Four verbs:
 *   approve / reject / redirect / finish
 *
 * Loop-budget exhaustion is an implicit gate (no `reject`; no `on_reject`).
 * Success-policy and spawn blocks offer approve / redirect / finish.
 *
 * Full re-entry machinery for `redirect` (orchestrator note on the entry
 * task) is shared with #242; this module decides *where* the cursor goes and
 * leaves spawn to the host.
 */

import type {
  WorkflowDefinition,
  WorkflowGateNode,
  WorkflowNode,
} from "@useparley/core";
import type { RunRow, RunState } from "./db.js";

// ---------------------------------------------------------------------------
// Local graph helpers (avoid a circular import with run-engine.ts)
// ---------------------------------------------------------------------------

function findNode(
  definition: WorkflowDefinition,
  id: string,
): WorkflowNode | undefined {
  return definition.nodes.find((n) => n.id === id);
}

function nextNode(
  definition: WorkflowDefinition,
  afterId: string,
): WorkflowNode | undefined {
  const idx = definition.nodes.findIndex((n) => n.id === afterId);
  if (idx < 0 || idx + 1 >= definition.nodes.length) return undefined;
  return definition.nodes[idx + 1];
}

/** Minimal context for resolving loop.with fills during a verb. */
export interface GateVerbContext {
  runInputs: Readonly<Record<string, unknown>>;
  outputAt: (nodeId: string, port: string, iteration: number) => unknown | undefined;
  completedIterations: (nodeId: string, port: string) => readonly number[];
}

/** Orchestrator verbs that action a blocked run. */
export type GateVerb = "approve" | "reject" | "redirect" | "finish";

/** Why the run is blocked — drives which verbs are legal. */
export type BlockReason =
  | "gate"
  | "loop_budget"
  | "success_policy"
  | "spawn"
  | "unfilled_inputs"
  | "unknown";

/** Options for {@link actionGateVerb}. */
export interface GateVerbRequest {
  verb: GateVerb;
  /**
   * Target node for `redirect`. Required when verb is `redirect`.
   * Also accepted on `approve` of a gate that has no loop (ignored).
   */
  to?: string | null;
  /** Free-text note for redirect (prompt layer); not a port. */
  note?: string | null;
}

/** Pure decision produced by a gate verb. */
export type GateVerbDecision =
  | {
      kind: "enter";
      node: string;
      iteration: number;
      loopFills: Record<string, unknown>;
      /** Orchestrator note for the entry task prompt (redirect / fork). */
      note: string | null;
      /** Verb that produced this enter (for surfaces). */
      via: GateVerb;
    }
  | {
      kind: "complete";
      via: GateVerb;
    }
  | {
      kind: "error";
      message: string;
    };

/**
 * Infer block reason from the run's `error` string and current node kind.
 * Best-effort for restarts; verbs still validate against the definition.
 */
export function inferBlockReason(
  run: Pick<RunRow, "state" | "error" | "current_node">,
  definition: WorkflowDefinition,
): BlockReason {
  if (run.state !== "blocked") return "unknown";
  const err = run.error ?? "";
  if (err.includes("loop ") || err.includes("loop_budget")) return "loop_budget";
  if (err.includes("success") || err.includes("slots)")) return "success_policy";
  if (err.includes("spawn")) return "spawn";
  if (err.includes("unfilled input") || err.includes("unfilled_inputs")) {
    return "unfilled_inputs";
  }
  if (run.current_node) {
    const node = findNode(definition, run.current_node);
    if (node?.kind === "gate") return "gate";
  }
  if (err.includes("gate")) return "gate";
  return "unknown";
}

/**
 * Verbs offered for a given block reason (ADR-0017 / query-surface F7).
 * `reject` only exists on an author-declared gate (has `on_reject`).
 */
export function verbsForBlockReason(reason: BlockReason): readonly GateVerb[] {
  switch (reason) {
    case "gate":
      return ["approve", "reject", "redirect", "finish"];
    case "loop_budget":
    case "success_policy":
    case "spawn":
    case "unfilled_inputs":
      return ["approve", "redirect", "finish"];
    default:
      return ["redirect", "finish"];
  }
}

/**
 * Pure gate-verb evaluation. No I/O. Caller applies the decision to the run
 * row and spawns via the existing enter host.
 *
 * ## Semantics
 *
 * **Gate node (`reason: gate`)**:
 * - `approve` — take the gate's loop when present and under budget; else next node
 * - `reject` — follow author `on_reject` (`finish` → complete; else node id → enter)
 * - `redirect --to` — enter `--to` at iteration+1 (exempt from loop budget)
 * - `finish` — complete the run
 *
 * **Loop budget (`reason: loop_budget`)**:
 * - `approve` — force exit the loop: advance to the next node after the step
 * - `redirect` / `finish` — as above
 * - `reject` — error
 *
 * **Success policy / spawn / unfilled inputs**:
 * - `approve` — force proceed: re-enter advance past the current step (next/loop)
 * - `redirect` / `finish` — as above
 * - `reject` — error
 */
export function actionGateVerb(
  run: Pick<RunRow, "state" | "current_node" | "iteration" | "error">,
  definition: WorkflowDefinition,
  request: GateVerbRequest,
  ctx: GateVerbContext,
): GateVerbDecision {
  if (run.state !== "blocked") {
    return {
      kind: "error",
      message: `run is ${run.state}, not blocked — gate verbs only action a blocked run`,
    };
  }
  const currentId = run.current_node;
  if (currentId === null || currentId === "") {
    return { kind: "error", message: "blocked run has no current_node" };
  }
  const node = findNode(definition, currentId);
  if (node === undefined) {
    return { kind: "error", message: `unknown current_node "${currentId}"` };
  }

  const reason = inferBlockReason(run, definition);
  const allowed = verbsForBlockReason(reason);
  if (!allowed.includes(request.verb)) {
    return {
      kind: "error",
      message: `verb "${request.verb}" is not offered for block reason ${reason} (allowed: ${allowed.join(", ")})`,
    };
  }

  switch (request.verb) {
    case "finish":
      return { kind: "complete", via: "finish" };

    case "redirect": {
      const to = request.to?.trim() ?? "";
      if (to === "") {
        return { kind: "error", message: "redirect requires --to <node>" };
      }
      const target = findNode(definition, to);
      if (target === undefined) {
        return { kind: "error", message: `unknown redirect target "${to}"` };
      }
      if (target.kind === "gate") {
        // Entering a gate blocks again — still a valid redirect.
        return {
          kind: "enter",
          node: target.id,
          iteration: run.iteration + 1,
          loopFills: {},
          note: emptyToNull(request.note),
          via: "redirect",
        };
      }
      return {
        kind: "enter",
        node: target.id,
        iteration: run.iteration + 1,
        loopFills: {},
        note: emptyToNull(request.note),
        via: "redirect",
      };
    }

    case "reject": {
      if (node.kind !== "gate") {
        return {
          kind: "error",
          message: "reject is only valid on an author-declared gate",
        };
      }
      return applyOnReject(node, run.iteration, emptyToNull(request.note));
    }

    case "approve":
      return approveBlocked(node, reason, run.iteration, definition, ctx);
  }
}

function applyOnReject(
  gate: WorkflowGateNode,
  iteration: number,
  note: string | null,
): GateVerbDecision {
  const path = gate.on_reject;
  if (path === "finish" || path === "reject") {
    // "reject" as on_reject is treated as finish (mandatory close).
    return { kind: "complete", via: "reject" };
  }
  // Author-declared node id.
  return {
    kind: "enter",
    node: path,
    iteration: iteration + 1,
    loopFills: {},
    note,
    via: "reject",
  };
}

function approveBlocked(
  node: WorkflowNode,
  reason: BlockReason,
  iteration: number,
  definition: WorkflowDefinition,
  ctx: GateVerbContext,
): GateVerbDecision {
  if (node.kind === "gate") {
    // Gate with a loop: orchestrator's "yes" takes the loop (coding-2).
    if (node.loop !== undefined) {
      if (iteration >= node.loop.max) {
        // Budget already exhausted while sitting on the gate — force finish
        // path is finish/redirect; approve past budget proceeds to *next*
        // after the gate (same as no loop).
        return enterNextAfter(definition, node.id, iteration, {}, "approve");
      }
      const loopFills = resolveLoopWithFromCtx(node.loop.with, ctx);
      const target = findNode(definition, node.loop.to);
      if (target === undefined) {
        return {
          kind: "error",
          message: `gate loop target "${node.loop.to}" not found`,
        };
      }
      return {
        kind: "enter",
        node: node.loop.to,
        iteration: iteration + 1,
        loopFills,
        note: null,
        via: "approve",
      };
    }
    return enterNextAfter(definition, node.id, iteration, {}, "approve");
  }

  // Step-level blocks (loop_budget, success_policy, spawn, unfilled_inputs).
  if (reason === "loop_budget") {
    // Force exit: next node after the looping step, same iteration.
    return enterNextAfter(definition, node.id, iteration, {}, "approve");
  }

  // success_policy / spawn / unfilled_inputs: force proceed to next/loop as
  // if the step had settled successfully. Reuse linear next (skip re-loop
  // evaluation — the human is overriding).
  return enterNextAfter(definition, node.id, iteration, {}, "approve");
}

function enterNextAfter(
  definition: WorkflowDefinition,
  afterId: string,
  iteration: number,
  loopFills: Record<string, unknown>,
  via: GateVerb,
): GateVerbDecision {
  const next = nextNode(definition, afterId);
  if (next === undefined) {
    return { kind: "complete", via };
  }
  return {
    kind: "enter",
    node: next.id,
    iteration,
    loopFills,
    note: null,
    via,
  };
}

function resolveLoopWithFromCtx(
  withMap: Record<string, string> | undefined,
  ctx: GateVerbContext,
): Record<string, unknown> {
  if (withMap === undefined) return {};
  const fills: Record<string, unknown> = {};
  for (const [port, from] of Object.entries(withMap)) {
    const parsed = from.split(".");
    if (parsed.length !== 2) continue;
    const [left, right] = parsed as [string, string];
    if (left === "run") {
      if (Object.prototype.hasOwnProperty.call(ctx.runInputs, right)) {
        fills[port] = ctx.runInputs[right];
      }
      continue;
    }
    const iters = ctx.completedIterations(left, right);
    if (iters.length === 0) continue;
    const latest = iters[iters.length - 1]!;
    const v = ctx.outputAt(left, right, latest);
    if (v !== undefined) fills[port] = v;
  }
  return fills;
}

function emptyToNull(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value.trim() === "") return null;
  return value;
}

/** Type guard for run states that can be actioned by gate verbs. */
export function isActionableRunState(state: RunState): boolean {
  return state === "blocked";
}
