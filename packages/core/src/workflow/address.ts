/**
 * Structural address formatting for runs (ADR-0018 / #234).
 *
 * One string, read alike on branches, scratch directories and tmp dirs:
 * `<node>.<iteration>[.<slot>][-r<n>]`.
 *
 * Mode-independent: both `repo` and `scratch` workspaces use the same
 * address and the same tmp layout under the workspace root.
 *
 * Pure string formatting lives in `./step-address.js` (browser-safe). Path
 * helpers below are host-only (`node:path`).
 */

import path from "node:path";

export { formatStepAddress, type StepAddress } from "./step-address.js";

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
