/**
 * Port-fill resolution shared by advance and gate verbs.
 *
 * Loop fills and from-wired ports use the same most-recent vs accumulate
 * rules (ADR-0017 / #382): the author's `accumulate` flag on the *target*
 * input port decides, including colliding-key later-wins and array concat.
 */

import { parseFromRef } from "@useparley/core";

/** The slice of advance / gate context that port fill reads. */
export interface PortFillContext {
  runInputs: Readonly<Record<string, unknown>>;
  outputAt: (nodeId: string, port: string, iteration: number) => unknown | undefined;
  completedIterations: (nodeId: string, port: string) => readonly number[];
}

/**
 * Resolve a `from` ref (`run.<input>` or `<node>.<port>`).
 *
 * - `run.<input>` → runInputs (accumulate is a no-op; run inputs have no iterations)
 * - `<node>.<port>` → most recent completed iteration, unless `accumulate`
 * - accumulate (containers only at lint time): merge all completed iterations;
 *   dict key collisions → later iteration wins; arrays concatenate in
 *   iteration order
 */
export function resolveFromRefValue(
  from: string,
  ctx: PortFillContext,
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
  ctx: PortFillContext,
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
  ctx: PortFillContext,
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
