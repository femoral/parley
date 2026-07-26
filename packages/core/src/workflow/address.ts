/**
 * Structural address formatting for runs (ADR-0018 / #234).
 *
 * One string, read alike on branches, scratch directories and tmp dirs:
 * `<node>.<iteration>[.<slot>][-r<n>]`.
 *
 * Mode-independent: both `repo` and `scratch` workspaces use the same
 * address and the same tmp layout under the workspace root.
 */

import path from "node:path";

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

/**
 * Relative path of the address-scoped tmp directory under a workspace:
 * `.parley/tmp/<address>`.
 */
export function formatTmpDirRel(address: string): string {
  if (address === "" || address.includes("..") || address.includes("/") || address.includes("\\")) {
    throw new Error(`invalid step address for tmp path: ${JSON.stringify(address)}`);
  }
  return path.join(".parley", "tmp", address);
}

/** Absolute paths for an address-scoped handoff dir: `{ root, in, out }`. */
export interface TmpHandoffPaths {
  /** `.parley/tmp/<address>` */
  root: string;
  /** Daemon writes inputs here. */
  in: string;
  /** Child writes outputs here. */
  out: string;
}

/**
 * Resolve absolute tmp handoff paths under `workspaceRoot` for `address`.
 * Does not create directories.
 */
export function tmpHandoffPaths(workspaceRoot: string, address: string): TmpHandoffPaths {
  const root = path.join(workspaceRoot, formatTmpDirRel(address));
  return {
    root,
    in: path.join(root, "in"),
    out: path.join(root, "out"),
  };
}
