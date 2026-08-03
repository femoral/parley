import { spawn, type ChildProcess } from "node:child_process";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import readline from "node:readline";
import {
  createLeaseHttpTransport,
  DEFAULT_RUNNER_REFINGERPRINT_MS,
  homePathsFromEnv,
  readConfig,
  RUNNER_PROTOCOL_VERSION,
  TASK_HEADER,
  type ChildChannel,
  type HubInfo,
  type JsonSchema,
  type LeaseTransport,
  type RunnerCapabilities,
  type RunnerLeaseSpec,
  type SpawnPlan,
  type TaskSpec,
  type VendorAdapter,
} from "@useparley/core";
import {
  createAdapterRegistry,
  createBuiltinAdapters,
} from "@useparley/daemon/adapters/index.js";
import {
  materializeChildHub,
  materializeContext,
} from "@useparley/daemon/context.js";
import { fingerprintCapabilities } from "@useparley/daemon/fingerprint.js";
import { DEFAULT_REPORT_SCHEMA } from "@useparley/daemon/report.js";
import { buildProtocolPreamble } from "@useparley/daemon/preamble.js";
import {
  assembleChildPrompt,
  composeOperatorInstructions,
} from "@useparley/daemon/prompt-layers.js";
import {
  createWorktree,
  excludeMaterializedFiles,
  removeWorktree,
  writeMaterializedFiles,
} from "@useparley/daemon/worktree.js";
import { type RunnerConfig, resolveRepoPath } from "./config.js";
import { startHubProxy, type HubProxy } from "./hub-proxy.js";
import { RUNNER_VERSION } from "./version.js";

/** Default heartbeat interval — well under the daemon's 90s window. */
const HEARTBEAT_INTERVAL_MS = 20_000;

/** How long a stopped child gets to exit on SIGTERM before SIGKILL. */
const CHILD_STOP_GRACE_MS = 2_000;

function refingerprintIntervalMs(): number {
  const parsed = Number(process.env.PARLEY_RUNNER_REFINGERPRINT_MS ?? "");
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_RUNNER_REFINGERPRINT_MS;
}

/**
 * Host-side seams for unit tests. Production uses real worktree/git/proxy
 * implementations; inject fakes to exercise fail branches without a daemon.
 */
export interface RunnerHost {
  createWorktree: typeof createWorktree;
  removeWorktree: typeof removeWorktree;
  pushBranch: (repoRoot: string, worktreePath: string, branch: string) => void;
  startHubProxy: typeof startHubProxy;
  materializeContext: typeof materializeContext;
  materializeChildHub: typeof materializeChildHub;
  /**
   * Optional override of spawn+stream. When set, the real child process is
   * not launched (tests inject a fixed exit code / event stream).
   */
  spawnAndStream?: (
    taskId: string,
    plan: SpawnPlan,
  ) => Promise<number | null>;
}

export interface RunnerLoopOptions {
  config: RunnerConfig;
  /** Process env for adapters (e.g. PARLEY_FAKE_VENDOR_BIN in tests). */
  env?: NodeJS.ProcessEnv;
  /** Optional log sink (default stderr). */
  log?: (line: string) => void;
  /**
   * Lease wire transport. Defaults to HTTP against `config.daemonUrl` with
   * `config.token` (production). Tests inject a recording fake.
   */
  transport?: LeaseTransport;
  /** Partial host overrides for unit tests. */
  host?: Partial<RunnerHost>;
  /** Override the adapter registry (tests). */
  adapters?: Map<string, VendorAdapter>;
  /**
   * Optional fingerprint override (tests). When set, skips PATH/model probing
   * and uses the returned capabilities for every register call.
   */
  fingerprint?: () => Promise<RunnerCapabilities> | RunnerCapabilities;
  /** Override build_version advertised on register (tests). */
  buildVersion?: string;
}

/**
 * Persistent runner loop: register → lease → execute → stream → push branch →
 * re-fingerprint periodically. SIGINT/SIGTERM stop leasing and fail or finish
 * the in-flight task.
 */
export class RunnerLoop {
  private readonly transport: LeaseTransport;
  private adapters: Map<string, VendorAdapter>;
  private readonly host: RunnerHost;
  private readonly log: (line: string) => void;
  private readonly env: NodeJS.ProcessEnv;
  private stopping = false;
  private adaptersReady: Promise<void>;
  private inFlight: { taskId: string; child: ChildProcess | null; proxy: HubProxy | null } | null =
    null;
  private reFingerprintTimer: NodeJS.Timeout | null = null;

  constructor(private readonly options: RunnerLoopOptions) {
    this.env = options.env ?? process.env;
    this.transport =
      options.transport ??
      createLeaseHttpTransport({
        daemonUrl: options.config.daemonUrl,
        token: options.config.token,
      });
    if (options.adapters !== undefined) {
      this.adapters = options.adapters;
      this.adaptersReady = Promise.resolve();
    } else {
      // Start with builtins; async plugin load fills in before first register.
      this.adapters = createBuiltinAdapters(this.env);
      this.adaptersReady = this.loadAdaptersWithPlugins();
    }
    this.host = {
      createWorktree,
      removeWorktree,
      pushBranch,
      startHubProxy,
      materializeContext,
      materializeChildHub,
      ...options.host,
    };
    this.log =
      options.log ?? ((line: string) => process.stderr.write(`parley-runner: ${line}\n`));
  }

  private async loadAdaptersWithPlugins(): Promise<void> {
    try {
      const paths = homePathsFromEnv(this.env);
      let config = {};
      try {
        config = readConfig(paths.config);
      } catch {
        /* optional */
      }
      this.adapters = await createAdapterRegistry(this.env, {
        config,
        parleyHome: paths.home,
        log: (line) => this.log(line),
      });
    } catch (err) {
      this.log(
        `adapter registry load failed, using builtins: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /** Request graceful shutdown (stop leasing; finish/fail in-flight). */
  stop(): void {
    this.stopping = true;
    if (this.reFingerprintTimer !== null) {
      clearInterval(this.reFingerprintTimer);
      this.reFingerprintTimer = null;
    }
  }

  /** Fingerprint host capabilities (PATH bins + adapter model catalogs). */
  async fingerprint(): Promise<RunnerCapabilities> {
    if (this.options.fingerprint !== undefined) {
      return await this.options.fingerprint();
    }
    await this.adaptersReady;
    const paths = homePathsFromEnv(this.env);
    let config = {};
    try {
      config = readConfig(paths.config);
    } catch {
      /* optional */
    }
    return fingerprintCapabilities({
      adapters: this.adapters,
      config,
      env: this.env,
    });
  }

  /** Register (or re-register) with the daemon. Idempotent upsert server-side. */
  async register(): Promise<void> {
    await this.adaptersReady;
    const capabilities = await this.fingerprint();
    const vendorIds = capabilities.vendors.map((v) => v.id).join(",") || "(none)";
    this.log(
      `registering name=${this.options.config.name} vendors=${vendorIds} ` +
        `protocol=${RUNNER_PROTOCOL_VERSION}`,
    );
    await this.transport.register({
      runner: this.options.config.name,
      protocol_version: RUNNER_PROTOCOL_VERSION,
      build_version: this.options.buildVersion ?? RUNNER_VERSION,
      capabilities,
    });
  }

  /** Run until stopped. */
  async run(): Promise<void> {
    this.log(
      `started name=${this.options.config.name} daemon=${this.options.config.daemonUrl}`,
    );
    await this.adaptersReady;

    // Initial registration — required before any lease.
    try {
      await this.register();
    } catch (err) {
      this.log(
        `register error: ${err instanceof Error ? err.message : String(err)}`,
      );
      // Keep trying register in the main loop rather than exiting — a
      // temporarily unreachable daemon should not kill the runner process.
    }

    // Periodic re-fingerprint so installing a vendor CLI needs no restart.
    const interval = refingerprintIntervalMs();
    this.reFingerprintTimer = setInterval(() => {
      if (this.stopping) return;
      void this.register().catch((err: unknown) => {
        this.log(
          `re-register error: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }, interval);
    this.reFingerprintTimer.unref();

    while (!this.stopping) {
      let lease: RunnerLeaseSpec | null;
      try {
        lease = await this.transport.lease(this.options.config.name);
      } catch (err) {
        if (this.stopping) break;
        const msg = err instanceof Error ? err.message : String(err);
        this.log(`lease error: ${msg}`);
        // Reconnect path: re-register after transport errors (auth/registration
        // gaps, daemon restart). Best-effort; next lease retries regardless.
        try {
          await this.register();
        } catch (regErr) {
          this.log(
            `re-register after lease error failed: ${
              regErr instanceof Error ? regErr.message : String(regErr)
            }`,
          );
        }
        await sleep(2_000);
        continue;
      }
      if (lease === null) continue; // poll window elapsed
      if (this.stopping) {
        // Claimed but shutting down — fail so the task is not stuck running.
        try {
          await this.transport.fail(lease.task_id, "runner shutting down before execute");
        } catch {
          /* best-effort */
        }
        break;
      }
      await this.execute(lease);
    }
    if (this.reFingerprintTimer !== null) {
      clearInterval(this.reFingerprintTimer);
      this.reFingerprintTimer = null;
    }
    this.log("stopped");
  }

  private async execute(lease: RunnerLeaseSpec): Promise<void> {
    const taskId = lease.task_id;
    this.log(`leased ${taskId} vendor=${lease.vendor}`);
    this.inFlight = { taskId, child: null, proxy: null };

    const heartbeat = setInterval(() => {
      void this.transport.heartbeat(taskId).catch((err: unknown) => {
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
        await this.transport.fail(
          taskId,
          `no local repo mapping for ${lease.repo} — configure runner.repos`,
        );
        return;
      }
      if (!fs.existsSync(repoLocal)) {
        await this.transport.fail(taskId, `mapped repo path does not exist: ${repoLocal}`);
        return;
      }

      const adapter = this.adapters.get(lease.vendor);
      if (!adapter) {
        const known = [...this.adapters.keys()].join(", ");
        await this.transport.fail(
          taskId,
          `unknown vendor on runner: ${lease.vendor} (known: ${known})`,
        );
        return;
      }

      const baseRef = lease.base_sha ?? lease.base_ref ?? "HEAD";
      let info;
      try {
        info = this.host.createWorktree({
          repoRoot: repoLocal,
          worktreesDir: this.options.config.worktreesDir,
          taskId,
          name: lease.name,
          baseRef,
        });
      } catch (err) {
        await this.transport.fail(
          taskId,
          `failed to create worktree: ${err instanceof Error ? err.message : String(err)}`,
        );
        return;
      }
      worktreePath = info.path;
      branch = info.branch;

      this.host.materializeContext(worktreePath, lease.prompt, lease.contexts);

      const proxy = await this.host.startHubProxy({
        daemonUrl: this.options.config.daemonUrl,
        token: this.options.config.token,
        taskId,
      });
      this.inFlight.proxy = proxy;

      this.host.materializeChildHub(worktreePath, proxy.url, taskId);

      const prompt = fullPrompt(
        worktreePath,
        branch,
        lease.answer_timeout_ms,
        lease.report_schema as JsonSchema,
        lease.prompt,
        adapter.childChannel,
        {
          vendorId: lease.vendor,
          profileName: lease.profile,
        },
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
      writeMaterializedFiles(plan.cwd, plan.files);

      const exitCode =
        this.host.spawnAndStream !== undefined
          ? await this.host.spawnAndStream(taskId, plan)
          : await this.spawnAndStream(taskId, adapter, plan);
      // Push the task branch so the orchestrator can fetch it. Report submission
      // already flowed through /child/report (completes via fallback or branch).
      if (branch !== null && worktreePath !== null && repoLocal !== null) {
        try {
          this.host.pushBranch(repoLocal, worktreePath, branch);
          await this.transport.branch(taskId, branch);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.log(`branch push/record failed for ${taskId}: ${msg}`);
          try {
            await this.transport.fail(taskId, `branch handoff failed: ${msg}`);
          } catch {
            /* task may already be terminal */
          }
        }
      }
      // Safety net: if the child exited without a report, fail the task. When a
      // report was already accepted, fail promotes to completed (#72).
      try {
        await this.transport.fail(
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
        await this.transport.fail(taskId, msg);
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
          this.host.removeWorktree(repoLocal, worktreePath);
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
      void this.transport.events(taskId, batch).catch((err: unknown) => {
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
      await this.transport.fail(flight.taskId, reason);
    } catch {
      /* already terminal */
    }
  }
}

/**
 * Full child prompt for a remote-runner spawn (#159). Project PROMPT.md layers
 * are read from the workspace (`cwd`) at spawn; home layers from the runner
 * host's parley home. Operator section order matches the daemon engine.
 * (Previously packages/runner/src/protocol.ts — inlined after #209 delete.)
 */
function fullPrompt(
  cwd: string,
  branch: string | null,
  answerTimeoutMs: number,
  reportSchema: JsonSchema,
  brief: string,
  childChannel: ChildChannel = "mcp",
  options: {
    vendorId?: string | null;
    profileName?: string | null;
    homeDir?: string;
  } = {},
): string {
  const preamble = buildProtocolPreamble({
    cwd,
    branch,
    answerTimeoutMs,
    reportSchema: reportSchema ?? DEFAULT_REPORT_SCHEMA,
    childChannel: childChannel ?? "mcp",
  });
  const homeDir = options.homeDir ?? homePathsFromEnv().home;
  const operator = composeOperatorInstructions({
    homeDir,
    projectDir: cwd,
    vendorId: options.vendorId ?? null,
    profileName: options.profileName ?? null,
  });
  return assembleChildPrompt(preamble, operator, brief);
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
