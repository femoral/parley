/**
 * Run workspaces — ADR-0018 / #234 (repo) + #235 (scratch).
 *
 * **The run owns every workspace in it.** Per-task auto-remove and per-task
 * naming do not apply. Callable units only — the run engine (#237/#238)
 * decides *when* to invoke them.
 *
 * Layout:
 * ```
 * ~/.parley/worktrees/<repo>/                   workspace: repo
 *   <runId>              run checkout   branch parley/<runId>-<workflow>
 *   <runId>--<taskId>    isolated sibling, branch parley/<runId>/<address>
 *
 * ~/.parley/runs/<runId>/                      workspace: scratch
 *   .parley/tmp/<address>/{in,out}
 *   <address>/                                 isolated sibling (nested)
 *     .parley/tmp/<address>/{in,out}
 * ```
 *
 * In `repo`, branch names carry the address and checkout paths carry the id.
 * In `scratch` there is no branch, so sibling directories are named by address.
 * The tmp path stays addressed in both modes (deliberate redundancy inside a
 * per-sibling dir) so layout and child prompt sentences match.
 *
 * Mode-independent: address formatting (`@useparley/core`), tmp handoff,
 * step context materialization, shared-hub rules. Isolation is read off the
 * sandbox in both modes — only the noun changes (checkout vs directory).
 * Checkpoints and "untouched" terminal retention are **repo-only**; scratch
 * has neither (gc owns deletion — #244).
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  formatStepAddress,
  tmpHandoffPaths,
  type SandboxMode,
  type StepAddress,
} from "@useparley/core";
import { PARLEY_DIR, type ContextFile } from "./context.js";
import {
  finalizeWorktree,
  isWorktreeModified,
  removeWorktree,
  worktreePathFor,
} from "./worktree.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Fixed author identity for checkpoint commits. Parley authors commits but
 * never merges (ADR-0018). Env-scoped on the commit process only — never
 * written into the worktree's git config.
 */
export const CHECKPOINT_AUTHOR = {
  name: "parley",
  email: "parley@useparley.local",
} as const;

/** Filename under `.parley/` marking a shared run checkout (no child.json). */
export const SHARED_RUN_MARKER = "shared-run-workspace";

// ---------------------------------------------------------------------------
// Git helper
// ---------------------------------------------------------------------------

function git(args: string[], cwd?: string, env?: NodeJS.ProcessEnv): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: env ? { ...process.env, ...env } : undefined,
  }).trim();
}

// ---------------------------------------------------------------------------
// Naming — paths carry id, branches carry address
// ---------------------------------------------------------------------------

/** Basename used under `worktrees/` for a source repo. */
export function repoWorktreeBasename(repoRoot: string): string {
  return path.basename(path.resolve(repoRoot));
}

/**
 * Run checkout path: `worktrees/<repo>/<runId>`.
 * Reuses the same parent layout as per-task worktrees.
 */
export function runCheckoutPath(
  worktreesDir: string,
  repoRoot: string,
  runId: string,
): string {
  return worktreePathFor(worktreesDir, repoRoot, runId);
}

/**
 * Isolated sibling checkout path: `worktrees/<repo>/<runId>--<taskId>`.
 * Siblings are siblings on disk because worktrees cannot nest.
 */
export function siblingCheckoutPath(
  worktreesDir: string,
  repoRoot: string,
  runId: string,
  taskId: string,
): string {
  return worktreePathFor(worktreesDir, repoRoot, `${runId}--${taskId}`);
}

/**
 * Run branch: `parley/<runId>-<workflow>`.
 * The `-<workflow>` suffix is mandatory — a ref cannot also be a directory.
 */
export function runBranchName(runId: string, workflow: string): string {
  if (runId === "" || workflow === "") {
    throw new Error("run branch requires non-empty runId and workflow");
  }
  // Workflow ids are directory names; keep the branch legible and git-safe.
  const safe = workflow.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (safe === "") {
    throw new Error(`workflow id ${JSON.stringify(workflow)} is not branch-safe`);
  }
  return `parley/${runId}-${safe}`;
}

/**
 * Sibling branch: `parley/<runId>/<address>` where address is
 * `<node>.<iter>[.<slot>][-r<n>]`.
 */
export function siblingBranchName(runId: string, address: string): string {
  if (runId === "" || address === "") {
    throw new Error("sibling branch requires non-empty runId and address");
  }
  if (address.includes("/") || address.includes("..")) {
    throw new Error(`invalid address for sibling branch: ${JSON.stringify(address)}`);
  }
  return `parley/${runId}/${address}`;
}

/** Build a sibling branch name from a structured step address. */
export function siblingBranchFromAddress(runId: string, addr: StepAddress): string {
  return siblingBranchName(runId, formatStepAddress(addr));
}

// ---------------------------------------------------------------------------
// Create run checkout
// ---------------------------------------------------------------------------

/** What parley records about a run's primary checkout. */
export interface RunCheckoutInfo {
  /** Absolute path to the run checkout. */
  path: string;
  /** Branch `parley/<runId>-<workflow>`. */
  branch: string;
  /** Commit the run branch started at — baseline for "untouched" / empty prune. */
  baseSha: string;
  runId: string;
  workflow: string;
}

export interface CreateRunCheckoutOptions {
  repoRoot: string;
  worktreesDir: string;
  runId: string;
  /** Workflow definition id (becomes the run-branch suffix). */
  workflow: string;
  /** Ref to branch from; null/omit ⇒ repo HEAD. */
  baseRef?: string | null;
}

/**
 * Create the run-owned checkout + branch. The run owns this tree for its whole
 * life; per-task auto-remove must never touch it.
 */
export function createRunCheckout(opts: CreateRunCheckoutOptions): RunCheckoutInfo {
  const branch = runBranchName(opts.runId, opts.workflow);
  const wtPath = runCheckoutPath(opts.worktreesDir, opts.repoRoot, opts.runId);
  fs.mkdirSync(path.dirname(wtPath), { recursive: true });

  git([
    "-C",
    opts.repoRoot,
    "worktree",
    "add",
    "-b",
    branch,
    wtPath,
    opts.baseRef ?? "HEAD",
  ]);
  try {
    const baseSha = finalizeWorktree(opts.repoRoot, wtPath);
    return {
      path: wtPath,
      branch,
      baseSha,
      runId: opts.runId,
      workflow: opts.workflow,
    };
  } catch (err) {
    try {
      git(["-C", opts.repoRoot, "worktree", "remove", "--force", wtPath]);
      git(["-C", opts.repoRoot, "branch", "-D", branch]);
    } catch {
      /* best-effort rollback */
    }
    throw err;
  }
}

/**
 * Resolve a fork's repo-mode base ref: the parent's run-branch tip.
 * Branches are never deleted by retention (ADR-0018), so the ref should
 * outlive the parent's worktree.
 */
export function parentRunBranchTip(
  repoRoot: string,
  parentRunId: string,
  workflow: string,
): string {
  const branch = runBranchName(parentRunId, workflow);
  // Verify the ref exists; throw a plain message the fork path can rewrap.
  git(["-C", repoRoot, "rev-parse", "--verify", branch]);
  return branch;
}

// ---------------------------------------------------------------------------
// Frozen run inputs (fork inherits by copy — ADR-0017 / #242)
// ---------------------------------------------------------------------------

/**
 * Path of the frozen run-inputs file under a run workspace root.
 * Written at run start (when it lands) and copied on fork; never edited by
 * `parley run fork` itself.
 */
export function runInputsFilePath(workspaceRoot: string): string {
  return path.join(workspaceRoot, PARLEY_DIR, "inputs.json");
}

/** Read frozen run-level inputs (`run.<name>`), or `{}` when missing/corrupt. */
export function readRunInputs(
  workspaceRoot: string | null | undefined,
): Record<string, unknown> {
  if (workspaceRoot == null || workspaceRoot === "") return {};
  const file = runInputsFilePath(workspaceRoot);
  if (!fs.existsSync(file)) return {};
  try {
    const raw = fs.readFileSync(file, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Write frozen run-level inputs (atomic-enough for local FS). */
export function writeRunInputs(
  workspaceRoot: string,
  inputs: Readonly<Record<string, unknown>>,
): void {
  const file = runInputsFilePath(workspaceRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(inputs, null, 2)}\n`);
}

/**
 * Copy a `file` or `dir` deliverable into a fork's scratch workspace.
 * Returns the new workspace-relative (or absolute under the child) path.
 * Same copy posture as {@link materializeInputs} for `in/` handoff.
 */
export function copyInheritedPathDeliverable(opts: {
  kind: "file" | "dir";
  /** Path recorded on the parent deliverable row. */
  sourcePath: string;
  /** Parent run workspace root (for resolving relative paths). */
  parentWorkspaceRoot: string | null;
  /** Child run workspace root. */
  childWorkspaceRoot: string;
  /** Address-ish relative destination under `.parley/inherited/`. */
  destRel: string;
}): string {
  const source = resolveExistingReferent(opts.sourcePath, opts.parentWorkspaceRoot);
  if (source === null) {
    throw new Error(
      `inherited ${opts.kind} referent missing on parent: ${opts.sourcePath}`,
    );
  }
  const destAbs = path.join(opts.childWorkspaceRoot, opts.destRel);
  fs.mkdirSync(path.dirname(destAbs), { recursive: true });
  if (opts.kind === "file") {
    if (!fs.statSync(source).isFile()) {
      throw new Error(`inherited file referent is not a file: ${source}`);
    }
    fs.copyFileSync(source, destAbs);
  } else {
    if (!fs.statSync(source).isDirectory()) {
      throw new Error(`inherited dir referent is not a directory: ${source}`);
    }
    fs.cpSync(source, destAbs, { recursive: true });
  }
  // Store a workspace-relative path when possible (materializeInputs accepts both).
  return opts.destRel;
}

function resolveExistingReferent(
  rawPath: string,
  root: string | null,
): string | null {
  if (rawPath === "" || rawPath.includes("\0")) return null;
  const resolved = path.isAbsolute(rawPath)
    ? path.resolve(rawPath)
    : root
      ? path.resolve(root, rawPath)
      : path.resolve(rawPath);
  try {
    if (!fs.existsSync(resolved)) return null;
  } catch {
    return null;
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Isolation — read off the sandbox
// ---------------------------------------------------------------------------

/** Resolved workspace for one step task. */
export interface StepWorkspace {
  /** Absolute working directory the child runs in. */
  path: string;
  /**
   * Branch for an isolated sibling, or null when the task shares the run
   * checkout (read-only sandbox). A run-owned task records worktree/branch
   * null on the task row; this field is for the run's own bookkeeping.
   */
  branch: string | null;
  /** Baseline SHA for untouched / empty-branch checks on this checkout. */
  baseSha: string;
  /**
   * True when this task shares the run checkout with concurrent siblings.
   * Shared checkouts get no `child.json` (ADR-0018).
   */
  shared: boolean;
  /** Address string used for branch / tmp: `<node>.<iter>[.<slot>][-r<n>]`. */
  address: string;
}

export interface ResolveStepWorkspaceOptions {
  repoRoot: string;
  worktreesDir: string;
  runId: string;
  /** Absolute path of the run checkout (from {@link createRunCheckout}). */
  runCheckoutPath: string;
  /** Run branch name (from {@link createRunCheckout}). */
  runBranch: string;
  taskId: string;
  address: StepAddress | string;
  /**
   * Sandbox posture. Isolation is read off this, not opted into (ADR-0018):
   * a `read-only` **fan-out** sibling shares the run checkout; a writable
   * fan-out sibling gets its own checkout cut from the run branch tip at
   * fan-out time. Linear (non-fan-out) steps always use the run checkout.
   */
  sandbox: SandboxMode;
  /**
   * True when this task is a fan-out sibling (authored slot or data fan-out).
   * Defaults to false — linear steps share the run checkout even when
   * writable, so sequential work and checkpoints land on the run branch.
   */
  fanOut?: boolean;
}

/**
 * Whether a fan-out sibling with this sandbox needs its own checkout.
 * Isolation is read off the sandbox, not opted into (ADR-0018).
 */
export function needsIsolatedCheckout(sandbox: SandboxMode): boolean {
  return sandbox !== "read-only";
}

/**
 * Resolve (and create when needed) the working directory for a step task.
 *
 * - Linear step → run checkout (`shared: false`; only one task at a time).
 * - Fan-out + `read-only` → run checkout (`shared: true`; no child.json).
 * - Fan-out + writable → isolated sibling at run-branch tip.
 */
export function resolveStepWorkspace(opts: ResolveStepWorkspaceOptions): StepWorkspace {
  const address =
    typeof opts.address === "string" ? opts.address : formatStepAddress(opts.address);
  const fanOut = opts.fanOut === true;

  if (fanOut && needsIsolatedCheckout(opts.sandbox)) {
    return createSiblingCheckout({
      repoRoot: opts.repoRoot,
      worktreesDir: opts.worktreesDir,
      runId: opts.runId,
      runBranch: opts.runBranch,
      taskId: opts.taskId,
      address,
    });
  }

  const baseSha = git(["-C", opts.runCheckoutPath, "rev-parse", "HEAD"]);
  return {
    path: opts.runCheckoutPath,
    branch: null,
    baseSha,
    // Concurrent RO siblings only — walk-up cannot disambiguate them.
    shared: fanOut && opts.sandbox === "read-only",
    address,
  };
}

export interface CreateSiblingCheckoutOptions {
  repoRoot: string;
  worktreesDir: string;
  runId: string;
  /** Branch to cut from (run branch tip at fan-out time). */
  runBranch: string;
  taskId: string;
  address: string;
}

/**
 * Create an isolated sibling checkout: path `<runId>--<taskId>`, branch
 * `parley/<runId>/<address>`, cut from the run branch tip.
 */
export function createSiblingCheckout(opts: CreateSiblingCheckoutOptions): StepWorkspace {
  const branch = siblingBranchName(opts.runId, opts.address);
  const wtPath = siblingCheckoutPath(
    opts.worktreesDir,
    opts.repoRoot,
    opts.runId,
    opts.taskId,
  );
  fs.mkdirSync(path.dirname(wtPath), { recursive: true });

  // Start point: tip of the run branch at fan-out time.
  const startPoint = opts.runBranch;
  git(["-C", opts.repoRoot, "worktree", "add", "-b", branch, wtPath, startPoint]);
  try {
    const baseSha = finalizeWorktree(opts.repoRoot, wtPath);
    return {
      path: wtPath,
      branch,
      baseSha,
      shared: false,
      address: opts.address,
    };
  } catch (err) {
    try {
      git(["-C", opts.repoRoot, "worktree", "remove", "--force", wtPath]);
      git(["-C", opts.repoRoot, "branch", "-D", branch]);
    } catch {
      /* best-effort rollback */
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Tmp handoff + step context (mode-independent layout)
// ---------------------------------------------------------------------------

/**
 * Ensure `.parley/tmp/<address>/{in,out}` exist under the workspace.
 * Daemon writes `in/`; child writes `out/`; nothing merges (ADR-0018).
 */
export function ensureTmpHandoff(
  workspaceRoot: string,
  address: string,
): { root: string; in: string; out: string } {
  const paths = tmpHandoffPaths(workspaceRoot, address);
  fs.mkdirSync(paths.in, { recursive: true });
  fs.mkdirSync(paths.out, { recursive: true });
  return paths;
}

/**
 * Materialize per-step brief + context under the address-scoped tmp dir:
 * `.parley/tmp/<address>/TASK.md` and `context/`. Shared checkouts cannot use
 * the fixed-path `.parley/TASK.md` (concurrent siblings would race).
 *
 * Also ensures `{in,out}` exist. Mode-independent so scratch can reuse it.
 */
export function materializeStepContext(
  workspaceRoot: string,
  address: string,
  brief: string,
  contexts: ContextFile[] = [],
): { root: string; in: string; out: string } {
  const paths = ensureTmpHandoff(workspaceRoot, address);
  fs.writeFileSync(
    path.join(paths.root, "TASK.md"),
    brief.endsWith("\n") ? brief : `${brief}\n`,
  );
  const contextDir = path.join(paths.root, "context");
  fs.rmSync(contextDir, { recursive: true, force: true });
  if (contexts.length > 0) {
    fs.mkdirSync(contextDir, { recursive: true });
    for (const file of contexts) {
      const name = path.basename(file.name);
      if (name === "" || name === "." || name === "..") continue;
      fs.writeFileSync(path.join(contextDir, name), file.contents);
    }
  }
  return paths;
}

// ---------------------------------------------------------------------------
// child.json — shared checkout rules
// ---------------------------------------------------------------------------

/** Marker written into a shared run checkout (no child.json). */
export interface SharedRunMarker {
  shared: true;
  run_id: string;
}

function sharedMarkerPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, PARLEY_DIR, SHARED_RUN_MARKER);
}

/** Write the shared-run marker so walk-up can fail loudly without child.json. */
export function writeSharedRunMarker(workspaceRoot: string, runId: string): void {
  const root = path.join(workspaceRoot, PARLEY_DIR);
  fs.mkdirSync(root, { recursive: true });
  const body: SharedRunMarker = { shared: true, run_id: runId };
  fs.writeFileSync(
    sharedMarkerPath(workspaceRoot),
    `${JSON.stringify(body)}\n`,
  );
}

/** Read the shared-run marker, or null when absent/unreadable. */
export function readSharedRunMarker(workspaceRoot: string): SharedRunMarker | null {
  try {
    const raw = fs.readFileSync(sharedMarkerPath(workspaceRoot), "utf8");
    const parsed = JSON.parse(raw) as { shared?: unknown; run_id?: unknown };
    if (parsed.shared === true && typeof parsed.run_id === "string" && parsed.run_id !== "") {
      return { shared: true, run_id: parsed.run_id };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Whether `workspaceRoot` is a shared run checkout (concurrent RO siblings).
 * Walk-up from here must not invent a task id.
 */
export function isSharedRunCheckout(workspaceRoot: string): boolean {
  return readSharedRunMarker(workspaceRoot) !== null;
}

/**
 * Materialize `.parley/child.json` only for isolated (non-shared) checkouts.
 * Shared checkouts get **no** `child.json` — concurrent read-only siblings
 * would overwrite each other's fixed path, and walk-up cannot disambiguate
 * them (ADR-0018). Children in a shared checkout must use env
 * (`PARLEY_HUB_URL` / `PARLEY_TASK_ID`).
 */
export function materializeStepChildHub(
  workspaceRoot: string,
  url: string,
  taskId: string,
  shared: boolean,
  runId?: string,
): void {
  if (shared) {
    // Concurrent RO siblings: marker + no child.json. Walk-up must fail
    // loudly rather than guess which sibling owns the hub (ADR-0018).
    writeSharedRunMarker(workspaceRoot, runId ?? "unknown");
    try {
      fs.unlinkSync(path.join(workspaceRoot, PARLEY_DIR, "child.json"));
    } catch {
      /* absent is fine */
    }
    return;
  }
  // Isolated (or sole linear) checkout: ordinary child.json is unambiguous.
  try {
    fs.unlinkSync(sharedMarkerPath(workspaceRoot));
  } catch {
    /* absent is fine */
  }
  const root = path.join(workspaceRoot, PARLEY_DIR);
  fs.mkdirSync(root, { recursive: true });
  const body = JSON.stringify({ url, task_id: taskId });
  fs.writeFileSync(
    path.join(root, "child.json"),
    body.endsWith("\n") ? body : `${body}\n`,
  );
}

/**
 * Error thrown when hub resolution would have to guess among concurrent
 * siblings in a shared run checkout.
 */
export class SharedWorkspaceChildHubError extends Error {
  readonly runId: string | null;

  constructor(runId: string | null) {
    super(
      runId !== null
        ? `shared run workspace (run ${runId}): set PARLEY_HUB_URL and PARLEY_TASK_ID — ` +
            `.parley/child.json is not written for concurrent read-only siblings ` +
            `(walk-up cannot disambiguate them)`
        : `shared run workspace: set PARLEY_HUB_URL and PARLEY_TASK_ID — ` +
            `.parley/child.json is not written for concurrent read-only siblings ` +
            `(walk-up cannot disambiguate them)`,
    );
    this.name = "SharedWorkspaceChildHubError";
    this.runId = runId;
  }
}

/**
 * Walk up from `cwd` looking for `.parley/child.json`. If a shared-run marker
 * is found without a resolvable child.json, fail loudly rather than guessing.
 *
 * Returns null when nothing is found (caller may fall back to other errors).
 * Throws {@link SharedWorkspaceChildHubError} on the shared-checkout case.
 */
export function findChildHubOnDisk(
  cwd: string,
): { url: string; taskId: string } | null {
  for (let dir = path.resolve(cwd); ; ) {
    const childPath = path.join(dir, PARLEY_DIR, "child.json");
    try {
      const raw = fs.readFileSync(childPath, "utf8");
      const parsed = JSON.parse(raw) as { url?: unknown; task_id?: unknown };
      if (
        typeof parsed.url === "string" &&
        parsed.url !== "" &&
        typeof parsed.task_id === "string" &&
        parsed.task_id !== ""
      ) {
        return { url: parsed.url.replace(/\/$/, ""), taskId: parsed.task_id };
      }
    } catch {
      /* missing or unreadable */
    }

    const marker = readSharedRunMarker(dir);
    if (marker !== null) {
      // Shared run checkout with no (usable) child.json — fail loudly.
      throw new SharedWorkspaceChildHubError(marker.run_id);
    }

    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Checkpoint commits
// ---------------------------------------------------------------------------

export interface CheckpointResult {
  /** True when a new commit was created. */
  committed: boolean;
  /** New HEAD SHA when committed; previous HEAD when empty-diff skip. */
  sha: string;
  /** Commit message used (or that would have been used). */
  message: string;
}

/**
 * Author a checkpoint commit on the settling checkout:
 * `parley: <node>.<iteration>` (ADR-0018).
 *
 * Called when a step settles — complete *or* failed. Empty-diff (nothing
 * staged after `git add -A`, excluding parley plumbing via worktree exclude)
 * skips the commit rather than creating an empty one — there is nothing for
 * a retry to rewind from.
 *
 * Author identity is fixed ({@link CHECKPOINT_AUTHOR}); never the user's
 * global git config.
 */
export function checkpointCommit(
  checkoutPath: string,
  node: string,
  iteration: number,
): CheckpointResult {
  const message = `parley: ${node}.${iteration}`;
  const headBefore = git(["-C", checkoutPath, "rev-parse", "HEAD"]);

  // Stage everything visible; `.parley/` is worktree-excluded so plumbing
  // never enters the index.
  git(["-C", checkoutPath, "add", "-A"]);

  let hasStaged = true;
  try {
    // Exit 0 = no diff; exit 1 = has diff. Other exits are real errors.
    execFileSync("git", ["-C", checkoutPath, "diff", "--cached", "--quiet"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    hasStaged = false;
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 1) {
      hasStaged = true;
    } else {
      throw err;
    }
  }

  if (!hasStaged) {
    return { committed: false, sha: headBefore, message };
  }

  const authorEnv = {
    GIT_AUTHOR_NAME: CHECKPOINT_AUTHOR.name,
    GIT_AUTHOR_EMAIL: CHECKPOINT_AUTHOR.email,
    GIT_COMMITTER_NAME: CHECKPOINT_AUTHOR.name,
    GIT_COMMITTER_EMAIL: CHECKPOINT_AUTHOR.email,
  };
  git(["-C", checkoutPath, "commit", "-m", message], undefined, authorEnv);
  const sha = git(["-C", checkoutPath, "rev-parse", "HEAD"]);
  return { committed: true, sha, message };
}

// ---------------------------------------------------------------------------
// Discovery of run-owned checkouts
// ---------------------------------------------------------------------------

/**
 * List absolute paths of checkouts the run owns under `worktreesDir`:
 * the run checkout `<runId>` and any siblings `<runId>--*`.
 */
export function listRunCheckoutPaths(
  worktreesDir: string,
  repoRoot: string,
  runId: string,
): string[] {
  const parent = path.join(worktreesDir, repoWorktreeBasename(repoRoot));
  const out: string[] = [];
  let entries: string[];
  try {
    entries = fs.readdirSync(parent);
  } catch {
    return out;
  }
  const prefix = `${runId}--`;
  for (const name of entries) {
    if (name === runId || name.startsWith(prefix)) {
      out.push(path.join(parent, name));
    }
  }
  return out.sort();
}

/**
 * List local branch names the run owns:
 * - run branch `parley/<runId>-*`
 * - sibling branches `parley/<runId>/*`
 */
/** Strip the `*` (HEAD) / `+` (other worktree) markers from `git branch` lines. */
function parseBranchListLine(line: string): string {
  return line.replace(/^[+*]?\s+/, "").trim();
}

export function listRunBranches(repoRoot: string, runId: string): string[] {
  const runBranches = git(["-C", repoRoot, "branch", "--list", `parley/${runId}-*`])
    .split("\n")
    .map(parseBranchListLine)
    .filter((l) => l !== "");
  const siblingBranches = git(["-C", repoRoot, "branch", "--list", `parley/${runId}/*`])
    .split("\n")
    .map(parseBranchListLine)
    .filter((l) => l !== "");
  return [...new Set([...runBranches, ...siblingBranches])].sort();
}

/** True when branch tip equals `baseSha` (provably empty of new commits). */
export function isBranchProvablyEmpty(
  repoRoot: string,
  branch: string,
  baseSha: string,
): boolean {
  try {
    const tip = git(["-C", repoRoot, "rev-parse", branch]);
    return tip === baseSha;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

export interface CleanRunResult {
  /** Checkout paths successfully removed. */
  removed: string[];
  /** Branches deleted because tip == recorded base. */
  prunedBranches: string[];
  /** Branches kept (have commits beyond base, or unknown base). */
  keptBranches: string[];
}

export interface CleanRunOptions {
  repoRoot: string;
  worktreesDir: string;
  runId: string;
  /**
   * Map of branch name → base SHA for empty-prune. Branches not in the map
   * are never pruned (unknown baseline). The run branch base is the run's
   * original baseSha; sibling bases are their cut-from tip.
   */
  branchBases?: Record<string, string>;
}

/**
 * `parley clean <run>`: remove every checkout the run owns, then prune only
 * provably-empty branches (tip == base). Non-empty branches are kept —
 * parley never merges and never destroys committed work via clean.
 */
export function cleanRunCheckouts(opts: CleanRunOptions): CleanRunResult {
  const paths = listRunCheckoutPaths(opts.worktreesDir, opts.repoRoot, opts.runId);
  const removed: string[] = [];
  for (const wt of paths) {
    try {
      removeWorktree(opts.repoRoot, wt);
      removed.push(wt);
    } catch {
      // If git refuses, try force-rm of a vanished/broken path then prune.
      if (fs.existsSync(wt)) {
        fs.rmSync(wt, { recursive: true, force: true });
        try {
          git(["-C", opts.repoRoot, "worktree", "prune"]);
        } catch {
          /* best-effort */
        }
        removed.push(wt);
      }
    }
  }
  const prune = pruneEmptyRunBranches(opts);
  return {
    removed,
    prunedBranches: prune.prunedBranches,
    keptBranches: prune.keptBranches,
  };
}

export interface RunTerminalRetentionOptions extends CleanRunOptions {
  /**
   * Per-checkout baseline for the untouched check. Keys are absolute paths.
   * Checkouts not listed are treated as modified (kept).
   */
  checkoutBases?: Record<string, string>;
}

export interface RunTerminalRetentionResult {
  removed: string[];
  retained: string[];
  prunedBranches: string[];
  keptBranches: string[];
}

/**
 * At run terminal: remove every checkout the run owns *if untouched*, and
 * prune only provably-empty branches (tip == base). gc never deletes branches.
 *
 * Nothing auto-removes at task settle inside a run — this is the only
 * checkout reclamation path besides explicit `cleanRunCheckouts`.
 */
export function retainRunCheckoutsAtTerminal(
  opts: RunTerminalRetentionOptions,
): RunTerminalRetentionResult {
  const paths = listRunCheckoutPaths(opts.worktreesDir, opts.repoRoot, opts.runId);
  const bases = opts.checkoutBases ?? {};
  const removed: string[] = [];
  const retained: string[] = [];

  for (const wt of paths) {
    const base = bases[wt];
    if (base === undefined) {
      retained.push(wt);
      continue;
    }
    if (isWorktreeModified(wt, base)) {
      retained.push(wt);
      continue;
    }
    try {
      removeWorktree(opts.repoRoot, wt);
      removed.push(wt);
    } catch {
      retained.push(wt);
    }
  }

  const prune = pruneEmptyRunBranches(opts);
  return {
    removed,
    retained,
    prunedBranches: prune.prunedBranches,
    keptBranches: prune.keptBranches,
  };
}

/**
 * Delete run-owned branches whose tip still equals their recorded base.
 * Branches without a known base are kept. Never called from gc.
 */
export function pruneEmptyRunBranches(opts: CleanRunOptions): CleanRunResult {
  const bases = opts.branchBases ?? {};
  const branches = listRunBranches(opts.repoRoot, opts.runId);
  const prunedBranches: string[] = [];
  const keptBranches: string[] = [];

  for (const branch of branches) {
    const base = bases[branch];
    if (base === undefined) {
      keptBranches.push(branch);
      continue;
    }
    if (!isBranchProvablyEmpty(opts.repoRoot, branch, base)) {
      keptBranches.push(branch);
      continue;
    }
    try {
      // Refuse to delete if a checkout still has it checked out.
      git(["-C", opts.repoRoot, "branch", "-D", branch]);
      prunedBranches.push(branch);
    } catch {
      keptBranches.push(branch);
    }
  }

  return { removed: [], prunedBranches, keptBranches };
}

// ===========================================================================
// Scratch mode — parley-owned plain directory, no git (ADR-0018 / #235)
// ===========================================================================
//
// A scratch run drops **git**, not the workspace. Nesting is available because
// there are no worktrees to collide; a run's whole footprint is one deletable
// subtree under `~/.parley/runs/<runId>/`.
//
// No checkpoints. No auto-removal at task settle or run terminal — gc owns
// deletion (#244). `cleanRunScratch` is the on-demand escape hatch
// (`parley clean <run>`).

// ---------------------------------------------------------------------------
// Naming — paths carry the address (there is no branch)
// ---------------------------------------------------------------------------

/**
 * Run workspace path: `runs/<runId>/`.
 * Root of the run's whole scratch footprint.
 */
export function runScratchPath(runsDir: string, runId: string): string {
  if (runId === "" || runId.includes("/") || runId.includes("..") || runId.includes("\\")) {
    throw new Error(`invalid runId for scratch path: ${JSON.stringify(runId)}`);
  }
  return path.join(runsDir, runId);
}

/**
 * Isolated sibling path: `runs/<runId>/<address>/`.
 * Named by **address**, not task id — with no branch the path is the only
 * place the address can live (ADR-0018).
 */
export function siblingScratchPath(
  runsDir: string,
  runId: string,
  address: string,
): string {
  if (runId === "" || runId.includes("/") || runId.includes("..") || runId.includes("\\")) {
    throw new Error(`invalid runId for sibling scratch path: ${JSON.stringify(runId)}`);
  }
  if (
    address === "" ||
    address.includes("/") ||
    address.includes("..") ||
    address.includes("\\")
  ) {
    throw new Error(`invalid address for sibling scratch path: ${JSON.stringify(address)}`);
  }
  return path.join(runsDir, runId, address);
}

// ---------------------------------------------------------------------------
// Run-start preflight
// ---------------------------------------------------------------------------

/**
 * Thrown when a `workspace: scratch` run is started with `--base` / `baseRef`.
 * Scratch has no branch and no base commit (ADR-0018).
 */
export class ScratchBaseRefNotAllowedError extends Error {
  readonly baseRef: string;

  constructor(baseRef: string) {
    super(
      `workspace: scratch refuses --base (got ${JSON.stringify(baseRef)}): ` +
        `a scratch run has no git branch and no base commit`,
    );
    this.name = "ScratchBaseRefNotAllowedError";
    this.baseRef = baseRef;
  }
}

/**
 * Thrown when a `workspace: repo` run is started outside a git repository.
 * Symmetric preflight seam for the engine (ADR-0018).
 */
export class RepoModeRequiresRepoError extends Error {
  constructor() {
    super(
      `workspace: repo requires a git repository: start the run from inside a ` +
        `repo, or use a workflow with workspace: scratch`,
    );
    this.name = "RepoModeRequiresRepoError";
  }
}

/**
 * Run-start preflight for `workspace: scratch` (ADR-0018):
 * - Ignores any ambient git repo (caller records `repo: null`).
 * - Refuses `--base` / `baseRef`.
 *
 * Does not create directories. Call before {@link createRunScratchWorkspace}.
 */
export function preflightScratchRun(opts: { baseRef?: string | null }): void {
  if (opts.baseRef != null && opts.baseRef !== "") {
    throw new ScratchBaseRefNotAllowedError(opts.baseRef);
  }
}

/**
 * Run-start preflight for `workspace: repo` (ADR-0018): fails when no repo
 * root is available. The engine maps this to a blocked/failed run start.
 */
export function preflightRepoRun(opts: { repoRoot: string | null | undefined }): void {
  if (opts.repoRoot == null || opts.repoRoot === "") {
    throw new RepoModeRequiresRepoError();
  }
}

// ---------------------------------------------------------------------------
// Create run workspace
// ---------------------------------------------------------------------------

/** What parley records about a scratch run's primary workspace. */
export interface RunScratchInfo {
  /** Absolute path: `runs/<runId>/`. */
  path: string;
  runId: string;
  /**
   * Always null — scratch ignores any ambient repo and records `repo` null
   * even when started inside one (ADR-0018).
   */
  repo: null;
}

export interface CreateRunScratchOptions {
  /** Absolute `~/.parley/runs` (or test override). */
  runsDir: string;
  runId: string;
  /**
   * Forbidden on scratch. Presence fails preflight — scratch has no base
   * commit and no branch (ADR-0018).
   */
  baseRef?: string | null;
}

/**
 * Create the run-owned scratch workspace: an empty directory at
 * `runs/<runId>/`. No git. The run owns this tree for its whole life;
 * per-task auto-remove must never touch it.
 *
 * Always records `repo: null` regardless of whether the orchestrator was
 * sitting inside a git repo when the run started.
 */
export function createRunScratchWorkspace(
  opts: CreateRunScratchOptions,
): RunScratchInfo {
  preflightScratchRun({ baseRef: opts.baseRef });
  const wsPath = runScratchPath(opts.runsDir, opts.runId);
  if (fs.existsSync(wsPath)) {
    throw new Error(
      `scratch run workspace already exists: ${wsPath}`,
    );
  }
  fs.mkdirSync(wsPath, { recursive: true });
  return {
    path: wsPath,
    runId: opts.runId,
    repo: null,
  };
}

// ---------------------------------------------------------------------------
// Isolation — same rule as repo, noun is directory
// ---------------------------------------------------------------------------

/** Resolved workspace for one step task in scratch mode. */
export interface ScratchStepWorkspace {
  /** Absolute working directory the child runs in. */
  path: string;
  /**
   * Always null — scratch has no git. Present so call sites can share a
   * shape with {@link StepWorkspace} without inventing a mode flag on every
   * field.
   */
  branch: null;
  /**
   * True when this task shares the run workspace with concurrent siblings.
   * Shared workspaces get no `child.json` (ADR-0018).
   */
  shared: boolean;
  /** Address string used for sibling path / tmp: `<node>.<iter>[.<slot>][-r<n>]`. */
  address: string;
}

export interface ResolveScratchStepWorkspaceOptions {
  runsDir: string;
  runId: string;
  /** Absolute path of the run workspace (from {@link createRunScratchWorkspace}). */
  runWorkspacePath: string;
  address: StepAddress | string;
  /**
   * Sandbox posture. Isolation is read off this, not opted into (ADR-0018):
   * a `read-only` **fan-out** sibling shares the run workspace; a writable
   * fan-out sibling gets its own empty directory named by address.
   * Linear (non-fan-out) steps always use the run workspace.
   */
  sandbox: SandboxMode;
  /**
   * True when this task is a fan-out sibling (authored slot or data fan-out).
   * Defaults to false — linear steps share the run workspace even when
   * writable.
   */
  fanOut?: boolean;
}

/**
 * Resolve (and create when needed) the working directory for a scratch step.
 *
 * - Linear step → run workspace (`shared: false`; only one task at a time).
 * - Fan-out + `read-only` → run workspace (`shared: true`; no child.json).
 * - Fan-out + writable → isolated empty sibling at `runs/<runId>/<address>/`.
 *
 * Reuses {@link needsIsolatedCheckout} — only the noun changes from repo mode.
 */
export function resolveScratchStepWorkspace(
  opts: ResolveScratchStepWorkspaceOptions,
): ScratchStepWorkspace {
  const address =
    typeof opts.address === "string" ? opts.address : formatStepAddress(opts.address);
  const fanOut = opts.fanOut === true;

  if (fanOut && needsIsolatedCheckout(opts.sandbox)) {
    return createSiblingScratchDir({
      runsDir: opts.runsDir,
      runId: opts.runId,
      address,
    });
  }

  return {
    path: opts.runWorkspacePath,
    branch: null,
    // Concurrent RO siblings only — walk-up cannot disambiguate them.
    shared: fanOut && opts.sandbox === "read-only",
    address,
  };
}

export interface CreateSiblingScratchOptions {
  runsDir: string;
  runId: string;
  address: string;
}

/**
 * Create an isolated sibling directory: `runs/<runId>/<address>/`, starting
 * empty. Nested under the run workspace so the whole footprint is one
 * deletable subtree. Retries append `-r<n>` on the address and thus the path.
 *
 * No git. No copy from the parent. Tmp handoff under this dir still uses the
 * addressed layout (`.parley/tmp/<address>/{in,out}`) so the child's prompt
 * sentence matches repo mode.
 */
export function createSiblingScratchDir(
  opts: CreateSiblingScratchOptions,
): ScratchStepWorkspace {
  const sibPath = siblingScratchPath(opts.runsDir, opts.runId, opts.address);
  if (fs.existsSync(sibPath)) {
    // Idempotent re-resolve of an existing sibling is fine; a colliding
    // non-directory or a half-built path from another address would be a bug.
    if (!fs.statSync(sibPath).isDirectory()) {
      throw new Error(`sibling scratch path exists and is not a directory: ${sibPath}`);
    }
  } else {
    fs.mkdirSync(sibPath, { recursive: true });
  }
  return {
    path: sibPath,
    branch: null,
    shared: false,
    address: opts.address,
  };
}

// ---------------------------------------------------------------------------
// Discovery + clean (on-demand only — no terminal auto-removal)
// ---------------------------------------------------------------------------

/**
 * Absolute path of the scratch run workspace if it exists, else null.
 * Nested siblings live under this single root.
 */
export function listRunScratchPath(
  runsDir: string,
  runId: string,
): string | null {
  const p = runScratchPath(runsDir, runId);
  try {
    if (fs.statSync(p).isDirectory()) return p;
  } catch {
    /* absent */
  }
  return null;
}

/**
 * List nested isolated sibling directories under the run workspace (direct
 * children that look like addresses). Does not recurse; does not include the
 * run root itself. Useful for bookkeeping; clean removes the whole subtree.
 */
export function listScratchSiblingPaths(
  runsDir: string,
  runId: string,
): string[] {
  const root = runScratchPath(runsDir, runId);
  let entries: string[];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of entries) {
    // Skip parley plumbing; siblings are address-named (node.iter…).
    if (name === ".parley" || name.startsWith(".")) continue;
    const full = path.join(root, name);
    try {
      if (fs.statSync(full).isDirectory()) out.push(full);
    } catch {
      /* race */
    }
  }
  return out.sort();
}

export interface CleanRunScratchResult {
  /** Paths successfully removed (the run root when present). */
  removed: string[];
}

/**
 * `parley clean <run>` for scratch: remove the entire `runs/<runId>/` subtree
 * (run workspace + every nested sibling). On-demand escape hatch only.
 *
 * There is **no** terminal auto-removal for scratch — no "untouched"
 * predicate without git, and inventing a second one was rejected (ADR-0018).
 * gc is the only scheduled owner of deletion (#244).
 */
export function cleanRunScratch(opts: {
  runsDir: string;
  runId: string;
}): CleanRunScratchResult {
  const root = runScratchPath(opts.runsDir, opts.runId);
  if (!fs.existsSync(root)) {
    return { removed: [] };
  }
  fs.rmSync(root, { recursive: true, force: true });
  return { removed: [root] };
}

