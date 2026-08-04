/**
 * Pure step-address formatting (ADR-0018 / #234) — no path/fs.
 *
 * Host-only tmp path helpers live in `./address.js` and re-export these.
 * The browser barrel imports this module directly so UI consumers can call
 * {@link formatStepAddress} without pulling `node:path`.
 */

/** Coordinates of a step attempt inside a run. */
export interface StepAddress {
  /** Node id within the workflow. */
  node: string;
  /** 1-based iteration (0 marks inheritance on a fork). */
  iteration: number;
  /** Authored slot name or data-fan-out key; null/omitted when no fan-out. */
  slot?: string | null;
  /**
   * 1-based retry index appended as `-r<n>`. Omit, null, or 0 for the first
   * attempt (no suffix).
   */
  retry?: number | null;
}

/**
 * Format a step address: `<node>.<iteration>[.<slot>][-r<n>]`.
 *
 * Slot is omitted when null/undefined/empty. Retry is omitted when null,
 * undefined, or ≤ 0.
 */
export function formatStepAddress(addr: StepAddress): string {
  if (addr.node === "") {
    throw new Error("step address requires a non-empty node id");
  }
  if (!Number.isInteger(addr.iteration) || addr.iteration < 0) {
    throw new Error(`step address iteration must be a non-negative integer, got ${addr.iteration}`);
  }
  let s = `${addr.node}.${addr.iteration}`;
  if (addr.slot != null && addr.slot !== "") {
    s += `.${addr.slot}`;
  }
  if (addr.retry != null && addr.retry > 0) {
    if (!Number.isInteger(addr.retry)) {
      throw new Error(`step address retry must be an integer, got ${addr.retry}`);
    }
    s += `-r${addr.retry}`;
  }
  return s;
}
