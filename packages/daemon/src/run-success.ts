/**
 * Fan-out success policy and step-level retries (ADR-0017 / #238).
 *
 * Pure decision helpers — the run engine applies them when a step settles.
 * Defaults: `all` for authored slots, `{min: 1}` for data fan-out, `all` for
 * a single-task step. `retries` is opt-in (default 0), fires only on
 * task-state `failed`, and spawns a *fresh* task (never a fix attempt).
 */

import type { WorkflowStepNode } from "@useparley/core";

/** Resolved success policy after applying author defaults. */
export type SuccessPolicy =
  | { kind: "all" }
  | { kind: "min"; min: number }
  | { kind: "required"; slots: readonly string[] };

/**
 * One task's contribution to a step's success tally.
 * `usable` means the sibling produced work the join can read:
 * - `completed` with report `outcome` of `success` | `partial` | absent
 * - `completed` with port-schema report (no outcome field) is usable
 * `outcome: blocked` is *not* usable (routes as a failed task).
 */
export interface PolicyTask {
  id: string;
  state: string;
  /** Authored slot / data key; null for a single-task step. */
  slot: string | null;
  /**
   * Report `outcome` when present (`success` | `partial` | `blocked`).
   * Null when no report or a port-schema report without outcome.
   */
  outcome: string | null;
}

/** Result of evaluating a step's success policy over settled siblings. */
export interface SuccessPolicyResult {
  met: boolean;
  policy: SuccessPolicy;
  /** Tasks that count toward the quorum (usable completed work). */
  succeeded: string[];
  /** Settled tasks that do not count (failed / cancelled / stalled / blocked). */
  failed: string[];
  /** Human-readable summary, e.g. `min 1 — MET, 2 of 3`. */
  summary: string;
}

/**
 * Resolve the effective success policy for a step (ADR-0017 defaults).
 *
 * - Explicit `success.required` → required slots
 * - Explicit `success.min` → min
 * - Authored `slots` → `all`
 * - Data fan-out (`over`) → `{min: 1}`
 * - Single task → `all`
 */
export function resolveSuccessPolicy(step: WorkflowStepNode): SuccessPolicy {
  const authored = step.success;
  if (authored?.required !== undefined && authored.required.length > 0) {
    return { kind: "required", slots: authored.required };
  }
  if (authored?.min !== undefined) {
    return { kind: "min", min: authored.min };
  }
  if (step.slots !== undefined && Object.keys(step.slots).length > 0) {
    return { kind: "all" };
  }
  if (step.over !== undefined) {
    return { kind: "min", min: 1 };
  }
  return { kind: "all" };
}

/**
 * True when a settled task counts as usable work for the success policy.
 *
 * - `completed` + outcome `blocked` → no (gave up)
 * - `completed` + outcome `partial` | `success` | null → yes
 * - any other settled state (`failed`, `cancelled`, `stalled`) → no
 */
export function isUsableTask(task: PolicyTask): boolean {
  if (task.state !== "completed") return false;
  if (task.outcome === "blocked") return false;
  return true;
}

/**
 * Evaluate a step's success policy over its settled tasks.
 * Caller must ensure the step is settled (`isSettledState` for every task).
 */
export function evaluateSuccessPolicy(
  step: WorkflowStepNode,
  tasks: readonly PolicyTask[],
): SuccessPolicyResult {
  const policy = resolveSuccessPolicy(step);
  const succeeded: string[] = [];
  const failed: string[] = [];
  for (const t of tasks) {
    if (isUsableTask(t)) succeeded.push(t.id);
    else failed.push(t.id);
  }

  let met = false;
  switch (policy.kind) {
    case "all":
      met = tasks.length > 0 && failed.length === 0;
      break;
    case "min":
      met = succeeded.length >= policy.min;
      break;
    case "required": {
      const bySlot = new Map<string, PolicyTask>();
      for (const t of tasks) {
        if (t.slot !== null && t.slot !== "") bySlot.set(t.slot, t);
      }
      met = policy.slots.every((slot) => {
        const t = bySlot.get(slot);
        return t !== undefined && isUsableTask(t);
      });
      break;
    }
  }

  return {
    met,
    policy,
    succeeded,
    failed,
    summary: formatSuccessSummary(policy, succeeded.length, tasks.length, met),
  };
}

/** Format a compact policy verdict for run.error / query surfaces. */
export function formatSuccessSummary(
  policy: SuccessPolicy,
  succeeded: number,
  total: number,
  met: boolean,
): string {
  const verdict = met ? "MET" : "NOT MET";
  switch (policy.kind) {
    case "all":
      return `all — ${verdict}, ${succeeded} of ${total}`;
    case "min":
      return `min ${policy.min} — ${verdict}, ${succeeded} of ${total}`;
    case "required":
      return `required [${policy.slots.join(", ")}] — ${verdict}, ${succeeded} of ${total}`;
  }
}

// ---------------------------------------------------------------------------
// Retries (fresh task, never a fix attempt)
// ---------------------------------------------------------------------------

/**
 * Per-slot retry plan: which slots need a fresh task after a `failed` sibling.
 * Only task-state `failed` consumes a retry (not cancelled/stalled/blocked-outcome).
 */
export interface RetryPlan {
  /** Slot to re-spawn (null for a single-task step). */
  slot: string | null;
  /** How many `failed` attempts already exist for this slot at this iteration. */
  failedAttempts: number;
  /** Author-declared `retries` (max additional spawns after the first). */
  retries: number;
}

/**
 * Compute which slots still have retry budget after a settled step.
 * Fires only when the latest attempt for a slot is `failed` and
 * `failedAttempts <= retries` (retries default 0 ⇒ never).
 *
 * Counting: number of tasks in `failed` state for that slot. A first spawn
 * that fails counts as 1; with `retries: 1` one more spawn is allowed.
 */
export function planRetries(
  step: WorkflowStepNode,
  tasks: readonly PolicyTask[],
): RetryPlan[] {
  const retries = step.retries ?? 0;
  if (retries <= 0) return [];

  // Group by slot key ("" for null).
  const bySlot = new Map<string, PolicyTask[]>();
  for (const t of tasks) {
    const key = t.slot ?? "";
    const list = bySlot.get(key) ?? [];
    list.push(t);
    bySlot.set(key, list);
  }

  const plans: RetryPlan[] = [];
  for (const [key, group] of bySlot) {
    const failedCount = group.filter((t) => t.state === "failed").length;
    if (failedCount === 0) continue;
    // Only retry when the *latest* task for the slot failed (no concurrent
    // success / still-running sibling for the same slot).
    const latest = group[group.length - 1]!;
    if (latest.state !== "failed") continue;
    if (failedCount > retries) continue;
    plans.push({
      slot: key === "" ? null : key,
      failedAttempts: failedCount,
      retries,
    });
  }
  return plans;
}

/**
 * 1-based retry index for address formatting (`-r<n>`). The first spawn is
 * retry 0 (no suffix); each subsequent spawn for the same slot increments.
 */
export function nextRetryIndex(existingAttempts: number): number {
  // existingAttempts includes the failed ones about to be replaced; the new
  // task is attempt number existingAttempts + 1, so -r suffix is that - 1
  // when > 1, i.e. existingAttempts when existingAttempts >= 1.
  return existingAttempts >= 1 ? existingAttempts : 0;
}
