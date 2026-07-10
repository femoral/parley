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
  resolveTask,
  updateTask,
  TERMINAL_STATES,
  type DatabaseHandle,
  type TaskRow,
} from "./db.js";
import { taskLogDir } from "./discovery.js";
import { validateReport, type Report } from "./report.js";

/** Correlation header children send on every MCP request (ADR-0003). */
export const TASK_HEADER = "x-parley-task";

/** A caller mistake surfaced to the CLI plane as HTTP 400 → exit code 2. */
export class DelegateError extends Error {
  override readonly name = "DelegateError";
}

export interface DelegateRequest {
  prompt: string;
  vendor: string;
  model: string | null;
  name: string | null;
  cwd: string;
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

    const row = insertTask(this.db, {
      name: request.name,
      vendor: request.vendor,
      model: request.model,
      // No worktrees yet (#19): the task is tagged with its working directory.
      repo: cwd,
      cwd,
      prompt: request.prompt,
    });

    void this.run(row, adapter).catch((err: unknown) => {
      this.fail(row.id, `task runner crashed: ${String(err)}`);
    });
    return row;
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
   * Resolve when the task reaches a terminal state, or after `timeoutMs` (the
   * long-poll window — the CLI re-polls). Returns the current row either way.
   */
  async waitForTerminal(taskId: string, timeoutMs: number): Promise<TaskRow | undefined> {
    const task = getTask(this.db, taskId);
    if (!task || TERMINAL_STATES.has(task.state)) return task;

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
      // Re-check after registering: the task may have completed in between.
      const now = getTask(this.db, taskId);
      if (!now || TERMINAL_STATES.has(now.state)) wake();
    });
    return getTask(this.db, taskId);
  }

  private notify(taskId: string): void {
    const set = this.waiters.get(taskId);
    if (!set) return;
    this.waiters.delete(taskId);
    for (const wake of set) wake();
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
        resolve();
      });
    });
  }
}
