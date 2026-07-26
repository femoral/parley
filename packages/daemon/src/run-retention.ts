/**
 * Run retention (#244 / ADR-0016, ADR-0018).
 *
 * Extends the existing task retention sweep: runs *decay* (rows stay, values
 * purge) rather than expire. Pure planning helpers live here so unit tests do
 * not need a daemon; {@link sweepRunRetention} is the thin effectful driver.
 *
 * Rules (authoritative):
 * - Same `retention.days` clock as tasks — no new knob.
 * - Deliverable decay rides the producing task's expiry; declared run
 *   `outputs` are retained (all iterations/slots for each `node.port`).
 * - Run row `purged_at` + scratch-subtree deletion ride terminal + past cutoff.
 * - gc never deletes branches (repo-mode).
 * - Declared `file`/`dir` outputs keep path strings (`purged_at` null); bytes
 *   still die with the workspace.
 */

import fs from "node:fs";
import path from "node:path";
import {
  parseFromRef,
  resolveWorkflow,
  type WorkflowRunOutput,
} from "@useparley/core";
import {
  getRun,
  isRunTerminalState,
  listDeliverablesForTask,
  listExpiredRuns,
  purgeDeliverable,
  purgeRun,
  type DatabaseHandle,
  type DeliverableRow,
  type RunRow,
  type TaskRow,
} from "./db.js";
import { cleanRunScratch, listRunScratchPath } from "./run-workspace.js";

// ---------------------------------------------------------------------------
// Pure planning
// ---------------------------------------------------------------------------

/** Key for a declared output: `"node.port"`. */
export type DeclaredOutputKey = string;

/**
 * Build the set of declared output `(node, port)` keys from a workflow's
 * top-level `outputs` map. `from` is `"node.port"` (parseFromRef). Invalid
 * refs are skipped. Run outputs never fan out (lint), so one key per product.
 */
export function declaredOutputKeys(
  outputs: Readonly<Record<string, Pick<WorkflowRunOutput, "from">>>,
): Set<DeclaredOutputKey> {
  const keys = new Set<DeclaredOutputKey>();
  for (const out of Object.values(outputs)) {
    const parsed = parseFromRef(out.from);
    if (parsed === null || parsed.left === "run") continue;
    keys.add(`${parsed.left}.${parsed.right}`);
  }
  return keys;
}

/** Stable key for a deliverable's producing port (ignores iteration/slot). */
export function deliverableOutputKey(
  d: Pick<DeliverableRow, "node" | "port">,
): DeclaredOutputKey {
  return `${d.node}.${d.port}`;
}

/**
 * Whether a deliverable is a retained declared output.
 *
 * `declared === null` means "definition unavailable → over-retain everything"
 * (safe error; under-retaining would destroy the product).
 */
export function isRetainedDeliverable(
  d: Pick<DeliverableRow, "node" | "port" | "purged_at">,
  declared: ReadonlySet<DeclaredOutputKey> | null,
): boolean {
  // Already purged — nothing left to retain.
  if (d.purged_at !== null) return false;
  if (declared === null) return true;
  return declared.has(deliverableOutputKey(d));
}

export interface DeliverableDecayPlan {
  /** Ids whose value should clear and `purged_at` stamp. */
  toPurge: string[];
  /** Ids kept as-is (declared outputs, or over-retain). */
  toRetain: string[];
}

/**
 * Plan deliverable decay for one producing task: purge scaffolding, retain
 * declared outputs across all iterations/slots. Already-purged rows are
 * ignored (not listed in either bucket).
 */
export function planDeliverableDecay(
  deliverables: readonly DeliverableRow[],
  declared: ReadonlySet<DeclaredOutputKey> | null,
): DeliverableDecayPlan {
  const toPurge: string[] = [];
  const toRetain: string[] = [];
  for (const d of deliverables) {
    if (d.purged_at !== null) continue;
    if (isRetainedDeliverable(d, declared)) {
      toRetain.push(d.id);
    } else {
      toPurge.push(d.id);
    }
  }
  return { toPurge, toRetain };
}

/**
 * A run-owned task must not expire while its run is still live/blocked —
 * purging under an in-flight run would be data loss on a gate held open past
 * the retention window.
 */
export function shouldSkipRunOwnedTaskExpiry(
  task: Pick<TaskRow, "run_id">,
  run: Pick<RunRow, "state"> | undefined,
): boolean {
  if (task.run_id === null) return false;
  if (run === undefined) return false; // orphaned — let task gc proceed
  return !isRunTerminalState(run.state);
}

/**
 * Whether a run row is eligible for `purged_at` + scratch deletion: terminal,
 * past cutoff, not already purged. Mirrors {@link listExpiredRuns} predicate
 * for pure unit tests without SQLite.
 */
export function isRunEligibleForPurge(
  run: Pick<RunRow, "state" | "completed_at" | "updated_at" | "purged_at">,
  cutoffIso: string,
): boolean {
  if (run.purged_at !== null) return false;
  if (!isRunTerminalState(run.state)) return false;
  const clock = run.completed_at ?? run.updated_at;
  return clock <= cutoffIso;
}

// ---------------------------------------------------------------------------
// Definition resolution (best-effort; null ⇒ over-retain)
// ---------------------------------------------------------------------------

export interface ResolveDeclaredOptions {
  /** Parley home (global workflow layer). */
  home: string;
  /**
   * cwd for the local workflow layer. Prefer the run's bound `repo`; fall
   * back to process.cwd() for scratch (same posture as recordRunDeliverables).
   */
  cwd: string;
}

/**
 * Load declared output keys for a run's workflow. Returns `null` when the
 * definition cannot be resolved or parsed — callers over-retain.
 */
export function resolveDeclaredOutputKeys(
  workflowId: string,
  opts: ResolveDeclaredOptions,
): Set<DeclaredOutputKey> | null {
  try {
    const resolved = resolveWorkflow(workflowId, {
      cwd: opts.cwd,
      home: opts.home,
    });
    if (resolved === null) return null;
    return declaredOutputKeys(resolved.definition.outputs);
  } catch {
    return null;
  }
}

export function resolveDeclaredOutputKeysForRun(
  run: Pick<RunRow, "workflow" | "repo">,
  home: string,
): Set<DeclaredOutputKey> | null {
  const cwd = run.repo !== null && run.repo !== "" ? run.repo : process.cwd();
  return resolveDeclaredOutputKeys(run.workflow, { home, cwd });
}

// ---------------------------------------------------------------------------
// Effectful: deliverable decay on task expiry
// ---------------------------------------------------------------------------

export interface DecayTaskDeliverablesResult {
  purged: string[];
  retained: string[];
}

/**
 * Decay deliverables produced by an expired run-owned task: clear value +
 * stamp `purged_at` on every non-declared payload. Declared outputs keep
 * value and `purged_at` null (including `file`/`dir` path strings).
 */
export function decayTaskDeliverables(
  db: DatabaseHandle,
  taskId: string,
  declared: ReadonlySet<DeclaredOutputKey> | null,
  purgedAt: string = new Date().toISOString(),
): DecayTaskDeliverablesResult {
  const rows = listDeliverablesForTask(db, taskId);
  const plan = planDeliverableDecay(rows, declared);
  for (const id of plan.toPurge) {
    purgeDeliverable(db, id, purgedAt);
  }
  return { purged: plan.toPurge, retained: plan.toRetain };
}

// ---------------------------------------------------------------------------
// Effectful: run row purge + scratch subtree deletion
// ---------------------------------------------------------------------------

/** One run considered (or purged) by the retention sweep. */
export interface GcRunEntry {
  run_id: string;
  state: string;
  completed_at: string | null;
  workspace: "repo" | "scratch";
  /** Scratch root removed (or would be); null for repo mode / absent tree. */
  scratch: string | null;
  /** Estimated on-disk bytes reclaimed from the scratch subtree. */
  bytes: number;
}

export interface SweepRunRetentionResult {
  dry_run: boolean;
  runs: GcRunEntry[];
  /** Sum of estimated scratch bytes for purged (or listed) runs. */
  freed_bytes: number;
  failed: { run_id: string; error: string }[];
}

export interface SweepRunRetentionOptions {
  db: DatabaseHandle;
  cutoffIso: string;
  dryRun: boolean;
  /** `~/.parley/runs` — scratch trees live here. */
  runsDir: string;
  /** Optional clock override for `purged_at` stamps (tests). */
  purgedAt?: string;
  /** Injected for tests; defaults to recursive directory size. */
  directoryBytes?: (root: string) => number;
}

/**
 * Purge terminal runs past the retention cutoff: stamp `purged_at`, and for
 * `scratch` mode delete the run subtree (gc is its only scheduled deleter).
 * Never touches branches. Effect first (scratch), then stamp — a failed
 * removal leaves the row so the next sweep retries.
 */
export function sweepRunRetention(
  opts: SweepRunRetentionOptions,
): SweepRunRetentionResult {
  const dryRun = opts.dryRun;
  const directoryBytes = opts.directoryBytes ?? defaultDirectoryBytes;
  const purgedAt = opts.purgedAt ?? new Date().toISOString();
  const expired = listExpiredRuns(opts.db, opts.cutoffIso);

  const runs: GcRunEntry[] = [];
  const failed: { run_id: string; error: string }[] = [];
  let freed = 0;

  for (const run of expired) {
    const scratch =
      run.workspace === "scratch"
        ? listRunScratchPath(opts.runsDir, run.id)
        : null;
    const bytes = scratch !== null ? directoryBytes(scratch) : 0;
    const entry: GcRunEntry = {
      run_id: run.id,
      state: run.state,
      completed_at: run.completed_at,
      workspace: run.workspace,
      scratch,
      bytes,
    };

    if (dryRun) {
      runs.push(entry);
      freed += bytes;
      continue;
    }

    // Scratch first: if removal fails, keep the row un-purged for retry.
    if (run.workspace === "scratch") {
      try {
        cleanRunScratch({ runsDir: opts.runsDir, runId: run.id });
      } catch (err) {
        failed.push({
          run_id: run.id,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
    }

    // Repo mode: checkouts may already be gone at run-terminal; gc never
    // deletes branches. Just stamp the decayed state.
    purgeRun(opts.db, run.id, purgedAt);
    runs.push(entry);
    freed += bytes;
  }

  return { dry_run: dryRun, runs, freed_bytes: freed, failed };
}

/** Recursively sum on-disk bytes; missing paths contribute 0. */
export function defaultDirectoryBytes(root: string): number {
  let total = 0;
  let st: fs.Stats;
  try {
    st = fs.lstatSync(root);
  } catch {
    return 0;
  }
  if (st.isFile() || st.isSymbolicLink()) return st.size;
  if (!st.isDirectory()) return 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    total += defaultDirectoryBytes(path.join(root, entry.name));
  }
  return total;
}

// ---------------------------------------------------------------------------
// Helpers used by the engine task loop
// ---------------------------------------------------------------------------

/**
 * Resolve the run row for a task (if any) and whether task expiry must wait.
 * Convenience for the engine gc loop.
 */
export function runOwnedExpiryGate(
  db: DatabaseHandle,
  task: Pick<TaskRow, "run_id">,
): { run: RunRow | undefined; skip: boolean } {
  if (task.run_id === null) return { run: undefined, skip: false };
  const run = getRun(db, task.run_id);
  return { run, skip: shouldSkipRunOwnedTaskExpiry(task, run) };
}
