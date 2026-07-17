import { spawn, type ChildProcess } from "node:child_process";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import type { JsonSchema } from "@useparley/core";
import { createBuiltinAdapters } from "@useparley/daemon/adapters/index.js";
import type { RunnerLeaseSpec } from "@useparley/daemon/engine.js";
import { TASK_HEADER } from "@useparley/daemon/engine.js";
import {
  materializeChildHub,
} from "@useparley/daemon/context.js";
import {
  createWorktree,
  excludeMaterializedFiles,
  removeWorktree,
} from "@useparley/daemon/worktree.js";
import type { HubInfo, SpawnPlan, TaskSpec, VendorAdapter } from "@useparley/core";
import { RunnerClient } from "./client.js";
import { type RunnerConfig, resolveRepoPath } from "./config.js";
import { startHubProxy, type HubProxy } from "./hub-proxy.js";
import { fullPrompt, materializeTaskContext } from "./protocol.js";

/** Default heartbeat interval — well under the daemon's 90s window. */
const HEARTBEAT_INTERVAL_MS = 20_000;

/** How long a stopped child gets to exit on SIGTERM before SIGKILL. */
const CHILD_STOP_GRACE_MS = 2_000;

export interface RunnerLoopOptions {
  config: RunnerConfig;
  /** Process env for adapters (e.g. PARLEY_FAKE_VENDOR_BIN in tests). */
  env?: NodeJS.ProcessEnv;
  /** Optional log sink (default stderr). */
  log?: (line: string) => void;
}

/**
 * Persistent runner loop: lease → execute → stream → push branch → repeat.
 * SIGINT/SIGTERM stop leasing and fail or finish the in-flight task.
 */
export class RunnerLoop {
  private readonly client: RunnerClient;
  private readonly adapters: Map<string, VendorAdapter>;
  private readonly log: (line: string) => void;
  private stopping = false;
  private inFlight: { taskId: string; child: ChildProcess | null; proxy: HubProxy | null } | null =
    null;

  constructor(private readonly options: RunnerLoopOptions) {
    this.client = new RunnerClient(options.config.daemonUrl, options.config.token);
    this.adapters = createBuiltinAdapters(options.env ?? process.env);
    this.log =
      options.log ?? ((line: string) => process.stderr.write(`parley-runner: ${line}\n`));
  }

  /** Request graceful shutdown (stop leasing; finish/fail in-flight). */
  stop(): void {
    this.stopping = true;
  }

  /** Run until stopped. */
  async run(): Promise<void> {
    this.log(
      `started name=${this.options.config.name} daemon=${this.options.config.daemonUrl}`,
    );
    while (!this.stopping) {
      let lease: RunnerLeaseSpec | null;
      try {
        lease = await this.client.lease(this.options.config.name);
      } catch (err) {
        if (this.stopping) break;
        this.log(`lease error: ${err instanceof Error ? err.message : String(err)}`);
        await sleep(2_000);
        continue;
      }
      if (lease === null) continue; // poll window elapsed
      if (this.stopping) {
        // Claimed but shutting down — fail so the task is not stuck running.
        try {
          await this.client.fail(lease.task_id, "runner shutting down before execute");
        } catch {
          /* best-effort */
        }
        break;
      }
      await this.execute(lease);
    }
    this.log("stopped");
  }

  private async execute(lease: RunnerLeaseSpec): Promise<void> {
    const taskId = lease.task_id;
    this.log(`leased ${taskId} vendor=${lease.vendor}`);
    this.inFlight = { taskId, child: null, proxy: null };

    const heartbeat = setInterval(() => {
      void this.client.heartbeat(taskId).catch((err: unknown) => {
        this.log(
          `heartbeat error for ${taskId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }, HEARTBEAT_INTERVAL_MS);
    heartbeat.unref();

    let worktreePath: string | null = null;
    let repoLocal: string | null = null;
    let branch: string | null = null;

    try {
      repoLocal = resolveRepoPath(this.options.config.repos, lease.repo);
      if (repoLocal === null) {
        await this.client.fail(
          taskId,
          `no local repo mapping for ${lease.repo} — configure runner.repos`,
        );
        return;
      }
      if (!fs.existsSync(repoLocal)) {
        await this.client.fail(taskId, `mapped repo path does not exist: ${repoLocal}`);
        return;
      }

      const adapter = this.adapters.get(lease.vendor);
      if (!adapter) {
        const known = [...this.adapters.keys()].join(", ");
        await this.client.fail(
          taskId,
          `unknown vendor on runner: ${lease.vendor} (known: ${known})`,
        );
        return;
      }

      const baseRef = lease.base_sha ?? lease.base_ref ?? "HEAD";
      let info;
      try {
        info = createWorktree({
          repoRoot: repoLocal,
          worktreesDir: this.options.config.worktreesDir,
          taskId,
          name: lease.name,
          baseRef,
        });
      } catch (err) {
        await this.client.fail(
          taskId,
          `failed to create worktree: ${err instanceof Error ? err.message : String(err)}`,
        );
        return;
      }
      worktreePath = info.path;
      branch = info.branch;

      materializeTaskContext(worktreePath, lease.prompt, lease.contexts);

      const proxy = await startHubProxy({
        daemonUrl: this.options.config.daemonUrl,
        token: this.options.config.token,
        taskId,
      });
      this.inFlight.proxy = proxy;

      materializeChildHub(worktreePath, proxy.url, taskId);

      const prompt = fullPrompt(
        worktreePath,
        branch,
        lease.answer_timeout_ms,
        lease.report_schema as JsonSchema,
        lease.prompt,
        adapter.childChannel,
      );

      const hub: HubInfo = {
        url: `${proxy.url}/mcp`,
        headers: { [TASK_HEADER]: taskId },
      };
      const spec: TaskSpec = {
        id: taskId,
        name: lease.name,
        prompt,
        vendor: lease.vendor,
        model: lease.model,
        effort: lease.effort,
        cwd: worktreePath,
        sandbox: lease.sandbox,
        network: lease.network,
        answerTimeoutMs: lease.answer_timeout_ms,
        extraArgs: lease.extra_args,
      };

      let plan = await adapter.prepare(spec, hub);
      plan = applyLeaseEnv(plan, lease);

      if (plan.files.length > 0) {
        try {
          excludeMaterializedFiles(
            worktreePath,
            plan.files.map((f) => f.path),
          );
        } catch (err) {
          this.log(
            `git-exclude failed for ${taskId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      for (const file of plan.files) {
        const target = path.join(plan.cwd, file.path);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, file.contents);
      }

      const exitCode = await this.spawnAndStream(taskId, adapter, plan);
      // Push the task branch so the orchestrator can fetch it. Report submission
      // already flowed through /child/report (completes via fallback or branch).
      if (branch !== null && worktreePath !== null && repoLocal !== null) {
        try {
          pushBranch(repoLocal, worktreePath, branch);
          await this.client.branch(taskId, branch);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.log(`branch push/record failed for ${taskId}: ${msg}`);
          try {
            await this.client.fail(taskId, `branch handoff failed: ${msg}`);
          } catch {
            /* task may already be terminal */
          }
        }
      }
      // Safety net: if the child exited without a report, fail the task. When a
      // report was already accepted, fail promotes to completed (#72).
      try {
        await this.client.fail(
          taskId,
          `vendor child exited (code ${exitCode ?? "?"}) without submitting a report`,
        );
      } catch {
        /* already terminal (completed via report/branch) */
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log(`execute error for ${taskId}: ${msg}`);
      try {
        await this.client.fail(taskId, msg);
      } catch {
        /* best-effort */
      }
    } finally {
      clearInterval(heartbeat);
      if (this.inFlight?.proxy) {
        try {
          await this.inFlight.proxy.close();
        } catch {
          /* ignore */
        }
      }
      // Best-effort local cleanup; remote review is on the pushed branch.
      if (worktreePath !== null && repoLocal !== null) {
        try {
          removeWorktree(repoLocal, worktreePath);
        } catch {
          /* leave for manual cleanup */
        }
      }
      this.inFlight = null;
    }
  }

  private spawnAndStream(
    taskId: string,
    _adapter: VendorAdapter,
    plan: SpawnPlan,
  ): Promise<number | null> {
    const [command, ...args] = plan.argv;
    if (!command) throw new Error("adapter produced an empty argv");

    const planEnv: Record<string, string> = {
      ...plan.env,
      PARLEY_HUB_URL: plan.env.PARLEY_HUB_URL ?? "",
      PARLEY_TASK_ID: taskId,
    };
    // Hub URL for child REST/CLI: the local proxy base.
    // Prefer whatever materializeChildHub wrote; inject from plan if set.
    if (!planEnv.PARLEY_HUB_URL && this.inFlight?.proxy) {
      planEnv.PARLEY_HUB_URL = this.inFlight.proxy.url;
    } else if (this.inFlight?.proxy) {
      planEnv.PARLEY_HUB_URL = this.inFlight.proxy.url;
    }

    const child = spawn(command, args, {
      cwd: plan.cwd,
      env: { ...process.env, ...planEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (this.inFlight) this.inFlight.child = child;

    const pendingLines: string[] = [];
    let flushTimer: NodeJS.Timeout | null = null;
    const flush = (): void => {
      if (pendingLines.length === 0) return;
      const batch = pendingLines.splice(0);
      void this.client.events(taskId, batch).catch((err: unknown) => {
        this.log(
          `events error for ${taskId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    };

    const lines = readline.createInterface({ input: child.stdout! });
    lines.on("line", (line) => {
      pendingLines.push(line);
      if (pendingLines.length >= 32) {
        flush();
      } else if (flushTimer === null) {
        flushTimer = setTimeout(() => {
          flushTimer = null;
          flush();
        }, 100);
        flushTimer.unref();
      }
    });

    // Capture stderr for diagnostics but don't fail solely on it.
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      if (text.trim() !== "") {
        this.log(`child stderr ${taskId}: ${text.trim().slice(0, 200)}`);
      }
    });

    return new Promise((resolve) => {
      const done = (code: number | null): void => {
        if (flushTimer) clearTimeout(flushTimer);
        flush();
        lines.close();
        resolve(code);
      };
      child.on("error", (err) => {
        this.log(`spawn error ${taskId}: ${err.message}`);
        done(null);
      });
      child.on("close", (code) => done(code));
    });
  }

  /** Stop an in-flight child (used on signal). */
  async abortInFlight(reason: string): Promise<void> {
    const flight = this.inFlight;
    if (!flight) return;
    if (flight.child && !flight.child.killed) {
      flight.child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          try {
            flight.child?.kill("SIGKILL");
          } catch {
            /* gone */
          }
          resolve();
        }, CHILD_STOP_GRACE_MS);
        flight.child?.once("close", () => {
          clearTimeout(t);
          resolve();
        });
      });
    }
    try {
      await this.client.fail(flight.taskId, reason);
    } catch {
      /* already terminal */
    }
  }
}

function applyLeaseEnv(plan: SpawnPlan, lease: RunnerLeaseSpec): SpawnPlan {
  return {
    ...plan,
    env: {
      ...plan.env,
      ...lease.env,
    },
    // extra_args already folded into TaskSpec.extraArgs for the adapter.
  };
}

function pushBranch(repoRoot: string, worktreePath: string, branch: string): void {
  // Ensure commits on the worktree branch are reachable, then push to origin.
  // The runner host needs push access to origin (documented).
  try {
    execFileSync("git", ["-C", worktreePath, "push", "-u", "origin", branch], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    // Surface stderr when present.
    const stderr =
      err && typeof err === "object" && "stderr" in err
        ? String((err as { stderr: unknown }).stderr)
        : "";
    throw new Error(
      `git push origin ${branch} failed${stderr ? `: ${stderr.trim()}` : ""} (repo ${repoRoot})`,
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
