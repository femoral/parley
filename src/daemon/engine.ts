import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import type { HomePaths } from "../home.js";
import type {
  HubInfo,
  SandboxMode,
  SpawnPlan,
  TaskSpec,
  VendorAdapter,
  VendorEvent,
} from "./adapters/types.js";
import { VENDOR_DIAG_PREFIX } from "./adapters/types.js";
import {
  bumpTaskSeq,
  currentSeq,
  getTask,
  insertTask,
  listTasks,
  nextQuestionId,
  nextTaskId,
  resolveTask,
  updateTask,
  SETTLED_STATES,
  TERMINAL_STATES,
  type DatabaseHandle,
  type TaskPatch,
  type TaskRow,
} from "./db.js";
import { contextPointers, materializeContext, type ContextFile } from "./context.js";
import { taskLogDir } from "./discovery.js";
import {
  assertValidSchema,
  DEFAULT_REPORT_SCHEMA,
  parseJsonColumn,
  summarizeReportSchema,
  validateReport,
  type JsonSchema,
  type Report,
} from "./report.js";
import { formatDuration } from "../util/time.js";
import {
  commonGitDir,
  createWorktree,
  excludeMaterializedFiles,
  gitDir,
  isWorktreeModified,
  removeWorktree,
  repoRoot,
} from "./worktree.js";

/** Correlation header children send on every MCP request (ADR-0003). */
export const TASK_HEADER = "x-parley-task";

/**
 * States a long-poll waiter wakes on — a task has produced a CLI event (spec
 * §3). Terminal outcomes plus `awaiting_answer` (a question) and `stalled`.
 */
function isEventState(state: string): boolean {
  return TERMINAL_STATES.has(state) || state === "awaiting_answer" || state === "stalled";
}

/** Default `--answer-timeout`: 30 minutes (spec §2). */
export const DEFAULT_ANSWER_TIMEOUT_MS = 30 * 60 * 1000;

/** How long a stopped child gets to exit on SIGTERM before SIGKILL. */
const CHILD_STOP_GRACE_MS = 2_000;

/** What an `ask_orchestrator` call settles with: an answer, or a tool error. */
type AskOutcome = { answer: string } | { error: string };

/**
 * A blocking `ask_orchestrator` call parked in daemon memory until answered —
 * or until `timer` fires the answer-timeout and stalls the task (#18).
 */
interface PendingQuestion {
  questionId: string;
  resolve: (outcome: AskOutcome) => void;
  timer: NodeJS.Timeout;
}

/**
 * One recorded task-state transition (#34): the global `seq` it was assigned,
 * the task that changed, and the state it moved to. Appended to the engine's
 * in-memory event log so `parley watch`'s multi-task long-poll can replay a
 * transition that happened after a caller's `since`.
 */
export interface Transition {
  seq: number;
  task_id: string;
  state: string;
}

/** A caller mistake surfaced to the CLI plane as HTTP 400 → exit code 2. */
export class DelegateError extends Error {
  override readonly name = "DelegateError";
}

/** Best-effort message from a thrown value (git errors arrive as `Error`). */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface DelegateRequest {
  prompt: string;
  vendor: string;
  model: string | null;
  /** Opaque reasoning-effort string (spec §9); passed through to the vendor unchanged. */
  effort: string | null;
  name: string | null;
  /** The invocation directory: an explicit `--cwd`, else the caller's cwd. */
  cwd: string;
  /**
   * Whether to create an isolated worktree (default path). False when the
   * caller passed `--cwd`, which runs the child directly in that directory.
   */
  useWorktree: boolean;
  /** Ref to branch the worktree from; null means the repo's current HEAD. */
  baseRef: string | null;
  /** Normalized sandbox posture (spec §8); defaults to `workspace`. */
  sandbox: SandboxMode;
  /** Whether the child may reach the network (ADR-0006 default: true). */
  network: boolean;
  /** `--answer-timeout` in ms; null means the daemon default (30m). */
  answerTimeoutMs: number | null;
  /**
   * Caller-supplied report schema (`--report-schema`); null uses parley's
   * default. Arbitrary parsed JSON — validated as a JSON Schema before the task
   * is created, so a non-schema is rejected here (→ exit 2).
   */
  reportSchema: unknown;
  /**
   * `--context` files, read by the CLI and shipped by value (name + contents).
   * Materialized under `.parley/context/` in the workspace (spec §7); the CLI
   * has already rejected an unreadable file (→ exit 2) before this point.
   */
  contexts: ContextFile[];
}

/**
 * The task engine: owns task rows, spawns vendor children through their
 * adapters, captures raw vendor streams as per-task JSONL, applies lifecycle
 * transitions, and wakes long-poll waiters on terminal states.
 *
 * Crash story (spec §3): children spawn into the daemon's process group and
 * die with it; the startup sweep (`sweepInterruptedTasks`, run by the server
 * before the engine takes requests) marks tasks recorded live as `stalled`.
 */
export class TaskEngine {
  private readonly waiters = new Map<string, Set<() => void>>();
  /**
   * Append-only in-memory log of every task-state transition this daemon has
   * recorded (#34), in seq order. `parley watch`'s multi-task long-poll scans it
   * to replay a transition after a caller's `since`, or blocks on `eventWaiters`
   * until the next one. Lost on restart — a reconnecting watcher just resumes
   * from the current seq; nothing before connect is replayed (spec §3).
   */
  private readonly transitions: Transition[] = [];
  /** Long-poll watchers (`parley watch`) parked until the next transition. */
  private readonly eventWaiters = new Set<() => void>();
  /**
   * Live `ask_orchestrator` calls, keyed by task id. The value's `resolve`
   * unblocks the child's MCP request with the answer text (or a tool error on
   * stall). One per task by construction (the child blocks while asking).
   * These live only in memory — a daemon restart abandons them; the startup
   * sweep marks their tasks `stalled` and `parley answer` resumes them.
   */
  private readonly pending = new Map<string, PendingQuestion>();
  /**
   * Live vendor children, keyed by task id — the handle `cancel` uses to
   * terminate a running child; also stopped on stall and daemon exit.
   */
  private readonly children = new Map<string, ChildProcess>();
  /**
   * Set once the daemon is going down: child exits stop being lifecycle events
   * (their tasks stay recorded `running`/`awaiting_answer`, and the *next*
   * daemon's startup sweep marks them `stalled` — the crash story, spec §3)
   * and must not touch the database, which is closing.
   */
  private shuttingDown = false;
  /** MCP endpoint port — published by the server once it has bound. */
  private hubPort: number | null = null;

  constructor(
    private readonly db: DatabaseHandle,
    private readonly paths: HomePaths,
    private readonly adapters: Map<string, VendorAdapter>,
  ) {}

  setHubPort(port: number): void {
    this.hubPort = port;
  }

  list(): TaskRow[] {
    return listTasks(this.db);
  }

  get(id: string): TaskRow | undefined {
    return getTask(this.db, id);
  }

  resolve(ref: string): TaskRow | undefined {
    return resolveTask(this.db, ref);
  }

  /** The directory holding a task's captured vendor output (the diagnostics reference). */
  logDir(taskId: string): string {
    return taskLogDir(this.paths, taskId);
  }

  /**
   * Create a task (pending) and kick off its background run. Returns the row
   * immediately — `--wait` callers long-poll `/tasks/:id/events` afterwards.
   */
  delegate(request: DelegateRequest): TaskRow {
    const adapter = this.adapters.get(request.vendor);
    if (!adapter) {
      const known = [...this.adapters.keys()].join(", ");
      throw new DelegateError(`unknown vendor: ${request.vendor} (known: ${known})`);
    }
    // Ids and names are interchangeable task refs, so an id-shaped name would
    // shadow (or be shadowed by) a real task id in `resolveTask`.
    if (request.name !== null && /^t\d+$/.test(request.name)) {
      throw new DelegateError(`name must not look like a task id: ${request.name}`);
    }
    // A bad `--report-schema` is rejected before the task exists (spec §5): the
    // caller supplied it, so a non-schema is their mistake (→ exit 2).
    if (request.reportSchema !== null) {
      try {
        assertValidSchema(request.reportSchema);
      } catch (err) {
        throw new DelegateError(`invalid report schema: ${errorMessage(err)}`);
      }
    }
    const cwd = path.resolve(request.cwd);
    let isDir = false;
    try {
      isDir = fs.statSync(cwd).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) {
      throw new DelegateError(`cwd is not a directory: ${cwd}`);
    }

    // `--cwd` runs the child directly in that directory (no worktree); the
    // default path creates a parley-owned worktree from the repo's HEAD.
    let repo = cwd;
    let workingDir = cwd;
    let worktreePath: string | null = null;
    let branch: string | null = null;
    let baseSha: string | null = null;

    // The branch name embeds the id, so the id is allocated before the row.
    const id = nextTaskId(this.db);

    if (request.useWorktree) {
      const root = repoRoot(cwd);
      if (root === null) {
        throw new DelegateError(
          `not a git repository: ${cwd} — pass --cwd to delegate outside a worktree`,
        );
      }
      let info;
      try {
        info = createWorktree({
          repoRoot: root,
          worktreesDir: this.paths.worktrees,
          taskId: id,
          name: request.name,
          baseRef: request.baseRef,
        });
      } catch (err) {
        throw new DelegateError(`failed to create worktree: ${errorMessage(err)}`);
      }
      repo = root;
      workingDir = info.path;
      worktreePath = info.path;
      branch = info.branch;
      baseSha = info.baseSha;
    }

    // Task context rides the workspace, not the prompt (spec §7): the brief and
    // any `--context` files land under `.parley/`, which the worktree already
    // git-excludes. Roll a worktree back if this fails so nothing leaks untracked.
    try {
      materializeContext(workingDir, request.prompt, request.contexts);
    } catch (err) {
      if (worktreePath !== null) {
        try {
          removeWorktree(repo, worktreePath);
        } catch {
          /* best-effort rollback; the materialization error is the one that matters */
        }
      }
      throw new DelegateError(`failed to materialize task context: ${errorMessage(err)}`);
    }

    const row = insertTask(this.db, {
      id,
      name: request.name,
      vendor: request.vendor,
      model: request.model,
      effort: request.effort,
      repo,
      cwd: workingDir,
      prompt: request.prompt,
      worktree: worktreePath,
      branch,
      base_sha: baseSha,
      sandbox: request.sandbox,
      network: request.network,
      answer_timeout_ms: request.answerTimeoutMs,
      report_schema:
        request.reportSchema !== null ? JSON.stringify(request.reportSchema) : null,
    });

    void this.run(row, adapter).catch((err: unknown) => {
      this.fail(row.id, `task runner crashed: ${String(err)}`);
    });
    return row;
  }

  /**
   * Remove a task's worktree (keeping its branch — parley never merges). Refuses
   * tasks that are not in a terminal state. A `--cwd` task (no worktree) is a
   * no-op. Throws `DelegateError` (→ exit 2) on refusal or an unknown ref.
   */
  clean(ref: string): { task_id: string; worktree: string | null; removed: boolean } {
    const task = resolveTask(this.db, ref);
    if (!task) throw new DelegateError(`no such task: ${ref}`);
    if (!TERMINAL_STATES.has(task.state)) {
      throw new DelegateError(
        `task ${task.id} is ${task.state}; refusing to clean a task that is still running`,
      );
    }
    if (task.worktree === null) return { task_id: task.id, worktree: null, removed: false };
    try {
      this.removeTaskWorktree(task);
    } catch (err) {
      throw new DelegateError(`failed to remove worktree: ${errorMessage(err)}`);
    }
    return { task_id: task.id, worktree: task.worktree, removed: true };
  }

  /**
   * Sweep worktrees for every terminal-state task; running tasks are skipped.
   * Removal failures are reported (not silently dropped) and retried next sweep.
   */
  cleanAllTerminal(): {
    cleaned: { task_id: string; worktree: string }[];
    failed: { task_id: string; worktree: string; error: string }[];
  } {
    const cleaned: { task_id: string; worktree: string }[] = [];
    const failed: { task_id: string; worktree: string; error: string }[] = [];
    for (const task of listTasks(this.db)) {
      if (!TERMINAL_STATES.has(task.state) || task.worktree === null) continue;
      try {
        this.removeTaskWorktree(task);
        cleaned.push({ task_id: task.id, worktree: task.worktree });
      } catch (err) {
        failed.push({ task_id: task.id, worktree: task.worktree, error: errorMessage(err) });
      }
    }
    return { cleaned, failed };
  }

  /**
   * Remove a task's worktree from disk and clear its `worktree` column (the
   * branch is always kept). Throws on git failure — callers choose whether
   * that's fatal (clean), reported (sweep), or best-effort (auto-remove).
   */
  private removeTaskWorktree(task: TaskRow): void {
    if (task.worktree === null) return;
    if (task.repo === null) {
      // Worktree tasks always record their source repo; a null here is a
      // corrupt row, and silently nulling the worktree would orphan the dir.
      throw new Error(`task ${task.id} has a worktree but no repo recorded`);
    }
    removeWorktree(task.repo, task.worktree);
    updateTask(this.db, task.id, { worktree: null });
  }

  /**
   * Handle a `submit_report` MCP call for a task. Returns validation errors
   * (bounced to the child as a tool error) or null on acceptance, which
   * completes the task.
   */
  submitReport(taskId: string, payload: unknown): string[] | null {
    const task = getTask(this.db, taskId);
    if (!task) return [`unknown task: ${taskId}`];
    // A settled task's child is gone (a stalled one was stopped) — a
    // straggling report must not move the task out from under stall/resume.
    if (SETTLED_STATES.has(task.state)) {
      return [`task ${taskId} is already ${task.state}`];
    }
    const schema =
      parseJsonColumn<JsonSchema>(task.report_schema) ?? DEFAULT_REPORT_SCHEMA;
    const errors = validateReport(payload, schema);
    if (errors.length > 0) return errors;

    // A misbehaving child may report over its own outstanding question —
    // settle the parked call so its timer cannot stall a completed task.
    this.settlePending(taskId, { error: `task ${taskId} completed` });
    updateTask(this.db, taskId, {
      state: "completed",
      report: JSON.stringify(payload as Report),
      completed_at: new Date().toISOString(),
      question_id: null,
      question: null,
    });
    this.transitioned(taskId);
    return null;
  }

  /**
   * Settle and forget a task's parked `ask_orchestrator` call, if any: disarm
   * its answer-timeout and resolve the child's blocked MCP request with
   * `outcome`. Returns true when a call was parked.
   */
  private settlePending(taskId: string, outcome: AskOutcome): boolean {
    const pending = this.pending.get(taskId);
    if (!pending) return false;
    this.pending.delete(taskId);
    clearTimeout(pending.timer);
    pending.resolve(outcome);
    return true;
  }

  /**
   * Handle an `ask_orchestrator` MCP call: record the question, move the task
   * to `awaiting_answer`, wake long-poll waiters, and block until `parley
   * answer` delivers the text (ADR-0003). Returns the answer as the tool
   * result, or an error string (bounced to the child as a tool error).
   *
   * Unanswered at the task's `--answer-timeout` (default 30m), the question
   * stays durably recorded on the row, the child is stopped, and the task
   * moves to `stalled` (spec §2) — the parked call settles with a tool error.
   */
  async askOrchestrator(taskId: string, question: string): Promise<AskOutcome> {
    const task = getTask(this.db, taskId);
    if (!task) return { error: `unknown task: ${taskId}` };
    if (SETTLED_STATES.has(task.state)) {
      return { error: `task ${taskId} is already ${task.state}` };
    }
    // One outstanding question per task holds by construction (the child blocks
    // while asking); guard anyway against a misbehaving child.
    if (this.pending.has(taskId)) {
      return { error: `task ${taskId} already has a pending question` };
    }

    const questionId = nextQuestionId(this.db);
    updateTask(this.db, taskId, {
      state: "awaiting_answer",
      question_id: questionId,
      question,
    });
    return new Promise<AskOutcome>((resolve) => {
      const timeoutMs = task.answer_timeout_ms ?? DEFAULT_ANSWER_TIMEOUT_MS;
      const timer = setTimeout(() => {
        this.stallOnAnswerTimeout(taskId);
      }, timeoutMs);
      timer.unref();
      this.pending.set(taskId, { questionId, resolve, timer });
      // Wake the waiting `delegate --wait` / `answer --wait` long-poll and any
      // `parley watch` (the `awaiting_answer` transition).
      this.transitioned(taskId);
    });
  }

  /**
   * The answer-timeout fired with the question still unanswered: stall the
   * task (spec §2). The question stays recorded on the row (visible via
   * `parley status`), the parked MCP call settles with a tool error, the child
   * is stopped, and long-poll waiters wake with `task.stalled` (exit 4).
   */
  private stallOnAnswerTimeout(taskId: string): void {
    const pending = this.pending.get(taskId);
    if (!pending) return; // answered in the meantime
    this.pending.delete(taskId);
    const task = getTask(this.db, taskId);
    if (!task || SETTLED_STATES.has(task.state)) {
      // Settled by other means: just release the parked call, no transition.
      pending.resolve({ error: `task ${taskId} is already ${task?.state ?? "gone"}` });
      return;
    }
    // Stall before stopping the child so its exit is read as part of the
    // stall, not as a report-less failure.
    updateTask(this.db, taskId, {
      state: "stalled",
      error: `answer timeout: question ${pending.questionId} was not answered in time`,
    });
    pending.resolve({
      error: "answer timeout — the task is stalled; the orchestrator can resume it with `parley answer`",
    });
    this.stopChild(taskId);
    this.transitioned(taskId);
  }

  /** SIGTERM a task's child, escalating to SIGKILL after a short grace. */
  private stopChild(taskId: string): void {
    const child = this.children.get(taskId);
    if (!child) return;
    child.kill("SIGTERM");
    const hardKill = setTimeout(() => {
      child.kill("SIGKILL");
    }, CHILD_STOP_GRACE_MS);
    hardKill.unref();
    child.once("close", () => clearTimeout(hardKill));
  }

  /**
   * Hard-stop every live vendor child. Called on daemon shutdown — children
   * must never outlive the daemon (spec §3: no orphans). Safe to call from a
   * process `exit` handler (synchronous) and idempotent. Their tasks stay
   * recorded as they were; the next daemon's startup sweep stalls them.
   */
  killChildren(): void {
    this.shuttingDown = true;
    for (const child of this.children.values()) {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }

  /**
   * Deliver an answer to a task. Two cases:
   *
   * - A live pending question: unblock the child's `ask_orchestrator` call
   *   with the text and move the task back to `running`.
   * - A `stalled` task (answer timeout or daemon crash): respawn the child via
   *   the adapter's `resume()` with the persisted vendor session id (ADR-0004);
   *   the answer text is the resume prompt, so it reaches the child as the
   *   continuation of the conversation (spec §2/§7).
   *
   * Throws `DelegateError` (→ exit 2) when the ref is unknown or the task has
   * neither a pending question nor a stall to resume from. Answers correlate
   * to the single outstanding question by construction.
   */
  answer(ref: string, text: string): TaskRow {
    const task = resolveTask(this.db, ref);
    if (!task) throw new DelegateError(`no such task: ${ref}`);

    const pending = this.pending.get(task.id);
    if (pending) {
      this.pending.delete(task.id);
      clearTimeout(pending.timer);
      updateTask(this.db, task.id, { state: "running", question_id: null, question: null });
      // `awaiting_answer → running` — a transition `parley watch` surfaces. The
      // stalled-resume path below transitions via `runChild`'s onSpawn instead.
      this.transitioned(task.id);
      pending.resolve({ answer: text });
      return getTask(this.db, task.id)!;
    }

    if (task.state === "stalled") {
      const adapter = this.adapters.get(task.vendor ?? "");
      if (!adapter) {
        throw new DelegateError(`task ${task.id} has an unknown vendor: ${task.vendor ?? "?"}`);
      }
      // The answered question is no longer outstanding; the stall reason is spent.
      updateTask(this.db, task.id, {
        state: "running",
        question_id: null,
        question: null,
        error: null,
      });
      // A vendor session can only be resumed if one was ever captured. A task
      // swept stalled before its child spoke (e.g. daemon died right after
      // delegate) has none — rerun it fresh with its original prompt instead.
      const revive =
        task.session_id !== null ? this.resume(task, adapter, text) : this.run(task, adapter);
      void revive.catch((err: unknown) => {
        this.fail(task.id, `task resume crashed: ${String(err)}`);
      });
      return getTask(this.db, task.id)!;
    }

    throw new DelegateError(`task ${task.id} has no pending question to answer`);
  }

  /**
   * Record an orchestrator's quality score/feedback against a task. 1:1 with
   * the task — a later call overwrites the previous score/feedback. Throws
   * `DelegateError` (→ exit 2) for an unknown ref.
   */
  evalTask(ref: string, score: number, feedback: string): TaskRow {
    const task = resolveTask(this.db, ref);
    if (!task) throw new DelegateError(`no such task: ${ref}`);
    updateTask(this.db, task.id, { eval_score: score, eval_feedback: feedback });
    return getTask(this.db, task.id)!;
  }

  /**
   * Cancel a task: terminate its vendor child (if running) and move the task to
   * `cancelled`, waking long-poll waiters (the blocking CLI exits 5). Throws
   * `DelegateError` (→ exit 2) for an unknown ref or an already-terminal task.
   * The worktree and captured logs are retained for inspection (never merged).
   */
  cancel(ref: string): TaskRow {
    const task = resolveTask(this.db, ref);
    if (!task) throw new DelegateError(`no such task: ${ref}`);
    if (TERMINAL_STATES.has(task.state)) {
      throw new DelegateError(`task ${task.id} is already ${task.state}`);
    }
    // Free any parked `ask_orchestrator` promise; the child is about to die, so
    // nothing is left to receive its tool result.
    this.pending.delete(task.id);
    // Terminate the child. Its own `close` handler fires afterwards, but the
    // `cancelled` state is terminal so it will not be overwritten with `failed`.
    const child = this.children.get(task.id);
    if (child) child.kill("SIGTERM");
    updateTask(this.db, task.id, {
      state: "cancelled",
      error: "cancelled by parley cancel",
      completed_at: new Date().toISOString(),
      // Clear any outstanding question so the terminal envelope honours the
      // "question_id/question are null unless awaiting_answer" contract.
      question_id: null,
      question: null,
    });
    this.transitioned(task.id);
    return getTask(this.db, task.id)!;
  }

  /**
   * Resolve when the task reaches an event state — terminal, `awaiting_answer`
   * (a question), or `stalled` — or after `timeoutMs` (the long-poll window,
   * the CLI re-polls). Returns the current row either way.
   */
  async waitForEvent(taskId: string, timeoutMs: number): Promise<TaskRow | undefined> {
    const task = getTask(this.db, taskId);
    if (!task || isEventState(task.state)) return task;

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        wake();
      }, timeoutMs);
      const wake = (): void => {
        clearTimeout(timer);
        this.waiters.get(taskId)?.delete(wake);
        resolve();
      };
      let set = this.waiters.get(taskId);
      if (!set) {
        set = new Set();
        this.waiters.set(taskId, set);
      }
      set.add(wake);
      // Re-check after registering: the task may have reached an event state
      // (completed, question, …) in between.
      const now = getTask(this.db, taskId);
      if (!now || isEventState(now.state)) wake();
    });
    return getTask(this.db, taskId);
  }

  private notify(taskId: string): void {
    const set = this.waiters.get(taskId);
    if (!set) return;
    this.waiters.delete(taskId);
    for (const wake of set) wake();
  }

  /**
   * Record a task-state transition (#34): stamp the row with the next global
   * `seq`, append it to the in-memory event log, and wake both the single-task
   * long-poll waiters (`delegate --wait` / `answer --wait`) and the multi-task
   * watchers (`parley watch`). Call this after every state change — including
   * `pending → running` and `awaiting_answer → running`, which are transitions
   * `watch` surfaces even though the single-task waiter re-polls past them.
   */
  private transitioned(taskId: string): void {
    const row = getTask(this.db, taskId);
    if (!row) return;
    const seq = bumpTaskSeq(this.db, taskId);
    this.transitions.push({ seq, task_id: taskId, state: row.state });
    this.notify(taskId);
    this.wakeEventWaiters();
  }

  private wakeEventWaiters(): void {
    // Snapshot then clear before waking: a woken watcher re-registers itself
    // (in its async continuation) when it re-blocks, so clearing here can't drop
    // that fresh registration.
    const waiters = [...this.eventWaiters];
    this.eventWaiters.clear();
    for (const wake of waiters) wake();
  }

  /** The current global transition seq — `parley watch`'s "start from now" baseline. */
  currentSeq(): number {
    return currentSeq(this.db);
  }

  /**
   * The earliest recorded transition of a watched task with `seq > since`, or
   * null if none has happened yet. The non-blocking core of the multi-task
   * long-poll; `waitForEvents` blocks on top of it.
   */
  peekEvent(ids: readonly string[], since: number): Transition | null {
    const watched = new Set(ids);
    // The log is append-only in seq order, so the first match is the earliest.
    return this.transitions.find((t) => t.seq > since && watched.has(t.task_id)) ?? null;
  }

  /**
   * Multi-task long-poll (#34, spec §3): resolve with the earliest transition of
   * any watched task after `since` — replaying immediately if one already
   * happened, else blocking until the next transition — or null when the poll
   * window elapses (the CLI re-polls). Distinct from the per-task `waitForEvent`
   * it generalizes; `watch` threads the returned `seq` back as `since` to stream
   * the next.
   */
  async waitForEvents(
    ids: readonly string[],
    since: number,
    timeoutMs: number,
  ): Promise<Transition | null> {
    for (;;) {
      const found = this.peekEvent(ids, since);
      if (found) return found;
      const woke = await new Promise<boolean>((resolve) => {
        const wake = (): void => {
          clearTimeout(timer);
          this.eventWaiters.delete(wake);
          resolve(true);
        };
        const timer = setTimeout(() => {
          this.eventWaiters.delete(wake);
          resolve(false);
        }, timeoutMs);
        this.eventWaiters.add(wake);
      });
      if (!woke) return null; // poll window elapsed, no matching transition yet
    }
  }

  /**
   * Auto-remove the task's worktree once its child has exited, but only when it
   * is untouched (no new commits, clean tree). Modified worktrees are kept so
   * the orchestrator can review and merge; `--cwd` tasks have no worktree.
   */
  private maybeAutoRemoveWorktree(taskId: string): void {
    const task = getTask(this.db, taskId);
    // Only a clean completion reclaims its worktree. A `failed` or `cancelled`
    // task retains its worktree and logs so the orchestrator can diagnose it.
    if (!task || task.state !== "completed") return;
    if (task.worktree === null || task.base_sha === null) return;
    if (isWorktreeModified(task.worktree, task.base_sha)) return;
    try {
      this.removeTaskWorktree(task);
    } catch {
      // leave it in place if git refuses; `parley clean` can retry
    }
  }

  private fail(taskId: string, error: string): void {
    const task = getTask(this.db, taskId);
    if (!task || TERMINAL_STATES.has(task.state)) return;
    updateTask(this.db, taskId, {
      state: "failed",
      error,
      completed_at: new Date().toISOString(),
    });
    this.transitioned(taskId);
  }

  private hubFor(taskId: string): HubInfo {
    if (this.hubPort === null) {
      throw new Error("task engine has no hub port yet");
    }
    return {
      url: `http://127.0.0.1:${this.hubPort}/mcp`,
      headers: { [TASK_HEADER]: taskId },
    };
  }

  private buildSpec(task: TaskRow): TaskSpec {
    return {
      id: task.id,
      name: task.name,
      prompt: task.prompt ?? "",
      vendor: task.vendor ?? "",
      model: task.model,
      effort: task.effort,
      cwd: task.cwd ?? process.cwd(),
      // Posture flows to the adapter the same way for a fresh run and a resume,
      // so a resumed task keeps the sandbox it was delegated with (spec §8).
      sandbox: task.sandbox,
      network: task.network === 1,
      // Adapters raise the vendor's MCP tool timeout above this (spec §4).
      answerTimeoutMs: task.answer_timeout_ms ?? DEFAULT_ANSWER_TIMEOUT_MS,
      ...(task.session_id !== null ? { sessionId: task.session_id } : {}),
      // Only codex needs the worktree's gitdirs (#25, #31) and only
      // parley-managed worktrees have any to grant — skip the git shell-out
      // otherwise so every other vendor's prepare/resume stays git-free. Both
      // the private gitdir (HEAD, index.lock) and the common gitdir
      // (objects/, refs/) are required for `git commit` to succeed inside the
      // sandbox (#31) — granting only the former still left the object
      // database read-only. Each resolution can throw independently (worktree
      // gone from disk out-of-band); degrade that one to "no extra writable
      // root" rather than fail the whole task over it.
      ...(task.worktree !== null && task.vendor === "codex"
        ? {
            gitDir: this.tryGitDir(task.worktree),
            gitCommonDir: this.tryCommonGitDir(task.worktree),
          }
        : {}),
    };
  }

  private tryGitDir(wt: string): string | undefined {
    try {
      return gitDir(wt);
    } catch {
      return undefined;
    }
  }

  private tryCommonGitDir(wt: string): string | undefined {
    try {
      return commonGitDir(wt);
    } catch {
      return undefined;
    }
  }

  /**
   * The protocol preamble prepended to every vendor prompt (spec §7). Mechanics
   * only — no repo digest or history: the tools the child has, the report schema
   * it must satisfy, where its brief and context live on disk, the workspace and
   * branch facts, and the answer timeout. Re-prepended on resume too, so a
   * respawned child is re-taught the rules. Context pointers are read from disk
   * at build time, so they reflect what was actually materialized.
   */
  private buildPreamble(task: TaskRow): string {
    const cwd = task.cwd ?? process.cwd();
    const schema = parseJsonColumn<JsonSchema>(task.report_schema) ?? DEFAULT_REPORT_SCHEMA;
    const timeout = formatDuration(task.answer_timeout_ms ?? DEFAULT_ANSWER_TIMEOUT_MS);
    const location =
      task.branch !== null
        ? `You are working in a git worktree at \`${cwd}\` on branch \`${task.branch}\`. Commit your work there; parley never merges — the orchestrator reviews the branch.`
        : `You are working directly in \`${cwd}\` (no dedicated branch).`;
    const pointers = contextPointers(cwd);
    const contextList =
      pointers.length > 0
        ? pointers.map((p) => `- \`${p}\``).join("\n")
        : "- (none)";

    return [
      "# Parley protocol",
      "",
      "You are an agent working on a task delegated through parley. Read these rules before you begin.",
      "",
      "## Where things are",
      location,
      "- Your task brief is on disk at `.parley/TASK.md` — read it first.",
      "- Supporting context files are under `.parley/context/`:",
      contextList,
      "",
      "## Tools available to you",
      `- \`ask_orchestrator({ question })\` — ask the orchestrator a blocking question when you are genuinely stuck or need a decision only they can make. It blocks until an answer arrives; a question left unanswered for ${timeout} stalls the task (it can be resumed later). Do not use it for anything you can resolve yourself.`,
      "- `submit_report({ ... })` — you MUST finish by calling this exactly once. The task only completes when you submit a report that satisfies the schema below; exiting without one is a failure.",
      "",
      "## Report schema",
      summarizeReportSchema(schema),
      "",
      "The task itself follows below (and in `.parley/TASK.md`); everything above is protocol, not the task.",
    ].join("\n");
  }

  /** Fresh-run prompt: the preamble, then the caller's brief (spec §7). */
  private initialPrompt(task: TaskRow): string {
    return `${this.buildPreamble(task)}\n\n---\n\n${task.prompt ?? ""}`;
  }

  /**
   * Resume prompt: the preamble re-prepended (spec §2/§7), then the
   * orchestrator's answer as the conversation's continuation.
   */
  private resumePrompt(task: TaskRow, answer: string): string {
    return [
      this.buildPreamble(task),
      "",
      "---",
      "",
      "The orchestrator answered your outstanding question:",
      "",
      answer,
      "",
      "Continue the task from here and finish by calling `submit_report`.",
    ].join("\n");
  }

  /** Fresh run: spawn the vendor child via `prepare` and pump it until exit. */
  private async run(task: TaskRow, adapter: VendorAdapter): Promise<void> {
    const spec: TaskSpec = { ...this.buildSpec(task), prompt: this.initialPrompt(task) };
    const plan = await adapter.prepare(spec, this.hubFor(task.id));
    await this.runChild(task, adapter, plan, {
      state: "running",
      started_at: new Date().toISOString(),
    });
  }

  /**
   * Resume a stalled task (spec §2): respawn via the adapter's `resume()` with
   * the persisted vendor session id; the orchestrator's answer is the resume
   * prompt, delivered to the child as the conversation's continuation.
   * `started_at` is kept from the original run.
   */
  private async resume(task: TaskRow, adapter: VendorAdapter, answer: string): Promise<void> {
    const spec: TaskSpec = { ...this.buildSpec(task), prompt: this.resumePrompt(task, answer) };
    const plan = await adapter.resume(spec, this.hubFor(task.id));
    await this.runChild(task, adapter, plan, {
      state: "running",
      // Kept from the original run; stamped here only if that never happened.
      ...(task.started_at === null ? { started_at: new Date().toISOString() } : {}),
    });
  }

  /** Spawn a planned vendor child and pump its stream until exit. */
  private async runChild(
    task: TaskRow,
    adapter: VendorAdapter,
    plan: SpawnPlan,
    onSpawn: TaskPatch,
  ): Promise<void> {
    // `cancel` may have landed while the adapter was preparing; don't spawn a
    // child for an already-terminal task.
    const beforeSpawn = getTask(this.db, task.id);
    if (!beforeSpawn || TERMINAL_STATES.has(beforeSpawn.state)) return;

    // Git-exclude vendor plumbing before writing it, so a worktree task's
    // `git status` stays clean, the files never count as "modified" (which would
    // block auto-remove of an otherwise-untouched worktree), and the child can
    // never stage them. A `--cwd` task has no parley worktree to manage.
    if (plan.files.length > 0 && task.worktree !== null) {
      try {
        excludeMaterializedFiles(task.worktree, plan.files.map((file) => file.path));
      } catch (err) {
        // Best-effort: a git failure here must not stop the task from running —
        // but it leaves plumbing visible as untracked (blocking auto-remove of
        // an untouched worktree), so record it in the daemon log, don't hide it.
        console.error(
          `task ${task.id}: failed to git-exclude vendor files in ${task.worktree}: ${errorMessage(err)}`,
        );
      }
    }

    for (const file of plan.files) {
      const target = path.join(plan.cwd, file.path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, file.contents);
    }

    const logDir = taskLogDir(this.paths, task.id);
    fs.mkdirSync(logDir, { recursive: true });
    const rawLog = fs.createWriteStream(path.join(logDir, "vendor.jsonl"), { flags: "a" });
    const stderrLog = fs.createWriteStream(path.join(logDir, "stderr.log"), { flags: "a" });
    // Distilled, greppable trail of adapter-tagged diagnostics (see
    // VENDOR_DIAG_PREFIX) — separate from the untouched raw stream so a human
    // or the orchestrator troubleshooting parley itself doesn't have to read
    // the full vendor.jsonl to find e.g. a vendor approval gate silently
    // cancelling submit_report/ask_orchestrator.
    const diagLog = fs.createWriteStream(path.join(logDir, "diag.log"), { flags: "a" });

    const [command, ...args] = plan.argv;
    if (!command) throw new Error(`adapter ${adapter.id} produced an empty argv`);
    // Deliberately NOT detached: the child joins the daemon's process group
    // (the daemon is a session leader) so a group kill takes children with it,
    // and `killChildren` covers daemon shutdown — no orphans (spec §3).
    const child = spawn(command, args, {
      cwd: plan.cwd,
      env: { ...process.env, ...plan.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.children.set(task.id, child);

    updateTask(this.db, task.id, onSpawn);
    // The child is live: `pending → running` (fresh run) or `stalled → running`
    // (resume). Record the transition so `parley watch` sees the task start.
    this.transitioned(task.id);

    child.stderr.pipe(stderrLog);

    const events: VendorEvent[] = [];
    let sessionId: string | undefined;
    let usage: Record<string, number> | undefined;
    // The most recent *fatal* error the vendor reported (codex `turn.failed`/
    // top-level `error`). Exit codes are often opaque (codex is 0/1 only), so a
    // child that dies without a report surfaces this as the failure detail.
    // Recoverable mid-run error items are deliberately not captured — the agent
    // may work past them, and a stale one would misattribute the failure.
    let lastError: string | undefined;
    // The most recent adapter-tagged diagnostic (VENDOR_DIAG_PREFIX) — kept
    // separately from `lastError` since it's non-fatal by construction, but
    // still worth carrying into the failure detail when the task ends without
    // a report and no fatal error explains why.
    let lastDiag: string | undefined;
    const lines = readline.createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      // Raw stream is the durable record — stored untouched, unknown lines included.
      rawLog.write(`${line}\n`);
      const lineEvents = adapter.parseEvent(line);
      if (lineEvents.length === 0) return;
      events.push(...lineEvents);

      const patch: TaskPatch = {};
      let usageChanged = false;
      for (const event of lineEvents) {
        if (event.kind === "session_meta" && event.usage !== undefined) {
          usage = { ...usage, ...event.usage };
          usageChanged = true;
        }
        if (event.kind === "error" && event.fatal === true && event.text) {
          lastError = event.text;
        }
        if (event.kind === "error" && event.text?.startsWith(VENDOR_DIAG_PREFIX)) {
          lastDiag = event.text;
          diagLog.write(`${new Date().toISOString()} ${event.text}\n`);
        }
      }
      // Only re-extract when this line could have changed the answer.
      if (lineEvents.some((e) => e.kind === "session_meta" && e.session_id !== undefined)) {
        const found = adapter.sessionId(events);
        if (found !== undefined && found !== sessionId) {
          sessionId = found;
          patch.session_id = found;
        }
      }
      if (usageChanged) patch.usage = JSON.stringify(usage);
      if (Object.keys(patch).length > 0) updateTask(this.db, task.id, patch);
    });

    await new Promise<void>((resolve) => {
      // A resume replaces this task's entry in `children` — once that has
      // happened this child is stale (a stall's SIGTERM straggler) and its
      // exit is no longer a lifecycle event for the task.
      const isCurrentChild = (): boolean => this.children.get(task.id) === child;
      let settled = false;
      const closeStreams = (): void => {
        lines.close();
        rawLog.end();
        stderrLog.end();
        diagLog.end();
      };
      child.on("error", (err) => {
        // A spawn failure (bad binary → ENOENT) fails the task with a clear
        // error rather than hanging. `close` may or may not follow; guard once.
        if (settled) return;
        settled = true;
        const current = isCurrentChild();
        if (current) this.children.delete(task.id);
        closeStreams();
        if (!this.shuttingDown && current) {
          this.fail(task.id, `failed to spawn vendor child: ${errorMessage(err)}`);
        }
        resolve();
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        const current = isCurrentChild();
        if (current) this.children.delete(task.id);
        closeStreams();
        if (this.shuttingDown || !current) {
          // Daemon-initiated kill (db is closing) or a superseded child:
          // either way, not a task outcome.
          resolve();
          return;
        }
        // A child that died while blocked on ask_orchestrator leaves its parked
        // call behind — settle it so nothing leaks (the stall path has already
        // settled its own).
        this.settlePending(task.id, {
          error: "vendor child exited while its question was pending",
        });
        const row = getTask(this.db, task.id);
        if (row && !SETTLED_STATES.has(row.state)) {
          // `completed` strictly requires submit_report (spec §2): exit
          // without one is a failure, whatever the exit code says. A `stalled`
          // exit is the stall stopping the child, not a failure. Codex exit
          // codes are 0/1 only, so any `turn.failed`/`error` detail from the
          // stream is the real diagnosis — append it when present.
          let detail = `vendor child exited (code ${code ?? "?"}) without submitting a report`;
          if (lastError !== undefined) detail += `: ${lastError}`;
          // Surfaced even when a fatal error already explains the exit — a
          // vendor approval gate cancelling submit_report is often the reason
          // the report never landed even when the turn itself "succeeded".
          if (lastDiag !== undefined) detail += ` [${lastDiag}]`;
          this.fail(task.id, detail);
        }
        // The child has exited, so a cleanly completed task's untouched worktree
        // is reclaimed; a failed/cancelled task retains its worktree and logs
        // for the orchestrator to diagnose (spec §6).
        this.maybeAutoRemoveWorktree(task.id);
        resolve();
      });
    });
  }
}
