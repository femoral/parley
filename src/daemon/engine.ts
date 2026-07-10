import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import type { HomePaths } from "../home.js";
import type { HubInfo, TaskSpec, VendorAdapter, VendorEvent } from "./adapters/types.js";
import {
  getTask,
  insertTask,
  listTasks,
  nextQuestionId,
  nextTaskId,
  resolveTask,
  updateTask,
  TERMINAL_STATES,
  type DatabaseHandle,
  type TaskRow,
} from "./db.js";
import { taskLogDir } from "./discovery.js";
import { validateReport, type Report } from "./report.js";
import {
  createWorktree,
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

/** A blocking `ask_orchestrator` call parked in daemon memory until answered. */
interface PendingQuestion {
  questionId: string;
  resolve: (answer: string) => void;
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
}

/**
 * The task engine: owns task rows, spawns vendor children through their
 * adapters, captures raw vendor streams as per-task JSONL, applies lifecycle
 * transitions, and wakes long-poll waiters on terminal states.
 *
 * The full crash story (spec §3: orphan sweep marking running tasks stalled on
 * daemon start) lands with the failure-path ticket (#17).
 */
export class TaskEngine {
  private readonly waiters = new Map<string, Set<() => void>>();
  /**
   * Live `ask_orchestrator` calls, keyed by task id. The value's `resolve`
   * unblocks the child's MCP request with the answer text. One per task by
   * construction (the child blocks while asking). These live only in memory —
   * a daemon restart abandons them (the resume story lands with #17/#18).
   */
  private readonly pending = new Map<string, PendingQuestion>();
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

    const row = insertTask(this.db, {
      id,
      name: request.name,
      vendor: request.vendor,
      model: request.model,
      repo,
      cwd: workingDir,
      prompt: request.prompt,
      worktree: worktreePath,
      branch,
      base_sha: baseSha,
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
    if (TERMINAL_STATES.has(task.state)) {
      return [`task ${taskId} is already ${task.state}`];
    }
    const errors = validateReport(payload);
    if (errors.length > 0) return errors;

    updateTask(this.db, taskId, {
      state: "completed",
      report: JSON.stringify(payload as Report),
      completed_at: new Date().toISOString(),
    });
    this.notify(taskId);
    return null;
  }

  /**
   * Handle an `ask_orchestrator` MCP call: record the question, move the task
   * to `awaiting_answer`, wake long-poll waiters, and block until `parley
   * answer` delivers the text (ADR-0003). Returns the answer as the tool
   * result, or an error string (bounced to the child as a tool error).
   *
   * Answer-timeout / stall (#18) is out of scope here: an unanswered question
   * simply blocks. The parked promise lives only in memory.
   */
  async askOrchestrator(taskId: string, question: string): Promise<{ answer: string } | { error: string }> {
    const task = getTask(this.db, taskId);
    if (!task) return { error: `unknown task: ${taskId}` };
    if (TERMINAL_STATES.has(task.state)) {
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
    const answer = await new Promise<string>((resolve) => {
      this.pending.set(taskId, { questionId, resolve });
      // Wake the waiting `delegate --wait` / `answer --wait` long-poll.
      this.notify(taskId);
    });
    return { answer };
  }

  /**
   * Deliver an answer to a task's outstanding question: unblock the child's
   * `ask_orchestrator` call with the text and move the task back to `running`.
   * Throws `DelegateError` (→ exit 2) when the ref is unknown or the task has
   * no pending question. Answers correlate to the single outstanding question
   * by construction.
   */
  answer(ref: string, text: string): TaskRow {
    const task = resolveTask(this.db, ref);
    if (!task) throw new DelegateError(`no such task: ${ref}`);
    const pending = this.pending.get(task.id);
    if (!pending) {
      throw new DelegateError(`task ${task.id} has no pending question to answer`);
    }
    this.pending.delete(task.id);
    updateTask(this.db, task.id, { state: "running", question_id: null, question: null });
    pending.resolve(text);
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
   * Auto-remove the task's worktree once its child has exited, but only when it
   * is untouched (no new commits, clean tree). Modified worktrees are kept so
   * the orchestrator can review and merge; `--cwd` tasks have no worktree.
   */
  private maybeAutoRemoveWorktree(taskId: string): void {
    const task = getTask(this.db, taskId);
    if (!task || !TERMINAL_STATES.has(task.state)) return;
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
    this.notify(taskId);
  }

  /** Spawn the vendor child and pump its stream until exit. */
  private async run(task: TaskRow, adapter: VendorAdapter): Promise<void> {
    if (this.hubPort === null) {
      throw new Error("task engine has no hub port yet");
    }
    const hub: HubInfo = {
      url: `http://127.0.0.1:${this.hubPort}/mcp`,
      headers: { [TASK_HEADER]: task.id },
    };
    const spec: TaskSpec = {
      id: task.id,
      name: task.name,
      prompt: task.prompt ?? "",
      vendor: task.vendor ?? "",
      model: task.model,
      cwd: task.cwd ?? process.cwd(),
    };
    const plan = await adapter.prepare(spec, hub);

    for (const file of plan.files) {
      const target = path.join(plan.cwd, file.path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, file.contents);
    }

    const logDir = taskLogDir(this.paths, task.id);
    fs.mkdirSync(logDir, { recursive: true });
    const rawLog = fs.createWriteStream(path.join(logDir, "vendor.jsonl"), { flags: "a" });
    const stderrLog = fs.createWriteStream(path.join(logDir, "stderr.log"), { flags: "a" });

    const [command, ...args] = plan.argv;
    if (!command) throw new Error(`adapter ${adapter.id} produced an empty argv`);
    const child = spawn(command, args, {
      cwd: plan.cwd,
      env: { ...process.env, ...plan.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    updateTask(this.db, task.id, { state: "running", started_at: new Date().toISOString() });

    child.stderr.pipe(stderrLog);

    const events: VendorEvent[] = [];
    let sessionId: string | undefined;
    let usage: Record<string, number> | undefined;
    const lines = readline.createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      // Raw stream is the durable record — stored untouched, unknown lines included.
      rawLog.write(`${line}\n`);
      const lineEvents = adapter.parseEvent(line);
      if (lineEvents.length === 0) return;
      events.push(...lineEvents);

      const patch: Parameters<typeof updateTask>[2] = {};
      let usageChanged = false;
      for (const event of lineEvents) {
        if (event.kind === "session_meta" && event.usage !== undefined) {
          usage = { ...usage, ...event.usage };
          usageChanged = true;
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
      child.on("error", (err) => {
        this.fail(task.id, `failed to spawn vendor child: ${String(err)}`);
        resolve();
      });
      child.on("close", (code) => {
        lines.close();
        rawLog.end();
        stderrLog.end();
        const current = getTask(this.db, task.id);
        if (current && !TERMINAL_STATES.has(current.state)) {
          // `completed` strictly requires submit_report (spec §2): exit
          // without one is a failure, whatever the exit code says.
          this.fail(task.id, `vendor child exited (code ${code ?? "?"}) without submitting a report`);
        }
        // The child has exited, so its worktree is free to reclaim: an untouched
        // one is auto-removed; any new commits or dirty files retain it for the
        // orchestrator to review (spec §6).
        this.maybeAutoRemoveWorktree(task.id);
        resolve();
      });
    });
  }
}
