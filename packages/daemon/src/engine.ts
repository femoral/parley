import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import {
  DEFAULT_NETWORK,
  DEFAULT_RETENTION_DAYS,
  DEFAULT_RUNNER_HEARTBEAT_TIMEOUT_MS,
  DEFAULT_SANDBOX,
  FALLBACK_TASK_TYPE,
  formatValidDifficulties,
  formatValidSizes,
  formatValidTaskTypes,
  isChildChannel,
  isSettledState,
  isTerminalState,
  isValidDifficulty,
  isValidSize,
  isValidTaskType,
  formatCliSelectedHint,
  listAllowedCombos,
  ModelAllowlistError,
  normalizeUsage,
  parseDuration,
  profileHasLaunchTemplate,
  readConfig,
  resolveAllowedCombo,
  resolveWorkflow,
  retentionDays,
  scoreRubric,
  expandLaunchTemplate,
  formatStepAddress,
  TASK_HEADER,
  validateAnswers,
  type ChildChannel,
  type HomePaths,
  type ParleyConfig,
  type ProfileConfig,
  type RunnerLeaseSpec,
  type WorkflowDefinition,
  type WorkflowStepNode,
} from "@useparley/core";

/** Compat re-exports for deep imports (`@useparley/daemon/engine.js`) during #209 migration. */
export { DEFAULT_RUNNER_HEARTBEAT_TIMEOUT_MS, TASK_HEADER, type RunnerLeaseSpec };
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
  answerQaTurn,
  claimOldestPendingRunnerTask,
  currentSeq,
  deleteSession,
  deleteTask,
  bumpRunSeq,
  getRun,
  getRunBlockReason,
  getRunSeq,
  getSession,
  getTask,
  isRunTerminalState,
  sessionHasTasks,
  setRunBlockReason,
  insertDeliverable,
  insertQaTurn,
  insertSession,
  insertTask,
  listAllSessions,
  listExpiredSessions,
  listExpiredTasks,
  listQaTurns,
  listRuns,
  listRunsForSession,
  listSessions,
  listQueuedTasks,
  listTasks,
  nextDeliverableId,
  nextQuestionId,
  nextTaskId,
  resolveRun,
  resolveTask,
  updateRunEval,
  updateSession,
  updateTask,
  countSlotHoldingForProfile,
  countSlotHoldingForVendor,
  SLOT_HOLDING_STATES,
  type DatabaseHandle,
  type ProcessAnchor,
  type QaTurnRow,
  type RunRow,
  type SessionRow,
  type SessionSummary,
  type TaskDataPatch,
  type TaskRow,
} from "./db.js";
import {
  createInbox,
  sqliteAckStore,
  sqliteRunSnapshot,
  sqliteTaskSnapshot,
  type Inbox,
  runInboxTierState,
  type InboxEvent,
  type WatchSet,
} from "./inbox.js";
import {
  decayTaskDeliverables,
  resolveDeclaredOutputKeysForRun,
  runOwnedExpiryGate,
  sweepRunRetention,
  type GcRunEntry,
} from "./run-retention.js";
import {
  noteEventResolved,
  noteInboxDelivery,
  isPanickedSession,
  clearSessionPanic,
} from "./session-panic.js";
import {
  createRunTransitions,
  createTaskTransitions,
  type RunTransitions,
  type TaskTransitions,
  type Transition,
} from "./transition.js";
import {
  materializeChildHub,
  materializeContext,
  readProjectClassification,
  readEvalEnabled,
  readProjectTaskTypes,
  readResumeEnabled,
  readRetryMax,
  readRetryWindowMs,
  type ContextFile,
} from "./context.js";
import {
  CODE_REATTEMPT_WINDOW_EXPIRED,
  CODE_RETRY_LIMIT_EXCEEDED,
  collectAttemptChain,
  composeFreshFixBody,
  countResumedAttempts,
  DEFAULT_RETRY_MAX,
  DEFAULT_RETRY_WINDOW_MS,
  parentTerminalAgeMs,
  reattemptWindowMessage,
  retryLimitMessage,
} from "./retry.js";
import {
  CODE_SESSION_REQUIRED,
  classifySessionLiveness,
  isPidAlive,
  isSessionCandidateLive,
  normalizeOptionalProvenance,
  readMachineId,
  readPidStartTime,
  resolveSessionBinding,
  sessionRequiredMessage,
  snapshotFromSession,
  type PidAliveFn,
  type PidStartTimeFn,
  type ProvenanceSnapshot,
} from "./session-binding.js";
import { taskLogDir } from "./discovery.js";
import {
  actionRunVerb,
  cancelRunRow,
  drainRuns,
  forkRun,
  listCancellableRunTasks,
  type ForkApplyResult,
  type ForkRunRequest,
  type GateVerbRequest,
  type RunDrainHost,
} from "./run-engine.js";
import { inferBlockReason } from "./run-gates.js";
import {
  startRun as startRunImpl,
  type InputFlag,
  type StartRunResult,
} from "./run-start.js";
import { readRunInputs } from "./run-workspace.js";
import { resolveRubricForRun, resolveRubricForTask } from "./rubrics.js";
import {
  deliverablesFromReport,
  generateReportSchema,
  materializeInputs,
  renderInputsSection,
  type InputPortValue,
  type OutputPortSpec,
  type RenderInputEntry,
} from "./deliverables.js";
import { composeStepBody } from "./prompt-layers.js";
import {
  resolveStepExecution,
  StepConfigError,
} from "./run-preflight.js";
import {
  runCheckoutPath,
  runScratchPath,
  resolveScratchStepWorkspace,
  resolveStepWorkspace,
  runBranchName,
} from "./run-workspace.js";
import {
  assertValidSchema,
  DEFAULT_REPORT_SCHEMA,
  parseJsonColumn,
  resolveReportSchema,
  validateReport,
  type JsonSchema,
  type Report,
} from "./report.js";
import { buildProtocolPreamble, finishInstruction } from "./preamble.js";
import {
  assembleChildPrompt,
  assemblePromptPreview,
  composeOperatorInstructions,
  composeOrchestratorInstructions,
} from "./prompt-layers.js";
import { buildInfo, type InfoResponse } from "./info.js";
import {
  appendLaunchCommand,
  captureLaunchCommand,
  resolveDeclaredTraceField,
  resolveTraceField,
  upgradeTraceField,
  type ResolvedTraceField,
} from "./trace.js";
import {
  attachWorktree,
  commonGitDir,
  createWorktree,
  excludeMaterializedFiles,
  gitDir,
  isValidGitCheckout,
  isWorktreeModified,
  removeWorktree,
  repoRoot,
} from "./worktree.js";

/** Re-export transition type for callers that imported it from the engine. */
export type { Transition } from "./transition.js";

/** Default `--answer-timeout`: 30 minutes (spec §2). */
export const DEFAULT_ANSWER_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * How long a leased remote task may go without a runner heartbeat before the
 * daemon fails it with a runner-lost error. Override via
 * `PARLEY_RUNNER_HEARTBEAT_MS` for fast tests (read each call so tests can set
 * the env after the module loads).
 */
export function runnerHeartbeatTimeoutMs(): number {
  const parsed = Number(process.env.PARLEY_RUNNER_HEARTBEAT_MS ?? "");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_RUNNER_HEARTBEAT_TIMEOUT_MS;
}

/** Filename under the task log dir for contexts + base_ref of runner-affine tasks. */
const RUNNER_META_FILE = "runner-meta.json";

/**
 * After `submit_report` is accepted the task stays `running` until the vendor
 * stream closes, so the final usage event can land in the same DB update as
 * `completed` (#72). If the child never exits, complete with best-effort usage
 * after this window — generous enough for trailing events (e.g. codex's
 * `turn.completed`), short enough that a hung child does not park `watch`
 * for minutes. Override via `PARLEY_REPORT_ACCEPTED_FALLBACK_MS` for tests.
 */
export const REPORT_ACCEPTED_FALLBACK_MS = 30_000;

/** How long a stopped child gets to exit on SIGTERM before SIGKILL. */
const CHILD_STOP_GRACE_MS = 2_000;

/** Resolve the post-report fallback window (env override for fast tests). */
function reportAcceptedFallbackMs(): number {
  const raw = process.env.PARLEY_REPORT_ACCEPTED_FALLBACK_MS;
  if (raw !== undefined) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return REPORT_ACCEPTED_FALLBACK_MS;
}

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
 * A caller mistake surfaced to the CLI plane as HTTP 400 → exit code 2
 * (or a distinct code when {@link code} is set — e.g. retry gates #158).
 */
export class DelegateError extends Error {
  override readonly name = "DelegateError";
  constructor(
    message: string,
    /** Stable machine-readable code when the CLI maps to a non-2 exit. */
    readonly code?: string,
  ) {
    super(message);
  }
}

/** Best-effort message from a thrown value (git errors arrive as `Error`). */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Last-resort port map when the workflow definition cannot be resolved.
 * Every reported key becomes a text atom (inline deliverable). Used only
 * after {@link TaskEngine.resolveStepOutputPorts} fails — see #238 fix.
 */
function fallbackTextOutputPorts(
  report: Readonly<Record<string, unknown>>,
  reportSchemaJson: string | null,
): Record<string, OutputPortSpec> {
  const ports: Record<string, OutputPortSpec> = {};
  const schema = parseJsonColumn<{
    properties?: Record<string, unknown>;
  }>(reportSchemaJson);
  if (schema?.properties !== undefined) {
    for (const name of Object.keys(schema.properties)) {
      ports[name] = { type: { kind: "text" } };
    }
    return ports;
  }
  for (const name of Object.keys(report)) {
    if (name === "summary" || name === "outcome" || name === "files_changed") {
      continue;
    }
    ports[name] = { type: { kind: "text" } };
  }
  return ports;
}

/**
 * Minimal adapter for free-form launch-template vendors outside the registry
 * (#195 / ADR-0015). Argv comes from the template, not prepare/resume. Teaches
 * the HTTP child channel so ask/report work without MCP harness wiring.
 * parseEvent is a no-op — raw logs remain the durable record.
 */
function createGenericTemplateAdapter(vendorId: string): VendorAdapter {
  const emptyPlan = (task: TaskSpec): SpawnPlan => ({
    argv: [],
    env: {},
    files: [],
    cwd: task.cwd,
  });
  return {
    id: vendorId,
    childChannel: "http",
    // Template profiles have no real vendor isolation (#279).
    // full is always enforced: unrestricted access is what full asks for.
    enforcement: {
      "read-only": { level: "none", via: "generic template adapter" },
      workspace: { level: "none", via: "generic template adapter" },
      full: { level: "enforced", via: "no isolation requested" },
      "network:false": { level: "none", via: "generic template adapter" },
    },
    prepare(task) {
      return Promise.resolve(emptyPlan(task));
    },
    resume(task) {
      return Promise.resolve(emptyPlan(task));
    },
    parseEvent() {
      return [];
    },
    sessionId() {
      return undefined;
    },
  };
}

/** Recursively sum on-disk bytes for a path; missing paths contribute 0. */
function directoryBytes(root: string): number {
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
    total += directoryBytes(path.join(root, entry.name));
  }
  return total;
}

/** One task considered (or removed) by a retention sweep (#153). */
export interface GcTaskEntry {
  task_id: string;
  state: string;
  completed_at: string | null;
  /** Estimated on-disk bytes reclaimed (logs + worktree). */
  bytes: number;
  worktree: string | null;
}

/** Result of `parley gc` / the scheduled daemon sweep (#153 / #244). */
export interface GcResult {
  dry_run: boolean;
  /** Tasks purged (or listed when dry-run). */
  removed: number;
  /** Sum of estimated on-disk bytes for removed (or listed) tasks + runs. */
  freed_bytes: number;
  tasks: GcTaskEntry[];
  /**
   * Runs decayed (or listed when dry-run): `purged_at` stamp + scratch
   * subtree removal (#244). Empty when no terminal run is past the cutoff.
   */
  runs: GcRunEntry[];
  /** Per-task / per-run failures that did not block the rest. */
  failed: { task_id?: string; run_id?: string; error: string }[];
}

export interface DelegateRequest {
  prompt: string;
  /**
   * Vendor id. Optional when `profile` is set — the profile supplies the vendor
   * (explicit request vendor still wins). Null means "not specified".
   */
  vendor: string | null;
  /**
   * Named profile from `~/.parley/parley.json` `profiles.<name>` (#113). Null
   * when the caller named a vendor directly. Explicit request fields beat
   * profile values; profile values beat ADR defaults.
   */
  profile: string | null;
  /**
   * Opaque model string. Null means "not specified" (use profile, else none) —
   * not "clear the profile's model".
   */
  model: string | null;
  /** Opaque reasoning-effort string (spec §9); null means not specified. */
  effort: string | null;
  name: string | null;
  /**
   * Explicit orchestrator session override (`--session` / `PARLEY_SESSION_ID`).
   * Null when omitted — the daemon binds via ancestry / single-live fallback
   * (#162). Free-form ids still stamp when evals are off.
   */
  orchestratorSessionId: string | null;
  /**
   * Caller's process-ancestry chain (self first) for session binding (#162).
   * Empty/absent when the client cannot walk the table.
   */
  ancestryChain?: ProcessAnchor[];
  /**
   * Absolute workspace root the caller is operating in (#162). Used for
   * single-live-session fallback and eval gating.
   */
  workspaceRoot?: string | null;
  /** The invocation directory: an explicit `--cwd`, else the caller's cwd. */
  cwd: string;
  /**
   * Whether to create an isolated worktree (default path). False when the
   * caller passed `--cwd`, which runs the child directly in that directory.
   */
  useWorktree: boolean;
  /** Ref to branch the worktree from; null means the repo's current HEAD. */
  baseRef: string | null;
  /**
   * Normalized sandbox posture when the caller set it explicitly; null means
   * use the profile (if any) then ADR-0006 default (`workspace`).
   */
  sandbox: SandboxMode | null;
  /**
   * Network access when the caller set it explicitly; null means use the
   * profile (if any) then ADR-0006 default (on).
   */
  network: boolean | null;
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
  /**
   * Remote runner affinity (`--runner <name>`), if any (#111 / ADR-0012). Null
   * means the task executes in-daemon (default). When set, the task stays
   * pending until that runner leases it — never locally spawned.
   */
  runner: string | null;
  /**
   * Task size classification; null when unset (#118 / #161). Validated against
   * the project's hot-read classification set after repo resolution.
   */
  size: string | null;
  /**
   * Task difficulty; null when unset (#118 / #161). Validated against the
   * project's hot-read classification set after repo resolution.
   */
  difficulty: string | null;
  /**
   * Work-domain task type (#151). Null/absent means store `other`. Validated
   * against the project's hot-read `taskTypes` set after repo resolution.
   */
  type: string | null;
  /**
   * When true (`delegate --dry-run`, #161): run the task normally, then purge
   * the row (and logs/worktree) on terminal so nothing is recorded.
   */
  dryRun?: boolean;
}

/**
 * `parley fix <task> "<brief>"` request (#152) — create a linked attempt that
 * inherits the parent's classification/posture/workspace and optionally
 * resumes its vendor session. `#158`: `--fresh` skips resume gates and
 * composes opening context.
 */
export interface FixRequest {
  /** Parent task ref (short id or name). */
  parentRef: string;
  /** The fix brief that becomes this attempt's prompt. */
  prompt: string;
  /**
   * When true (`parley fix --fresh`), force a blank session, skip retry budget
   * and reattempt-window gates, and compose original-brief + history + fix
   * request behind the channel-matched preamble.
   */
  fresh?: boolean;
  /**
   * Explicit session override for this fix spawn (#162). Null/omitted ⇒ bind
   * fresh via ancestry (does not inherit the parent's session id).
   */
  orchestratorSessionId?: string | null;
  /** Caller's process-ancestry chain for fresh binding (#162). */
  ancestryChain?: ProcessAnchor[];
  /** Workspace root for single-live fallback / eval gate (#162). */
  workspaceRoot?: string | null;
}

/** `parley session` registration request (#162 / #190). */
export interface RegisterSessionRequest {
  /**
   * Optional free-form harness (lowercased for grouping). Null/omit → unknown
   * provenance; never defaulted.
   */
  harness?: string | null;
  /**
   * Optional free-form model (lowercased). Null/omit → unknown provenance.
   */
  model?: string | null;
  /**
   * Optional free-form effort (lowercased). Null/omit → unknown provenance.
   */
  effort?: string | null;
  /**
   * Session id to re-anchor or (when {@link createIfMissing}) insert.
   * Null/omitted ⇒ allocate a fresh id. Unknown id without createIfMissing
   * is an error (typo protection for `--session` re-anchor).
   */
  sessionId?: string | null;
  /**
   * When true and `sessionId` is unknown, insert a new session with that id
   * (#196 plugin env / session-state). Default false preserves `--session`
   * re-anchor-only behavior.
   */
  createIfMissing?: boolean;
  /** Absolute workspace root this session is flying. */
  workspaceRoot: string;
  /** The registering process's own anchor (not the full chain). */
  anchor: ProcessAnchor;
  /**
   * Human clear of the enforcing `panicked` state (ADR-0019 / #240). Only
   * applies when re-anchoring a known session; ignored on fresh insert.
   */
  clearPanic?: boolean;
}

/** Inputs shared by delegate/fix/eval for session binding (#162). */
export interface SessionBindInput {
  explicitSessionId: string | null;
  ancestryChain: ProcessAnchor[];
  workspaceRoot: string | null;
  /** Repo (or cwd) used to read `eval.enabled`. */
  evalProjectRoot: string | null;
}

/** Sidecar written for runner-affine tasks (contexts survive until lease). */
interface RunnerMeta {
  contexts: ContextFile[];
  base_ref: string | null;
}

/** Resolved create-time fields after profile + defaults (#113 / #154 / #195). */
interface ResolvedDelegate {
  vendor: string;
  profile: string | null;
  model: string | null;
  effort: string | null;
  /**
   * Provenance of model: `resolved` (adapter path), `declared` (template
   * profile), or null when unknown (#154 / #195).
   */
  model_source: string | null;
  /**
   * Provenance of effort: same vocabulary as {@link model_source}.
   */
  effort_source: string | null;
  sandbox: SandboxMode;
  network: boolean;
  /**
   * True when the resolved profile carries a launch template (#195 / ADR-0015).
   * Skips adapter argv composition, the model allowlist, and resume composition.
   */
  launchTemplate: boolean;
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
  /**
   * Append-only in-memory log of every task-state transition this daemon has
   * recorded (#34), in seq order. `parley watch`'s multi-task long-poll scans it
   * to replay a transition after a caller's `since`, or blocks on `eventWaiters`
   * until the next one. Lost on restart — a reconnecting watcher just resumes
   * from the current seq; nothing before connect is replayed (spec §3).
   */
  private readonly transitions: Transition[] = [];
  /**
   * Paired state-write + notify path (#206). All lifecycle state mutations go
   * through here so seq / log / wake / concurrency drain cannot be forgotten.
   */
  private readonly taskTransitions: TaskTransitions;
  /**
   * ADR-0007 / ADR-0019 inbox (peek / ack / waitFor / allDone) — level-triggered
   * view over task rows + run rows + acks (#207 / #240). Wake bus stays on
   * {@link eventWaiters}.
   */
  private readonly inbox: Inbox;
  /**
   * Run firehose recorder (ADR-0019). Shares the transition log / wake bus with
   * task transitions so `watch --follow` sees `run.*` events.
   */
  private readonly runTransitions: RunTransitions;
  /**
   * Last observed (state, node, iteration) per run id — used to emit edge
   * transitions after drainRuns / actionRun without modifying updateRun.
   */
  private readonly runSnapshots = new Map<
    string,
    { state: string; current_node: string | null; iteration: number }
  >();
  /** Long-poll waiters (inbox / firehose / SSE) parked until the next transition. */
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
   * Fallback timers armed when a report is accepted while the vendor child is
   * still live (#72). Fire `completeAcceptedReport` if the stream never closes.
   */
  private readonly reportFallbackTimers = new Map<string, NodeJS.Timeout>();
  /**
   * Per-task runner heartbeat timers (#111): re-armed on each lease/heartbeat;
   * fire `fail` with a runner-lost error when the window elapses.
   */
  private readonly runnerHeartbeatTimers = new Map<string, NodeJS.Timeout>();
  /**
   * Task ids created with `delegate --dry-run` (#161). On terminal transition
   * the row + logs + worktree are purged so nothing is recorded. In-memory
   * only — a daemon restart mid dry-run may leave a rare orphan row.
   */
  private readonly dryRunTaskIds = new Set<string>();
  /**
   * Task ids admitted to spawn but not yet holding a DB slot (`running` /
   * `awaiting_answer`) — counted toward concurrency caps so prepare races
   * cannot over-admit (#171).
   */
  private readonly admitted = new Set<string>();
  /** Re-entrancy guard for {@link drainConcurrencyQueue}. */
  private drainingQueue = false;
  /**
   * Re-entrancy guard for {@link drainRuns} (#237). Same shape as
   * {@link drainingQueue}: a state change may unlock more work.
   */
  private drainingRuns = false;
  /**
   * Long-poll waiters parked on `POST /runner/lease` until a matching pending
   * task appears or the poll window elapses.
   */
  private readonly runnerLeaseWaiters = new Set<() => void>();
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
  ) {
    const transitionHooks = {
      append: (t: Transition) => {
        this.transitions.push(t);
      },
      wake: () => {
        this.wakeEventWaiters();
      },
      onSlotFreed: () => {
        this.drainConcurrencyQueue();
        // #237: a settled run-owned task may unlock the run cursor (advance).
        this.drainRuns();
      },
      onTerminal: (taskId: string) => {
        // Dry-run (#161): after waiters observe the terminal event, purge the
        // row so list/status leave no record. A short delay lets an already-
        // parked (or just-started) watch read the terminal state first.
        if (this.dryRunTaskIds.has(taskId)) {
          const timer = setTimeout(() => this.purgeDryRunTask(taskId), 250);
          timer.unref();
        }
      },
    };
    this.taskTransitions = createTaskTransitions(db, transitionHooks);
    this.runTransitions = createRunTransitions(db, transitionHooks);
    this.inbox = createInbox(
      sqliteTaskSnapshot(db),
      sqliteAckStore(db),
      sqliteRunSnapshot(db),
    );
    // Seed run snapshots so the first post-start drain only emits real edges.
    // Ensure every already-actionable run has an event-id seq (restart safety:
    // a gate that predates this daemon must still surface in the inbox).
    // Backfill missing block_reason via inferBlockReason when definition loads
    // — never substring-guess from error text in the inbox.
    for (const run of listRuns(this.db)) {
      this.runSnapshots.set(run.id, {
        state: run.state,
        current_node: run.current_node,
        iteration: run.iteration,
      });
      if (run.state === "blocked") {
        this.ensureRunBlockReason(run);
      }
      const tier = runInboxTierState({
        state: run.state,
        block_reason: getRunBlockReason(this.db, run.id),
      });
      if (tier !== null && getRunSeq(this.db, run.id) === 0) {
        bumpRunSeq(this.db, run.id);
      }
    }
    // Re-arm heartbeats for runner tasks that survived a daemon restart
    // (excluded from the process-group crash sweep).
    for (const task of listTasks(this.db)) {
      if (
        task.runner !== null &&
        task.runner !== "" &&
        !isTerminalState(task.state) &&
        task.state !== "pending"
      ) {
        this.armRunnerHeartbeat(task.id);
      }
    }
    // #171: re-drain durable queued tasks in original FIFO order after restart.
    // Synchronous: only admits (async spawn is fire-and-forget via admitAndStart).
    this.drainConcurrencyQueue();
    // #237: resume advance for any run left mid-flight across a restart.
    this.drainRuns();
  }

  setHubPort(port: number): void {
    this.hubPort = port;
  }

  list(): TaskRow[] {
    return listTasks(this.db).map((t) => this.withQueueInfo(t));
  }

  /**
   * Distinct orchestrator sessions known via tasks, most-recent first (#88).
   * Optional `query` filters by id substring.
   */
  listSessions(query?: string): SessionSummary[] {
    return listSessions(this.db, query);
  }

  /**
   * Register or re-anchor an orchestrator session (#162 / #190 / #196).
   * - No `sessionId` ⇒ allocate a fresh id and insert.
   * - Known `sessionId` ⇒ re-anchor + update harness/model/effort/workspace.
   * - Unknown `sessionId` + `createIfMissing` ⇒ insert with that id (plugin
   *   env / session-state first registration).
   * - Unknown `sessionId` without createIfMissing ⇒ usage error.
   * Harness/model/effort are optional; null stores as honest unknown.
   * Non-null values are lowercased for grouping. Does not rewrite past
   * task/eval dual snapshots.
   */
  registerSession(request: RegisterSessionRequest): SessionRow {
    const harness = normalizeOptionalProvenance(request.harness);
    const model = normalizeOptionalProvenance(request.model);
    const effort = normalizeOptionalProvenance(request.effort);
    if (request.workspaceRoot === "" || request.workspaceRoot === null) {
      throw new DelegateError("session: workspace_root is required");
    }
    const anchor = request.anchor;
    if (
      typeof anchor?.machine_id !== "string" ||
      anchor.machine_id === "" ||
      typeof anchor.pid !== "number" ||
      !Number.isFinite(anchor.pid) ||
      typeof anchor.start_time !== "string" ||
      anchor.start_time === ""
    ) {
      throw new DelegateError(
        "session: anchor must be { machine_id, pid, start_time }",
      );
    }

    const existingId =
      typeof request.sessionId === "string" && request.sessionId !== ""
        ? request.sessionId
        : null;

    if (existingId !== null) {
      const existing = getSession(this.db, existingId);
      if (existing) {
        if (request.clearPanic === true) {
          clearSessionPanic(this.db, existingId);
        }
        return updateSession(this.db, existingId, {
          harness,
          model,
          effort,
          workspace_root: request.workspaceRoot,
          anchor,
        });
      }
      if (request.createIfMissing !== true) {
        throw new DelegateError(`unknown session: ${existingId}`);
      }
      return insertSession(this.db, {
        id: existingId,
        harness,
        model,
        effort,
        workspace_root: request.workspaceRoot,
        anchor,
      });
    }

    // Fresh id: short, unique, free-form-friendly (matches historical session ids).
    const id = `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    return insertSession(this.db, {
      id,
      harness,
      model,
      effort,
      workspace_root: request.workspaceRoot,
      anchor,
    });
  }

  /**
   * Warning from the most recent {@link bindOrchestrator} call (multi-live
   * most-recent fallback, #280). Cleared by {@link takeSessionBindingWarning}.
   */
  private lastSessionBindingWarning: string | null = null;

  /**
   * Consume the warning from the most recent bind (HTTP layer threads it to
   * the CLI for stderr). Single-threaded request handlers call this before the
   * next bind.
   */
  takeSessionBindingWarning(): string | null {
    const w = this.lastSessionBindingWarning;
    this.lastSessionBindingWarning = null;
    return w;
  }

  /**
   * Resolve orchestrator binding for a call (#162 / #280). Returns a provenance
   * snapshot when a registered session binds, a free-form id when the caller
   * overrode with an unregistered id, or null when unbound. Throws
   * `session_required` when evals are on and nothing resolves.
   *
   * Multi-live workspace fallback binds the most-recently-updated live session
   * and records a warning (no hard ambiguous error).
   */
  private bindOrchestrator(
    input: SessionBindInput,
  ): { snapshot: ProvenanceSnapshot | null; freeformId: string | null } {
    this.lastSessionBindingWarning = null;
    const workspaceRoot = input.workspaceRoot ?? "";
    const machineId = readMachineId();
    const result = resolveSessionBinding({
      explicitSessionId: input.explicitSessionId,
      ancestryChain: input.ancestryChain,
      workspaceRoot,
      sessions: listAllSessions(this.db),
      isSessionLive: (session) => isSessionCandidateLive(session, machineId),
    });

    let snapshot: ProvenanceSnapshot | null = null;
    let freeformId: string | null = null;
    if (result.kind === "bound") {
      snapshot = snapshotFromSession(result.session);
      if (result.warning !== undefined) {
        this.lastSessionBindingWarning = result.warning;
      }
    } else if (result.kind === "freeform") {
      freeformId = result.sessionId;
    }

    const evalsOn = readEvalEnabled(input.evalProjectRoot);
    if (evalsOn && snapshot === null) {
      // Free-form ids without registration lack harness/model/effort — not
      // attributable enough when evals are on.
      throw new DelegateError(sessionRequiredMessage(), CODE_SESSION_REQUIRED);
    }

    return { snapshot, freeformId };
  }

  /**
   * Delete sessions whose same-machine anchor pid is verifiably dead (#280).
   * Foreign-machine anchors are never reaped. Logs one diag line per deletion.
   * Injectable probes keep unit tests off the real process table.
   *
   * @returns ids of deleted sessions
   */
  reapDeadSessions(opts: {
    machineId?: string;
    isPidAlive?: PidAliveFn;
    readPidStartTime?: PidStartTimeFn;
  } = {}): string[] {
    const machineId = opts.machineId ?? readMachineId();
    const isAlive = opts.isPidAlive ?? isPidAlive;
    const readStart = opts.readPidStartTime ?? readPidStartTime;
    const removed: string[] = [];
    for (const session of listAllSessions(this.db)) {
      if (
        classifySessionLiveness(session, machineId, isAlive, readStart) !== "dead"
      ) {
        continue;
      }
      deleteSession(this.db, session.id);
      removed.push(session.id);
      this.appendHomeDiag(
        `session-reap: deleted dead session ${session.id} ` +
          `(machine=${session.anchor_machine} pid=${session.anchor_pid})`,
      );
    }
    return removed;
  }

  /** Best-effort append to the daemon-home `diag.log`. */
  private appendHomeDiag(line: string): void {
    try {
      fs.appendFileSync(
        path.join(this.paths.home, "diag.log"),
        `${new Date().toISOString()} ${line}\n`,
      );
    } catch {
      /* never let logging take down the daemon */
    }
  }

  get(id: string): TaskRow | undefined {
    return getTask(this.db, id);
  }

  /**
   * Merge usage attributed outside the vendor stream (the xAI reverse proxy
   * for grok, #95). Same shallow-merge semantics as `session_meta` usage on the
   * stream path (`usage = { ...existing, ...delta }`), written to the durable
   * task row so concurrent proxy calls share one bag with any stream-sourced
   * fields. Proxy-captured xAI usage is per-response; multi-call tasks may
   * undercount if only the last response's counters remain — residual risk
   * documented on #95.
   */
  mergeUsage(taskId: string, delta: Record<string, number>): void {
    if (this.shuttingDown) return;
    const task = getTask(this.db, taskId);
    if (!task) return;
    const existing = parseJsonColumn<Record<string, number>>(task.usage) ?? {};
    const merged: Record<string, number> = { ...existing };
    for (const [key, value] of Object.entries(delta)) {
      if (typeof value === "number" && Number.isFinite(value)) {
        merged[key] = value;
      }
    }
    const patch: TaskDataPatch = { usage: JSON.stringify(merged) };
    // Best-effort cache column (#152): only write when the vendor reported a
    // cache count — never invent 0 for silent vendors (tri-state honesty).
    const cached = normalizeUsage(merged).cached;
    if (cached !== null) patch.cached_input_tokens = cached;
    updateTask(this.db, taskId, patch);
  }

  /**
   * Persist usage JSON and, when the vendor reported a cache count, the
   * durable `cached_input_tokens` column (#152). Leaves the column null when
   * cache is unreported so metrics/status never guess a hit or miss.
   */
  private usagePatch(usage: Record<string, number>): TaskDataPatch {
    const patch: TaskDataPatch = { usage: JSON.stringify(usage) };
    const cached = normalizeUsage(usage).cached;
    if (cached !== null) patch.cached_input_tokens = cached;
    return patch;
  }

  resolve(ref: string): TaskRow | undefined {
    const task = resolveTask(this.db, ref);
    return task ? this.withQueueInfo(task) : undefined;
  }

  /** Durable Q&A history for a task (#79), ask order — empty when none. */
  listQa(taskId: string): QaTurnRow[] {
    return listQaTurns(this.db, taskId);
  }

  /** The directory holding a task's captured vendor output (the diagnostics reference). */
  logDir(taskId: string): string {
    return taskLogDir(this.paths, taskId);
  }

  /**
   * Whether a vendor child is still live for this task. Normally `completed`
   * is committed only at stream close (#72), but the post-report fallback can
   * flip the row while the child is still running — so this is the
   * authoritative "no more log bytes can land" signal, not the row state alone
   * (see `handleLogs`'s `eof` computation).
   */
  hasLiveChild(taskId: string): boolean {
    return this.children.has(taskId);
  }

  /**
   * Re-read `~/.parley/parley.json` (hot for vendor args/env/profiles). A
   * corrupt file throws `DelegateError` so the delegate request fails loudly
   * without taking down the daemon.
   */
  private readParleyConfig(): ParleyConfig {
    try {
      return readConfig(this.paths.config);
    } catch (err) {
      throw new DelegateError(errorMessage(err));
    }
  }

  /**
   * Resolve profile + explicit request fields. Adapter-composed paths then
   * validate against the vendor model allowlist (#185 / ADR-0014); launch-
   * template profiles skip the allowlist and record declared provenance
   * (#195 / ADR-0015). Precedence before allowlist default: explicit request >
   * profile. Posture falls back to ADR defaults. When neither vendor nor
   * profile is on the request, apply `defaults.profile` (wins) or
   * `defaults.vendor` (#175). Throws `DelegateError` on unknown/stale
   * profile/vendor, missing selection, or allowlist rejection.
   */
  private resolveDelegate(request: DelegateRequest): ResolvedDelegate {
    const config = this.readParleyConfig();
    // Explicit flags always win. Only when both are omitted do config defaults
    // apply; when both defaults are set, profile wins (it already names a vendor).
    let profile = request.profile;
    let vendorReq = request.vendor;
    const usedDefaults = profile === null && vendorReq === null;
    if (usedDefaults) {
      const defProfile = config.defaults?.profile;
      const defVendor = config.defaults?.vendor;
      if (typeof defProfile === "string" && defProfile !== "") {
        profile = defProfile;
      } else if (typeof defVendor === "string" && defVendor !== "") {
        vendorReq = defVendor;
      } else {
        throw new DelegateError(
          "vendor or profile is required (pass -v/--profile, or set defaults.vendor / defaults.profile in config)",
        );
      }
    }
    let profileCfg: ProfileConfig | undefined;
    if (profile !== null) {
      profileCfg = config.profiles?.[profile];
      if (profileCfg === undefined) {
        const known = Object.keys(config.profiles ?? {});
        const list = known.length > 0 ? known.join(", ") : "(none)";
        const via =
          usedDefaults && request.profile === null
            ? " from defaults.profile"
            : "";
        throw new DelegateError(`unknown profile${via}: ${profile} (known: ${list})`);
      }
    }
    const vendor = vendorReq ?? profileCfg?.vendor ?? null;
    if (vendor === null || vendor === "") {
      throw new DelegateError("vendor is required (or set via profile)");
    }
    const launchTemplate = profileHasLaunchTemplate(profileCfg);
    // Template profiles: declared provenance, no adapter default fill-in.
    // Adapter paths: request/profile only — allowlist supplies the default
    // combo when both are omitted (#185). Allowlist runs in `delegate` after
    // the vendor registry check so "unknown vendor" stays the first error.
    const model = launchTemplate
      ? resolveDeclaredTraceField(request.model, profileCfg?.model)
      : resolveTraceField(request.model, profileCfg?.model, null);
    const effort = launchTemplate
      ? resolveDeclaredTraceField(request.effort, profileCfg?.effort)
      : resolveTraceField(request.effort, profileCfg?.effort, null);
    return {
      vendor,
      profile,
      model: model.value,
      effort: effort.value,
      model_source: model.source,
      effort_source: effort.source,
      sandbox: request.sandbox ?? profileCfg?.sandbox ?? DEFAULT_SANDBOX,
      network: request.network ?? profileCfg?.network ?? DEFAULT_NETWORK,
      launchTemplate,
    };
  }

  /**
   * Hot-read whether a named profile currently has a launch template (#195).
   * Used by fix/resume paths so template reattempts stay fresh even if the
   * profile is edited after the parent row was created.
   */
  private profileUsesLaunchTemplate(profileName: string | null): boolean {
    if (profileName === null || profileName === "") return false;
    try {
      const config = this.readParleyConfig();
      return profileHasLaunchTemplate(config.profiles?.[profileName]);
    } catch {
      return false;
    }
  }

  /**
   * Single choke point for model+effort allowlist validation (#185 / ADR-0014).
   * Used by `delegate` (after profile resolution) and `fix` (inherited parent
   * combo). Throws `DelegateError` with the same error shapes on every path.
   */
  private resolveModelAllowlist(
    vendor: string,
    config: ParleyConfig,
    model: string | null,
    effort: string | null,
  ): { model: string; effort: string | null } {
    // Allowlist gate first — no disk I/O on the success path. CLI selection
    // is advisory for rejection text only (#284); reading it eagerly would
    // put a synchronous vendor-home read on every spawn (and a FIFO there
    // would hang the daemon event loop — #288). Defer to not_allowed only.
    try {
      const resolved = resolveAllowedCombo({
        vendor,
        vendorCfg: config.vendors?.[vendor],
        model,
        effort,
        configPath: this.paths.config,
      });
      return { model: resolved.model, effort: resolved.effort };
    } catch (err) {
      if (err instanceof ModelAllowlistError) {
        let message = err.message;
        if (err.code === "not_allowed") {
          let cliSelected = null;
          try {
            cliSelected =
              this.adapters.get(vendor)?.readSelectedModel?.() ?? null;
          } catch {
            cliSelected = null;
          }
          message += formatCliSelectedHint(
            cliSelected,
            listAllowedCombos(config.vendors?.[vendor]),
          );
        }
        throw new DelegateError(message);
      }
      throw err;
    }
  }

  /**
   * Create a task (pending) and kick off its background run. Returns the row
   * immediately (ADR-0008); callers wait via the attention inbox (`parley watch`).
   *
   * When `runner` is set (#111 / ADR-0012), the task stays pending and is never
   * locally spawned — a remote runner leases it later.
   */
  delegate(request: DelegateRequest): TaskRow {
    const resolved = this.resolveDelegate(request);
    const adapter = this.adapters.get(resolved.vendor);
    if (!adapter) {
      // Template profiles may declare a free-form vendor outside the registry
      // (#195 / ADR-0015). Without a template the same id is still unknown.
      if (!resolved.launchTemplate) {
        const known = [...this.adapters.keys()].join(", ");
        // When the vendor came only from defaults.vendor (no flags, no profile),
        // name the setting so a stale default is easy to fix (#175).
        const via =
          request.vendor === null &&
          request.profile === null &&
          resolved.profile === null
            ? " from defaults.vendor"
            : "";
        throw new DelegateError(
          `unknown vendor${via}: ${resolved.vendor} (known: ${known})`,
        );
      }
    }
    // Model allowlist choke point (#185 / ADR-0014): adapter-composed paths
    // only. Template profiles are exempt and keep declared provenance (#195).
    if (!resolved.launchTemplate) {
      const allowed = this.resolveModelAllowlist(
        resolved.vendor,
        this.readParleyConfig(),
        resolved.model,
        resolved.effort,
      );
      resolved.model = allowed.model;
      resolved.effort = allowed.effort;
      resolved.model_source = allowed.model === null ? null : "resolved";
      resolved.effort_source = allowed.effort === null ? null : "resolved";
    }

    // Ids and names are interchangeable task refs, so an id-shaped name would
    // shadow (or be shadowed by) a real task id in `resolveTask`.
    if (request.name !== null && /^t\d+$/.test(request.name)) {
      throw new DelegateError(`name must not look like a task id: ${request.name}`);
    }
    // Validate runner affinity against settings before the task exists.
    if (request.runner !== null) {
      const config = this.readParleyConfig();
      if (config.runners?.[request.runner] === undefined) {
        const known = Object.keys(config.runners ?? {});
        const list = known.length > 0 ? known.join(", ") : "(none)";
        throw new DelegateError(`unknown runner: ${request.runner} (known: ${list})`);
      }
    }

    // Session binding (#162) before any worktree/row so session_required never
    // leaves orphan state. Workspace root falls back to repo root of cwd.
    const earlyRepo = repoRoot(request.cwd);
    const workspaceRoot =
      request.workspaceRoot ?? earlyRepo ?? path.resolve(request.cwd);
    const { snapshot: orchSnapshot, freeformId: orchFreeform } = this.bindOrchestrator({
      explicitSessionId: request.orchestratorSessionId,
      ancestryChain: request.ancestryChain ?? [],
      workspaceRoot,
      evalProjectRoot: earlyRepo ?? request.cwd,
    });
    const orchSessionId = orchSnapshot?.session_id ?? orchFreeform;
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
    // Runner-affine tasks never cut a local worktree — the remote runner does.
    const isRemote = request.runner !== null;
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
      repo = root;
      if (isRemote) {
        // Resolve base SHA now so the lease can hand the runner a fixed commit;
        // worktree + branch are created on the runner host.
        workingDir = root;
        try {
          baseSha = execFileSync(
            "git",
            ["-C", root, "rev-parse", request.baseRef ?? "HEAD"],
            { encoding: "utf8" },
          ).trim();
        } catch (err) {
          throw new DelegateError(`failed to resolve base ref: ${errorMessage(err)}`);
        }
      } else {
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
        workingDir = info.path;
        worktreePath = info.path;
        branch = info.branch;
        baseSha = info.baseSha;
      }
    }

    // Classification + work-domain type (#151 / #161): hot-read project files
    // at the resolved repo. Omitted type ⇒ other; unknown size/difficulty/type
    // ⇒ usage error listing the project's valid set. Validate before
    // materializing context so a bad value never leaves a task row — and roll
    // back any worktree already cut for the same reason.
    let taskType: string;
    let size: string | null = request.size;
    let difficulty: string | null = request.difficulty;
    try {
      const taskTypes = readProjectTaskTypes(repo);
      taskType =
        request.type === null || request.type === undefined || request.type === ""
          ? FALLBACK_TASK_TYPE
          : request.type;
      if (!isValidTaskType(taskType, taskTypes)) {
        throw new DelegateError(
          `unknown task type: ${taskType} (expected ${formatValidTaskTypes(taskTypes)})`,
        );
      }
      const classification = readProjectClassification(repo);
      if (size !== null && size !== "") {
        if (!isValidSize(size, classification)) {
          throw new DelegateError(
            `invalid size: ${size} (expected ${formatValidSizes(classification)})`,
          );
        }
      } else {
        size = null;
      }
      if (difficulty !== null && difficulty !== "") {
        if (!isValidDifficulty(difficulty, classification)) {
          throw new DelegateError(
            `invalid difficulty: ${difficulty} (expected ${formatValidDifficulties(classification)})`,
          );
        }
      } else {
        difficulty = null;
      }
    } catch (err) {
      if (worktreePath !== null) {
        try {
          removeWorktree(repo, worktreePath);
        } catch {
          /* best-effort */
        }
      }
      if (err instanceof DelegateError) throw err;
      // Malformed taskTypes / classification (or other named config error).
      throw new DelegateError(`invalid project config: ${errorMessage(err)}`);
    }

    if (!isRemote) {
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
    } else {
      // Persist contexts for the lease response (no local workspace yet).
      this.writeRunnerMeta(id, {
        contexts: request.contexts,
        base_ref: request.baseRef,
      });
    }

    const row = insertTask(this.db, {
      id,
      name: request.name,
      vendor: resolved.vendor,
      model: resolved.model,
      effort: resolved.effort,
      model_source: resolved.model_source,
      effort_source: resolved.effort_source,
      profile: resolved.profile,
      runner: request.runner,
      repo,
      cwd: workingDir,
      prompt: request.prompt,
      orchestrator_session_id: orchSessionId,
      orch_harness: orchSnapshot?.harness ?? null,
      orch_model: orchSnapshot?.model ?? null,
      orch_effort: orchSnapshot?.effort ?? null,
      worktree: worktreePath,
      branch,
      base_sha: baseSha,
      sandbox: resolved.sandbox,
      network: resolved.network,
      answer_timeout_ms: request.answerTimeoutMs,
      report_schema:
        request.reportSchema !== null ? JSON.stringify(request.reportSchema) : null,
      size,
      difficulty,
      type: taskType,
    });

    if (request.dryRun === true) {
      this.dryRunTaskIds.add(id);
    }

    if (isRemote) {
      // Wake any lease long-polls waiting for this runner.
      this.wakeRunnerLeaseWaiters();
      return row;
    }

    this.scheduleLocalStart(row);
    return getTask(this.db, row.id) ?? row;
  }

  /**
   * `parley fix <task> "<brief>"` (#152 / #158): create a new attempt row linked
   * to `parent`, inherit classification/posture/workspace/profile/vendor fields,
   * and either resume the parent's vendor session (`resume.enabled`, default
   * on) or start a fresh session (still chain-linked). Returns the new row
   * immediately (ADR-0008).
   *
   * Resume path is gated by `retry.max` (project, default 1 — count of
   * `resumed=true` in the chain) and a reattempt window (`retry.window` default
   * 30m, `vendors.<id>.retryWindow` override). `--fresh` skips both gates,
   * forces a blank session, and receives daemon-composed context.
   *
   * Launch-template profiles never resume (#195 / ADR-0015): reattempts always
   * use fresh composition (same as `--fresh`), documented on the CLI surface.
   *
   * The work-domain `type` (#151) is inherited alongside size/difficulty.
   */
  fix(request: FixRequest): TaskRow {
    const parent = resolveTask(this.db, request.parentRef);
    if (!parent) {
      throw new DelegateError(`no such task: ${request.parentRef}`);
    }
    if (!isTerminalState(parent.state)) {
      throw new DelegateError(
        `task ${parent.id} is ${parent.state}; fix requires a terminal attempt (completed|failed|cancelled)`,
      );
    }
    // ADR-0017 / #242: lineage stays at the run level. A task-level fix chain
    // inside a run would half-apply fan-out siblings across runs — refuse.
    // Repair a failed/dead run with `parley run fork`, not `parley fix`.
    if (parent.run_id !== null && parent.run_id !== "") {
      throw new DelegateError(
        `task ${parent.id} belongs to run ${parent.run_id}; parley fix inside a ` +
          `run is refused. Fork the run with parley run fork instead.`,
      );
    }
    if (typeof request.prompt !== "string" || request.prompt.trim() === "") {
      throw new DelegateError("prompt is required");
    }
    const vendor = parent.vendor;
    if (vendor === null || vendor === "") {
      throw new DelegateError(`task ${parent.id} has no vendor; cannot fix`);
    }
    const parentIsTemplate = this.profileUsesLaunchTemplate(parent.profile);
    const adapter = this.adapters.get(vendor);
    if (!adapter && !parentIsTemplate) {
      const known = [...this.adapters.keys()].join(", ");
      throw new DelegateError(`unknown vendor: ${vendor} (known: ${known})`);
    }

    // Allowlist only for adapter-composed paths (#185). Template parents keep
    // the declared combo as-is (#195).
    const fixConfig = this.readParleyConfig();
    let allowedModel = parent.model;
    let allowedEffort = parent.effort;
    let modelSource = parent.model_source;
    let effortSource = parent.effort_source;
    if (!parentIsTemplate) {
      const allowed = this.resolveModelAllowlist(
        vendor,
        fixConfig,
        parent.model,
        parent.effort,
      );
      allowedModel = allowed.model;
      allowedEffort = allowed.effort;
      modelSource = allowed.model === null ? null : "resolved";
      effortSource = allowed.effort === null ? null : "resolved";
    } else {
      // Preserve declared provenance on the reattempt row.
      if (allowedModel !== null && modelSource !== "declared") {
        modelSource = "declared";
      }
      if (allowedEffort !== null && effortSource !== "declared") {
        effortSource = "declared";
      }
    }

    const fresh = request.fresh === true || parentIsTemplate;
    // Resume when project config allows *and* the parent captured a session,
    // unless the caller forced `--fresh` or the parent is a template profile
    // (#195 — templates never compose resume). Off (or missing session) still
    // creates a linked attempt with a blank session — lineage is independent.
    const resumeWanted = !fresh && readResumeEnabled(parent.repo ?? parent.cwd);
    const canResume = resumeWanted && parent.session_id !== null;

    if (canResume) {
      // Budget is always enforced at enqueue (no phantom attempt row).
      this.assertResumeBudget(parent);
      // Reattempt-window freshness: if we would start immediately, validate
      // now so the CLI still gets exit 8 without creating a row. If we would
      // queue under a concurrency cap, defer to dequeue so wait time cannot
      // itself cause a stale-session resume (#171).
      const peek: TaskRow = {
        ...parent,
        id: "__peek__",
        vendor,
        profile: parent.profile,
        state: "pending",
        runner: parent.runner,
      };
      if (this.canAdmit(peek)) {
        this.assertResumeWindow(parent, vendor);
      }
    }

    const id = nextTaskId(this.db);
    // Validate / recreate the inherited workspace before materializing context
    // (#180). Never let mkdir-on-materialize revive a cleaned worktree path as
    // an empty non-git directory.
    let workingDir = "";
    let worktreePath: string | null = null;
    let branch: string | null = null;
    let baseSha: string | null = null;
    let recreatedWorktree = false;
    try {
      const resolved = this.resolveFixWorkspace(parent, id);
      workingDir = resolved.workingDir;
      worktreePath = resolved.worktree;
      branch = resolved.branch;
      baseSha = resolved.baseSha;
      recreatedWorktree = resolved.recreated;
      materializeContext(workingDir, request.prompt, []);
    } catch (err) {
      if (recreatedWorktree && worktreePath !== null && parent.repo !== null) {
        try {
          removeWorktree(parent.repo, worktreePath);
        } catch {
          /* best-effort rollback */
        }
      }
      if (err instanceof DelegateError) throw err;
      throw new DelegateError(`failed to materialize task context: ${errorMessage(err)}`);
    }

    // Fix resolves its orchestrator session fresh at its own spawn (#162) —
    // not inherited from the parent. Attempt lineage is independent.
    const workspaceRoot =
      request.workspaceRoot ?? parent.repo ?? path.resolve(workingDir);
    const { snapshot, freeformId } = this.bindOrchestrator({
      explicitSessionId: request.orchestratorSessionId ?? null,
      ancestryChain: request.ancestryChain ?? [],
      workspaceRoot,
      evalProjectRoot: parent.repo ?? workingDir,
    });
    const orchSessionId = snapshot?.session_id ?? freeformId;

    const row = insertTask(this.db, {
      id,
      name: parent.name,
      vendor,
      model: allowedModel,
      effort: allowedEffort,
      model_source: modelSource,
      effort_source: effortSource,
      profile: parent.profile,
      runner: parent.runner,
      repo: parent.repo,
      cwd: workingDir,
      prompt: request.prompt,
      orchestrator_session_id: orchSessionId,
      orch_harness: snapshot?.harness ?? null,
      orch_model: snapshot?.model ?? null,
      orch_effort: snapshot?.effort ?? null,
      worktree: worktreePath,
      branch,
      base_sha: baseSha,
      sandbox: parent.sandbox,
      network: parent.network === 1,
      answer_timeout_ms: parent.answer_timeout_ms,
      report_schema: parent.report_schema,
      size: parent.size,
      difficulty: parent.difficulty,
      type: parent.type,
      parent_task_id: parent.id,
      attempt: parent.attempt + 1,
      resumed: canResume,
      // Seed so buildSpec/resume see the parent's vendor session immediately.
      session_id: canResume ? parent.session_id : null,
    });

    // Remote-affine parents stay remote: the runner leases the new attempt.
    if (parent.runner !== null && parent.runner !== "") {
      this.wakeRunnerLeaseWaiters();
      return row;
    }

    this.scheduleLocalStart(row);
    return getTask(this.db, row.id) ?? row;
  }

  /**
   * Enforce resume budget (`retry.max`) and reattempt window for a would-be
   * resumed fix (#158). Window expiry does not consume budget (no row is
   * written when this throws). Hot-reads project + vendor config.
   */
  private assertResumeAllowed(parent: TaskRow, vendor: string): void {
    this.assertResumeBudget(parent);
    this.assertResumeWindow(parent, vendor);
  }

  /** Enforce `retry.max` budget for a would-be resumed fix (#158 / #171). */
  private assertResumeBudget(parent: TaskRow): void {
    const projectRoot = parent.repo ?? parent.cwd;
    const max = readRetryMax(projectRoot, DEFAULT_RETRY_MAX);
    const resumedCount = countResumedAttempts(listTasks(this.db), parent.id);
    if (resumedCount >= max) {
      throw new DelegateError(
        retryLimitMessage(resumedCount, max),
        CODE_RETRY_LIMIT_EXCEEDED,
      );
    }
  }

  /**
   * Enforce reattempt-window freshness for a would-be resumed fix (#158 / #171).
   * Called at dequeue/start so time spent `queued` cannot make a resume stale
   * without a clear window-expired error.
   */
  private assertResumeWindow(parent: TaskRow, vendor: string): void {
    const projectRoot = parent.repo ?? parent.cwd;
    const windowMs = this.resolveRetryWindowMs(projectRoot, vendor);
    const ageMs = parentTerminalAgeMs(parent);
    if (ageMs > windowMs) {
      throw new DelegateError(
        reattemptWindowMessage(ageMs, windowMs),
        CODE_REATTEMPT_WINDOW_EXPIRED,
      );
    }
  }

  /**
   * Effective reattempt window: `vendors.<id>.retryWindow` (daemon home, hot)
   * overrides project `retry.window` (default 30m).
   */
  private resolveRetryWindowMs(projectRoot: string | null, vendor: string): number {
    const projectMs = readRetryWindowMs(
      projectRoot,
      parseDuration,
      DEFAULT_RETRY_WINDOW_MS,
    );
    let config: ParleyConfig;
    try {
      config = this.readParleyConfig();
    } catch {
      return projectMs;
    }
    const override = config.vendors?.[vendor]?.retryWindow;
    if (override === undefined) return projectMs;
    if (typeof override === "number" && Number.isFinite(override) && override >= 0) {
      return Math.round(override);
    }
    if (typeof override === "string") {
      const ms = parseDuration(override);
      if (ms !== null && ms >= 0) return ms;
    }
    return projectMs;
  }

  /**
   * Remove a task's worktree (keeping its branch — parley never merges). Refuses
   * tasks that are not in a terminal state. A `--cwd` task (no worktree) is a
   * no-op. Throws `DelegateError` (→ exit 2) on refusal or an unknown ref.
   */
  clean(ref: string): { task_id: string; worktree: string | null; removed: boolean } {
    const task = resolveTask(this.db, ref);
    if (!task) throw new DelegateError(`no such task: ${ref}`);
    if (!isTerminalState(task.state)) {
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
      if (!isTerminalState(task.state) || task.worktree === null) continue;
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
   * Retention sweep (#153 / #244): purge terminal tasks older than
   * `retention.days` (daemon config, default 30), decay run deliverables and
   * stamp run rows purged, and delete scratch subtrees. Never git branches,
   * never non-terminal tasks/runs. Effect-first: worktree/scratch failures
   * leave the row so a later sweep can retry; other items continue.
   *
   * When `dryRun` is true, lists expired tasks/runs and estimated bytes
   * without deleting anything.
   */
  gc(opts: { dryRun?: boolean } = {}): GcResult {
    const dryRun = opts.dryRun === true;
    let days = DEFAULT_RETENTION_DAYS;
    try {
      days = retentionDays(readConfig(this.paths.config));
    } catch {
      /* corrupt config → shipped default */
    }
    const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
    const cutoffIso = new Date(cutoffMs).toISOString();
    const expired = listExpiredTasks(this.db, cutoffIso);

    const tasks: GcTaskEntry[] = [];
    const failed: { task_id?: string; run_id?: string; error: string }[] = [];
    let freed = 0;

    for (const task of expired) {
      // Run-owned tasks under a live/blocked run wait — a gate may hold the
      // run open past the window; purging under it would be data loss (#244).
      const gate = runOwnedExpiryGate(this.db, task);
      if (gate.skip) continue;

      const logDir = taskLogDir(this.paths, task.id);
      const logBytes = directoryBytes(logDir);
      const wtBytes = task.worktree !== null ? directoryBytes(task.worktree) : 0;
      const bytes = logBytes + wtBytes;
      const entry: GcTaskEntry = {
        task_id: task.id,
        state: task.state,
        completed_at: task.completed_at,
        bytes,
        worktree: task.worktree,
      };

      if (dryRun) {
        tasks.push(entry);
        freed += bytes;
        continue;
      }

      // Deliverable decay on the producing task's clock: retain declared
      // run outputs; purge every other payload (#244 / ADR-0016).
      if (task.run_id !== null && gate.run !== undefined) {
        const declared = resolveDeclaredOutputKeysForRun(
          gate.run,
          this.paths.home,
        );
        decayTaskDeliverables(this.db, task.id, declared);
      }

      // Worktree first: if removal fails, keep the row so the next sweep retries
      // and the branch association is not orphaned mid-flight.
      if (task.worktree !== null) {
        try {
          this.removeTaskWorktree(task);
        } catch (err) {
          failed.push({ task_id: task.id, error: errorMessage(err) });
          continue;
        }
      }

      try {
        fs.rmSync(logDir, { recursive: true, force: true });
      } catch (err) {
        // Log dir residual is non-fatal; still drop the row so gc converges.
        failed.push({
          task_id: task.id,
          error: `logs: ${errorMessage(err)}`,
        });
      }

      deleteTask(this.db, task.id);
      tasks.push(entry);
      freed += bytes;
    }

    // Sessions: reap verifiably-dead anchors (#280), then drop rows older than
    // the retention cutoff (#162). Dry-run still only reports tasks (session
    // rows are tiny).
    if (!dryRun) {
      this.reapDeadSessions();
      for (const session of listExpiredSessions(this.db, cutoffIso)) {
        deleteSession(this.db, session.id);
      }
    }

    // Run row decay + scratch subtree deletion + task-less deliverable decay
    // (#244 / #250). Same cutoff; never branches. Effect first on scratch so
    // a failed rm leaves the row and its task-less deliverables.
    const runSweep = sweepRunRetention({
      db: this.db,
      cutoffIso,
      dryRun,
      runsDir: this.paths.runs,
      home: this.paths.home,
      directoryBytes,
    });
    for (const f of runSweep.failed) {
      failed.push({ run_id: f.run_id, error: f.error });
    }
    freed += runSweep.freed_bytes;

    return {
      dry_run: dryRun,
      removed: tasks.length,
      freed_bytes: freed,
      tasks,
      runs: runSweep.runs,
      failed,
    };
  }

  /**
   * Resolve the workspace a fix reattempt should use (#180):
   * - Existing valid parley worktree → reuse as today.
   * - Parley-managed worktree gone (clean / vanished) but branch + base still
   *   recorded → recreate a checkout on that branch for the new attempt.
   * - User `--cwd` missing → fail fast (never mkdir).
   * - Remote-affine parents keep the recorded cwd; the runner owns the tree.
   */
  private resolveFixWorkspace(
    parent: TaskRow,
    fixTaskId: string,
  ): {
    workingDir: string;
    worktree: string | null;
    branch: string | null;
    baseSha: string | null;
    recreated: boolean;
  } {
    // Remote runners materialize on the runner host; do not recreate locally.
    if (parent.runner !== null && parent.runner !== "") {
      const workingDir = parent.cwd ?? parent.repo ?? process.cwd();
      return {
        workingDir,
        worktree: parent.worktree,
        branch: parent.branch,
        baseSha: parent.base_sha,
        recreated: false,
      };
    }

    // Local worktree-managed tasks always record branch + base_sha + repo.
    // After clean/auto-remove, worktree (and cwd) are null but branch/base remain.
    const wasWorktreeManaged =
      parent.repo !== null && parent.branch !== null && parent.base_sha !== null;

    if (wasWorktreeManaged) {
      const existingPath = parent.worktree ?? parent.cwd;
      if (existingPath !== null && isValidGitCheckout(existingPath)) {
        return {
          workingDir: existingPath,
          worktree: parent.worktree ?? existingPath,
          branch: parent.branch,
          baseSha: parent.base_sha,
          recreated: false,
        };
      }

      const missingHint = existingPath ?? `branch ${parent.branch}`;
      try {
        const info = attachWorktree({
          repoRoot: parent.repo!,
          worktreesDir: this.paths.worktrees,
          taskId: fixTaskId,
          branch: parent.branch!,
        });
        return {
          workingDir: info.path,
          worktree: info.path,
          // Keep the inherited baseline (not the branch tip) so auto-remove
          // and "modified vs base" stay consistent across attempts.
          branch: parent.branch,
          baseSha: parent.base_sha,
          recreated: true,
        };
      } catch (err) {
        throw new DelegateError(
          `workspace missing or not a git checkout (${missingHint}); ` +
            `failed to recreate worktree on branch ${parent.branch}: ${errorMessage(err)}. ` +
            `Run a fresh \`parley delegate\` instead.`,
        );
      }
    }

    // User-supplied `--cwd` (never worktree-managed): directory must already exist.
    const workingDir = parent.cwd;
    if (workingDir === null || workingDir === "") {
      throw new DelegateError(
        `task ${parent.id} has no workspace directory; run a fresh \`parley delegate\``,
      );
    }
    let isDir = false;
    try {
      isDir = fs.statSync(workingDir).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) {
      throw new DelegateError(
        `workspace directory is missing: ${workingDir} ` +
          `(task ${parent.id} used --cwd); restore the directory or run a fresh \`parley delegate\``,
      );
    }
    return {
      workingDir,
      worktree: null,
      branch: parent.branch,
      baseSha: parent.base_sha,
      recreated: false,
    };
  }

  /**
   * Remove a task's worktree from disk and clear its `worktree` + `cwd` columns
   * (the branch is always kept). Clearing `cwd` distinguishes a cleaned
   * worktree from a user-supplied `--cwd` for later fix (#180). Throws on git
   * failure — callers choose whether that's fatal (clean), reported (sweep),
   * or best-effort (auto-remove).
   */
  private removeTaskWorktree(task: TaskRow): void {
    if (task.worktree === null) return;
    if (task.repo === null) {
      // Worktree tasks always record their source repo; a null here is a
      // corrupt row, and silently nulling the worktree would orphan the dir.
      throw new Error(`task ${task.id} has a worktree but no repo recorded`);
    }
    removeWorktree(task.repo, task.worktree);
    // Null both so fix can tell "cleaned worktree" from "user --cwd still set".
    updateTask(this.db, task.id, { worktree: null, cwd: null });
  }

  /**
   * Handle a `submit_report` MCP call for a task. Returns validation errors
   * (bounced to the child as a tool error) or null on acceptance.
   *
   * Acceptance stores the report and settles any parked question but does
   * *not* transition to `completed` (#72): that happens atomically with the
   * final usage when the vendor stream closes (or the post-report fallback
   * fires). The task stays `running` until then so no observer can see
   * `state: completed` with usage still in flight.
   */
  submitReport(taskId: string, payload: unknown): string[] | null {
    const task = getTask(this.db, taskId);
    if (!task) return [`unknown task: ${taskId}`];
    // Settled tasks, or a prior accepted report while still `running` — a
    // second/straggling report must not re-accept or move the task.
    if (isSettledState(task.state)) {
      return [`task ${taskId} is already ${task.state}`];
    }
    if (task.report !== null) {
      return [`task ${taskId} already has an accepted report`];
    }
    const schema = resolveReportSchema(task.report_schema);
    const errors = validateReport(payload, schema);
    if (errors.length > 0) return errors;

    // A misbehaving child may report over its own outstanding question —
    // settle the parked call so its timer cannot stall the eventual completion.
    this.settlePending(taskId, { error: `task ${taskId} completed` });
    // Store the report only. Stay `running` (or return from `awaiting_answer`
    // to `running`) — completion waits for stream close / fallback.
    const wasAwaiting = task.state === "awaiting_answer";
    const reportFields = {
      report: JSON.stringify(payload as Report),
      question_id: null,
      question: null,
    };
    if (wasAwaiting) {
      this.taskTransitions.apply(taskId, "running", {
        cause: "submit_report_unawait",
        fields: reportFields,
      });
    } else {
      updateTask(this.db, taskId, reportFields);
    }
    this.scheduleReportFallback(taskId);
    return null;
  }

  /**
   * Commit `completed` + `completed_at` + final usage in one update and notify
   * waiters (#72). No-op when the task is already terminal, has no accepted
   * report, or the daemon is shutting down.
   *
   * ADR-0017 / #238: `outcome: blocked` routes as a **failed** task (gave up /
   * unusable work); `partial` is a success. Port-schema reports (no outcome)
   * complete as usual and materialize deliverables when run-owned — and those
   * rows are written *before* the completed transition so drain never sees a
   * settled task without its ports (#264).
   */
  private completeAcceptedReport(
    taskId: string,
    usage?: Record<string, number>,
  ): void {
    if (this.shuttingDown) return;
    this.clearReportFallback(taskId);
    this.clearRunnerHeartbeat(taskId);
    this.admitted.delete(taskId);
    const task = getTask(this.db, taskId);
    if (!task || isTerminalState(task.state)) return;
    if (task.report === null) return;

    const report = parseJsonColumn<Record<string, unknown>>(task.report);
    const outcome =
      report !== null && typeof report.outcome === "string" ? report.outcome : null;

    // `outcome: blocked` → failed task (ADR-0017). Still record the report.
    if (outcome === "blocked") {
      const fields: TaskDataPatch = {
        completed_at: new Date().toISOString(),
        question_id: null,
        question: null,
        queued_at: null,
        error: "report outcome: blocked",
      };
      if (usage !== undefined) {
        Object.assign(fields, this.usagePatch(usage));
      }
      this.taskTransitions.apply(taskId, "failed", {
        cause: "fail",
        fields,
      });
      return;
    }

    const fields: TaskDataPatch = {
      completed_at: new Date().toISOString(),
      question_id: null,
      question: null,
      queued_at: null,
    };
    // Prefer the caller's in-memory accumulation (stream-close path); fall
    // back to whatever is already on the row (fallback timer path).
    if (usage !== undefined) {
      Object.assign(fields, this.usagePatch(usage));
    }

    // Run-owned: materialize deliverable rows from the accepted report
    // *before* the completed transition. onSlotFreed drains runs
    // synchronously inside apply(), so advance must never observe a
    // completed task whose deliverables are still absent (#264 / ADR-0017).
    // Best-effort — a bad payload must not undo completion (validation
    // already ran at submit_report); the try/catch lives inside the
    // recorder so a throw still leaves the task completed below.
    if (task.run_id !== null && task.node !== null && report !== null) {
      this.recordRunDeliverables(task, report);
    }

    this.taskTransitions.apply(taskId, "completed", {
      cause: "complete",
      fields,
    });
  }

  /**
   * Insert deliverable rows for a run-owned task from its accepted report
   * payload. Called **before** the completed transition so drain/advance can
   * never observe a settled task without its deliverables (#264 / ADR-0017).
   * Port types (and therefore deliverable kind: inline / file / dir) come
   * from the step's declared `out` ports on the workflow definition
   * (ADR-0016). Falling back to every key as text is the exception path when
   * the definition cannot be resolved — logged, never silent.
   */
  private recordRunDeliverables(
    task: TaskRow,
    report: Readonly<Record<string, unknown>>,
  ): void {
    if (task.run_id === null || task.node === null || task.iteration === null) {
      return;
    }
    try {
      let ports = this.resolveStepOutputPorts(task);
      if (ports === null) {
        console.error(
          `[parley] recordRunDeliverables: could not resolve output ports for ` +
            `run=${task.run_id} node=${task.node}; falling back to inline text kinds`,
        );
        ports = fallbackTextOutputPorts(report, task.report_schema);
      }
      if (Object.keys(ports).length === 0) return;
      const rows = deliverablesFromReport(report, ports, {
        runId: task.run_id,
        node: task.node,
        iteration: task.iteration,
        slot: task.slot,
        taskId: task.id,
        nextId: () => nextDeliverableId(this.db),
      });
      for (const row of rows) {
        insertDeliverable(this.db, row);
      }
    } catch (err) {
      // Best-effort: completion already committed.
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[parley] recordRunDeliverables failed: ${message}`);
    }
  }

  /**
   * Look up the run's workflow definition and return the current step's
   * declared output ports with real {@link PortType}s. Null when the run,
   * definition, or step cannot be resolved.
   */
  private resolveStepOutputPorts(
    task: TaskRow,
  ): Record<string, OutputPortSpec> | null {
    if (task.run_id === null || task.node === null) return null;
    const run = getRun(this.db, task.run_id);
    if (run === undefined) return null;

    let definition: WorkflowDefinition | null;
    try {
      // Prefer the run's bound repo as cwd so the local workflow layer wins
      // (same posture as buildRunDrainHost).
      const cwd =
        run.repo !== null && run.repo !== "" ? run.repo : process.cwd();
      const resolved = resolveWorkflow(run.workflow, {
        cwd,
        home: this.paths.home,
      });
      definition = resolved?.definition ?? null;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[parley] resolveStepOutputPorts: failed to load workflow ` +
          `"${run.workflow}": ${message}`,
      );
      return null;
    }
    if (definition === null) return null;

    const node = definition.nodes.find((n) => n.id === task.node);
    if (node === undefined || node.kind !== "step") return null;

    const ports: Record<string, OutputPortSpec> = {};
    for (const [name, port] of Object.entries(node.out)) {
      ports[name] = { type: port.type, bounds: port.bounds };
    }
    return ports;
  }

  /** Arm the post-report fallback so a hung child cannot leave the task running forever. */
  private scheduleReportFallback(taskId: string): void {
    this.clearReportFallback(taskId);
    const timer = setTimeout(() => {
      this.reportFallbackTimers.delete(taskId);
      // Best-effort usage already on the row (possibly null).
      this.completeAcceptedReport(taskId);
    }, reportAcceptedFallbackMs());
    timer.unref();
    this.reportFallbackTimers.set(taskId, timer);
  }

  private clearReportFallback(taskId: string): void {
    const timer = this.reportFallbackTimers.get(taskId);
    if (!timer) return;
    clearTimeout(timer);
    this.reportFallbackTimers.delete(taskId);
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
    if (isSettledState(task.state)) {
      return { error: `task ${taskId} is already ${task.state}` };
    }
    // Report already accepted (task still `running` until stream close) — same
    // settled guard as submit_report (#72).
    if (task.report !== null) {
      return { error: `task ${taskId} already has an accepted report` };
    }
    // One outstanding question per task holds by construction (the child blocks
    // while asking); guard anyway against a misbehaving child.
    if (this.pending.has(taskId)) {
      return { error: `task ${taskId} already has a pending question` };
    }

    const questionId = nextQuestionId(this.db);
    // Durable history first (#79): the turn is visible on detail even if the
    // process dies before the awaiting_answer transition is observed live.
    insertQaTurn(this.db, taskId, questionId, question);
    return new Promise<AskOutcome>((resolve) => {
      const timeoutMs = task.answer_timeout_ms ?? DEFAULT_ANSWER_TIMEOUT_MS;
      const timer = setTimeout(() => {
        this.stallOnAnswerTimeout(taskId);
      }, timeoutMs);
      timer.unref();
      this.pending.set(taskId, { questionId, resolve, timer });
      // Publish `awaiting_answer` + wake `parley watch`.
      this.taskTransitions.apply(taskId, "awaiting_answer", {
        cause: "ask",
        fields: { question_id: questionId, question },
      });
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
    if (!task || isSettledState(task.state)) {
      // Settled by other means: just release the parked call, no transition.
      pending.resolve({ error: `task ${taskId} is already ${task?.state ?? "gone"}` });
      return;
    }
    // Stall before stopping the child so its exit is read as part of the
    // stall, not as a report-less failure.
    this.taskTransitions.apply(taskId, "stalled", {
      cause: "answer_timeout",
      fields: {
        error: `answer timeout: question ${pending.questionId} was not answered in time`,
      },
    });
    pending.resolve({
      error: "answer timeout — the task is stalled; the orchestrator can resume it with `parley answer`",
    });
    this.stopChild(taskId);
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
    // Disarm post-report fallbacks so they cannot flip rows while the DB is
    // closing; live tasks stay as-recorded for the next daemon's sweep.
    for (const taskId of this.reportFallbackTimers.keys()) {
      this.clearReportFallback(taskId);
    }
    for (const taskId of this.runnerHeartbeatTimers.keys()) {
      this.clearRunnerHeartbeat(taskId);
    }
    // Unblock lease long-polls so shutdown is not held open.
    this.wakeRunnerLeaseWaiters();
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
      // Update the history turn in place (#79) before clearing the outstanding fields.
      answerQaTurn(this.db, task.id, pending.questionId, text);
      // `awaiting_answer → running` — a transition `parley watch` surfaces.
      this.taskTransitions.apply(task.id, "running", {
        cause: "answer",
        fields: { question_id: null, question: null },
      });
      pending.resolve({ answer: text });
      return getTask(this.db, task.id)!;
    }

    if (task.state === "stalled") {
      const adapter = this.adapterForTask(task);
      if (!adapter) {
        throw new DelegateError(`task ${task.id} has an unknown vendor: ${task.vendor ?? "?"}`);
      }
      // Resume answers the recorded outstanding question when one is still on the row.
      if (task.question_id !== null) {
        answerQaTurn(this.db, task.id, task.question_id, text);
      }
      // Clear question/error while still `stalled` (#206 Recommendation A). The
      // single published `→ running` edge comes from `runChild` when the child
      // is actually live — no silent intermediate state write.
      updateTask(this.db, task.id, {
        question_id: null,
        question: null,
        error: null,
      });
      // Template profiles never compose resume (#195) — always fresh.
      // Otherwise a vendor session can only be resumed if one was ever
      // captured. A task swept stalled before its child spoke (e.g. daemon
      // died right after delegate) has none — rerun it fresh with its
      // original prompt instead.
      const useTemplate = this.profileUsesLaunchTemplate(task.profile);
      const revive =
        !useTemplate && task.session_id !== null
          ? this.resume(task, adapter, text)
          : this.run(task, adapter);
      void revive.catch((err: unknown) => {
        this.fail(task.id, `task resume crashed: ${String(err)}`);
      });
      return getTask(this.db, task.id)!;
    }

    throw new DelegateError(`task ${task.id} has no pending question to answer`);
  }

  /**
   * Record a structured rubric evaluation against a task (#157 / #162).
   * Resolves the task's type → rubric, validates answers, computes score +
   * baseline, and persists answers + rubric id/version + score + baseline +
   * feedback. Separately snapshots the *judging* session's provenance at eval
   * time (dual snapshot — never rewrites spawn-time orch_* columns). A later
   * call overwrites the previous eval (including judge snapshot).
   *
   * Ownership guard (#243 / ADR-0020): rejects a task whose `run_id` is
   * non-null, pointing at `parley run eval`. Three separately scored reviewer
   * tasks *are* per-node scoring through the side door; per-node eval is
   * deliberately deferred, and this guard is what keeps that deferral honest.
   */
  evalTask(
    ref: string,
    answers: Record<string, boolean>,
    feedback: string,
    bind?: {
      explicitSessionId?: string | null;
      ancestryChain?: ProcessAnchor[];
      workspaceRoot?: string | null;
    },
  ): TaskRow {
    const task = resolveTask(this.db, ref);
    if (!task) throw new DelegateError(`no such task: ${ref}`);

    // ADR-0020: a run-owned task is not evaluable at all.
    if (task.run_id !== null && task.run_id !== "") {
      throw new DelegateError(
        `task ${task.id} is owned by run ${task.run_id}; use \`parley run eval ${task.run_id}\` instead`,
      );
    }

    let rubric;
    try {
      rubric = resolveRubricForTask(task.repo, task.type);
    } catch (err) {
      throw new DelegateError(err instanceof Error ? err.message : String(err));
    }

    try {
      validateAnswers(rubric, answers);
    } catch (err) {
      throw new DelegateError(err instanceof Error ? err.message : String(err));
    }

    // Judge binding (#162): independent of the task's spawn-time session.
    const workspaceRoot =
      bind?.workspaceRoot ?? task.repo ?? (task.cwd !== null ? path.resolve(task.cwd) : "");
    const { snapshot, freeformId } = this.bindOrchestrator({
      explicitSessionId: bind?.explicitSessionId ?? null,
      ancestryChain: bind?.ancestryChain ?? [],
      workspaceRoot,
      evalProjectRoot: task.repo ?? task.cwd,
    });

    const result = scoreRubric(rubric, answers);
    updateTask(this.db, task.id, {
      eval_score: result.score,
      eval_baseline: result.baseline,
      eval_feedback: feedback,
      eval_answers: JSON.stringify(answers),
      eval_rubric: rubric.id,
      eval_rubric_version: rubric.version,
      eval_session_id: snapshot?.session_id ?? freeformId,
      eval_harness: snapshot?.harness ?? null,
      eval_model: snapshot?.model ?? null,
      eval_effort: snapshot?.effort ?? null,
    });
    return getTask(this.db, task.id)!;
  }

  /**
   * Record a structured whole-run rubric evaluation (#243 / ADR-0020).
   *
   * Terminal runs only (`completed` / `failed` / `cancelled`) — the same
   * precondition as `parley run fork`. `blocked` is excluded: scoring it would
   * measure inbox latency rather than work.
   *
   * Rubric resolves through existing machinery: the definition's `type` on the
   * run (or `--type` override) → project `taskTypes` → rubric. No new rubric
   * documents. The judge is expected to read only run-level artifacts (inputs,
   * outputs, structural summary, final branch when workspace is `repo`); no
   * node appears in this call path.
   */
  evalRun(
    ref: string,
    answers: Record<string, boolean>,
    feedback: string,
    opts?: {
      /** Override the run's stored type for rubric resolution (`--type`). */
      type?: string | null;
      explicitSessionId?: string | null;
      ancestryChain?: ProcessAnchor[];
      workspaceRoot?: string | null;
    },
  ): RunRow {
    const run = resolveRun(this.db, ref);
    if (!run) throw new DelegateError(`no such run: ${ref}`);

    if (!isRunTerminalState(run.state)) {
      throw new DelegateError(
        `run ${run.id} is ${run.state}; only terminal runs (completed|failed|cancelled) can be evaluated`,
      );
    }

    const runType =
      opts?.type !== undefined && opts.type !== null && opts.type !== ""
        ? opts.type
        : run.type;

    let rubric;
    try {
      rubric = resolveRubricForRun(run.repo, runType);
    } catch (err) {
      throw new DelegateError(err instanceof Error ? err.message : String(err));
    }

    try {
      validateAnswers(rubric, answers);
    } catch (err) {
      throw new DelegateError(err instanceof Error ? err.message : String(err));
    }

    // Judge binding: independent of the run's spawn-time session.
    const workspaceRoot =
      opts?.workspaceRoot ?? run.repo ?? "";
    const { snapshot, freeformId } = this.bindOrchestrator({
      explicitSessionId: opts?.explicitSessionId ?? null,
      ancestryChain: opts?.ancestryChain ?? [],
      workspaceRoot,
      evalProjectRoot: run.repo,
    });

    const result = scoreRubric(rubric, answers);
    updateRunEval(this.db, run.id, {
      eval_score: result.score,
      eval_baseline: result.baseline,
      eval_feedback: feedback,
      eval_answers: JSON.stringify(answers),
      eval_rubric: rubric.id,
      eval_rubric_version: rubric.version,
      eval_session_id: snapshot?.session_id ?? freeformId,
      eval_harness: snapshot?.harness ?? null,
      eval_model: snapshot?.model ?? null,
      eval_effort: snapshot?.effort ?? null,
    });
    return getRun(this.db, run.id)!;
  }

  /** All runs, newest first — for `GET /run-metrics` (#243). */
  listAllRuns(): RunRow[] {
    return listRuns(this.db);
  }

  /**
   * Cancel a task: terminate its vendor child (if running) and move the task to
   * `cancelled`, waking inbox/firehose long-poll waiters. Throws
   * `DelegateError` (→ exit 2) for an unknown ref or an already-terminal task.
   * The worktree and captured logs are retained for inspection (never merged).
   */
  cancel(ref: string): TaskRow {
    const task = resolveTask(this.db, ref);
    if (!task) throw new DelegateError(`no such task: ${ref}`);
    if (isTerminalState(task.state)) {
      throw new DelegateError(`task ${task.id} is already ${task.state}`);
    }
    // Free any parked `ask_orchestrator` promise; the child is about to die, so
    // nothing is left to receive its tool result.
    this.pending.delete(task.id);
    // Drop a post-report fallback so it cannot complete after we cancel (#72).
    this.clearReportFallback(task.id);
    this.clearRunnerHeartbeat(task.id);
    this.admitted.delete(task.id);
    // Terminate the child. Its own `close` handler fires afterwards, but the
    // `cancelled` state is terminal so it will not be overwritten with `failed`.
    const child = this.children.get(task.id);
    if (child) child.kill("SIGTERM");
    this.taskTransitions.apply(task.id, "cancelled", {
      cause: "cancel",
      fields: {
        error: "cancelled by parley cancel",
        completed_at: new Date().toISOString(),
        // Clear any outstanding question so the terminal envelope honours the
        // "question_id/question are null unless awaiting_answer" contract.
        question_id: null,
        question: null,
        queued_at: null,
      },
    });
    return getTask(this.db, task.id)!;
  }

  /**
   * Remove a dry-run task's worktree, logs, and DB row after it reaches a
   * terminal state (#161). Best-effort: failures are swallowed so a stuck
   * cleanup never leaves the daemon in a bad state.
   */
  private purgeDryRunTask(taskId: string): void {
    this.dryRunTaskIds.delete(taskId);
    const task = getTask(this.db, taskId);
    if (!task) return;
    if (!isTerminalState(task.state)) return;
    try {
      if (task.worktree !== null) {
        try {
          this.removeTaskWorktree(task);
        } catch {
          /* best-effort */
        }
      }
      try {
        fs.rmSync(taskLogDir(this.paths, taskId), { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
      deleteTask(this.db, taskId);
    } catch {
      /* best-effort */
    }
  }

  private wakeEventWaiters(): void {
    // Snapshot then clear before waking: a woken watcher re-registers itself
    // (in its async continuation) when it re-blocks, so clearing here can't drop
    // that fresh registration.
    const waiters = [...this.eventWaiters];
    this.eventWaiters.clear();
    for (const wake of waiters) wake();
  }

  /**
   * Park until the next transition wake or `timeoutMs` elapses.
   * Shared wake bus for firehose/SSE (`waitForTransition`) and inbox `waitFor`.
   * #206 left waiters on TaskEngine; inbox injects this as {@link WakeSource}.
   */
  private parkEventWaiter(timeoutMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
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
  }

  /** The current global transition seq — `parley watch`'s "start from now" baseline. */
  currentSeq(): number {
    return currentSeq(this.db);
  }

  /**
   * The earliest recorded transition of a watched task or run with `seq >
   * since`, or null if none has happened yet. The non-blocking core of the
   * multi-task long-poll; `waitForEvents` blocks on top of it.
   *
   * `ids` may mix task ids and run ids. A task transition matches when its
   * `task_id` is watched **or** its `run_id` is watched. A run transition
   * matches when its `run_id` is watched.
   */
  peekEvent(ids: readonly string[], since: number): Transition | null {
    const watched = new Set(ids);
    // The log is append-only in seq order, so the first match is the earliest.
    return (
      this.transitions.find((t) => {
        if (t.seq <= since) return false;
        if (t.kind === "run") {
          return t.run_id != null && watched.has(t.run_id);
        }
        if (t.task_id !== undefined && watched.has(t.task_id)) return true;
        if (t.run_id != null && t.run_id !== "" && watched.has(t.run_id)) {
          return true;
        }
        return false;
      }) ?? null
    );
  }

  /**
   * The earliest recorded transition of *any* task with `seq > since`, or null
   * if none has happened yet. The unfiltered counterpart of `peekEvent` — the
   * non-blocking core of the SSE transition stream (`GET /events/stream`), which
   * carries all tasks (no `ids` filter in v1, spec §"New: SSE event stream").
   */
  peekAnyEvent(since: number): Transition | null {
    return this.transitions.find((t) => t.seq > since) ?? null;
  }

  /**
   * Block until `peek` finds a transition after the caller's `since`, replaying
   * immediately if one already happened, else parking on `eventWaiters` until
   * the next transition — or resolving null when `timeoutMs` elapses (the caller
   * re-polls / the SSE loop re-blocks). Shared by the multi-task long-poll and
   * the SSE stream; both re-peek after every wake to advance their `since`.
   */
  private async waitForTransition(
    peek: () => Transition | null,
    timeoutMs: number,
  ): Promise<Transition | null> {
    for (;;) {
      const found = peek();
      if (found) return found;
      const woke = await this.parkEventWaiter(timeoutMs);
      if (!woke) return null; // poll window elapsed, no matching transition yet
    }
  }

  /**
   * Multi-task long-poll (#34, spec §3): resolve with the earliest transition of
   * any watched task after `since` — replaying immediately if one already
   * happened, else blocking until the next transition — or null when the poll
   * window elapses (the CLI re-polls). Used by `watch --follow` (the firehose)
   * and kept for the SSE stream's filtered counterpart.
   */
  async waitForEvents(
    ids: readonly string[],
    since: number,
    timeoutMs: number,
  ): Promise<Transition | null> {
    return this.waitForTransition(() => this.peekEvent(ids, since), timeoutMs);
  }

  /**
   * The unfiltered counterpart of `waitForEvents` for the SSE stream: block for
   * the next transition of any task after `since`, or null when the window
   * elapses (the SSE loop re-blocks to keep the connection open).
   */
  async waitForAnyEvent(since: number, timeoutMs: number): Promise<Transition | null> {
    return this.waitForTransition(() => this.peekAnyEvent(since), timeoutMs);
  }

  /**
   * Ack an inbox event by its id (the transition seq that produced the state).
   * No-op when the event is superseded, or when the subject is a gate (gates
   * are never acked — only actioned; ADR-0019). Un-acked events redeliver.
   */
  ackEvent(eventId: number): void {
    this.inbox.ack(eventId);
    // Successful ack (or no-op supersession) drops the delivery counter for
    // that event id so a later re-entry starts fresh.
    noteEventResolved(this.db, eventId);
  }

  /**
   * Expand task ids (+ optional session) into a dual-subject {@link WatchSet}
   * (ADR-0019). Runs are pulled from: explicit run ids in `ids`, runs owned by
   * watched tasks, and runs sharing the session of any watched task / the
   * explicit session filter.
   */
  resolveWatchSet(
    taskOrRunIds: readonly string[],
    sessionId?: string | null,
  ): WatchSet {
    const taskIds = new Set<string>();
    const runIds = new Set<string>();
    const sessions = new Set<string>();
    if (sessionId) sessions.add(sessionId);

    for (const id of taskOrRunIds) {
      const task = getTask(this.db, id);
      if (task) {
        taskIds.add(task.id);
        if (task.run_id) runIds.add(task.run_id);
        if (task.orchestrator_session_id) {
          sessions.add(task.orchestrator_session_id);
        }
        continue;
      }
      const run = getRun(this.db, id);
      if (run) {
        runIds.add(run.id);
        if (run.orchestrator_session_id) {
          sessions.add(run.orchestrator_session_id);
        }
      }
    }

    for (const sid of sessions) {
      for (const run of listRunsForSession(this.db, sid)) {
        runIds.add(run.id);
      }
      // Session-scoped task expansion when the caller passed session without
      // enumerating every task id (gate-first workflows with zero tasks yet).
      if (taskOrRunIds.length === 0 && sessionId) {
        for (const task of listTasks(this.db)) {
          if (task.orchestrator_session_id === sid) taskIds.add(task.id);
        }
      }
    }

    return { taskIds: [...taskIds], runIds: [...runIds] };
  }

  /**
   * The highest-priority pending inbox event among the watch set, or null
   * (ADR-0007 / ADR-0019). Level-triggered. Priority: gate/awaiting_answer >
   * blocked/stalled > failed > completed; FIFO by seq within a tier.
   */
  peekInbox(watch: WatchSet): InboxEvent | null {
    return this.inbox.peek(watch);
  }

  /**
   * True when every watched subject is terminal *and* no pending inbox events
   * remain (ADR-0019 session-finished). Empty set is never all-done (#256).
   * Task-only watch sets match ADR-0007 observationally.
   */
  isInboxAllDone(watch: WatchSet): boolean {
    return this.inbox.allDone(watch);
  }

  /**
   * Whether a session id is known to the daemon (#256): a registered session
   * row, or any task/run row carrying that orchestrator_session_id. Free-form
   * bound ids (no sessions row) count as known so they remain watchable.
   */
  isKnownSession(sessionId: string): boolean {
    if (sessionId === "") return false;
    if (getSession(this.db, sessionId) !== undefined) return true;
    if (sessionHasTasks(this.db, sessionId)) return true;
    if (listRunsForSession(this.db, sessionId).length > 0) return true;
    return false;
  }

  /**
   * Inbox long-poll (ADR-0007 / ADR-0019): next pending event, session-finished,
   * or null when the poll window elapses with live work still outstanding.
   * Records a delivery for the breaker when an event is returned.
   */
  async waitForInbox(
    watch: WatchSet,
    timeoutMs: number,
  ): Promise<{ event: InboxEvent } | { allDone: true } | null> {
    const result = await this.inbox.waitFor(watch, timeoutMs, {
      park: (ms) => this.parkEventWaiter(ms),
    });
    if (result !== null && "event" in result) {
      this.recordInboxDelivery(result.event);
    }
    return result;
  }

  /**
   * Non-blocking inbox peek with delivery accounting (for `wait=false` tests).
   */
  peekInboxDelivering(watch: WatchSet): InboxEvent | null {
    const event = this.inbox.peek(watch);
    if (event) this.recordInboxDelivery(event);
    return event;
  }

  /** Record one delivery; trip `panicked` when the breaker threshold is hit. */
  private recordInboxDelivery(event: InboxEvent): void {
    const sessionId =
      event.kind === "task"
        ? (event.task?.orchestrator_session_id ?? null)
        : (event.run?.orchestrator_session_id ?? null);
    noteInboxDelivery(this.db, {
      eventId: event.seq,
      subjectKind: event.kind,
      subjectId: event.id,
      sessionId,
    });
  }

  /**
   * Human clear of the enforcing `panicked` session state (ADR-0019).
   * Surface: `parley session --clear-panic`.
   */
  clearPanic(sessionId: string): boolean {
    return clearSessionPanic(this.db, sessionId);
  }

  /** True when the session is panicked (effective concurrency cap of 0). */
  isPanicked(sessionId: string | null | undefined): boolean {
    return isPanickedSession(this.db, sessionId);
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
    if (!task || isTerminalState(task.state)) return;
    // An accepted report wins over any subsequent failure path (#72).
    if (task.report !== null) {
      this.completeAcceptedReport(taskId);
      return;
    }
    this.clearReportFallback(taskId);
    this.clearRunnerHeartbeat(taskId);
    this.admitted.delete(taskId);
    this.taskTransitions.apply(taskId, "failed", {
      cause: "fail",
      fields: {
        error,
        completed_at: new Date().toISOString(),
        queued_at: null,
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Remote runners (#111 / ADR-0012)
  // ---------------------------------------------------------------------------

  private runnerMetaPath(taskId: string): string {
    return path.join(taskLogDir(this.paths, taskId), RUNNER_META_FILE);
  }

  private writeRunnerMeta(taskId: string, meta: RunnerMeta): void {
    const dir = taskLogDir(this.paths, taskId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.runnerMetaPath(taskId), `${JSON.stringify(meta)}\n`);
  }

  private readRunnerMeta(taskId: string): RunnerMeta {
    try {
      const raw = fs.readFileSync(this.runnerMetaPath(taskId), "utf8");
      const parsed = JSON.parse(raw) as RunnerMeta;
      return {
        contexts: Array.isArray(parsed.contexts) ? parsed.contexts : [],
        base_ref: typeof parsed.base_ref === "string" ? parsed.base_ref : null,
      };
    } catch {
      return { contexts: [], base_ref: null };
    }
  }

  private armRunnerHeartbeat(taskId: string): void {
    this.clearRunnerHeartbeat(taskId);
    const windowMs = runnerHeartbeatTimeoutMs();
    const timer = setTimeout(() => {
      this.runnerHeartbeatTimers.delete(taskId);
      this.fail(taskId, `runner lost: no heartbeat within ${windowMs}ms`);
    }, windowMs);
    timer.unref();
    this.runnerHeartbeatTimers.set(taskId, timer);
  }

  private clearRunnerHeartbeat(taskId: string): void {
    const timer = this.runnerHeartbeatTimers.get(taskId);
    if (!timer) return;
    clearTimeout(timer);
    this.runnerHeartbeatTimers.delete(taskId);
  }

  private wakeRunnerLeaseWaiters(): void {
    const waiters = [...this.runnerLeaseWaiters];
    this.runnerLeaseWaiters.clear();
    for (const wake of waiters) wake();
  }

  /** Config-level env for a task: vendor.env then profile.env (profile wins). */
  private configEnvFor(task: TaskRow): Record<string, string> {
    let config: ParleyConfig;
    try {
      config = readConfig(this.paths.config);
    } catch (err) {
      throw new Error(`config: ${errorMessage(err)}`);
    }
    const vendorId = task.vendor ?? "";
    const vendorEnv = config.vendors?.[vendorId]?.env ?? {};
    const profileEnv =
      task.profile !== null ? (config.profiles?.[task.profile]?.env ?? {}) : {};
    return { ...vendorEnv, ...profileEnv };
  }

  /**
   * Build the lease payload for a task row. Shared by the immediate-claim and
   * long-poll paths of `leaseRunnerTask`.
   */
  private buildLeaseSpec(task: TaskRow): RunnerLeaseSpec {
    if (task.repo === null || task.repo === "") {
      throw new DelegateError(`task ${task.id} has no repo recorded`);
    }
    const meta = this.readRunnerMeta(task.id);
    return {
      task_id: task.id,
      name: task.name,
      prompt: task.prompt ?? "",
      vendor: task.vendor ?? "",
      model: task.model,
      effort: task.effort,
      profile: task.profile,
      sandbox: task.sandbox,
      network: task.network === 1,
      answer_timeout_ms: task.answer_timeout_ms ?? DEFAULT_ANSWER_TIMEOUT_MS,
      report_schema:
        parseJsonColumn<JsonSchema>(task.report_schema) ?? DEFAULT_REPORT_SCHEMA,
      base_ref: meta.base_ref,
      base_sha: task.base_sha,
      repo: task.repo,
      contexts: meta.contexts,
      extra_args: this.extraArgsFor(task),
      env: this.configEnvFor(task),
    };
  }

  /**
   * Atomically claim the oldest pending task for `runnerName` (transition to
   * `running`) and return its lease spec, or null when none is waiting.
   */
  private tryClaimRunnerTask(runnerName: string): RunnerLeaseSpec | null {
    const pending = claimOldestPendingRunnerTask(this.db, runnerName);
    if (!pending) return null;
    this.taskTransitions.apply(pending.id, "running", {
      cause: "runner_claim",
      fields: { started_at: new Date().toISOString() },
    });
    this.armRunnerHeartbeat(pending.id);
    const claimed = getTask(this.db, pending.id);
    if (!claimed) return null;
    return this.buildLeaseSpec(claimed);
  }

  /**
   * `POST /runner/lease` — long-poll for the oldest pending task with the given
   * runner affinity. Returns the full lease spec when one is claimed, or null
   * when the poll window elapses with nothing to claim (HTTP 204).
   */
  async leaseRunnerTask(
    runnerName: string,
    timeoutMs: number,
  ): Promise<RunnerLeaseSpec | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const claimed = this.tryClaimRunnerTask(runnerName);
      if (claimed) return claimed;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return null;
      const woke = await new Promise<boolean>((resolve) => {
        const wake = (): void => {
          clearTimeout(timer);
          this.runnerLeaseWaiters.delete(wake);
          resolve(true);
        };
        const timer = setTimeout(() => {
          this.runnerLeaseWaiters.delete(wake);
          resolve(false);
        }, remaining);
        this.runnerLeaseWaiters.add(wake);
      });
      if (!woke) {
        // Window elapsed — one last try in case a task landed in the gap.
        return this.tryClaimRunnerTask(runnerName);
      }
    }
  }

  /**
   * `POST /runner/tasks/:id/heartbeat` — refresh the lease timer. Throws
   * `DelegateError` when the task is unknown, not runner-affine, or terminal.
   */
  runnerHeartbeat(taskId: string, runnerName: string): void {
    const task = getTask(this.db, taskId);
    if (!task) throw new DelegateError(`no such task: ${taskId}`);
    if (task.runner !== runnerName) {
      throw new DelegateError(`task ${taskId} is not leased to runner ${runnerName}`);
    }
    if (isTerminalState(task.state)) {
      throw new DelegateError(`task ${taskId} is already ${task.state}`);
    }
    this.armRunnerHeartbeat(taskId);
  }

  /**
   * `POST /runner/tasks/:id/events` — append raw vendor JSONL and run the same
   * parseEvent-based usage/session extraction as the local stream path.
   */
  processRunnerEvents(taskId: string, runnerName: string, lines: string[]): void {
    const task = getTask(this.db, taskId);
    if (!task) throw new DelegateError(`no such task: ${taskId}`);
    if (task.runner !== runnerName) {
      throw new DelegateError(`task ${taskId} is not leased to runner ${runnerName}`);
    }
    if (isTerminalState(task.state) && task.state !== "completed") {
      // Allow trailing events after completed (usage) but not after fail/cancel.
      if (task.state === "failed" || task.state === "cancelled") {
        throw new DelegateError(`task ${taskId} is already ${task.state}`);
      }
    }
    const adapter = this.adapters.get(task.vendor ?? "");
    if (!adapter) {
      throw new DelegateError(`task ${taskId} has an unknown vendor: ${task.vendor ?? "?"}`);
    }

    const logDir = taskLogDir(this.paths, taskId);
    fs.mkdirSync(logDir, { recursive: true });
    const rawLogPath = path.join(logDir, "vendor.jsonl");
    const diagLogPath = path.join(logDir, "diag.log");

    let usage = parseJsonColumn<Record<string, number>>(task.usage) ?? undefined;
    let sessionId = task.session_id ?? undefined;
    const events: VendorEvent[] = [];
    // Re-seed session extraction with a synthetic prior if we already have one
    // so sessionId() can still see it across chunk boundaries when needed.
    if (sessionId !== undefined) {
      events.push({ kind: "session_meta", session_id: sessionId });
    }

    const appendRaw: string[] = [];
    const appendDiag: string[] = [];
    let usageChanged = false;
    let sessionChanged = false;

    for (const line of lines) {
      appendRaw.push(line);
      const lineEvents = adapter.parseEvent(line);
      if (lineEvents.length === 0) continue;
      events.push(...lineEvents);
      for (const event of lineEvents) {
        if (event.kind === "session_meta" && event.usage !== undefined) {
          usage = { ...usage, ...event.usage };
          usageChanged = true;
        }
        if (event.kind === "error" && event.text?.startsWith(VENDOR_DIAG_PREFIX)) {
          appendDiag.push(`${new Date().toISOString()} ${event.text}`);
        }
      }
      if (lineEvents.some((e) => e.kind === "session_meta" && e.session_id !== undefined)) {
        const found = adapter.sessionId(events);
        if (found !== undefined && found !== sessionId) {
          sessionId = found;
          sessionChanged = true;
        }
      }
    }

    if (appendRaw.length > 0) {
      fs.appendFileSync(rawLogPath, `${appendRaw.join("\n")}\n`);
    }
    if (appendDiag.length > 0) {
      fs.appendFileSync(diagLogPath, `${appendDiag.join("\n")}\n`);
    }

    const patch: TaskDataPatch = {};
    if (usageChanged && usage !== undefined) Object.assign(patch, this.usagePatch(usage));
    if (sessionChanged && sessionId !== undefined) patch.session_id = sessionId;
    if (Object.keys(patch).length > 0) updateTask(this.db, taskId, patch);
  }

  /**
   * `POST /runner/tasks/:id/branch` — record the branch the runner pushed.
   * Worktree stays null for remote tasks. When a report is already accepted,
   * completes the task (remote stand-in for local stream-close).
   */
  recordRunnerBranch(taskId: string, runnerName: string, branch: string): TaskRow {
    const task = getTask(this.db, taskId);
    if (!task) throw new DelegateError(`no such task: ${taskId}`);
    if (task.runner !== runnerName) {
      throw new DelegateError(`task ${taskId} is not leased to runner ${runnerName}`);
    }
    if (branch.trim() === "") {
      throw new DelegateError("branch must be a non-empty string");
    }
    updateTask(this.db, taskId, { branch });
    if (task.report !== null && !isTerminalState(task.state)) {
      this.completeAcceptedReport(taskId);
    }
    return getTask(this.db, taskId)!;
  }

  /**
   * `POST /runner/tasks/:id/fail` — runner cannot execute (or child exited
   * without a report). An accepted report still wins (#72).
   */
  failRunnerTask(taskId: string, runnerName: string, error: string): TaskRow {
    const task = getTask(this.db, taskId);
    if (!task) throw new DelegateError(`no such task: ${taskId}`);
    if (task.runner !== runnerName) {
      throw new DelegateError(`task ${taskId} is not leased to runner ${runnerName}`);
    }
    this.fail(taskId, error);
    return getTask(this.db, taskId)!;
  }

  /** Daemon base URL (no path) — the HTTP/CLI child channels and MCP hub ride on it. */
  private hubBaseUrl(): string {
    if (this.hubPort === null) {
      throw new Error("task engine has no hub port yet");
    }
    return `http://127.0.0.1:${this.hubPort}`;
  }

  private hubFor(taskId: string): HubInfo {
    return {
      url: `${this.hubBaseUrl()}/mcp`,
      headers: { [TASK_HEADER]: taskId },
    };
  }

  /**
   * Build extraArgs from config: `vendors.<id>.args` then `profiles.<name>.args`.
   * Re-reads config so edits apply without a daemon restart. Corrupt config at
   * spawn fails the task (same loud posture as delegate).
   */
  private extraArgsFor(task: TaskRow): string[] {
    let config: ParleyConfig;
    try {
      config = readConfig(this.paths.config);
    } catch (err) {
      throw new Error(`config: ${errorMessage(err)}`);
    }
    const vendorId = task.vendor ?? "";
    const vendorArgs = config.vendors?.[vendorId]?.args ?? [];
    const profileArgs =
      task.profile !== null ? (config.profiles?.[task.profile]?.args ?? []) : [];
    return [...vendorArgs, ...profileArgs];
  }

  /**
   * Apply vendor-level spawn customization after the adapter builds a plan:
   * `vendors.<id>.bin` replaces argv[0]; env merge order is plan.env <
   * vendors.<id>.env < profile.env. Re-reads config (hot).
   */
  private applyVendorConfig(task: TaskRow, plan: SpawnPlan): SpawnPlan {
    let config: ParleyConfig;
    try {
      config = readConfig(this.paths.config);
    } catch (err) {
      throw new Error(`config: ${errorMessage(err)}`);
    }
    const vendorId = task.vendor ?? "";
    const vendorCfg = config.vendors?.[vendorId];
    const profileCfg =
      task.profile !== null ? config.profiles?.[task.profile] : undefined;
    const argv = [...plan.argv];
    if (vendorCfg?.bin !== undefined && argv.length > 0) {
      argv[0] = vendorCfg.bin;
    }
    return {
      ...plan,
      argv,
      env: {
        ...plan.env,
        ...(vendorCfg?.env ?? {}),
        ...(profileCfg?.env ?? {}),
      },
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
      // vendors.<id>.args then profiles.<name>.args — adapters splice into flags.
      extraArgs: this.extraArgsFor(task),
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
   * Resolve the child channel taught in the preamble (#155): config override
   * `vendors.<id>.childChannel` wins over the adapter's declared channel.
   * Re-reads config hot (same posture as args/env).
   */
  private childChannelFor(task: TaskRow, adapter: VendorAdapter): ChildChannel {
    let config: ParleyConfig;
    try {
      config = readConfig(this.paths.config);
    } catch {
      return adapter.childChannel;
    }
    const override = config.vendors?.[task.vendor ?? ""]?.childChannel;
    if (typeof override === "string" && isChildChannel(override)) return override;
    return adapter.childChannel;
  }

  /**
   * The protocol preamble prepended to every vendor prompt (spec §7 / #155).
   * Channel-matched tools section; everything else is channel-independent.
   * Re-prepended on resume too. Exported builder: {@link buildProtocolPreamble}.
   */
  private buildPreamble(task: TaskRow, adapter: VendorAdapter): string {
    const cwd = task.cwd ?? process.cwd();
    const schema = parseJsonColumn<JsonSchema>(task.report_schema) ?? DEFAULT_REPORT_SCHEMA;
    return buildProtocolPreamble({
      cwd,
      branch: task.branch,
      answerTimeoutMs: task.answer_timeout_ms ?? DEFAULT_ANSWER_TIMEOUT_MS,
      reportSchema: schema,
      childChannel: this.childChannelFor(task, adapter),
    });
  }

  /**
   * Hot-read operator PROMPT.md layers for a task (#159). Project layers resolve
   * from the workspace (`task.cwd`) so remote runners pick up the checked-out
   * repo's `.parley` prompts; home layers come from the daemon home.
   */
  private operatorInstructionsFor(task: TaskRow): string | null {
    return composeOperatorInstructions({
      homeDir: this.paths.home,
      projectDir: task.cwd,
      vendorId: task.vendor,
      profileName: task.profile,
    });
  }

  /** Fresh-run prompt: preamble + optional operator layers + brief (#159). */
  private initialPrompt(task: TaskRow, adapter: VendorAdapter): string {
    return assembleChildPrompt(
      this.buildPreamble(task, adapter),
      this.operatorInstructionsFor(task),
      task.prompt ?? "",
    );
  }

  /**
   * Resume prompt: preamble re-prepended (spec §2/§7), operator layers re-read
   * hot (#159), then the orchestrator's answer as the continuation.
   */
  private resumePrompt(task: TaskRow, adapter: VendorAdapter, answer: string): string {
    const channel = this.childChannelFor(task, adapter);
    const body = [
      "The orchestrator answered your outstanding question:",
      "",
      answer,
      "",
      finishInstruction(channel),
    ].join("\n");
    return assembleChildPrompt(
      this.buildPreamble(task, adapter),
      this.operatorInstructionsFor(task),
      body,
    );
  }

  /**
   * Effective configuration for `parley info` (#163): structured config plus
   * prose rendered from the same object (no drift). Project root is always
   * caller-supplied so remote daemons resolve the right workspace.
   */
  info(projectDir: string): InfoResponse {
    return buildInfo({
      projectDir,
      paths: this.paths,
      adapters: this.adapters,
    });
  }

  /**
   * Compose a prompt preview for `parley prompt` (#159). Child mode mirrors
   * what a spawn from `projectDir` would receive (preamble + operator layers,
   * no brief). Orchestrator mode returns compounded orchestrator PROMPT.md only.
   */
  previewPrompt(options: {
    projectDir: string;
    vendor: string | null;
    profile: string | null;
    orchestrator: boolean;
  }): string {
    if (options.orchestrator) {
      return (
        composeOrchestratorInstructions({
          homeDir: this.paths.home,
          projectDir: options.projectDir,
        }) ?? ""
      );
    }

    let config: ParleyConfig;
    try {
      config = readConfig(this.paths.config);
    } catch {
      config = {};
    }

    let profileCfg: ProfileConfig | undefined;
    if (options.profile !== null) {
      profileCfg = config.profiles?.[options.profile];
      if (profileCfg === undefined) {
        const known = Object.keys(config.profiles ?? {});
        const list = known.length > 0 ? known.join(", ") : "(none)";
        throw new DelegateError(`unknown profile: ${options.profile} (known: ${list})`);
      }
    }

    const vendor = options.vendor ?? profileCfg?.vendor ?? null;
    if (vendor === null) {
      throw new DelegateError("vendor is required (or set via profile)");
    }
    const adapter = this.adapters.get(vendor);
    if (!adapter) {
      const known = [...this.adapters.keys()].join(", ");
      throw new DelegateError(`unknown vendor: ${vendor} (known: ${known})`);
    }

    const override = config.vendors?.[vendor]?.childChannel;
    const childChannel =
      typeof override === "string" && isChildChannel(override)
        ? override
        : adapter.childChannel;

    const preamble = buildProtocolPreamble({
      cwd: options.projectDir,
      branch: null,
      answerTimeoutMs: DEFAULT_ANSWER_TIMEOUT_MS,
      reportSchema: DEFAULT_REPORT_SCHEMA,
      childChannel,
    });
    const operator = composeOperatorInstructions({
      homeDir: this.paths.home,
      projectDir: options.projectDir,
      vendorId: vendor,
      profileName: options.profile,
    });
    return assemblePromptPreview(preamble, operator);
  }


  // ---------------------------------------------------------------------------
  // Concurrency queue (#171)
  // ---------------------------------------------------------------------------

  /**
   * Admit a local (non-runner) task for spawn, or park it in `queued` when a
   * vendor/profile `maxConcurrent` cap is full. FIFO per cap; both caps must
   * have a free slot when both apply.
   */
  private scheduleLocalStart(task: TaskRow): void {
    if (task.runner !== null && task.runner !== "") return;
    if (this.canAdmit(task)) {
      this.admitAndStart(task);
      return;
    }
    this.enqueueTask(task.id);
  }

  /** Persist `queued` + `queued_at` and surface a `task.queued` transition. */
  private enqueueTask(taskId: string): void {
    const row = getTask(this.db, taskId);
    if (!row || isTerminalState(row.state)) return;
    if (row.state === "queued") return;
    this.taskTransitions.apply(taskId, "queued", {
      cause: "enqueue",
      fields: { queued_at: new Date().toISOString() },
    });
  }

  /**
   * True when every configured cap that applies to `task` has a free slot.
   * Counts DB slot-holders plus in-flight {@link admitted} prepares.
   */
  private canAdmit(task: TaskRow): boolean {
    // ADR-0019: panicked session ⇒ effective concurrency cap of 0.
    if (isPanickedSession(this.db, task.orchestrator_session_id)) {
      return false;
    }
    const caps = this.capsFor(task);
    if (caps.vendorMax === null && caps.profileMax === null) return true;

    if (caps.vendorMax !== null && task.vendor !== null) {
      const used = this.slotCountForVendor(task.vendor);
      if (used >= caps.vendorMax) return false;
    }
    if (caps.profileMax !== null && task.profile !== null) {
      const used = this.slotCountForProfile(task.profile);
      if (used >= caps.profileMax) return false;
    }
    return true;
  }

  private capsFor(task: TaskRow): {
    vendorMax: number | null;
    profileMax: number | null;
  } {
    let config: ParleyConfig;
    try {
      config = this.readParleyConfig();
    } catch {
      // Corrupt config: do not invent a cap (fail open to "no cap").
      return { vendorMax: null, profileMax: null };
    }
    const vendorMax =
      task.vendor !== null
        ? (config.vendors?.[task.vendor]?.maxConcurrent ?? null)
        : null;
    const profileMax =
      task.profile !== null
        ? (config.profiles?.[task.profile]?.maxConcurrent ?? null)
        : null;
    return {
      vendorMax: typeof vendorMax === "number" ? vendorMax : null,
      profileMax: typeof profileMax === "number" ? profileMax : null,
    };
  }

  private slotCountForVendor(vendor: string): number {
    let n = countSlotHoldingForVendor(this.db, vendor);
    for (const id of this.admitted) {
      const t = getTask(this.db, id);
      if (t && t.vendor === vendor && !SLOT_HOLDING_STATES.has(t.state)) n += 1;
    }
    return n;
  }

  private slotCountForProfile(profile: string): number {
    let n = countSlotHoldingForProfile(this.db, profile);
    for (const id of this.admitted) {
      const t = getTask(this.db, id);
      if (t && t.profile === profile && !SLOT_HOLDING_STATES.has(t.state)) n += 1;
    }
    return n;
  }

  /**
   * Which configured caps currently lack a free slot for `task` (#171).
   * Returns a stable string like `vendor:fake`, `profile:deep`, or
   * `vendor:fake+profile:deep`. Null when nothing is blocking (or no caps).
   */
  blockingCapFor(task: TaskRow): string | null {
    if (task.state !== "queued") return null;
    const caps = this.capsFor(task);
    const parts: string[] = [];
    if (caps.vendorMax !== null && task.vendor !== null) {
      if (this.slotCountForVendor(task.vendor) >= caps.vendorMax) {
        parts.push(`vendor:${task.vendor}`);
      }
    }
    if (caps.profileMax !== null && task.profile !== null) {
      if (this.slotCountForProfile(task.profile) >= caps.profileMax) {
        parts.push(`profile:${task.profile}`);
      }
    }
    // If nothing is full right now (race / about to drain), still name the
    // configured caps so the UI has something to show.
    if (parts.length === 0) {
      if (caps.vendorMax !== null && task.vendor !== null) {
        parts.push(`vendor:${task.vendor}`);
      } else if (caps.profileMax !== null && task.profile !== null) {
        parts.push(`profile:${task.profile}`);
      }
    }
    return parts.length > 0 ? parts.join("+") : null;
  }

  /**
   * 1-based FIFO position among queued peers for the primary blocking cap
   * (#171). Null when not queued.
   */
  queuePositionFor(task: TaskRow): number | null {
    if (task.state !== "queued") return null;
    const queued = listQueuedTasks(this.db);
    const caps = this.capsFor(task);
    const peers = queued.filter((t) => {
      if (caps.vendorMax !== null && task.vendor !== null) {
        return t.vendor === task.vendor;
      }
      if (caps.profileMax !== null && task.profile !== null) {
        return t.profile === task.profile;
      }
      // No cap configured (should not stay queued) — treat all queued as peers.
      return true;
    });
    const idx = peers.findIndex((t) => t.id === task.id);
    return idx === -1 ? null : idx + 1;
  }

  /**
   * Enrich a task row with computed queue observability fields (#171).
   * Safe for non-queued tasks (fields null).
   */
  withQueueInfo(task: TaskRow): TaskRow & {
    queue_position: number | null;
    blocking_cap: string | null;
  } {
    return {
      ...task,
      queue_position: this.queuePositionFor(task),
      blocking_cap: this.blockingCapFor(task),
    };
  }

  /** Reserve a slot and kick off the appropriate spawn path for `task`. */
  private admitAndStart(task: TaskRow): void {
    if (this.admitted.has(task.id)) return;
    if (isTerminalState(task.state)) return;
    this.admitted.add(task.id);
    void this.startAdmittedTask(task).catch((err: unknown) => {
      this.admitted.delete(task.id);
      this.fail(task.id, `task runner crashed: ${String(err)}`);
    });
  }

  /**
   * Start a previously-admitted task: re-validate resume freshness at dequeue,
   * then spawn via run / resumeFix / runFreshFix as appropriate.
   */
  private async startAdmittedTask(task: TaskRow): Promise<void> {
    const vendor = task.vendor;
    if (vendor === null || vendor === "") {
      this.admitted.delete(task.id);
      this.fail(task.id, "task has no vendor; cannot start");
      return;
    }
    const adapter = this.adapterForTask(task);
    if (!adapter) {
      this.admitted.delete(task.id);
      this.fail(task.id, `unknown vendor: ${vendor}`);
      return;
    }

    // Template profiles never resume (#195) — treat any residual resumed=1 as fresh.
    const useTemplate = this.profileUsesLaunchTemplate(task.profile);

    // Freshness at dequeue for resumed fix attempts (#171).
    if (!useTemplate && task.parent_task_id !== null && task.resumed === 1) {
      const parent = getTask(this.db, task.parent_task_id);
      if (!parent) {
        this.admitted.delete(task.id);
        this.fail(task.id, `parent task ${task.parent_task_id} is gone; cannot resume`);
        return;
      }
      try {
        this.assertResumeWindow(parent, vendor);
      } catch (err) {
        this.admitted.delete(task.id);
        const message = err instanceof Error ? err.message : String(err);
        this.fail(task.id, message);
        return;
      }
      const prompt = task.prompt ?? "";
      await this.resumeFix(task, adapter, prompt);
      return;
    }

    if (task.parent_task_id !== null) {
      const prompt = task.prompt ?? "";
      await this.runFreshFix(task, adapter, prompt);
      return;
    }

    await this.run(task, adapter);
  }

  /**
   * Resolve the adapter for a task: registered adapter when present; for a
   * launch-template free-form vendor, a generic HTTP-channel adapter that
   * only supplies parseEvent/sessionId stubs (#195).
   */
  private adapterForTask(task: TaskRow): VendorAdapter | undefined {
    const vendor = task.vendor ?? "";
    const registered = this.adapters.get(vendor);
    if (registered) return registered;
    if (this.profileUsesLaunchTemplate(task.profile)) {
      return createGenericTemplateAdapter(vendor);
    }
    return undefined;
  }

  /**
   * Walk the durable FIFO queue and admit any task that now fits under its
   * caps. Re-entrant safe; stops when no further task can be admitted.
   */
  private drainConcurrencyQueue(): void {
    if (this.drainingQueue || this.shuttingDown) return;
    this.drainingQueue = true;
    try {
      let progressed = true;
      while (progressed) {
        progressed = false;
        let queued: TaskRow[];
        try {
          queued = listQueuedTasks(this.db);
        } catch {
          // DB may already be closed (tests / shutdown race).
          return;
        }
        for (const task of queued) {
          if (this.admitted.has(task.id)) continue;
          if (!this.canAdmit(task)) continue;
          this.admitAndStart(task);
          progressed = true;
          // Re-list after each admit so slot counts stay accurate.
          break;
        }
      }
    } finally {
      this.drainingQueue = false;
    }
  }

  /**
   * Run-engine drain (#237 / #238 / ADR-0017): re-evaluate every `running`
   * run after a task settles (or on restart). Advance is pure in
   * `run-engine.ts`; this method is the host.
   *
   * Engine edit surface (keep small — later issues touch this file):
   * - `onSlotFreed` → `drainConcurrencyQueue()` then `drainRuns()`
   * - constructor → `drainRuns()` after the concurrency re-drain (restart)
   * - this method: re-entrancy guard + real host (loadDefinition / onEnter /
   *   onRetry / taskOutcome) + error logging
   * - `actionRun(verb)` public API for gate verbs
   * - `completeAcceptedReport`: outcome blocked → failed; run deliverables
   *   recorded *before* the completed transition (#264)
   *
   * Spawn-time errors block the run (never auto-fail). Definition parse
   * failures mark the run `failed` (nobody can advance it).
   */
  private drainRuns(): void {
    if (this.drainingRuns || this.shuttingDown) return;
    this.drainingRuns = true;
    try {
      drainRuns(this.db, this.buildRunDrainHost());
    } catch (err) {
      // Must not break onSlotFreed after concurrency drain already ran —
      // but a silent swallow made advance bugs invisible for a day (#238).
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[parley] drainRuns failed: ${message}`);
      if (err instanceof Error && err.stack) {
        console.error(err.stack);
      }
    } finally {
      this.drainingRuns = false;
      // ADR-0019: emit run.* firehose edges + bump run event-id seqs so the
      // inbox can surface gates/blocks without touching updateRun.
      this.syncRunTransitions();
    }
  }

  /**
   * Diff run rows against {@link runSnapshots} and emit `run.*` transitions
   * (ADR-0019). Called after drainRuns / actionRun. Gates spawn nothing — they
   * become visible only through these edges (`node_entered` + `blocked`).
   */
  private syncRunTransitions(): void {
    let any = false;
    for (const run of listRuns(this.db)) {
      if (run.state === "blocked") {
        this.ensureRunBlockReason(run);
      } else if (
        run.state === "running" ||
        run.state === "completed" ||
        run.state === "failed" ||
        run.state === "cancelled"
      ) {
        // Clear stale gate/block reason when the run has left blocked.
        if (getRunBlockReason(this.db, run.id) !== null) {
          setRunBlockReason(this.db, run.id, null);
        }
      }
      const prev = this.runSnapshots.get(run.id);
      const next = {
        state: run.state,
        current_node: run.current_node,
        iteration: run.iteration,
      };
      if (prev === undefined) {
        // Brand-new run observed for the first time this process.
        if (run.current_node) {
          this.runTransitions.record(run.id, {
            event: "run.node_entered",
            state: run.state,
            node: run.current_node,
            iteration: run.iteration,
            cause: "run_advance",
          });
          any = true;
        }
        if (run.state !== "running") {
          this.runTransitions.record(run.id, {
            event: `run.${run.state}`,
            state: run.state,
            node: run.current_node,
            iteration: run.iteration,
            cause: "run_advance",
          });
          any = true;
        } else if (!run.current_node) {
          // Running with no node yet — still allocate a seq baseline via started.
          this.runTransitions.record(run.id, {
            event: "run.started",
            state: run.state,
            node: null,
            iteration: run.iteration,
            cause: "run_advance",
          });
          any = true;
        }
      } else {
        const nodeChanged =
          prev.current_node !== next.current_node ||
          prev.iteration !== next.iteration;
        if (nodeChanged && next.current_node) {
          this.runTransitions.record(run.id, {
            event: "run.node_entered",
            state: run.state,
            node: next.current_node,
            iteration: next.iteration,
            cause: "run_advance",
          });
          any = true;
        }
        if (prev.state !== next.state) {
          this.runTransitions.record(run.id, {
            event: `run.${next.state}`,
            state: next.state,
            node: next.current_node,
            iteration: next.iteration,
            cause: next.state === "blocked" ? "run_gate" : "run_advance",
          });
          any = true;
        } else if (
          // Re-block on the same node (e.g. re-enter gate after redirect) still
          // needs a fresh event-id seq so the inbox redelivers.
          next.state === "blocked" &&
          nodeChanged
        ) {
          this.runTransitions.record(run.id, {
            event: "run.blocked",
            state: "blocked",
            node: next.current_node,
            iteration: next.iteration,
            cause: "run_gate",
          });
          any = true;
        }
      }
      this.runSnapshots.set(run.id, next);
    }
    // Wake even when only snapshots updated without edges? record() already wakes.
    void any;
  }

  /**
   * Ensure a blocked run has a stored `block_reason` for the inbox.
   * Prefer the reason already written by run-engine at block time; if missing
   * (legacy / restart), backfill with {@link inferBlockReason} when the
   * definition loads. Never invent a gate from free-text error alone.
   */
  private ensureRunBlockReason(run: RunRow): void {
    if (getRunBlockReason(this.db, run.id) !== null) return;
    try {
      const def = this.buildRunDrainHost().loadDefinition(
        run.workflow,
        run.version,
      );
      if (def === null) return;
      const reason = inferBlockReason(run, def);
      // Store even "unknown" so we do not re-infer every peek; inbox treats
      // only exact "gate" as unackable tier 1.
      setRunBlockReason(this.db, run.id, reason);
    } catch {
      // Definition unparseable — leave null ⇒ inbox treats as non-gate.
    }
  }

  /**
   * Host for {@link drainRuns} / {@link actionRunVerb}: resolve definitions
   * via two-layer discovery, spawn step tasks, report outcomes for policy.
   */
  private buildRunDrainHost(): RunDrainHost {
    return {
      loadDefinition: (workflowId, _version) => {
        // Prefer the run's repo (local layer), fall back to daemon home.
        // Version is recorded at start; we load the nearest definition and
        // trust the id. A parse throw becomes markRunFailed in advanceRun.
        const cwd = process.cwd();
        const resolved = resolveWorkflow(workflowId, {
          cwd,
          home: this.paths.home,
        });
        return resolved?.definition ?? null;
      },
      runInputs: (run) => {
        const root = this.resolveRunWorkspaceRoot(run);
        return readRunInputs(root);
      },
      taskOutcome: (taskId) => {
        const task = getTask(this.db, taskId);
        if (!task || task.report === null) return null;
        const report = parseJsonColumn<Record<string, unknown>>(task.report);
        if (report === null) return null;
        return typeof report.outcome === "string" ? report.outcome : null;
      },
      onEnter: (args) => this.spawnStepTasks(args),
      onRetry: (args) =>
        this.spawnStepTasks({
          run: args.run,
          definition: args.definition,
          step: args.step,
          iteration: args.iteration,
          inputs: args.inputs,
          loopFills: {},
          retryPlans: args.plans,
        }),
    };
  }

  /**
   * Gate / block verbs (ADR-0017 / #238): approve, reject, redirect, finish.
   * Only legal on a `blocked` run. Returns the updated run or throws
   * {@link DelegateError} on unknown id / illegal verb.
   */
  actionRun(
    runId: string,
    request: GateVerbRequest,
  ): { run: RunRow; decision: unknown } {
    const existing = getRun(this.db, runId);
    if (existing === undefined) {
      throw new DelegateError(`no such run: ${runId}`);
    }
    const result = actionRunVerb(this.db, runId, this.buildRunDrainHost(), request);
    if (result === null) {
      throw new DelegateError(`no such run: ${runId}`);
    }
    if (result.decision.kind === "error") {
      throw new DelegateError(result.decision.message);
    }
    // Gate actioned → emit run.* edges + new event-id seq (supersedes the gate
    // inbox event without an ack — ADR-0019).
    this.syncRunTransitions();
    return { run: result.run, decision: result.decision };
  }

  /**
   * `parley run start` (ADR-0022 / #249): bind inputs, preflight, create
   * workspace, insert run, enter node 1. Returns as soon as phase 2 commits
   * (ADR-0008); observation is `parley watch` / `parley run status`.
   */
  startRun(request: {
    workflow: string;
    fileInputs?: Record<string, unknown> | null;
    flagInputs?: InputFlag[];
    baseRef?: string | null;
    cwd: string;
    orchestratorSessionId?: string | null;
  }): StartRunResult {
    let config: ParleyConfig;
    try {
      config = readConfig(this.paths.config);
    } catch (err) {
      throw new DelegateError(
        `config unreadable: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const host = {
      ...this.buildRunDrainHost(),
      worktreesDir: this.paths.worktrees,
      runsDir: this.paths.runs,
      config,
      configPath: this.paths.config,
    };
    const result = startRunImpl(this.db, host, {
      workflow: request.workflow,
      fileInputs: request.fileInputs,
      flagInputs: request.flagInputs,
      baseRef: request.baseRef,
      cwd: request.cwd,
      home: this.paths.home,
      orchestratorSessionId: request.orchestratorSessionId,
    });
    if (result.kind === "ok" || (result.kind === "error" && result.run !== undefined)) {
      this.syncRunTransitions();
      this.drainRuns();
    }
    if (result.kind === "ok") {
      return {
        ...result,
        run: getRun(this.db, result.run.id) ?? result.run,
      };
    }
    return result;
  }

  /**
   * `parley run fork` (ADR-0017 / #242): new run from a **terminal** parent.
   * Never overlaps with redirect (live-only). Inputs frozen; steer is `note`.
   */
  forkRun(request: ForkRunRequest): ForkApplyResult {
    const host = {
      ...this.buildRunDrainHost(),
      worktreesDir: this.paths.worktrees,
      runsDir: this.paths.runs,
      resolveWorkspaceRoot: (run: RunRow) => this.resolveRunWorkspaceRoot(run),
    };
    const result = forkRun(this.db, host, request);
    if (result.kind === "error") {
      throw new DelegateError(result.message);
    }
    this.syncRunTransitions();
    // Entry may have spawned tasks — drain so any immediate settle advances.
    this.drainRuns();
    return {
      ...result.result,
      run: getRun(this.db, result.result.run.id) ?? result.result.run,
    };
  }

  /**
   * `parley run cancel` (ADR-0017 / #242): abandon a live run so it can be
   * forked. Cancels every non-terminal child task (kills vendor children),
   * then marks the run `cancelled`. Terminal runs are refused.
   */
  cancelRun(runId: string): RunRow {
    const existing = getRun(this.db, runId);
    if (existing === undefined) {
      throw new DelegateError(`no such run: ${runId}`);
    }
    // Cancel tasks first so vendor children die before the run goes terminal.
    for (const task of listCancellableRunTasks(this.db, runId)) {
      try {
        this.cancel(task.id);
      } catch {
        // Already terminal / race — keep cancelling siblings.
      }
    }
    const result = cancelRunRow(this.db, runId);
    if (result.kind === "error") {
      throw new DelegateError(result.message);
    }
    this.syncRunTransitions();
    return result.run;
  }

  /**
   * Spawn one or more tasks for a step enter / retry. Returns `{ error }` on
   * fixable failure so the run parks on `blocked` (never auto-fails).
   */
  private spawnStepTasks(args: {
    run: RunRow;
    definition: WorkflowDefinition;
    step: WorkflowStepNode;
    iteration: number;
    inputs: Record<string, unknown>;
    loopFills: Record<string, unknown>;
    note?: string | null;
    retryPlans?: readonly { slot: string | null; failedAttempts: number; retries: number }[];
  }): void | { error: string } {
    try {
      this.spawnStepTasksOrThrow(args);
      return;
    } catch (err) {
      const message =
        err instanceof StepConfigError || err instanceof DelegateError
          ? err.message
          : errorMessage(err);
      return { error: message };
    }
  }

  private spawnStepTasksOrThrow(args: {
    run: RunRow;
    definition: WorkflowDefinition;
    step: WorkflowStepNode;
    iteration: number;
    inputs: Record<string, unknown>;
    loopFills: Record<string, unknown>;
    note?: string | null;
    retryPlans?: readonly { slot: string | null; failedAttempts: number; retries: number }[];
  }): void {
    const { run, definition, step, iteration, inputs, note } = args;
    let config: ParleyConfig;
    try {
      config = readConfig(this.paths.config);
    } catch (err) {
      throw new DelegateError(`invalid config: ${errorMessage(err)}`);
    }

    // Which (slot) siblings to spawn.
    type Sibling = { slotId: string | null; retryIndex: number };
    const siblings: Sibling[] = [];

    if (args.retryPlans !== undefined && args.retryPlans.length > 0) {
      for (const plan of args.retryPlans) {
        siblings.push({
          slotId: plan.slot,
          retryIndex: plan.failedAttempts, // -rN for the next attempt
        });
      }
    } else if (step.slots !== undefined && Object.keys(step.slots).length > 0) {
      for (const slotId of Object.keys(step.slots)) {
        siblings.push({ slotId, retryIndex: 0 });
      }
    } else if (step.over !== undefined) {
      // Data fan-out: keys from the filled `over` input.
      const overValue = inputs[step.over];
      if (overValue === undefined) {
        throw new DelegateError(
          `data fan-out port "${step.over}" has no filled value on step ${step.id}`,
        );
      }
      if (Array.isArray(overValue)) {
        for (let i = 0; i < overValue.length; i++) {
          siblings.push({ slotId: String(i), retryIndex: 0 });
        }
      } else if (overValue !== null && typeof overValue === "object") {
        for (const key of Object.keys(overValue as Record<string, unknown>)) {
          siblings.push({ slotId: key, retryIndex: 0 });
        }
      } else {
        throw new DelegateError(
          `data fan-out port "${step.over}" is not a container on step ${step.id}`,
        );
      }
    } else {
      siblings.push({ slotId: null, retryIndex: 0 });
    }

    if (siblings.length === 0) {
      throw new DelegateError(`step ${step.id} resolved zero tasks to spawn`);
    }

    // Workspace root for the run (must already exist from run start).
    const workspaceRoot = this.resolveRunWorkspaceRoot(run);
    if (workspaceRoot === null) {
      throw new DelegateError(
        `run ${run.id} has no workspace on disk (start the run first, or workspace was removed)`,
      );
    }

    const isFanOut = siblings.length > 1 || step.over !== undefined || step.slots !== undefined;

    for (const sib of siblings) {
      const slot =
        sib.slotId !== null && step.slots !== undefined
          ? step.slots[sib.slotId]
          : null;
      const resolved = resolveStepExecution({
        step,
        slot: slot ?? null,
        slotId: sib.slotId,
        config,
        configPath: this.paths.config,
        // #284: wire selection read for run/workflow spawn so the advisory
        // line is not dead plumbing (same lazy-on-rejection contract as
        // resolveModelAllowlist — no disk I/O on the success path).
        readSelectedModel: (v) => {
          try {
            return this.adapters.get(v)?.readSelectedModel?.() ?? null;
          } catch {
            return null;
          }
        },
      });

      // Per-sibling input: data fan-out peels one element.
      const siblingInputs = { ...inputs };
      if (step.over !== undefined && sib.slotId !== null) {
        const container = inputs[step.over];
        if (Array.isArray(container)) {
          const idx = Number(sib.slotId);
          if (Number.isInteger(idx)) siblingInputs[step.over] = container[idx];
        } else if (container !== null && typeof container === "object") {
          siblingInputs[step.over] = (container as Record<string, unknown>)[sib.slotId];
        }
      }

      const address = formatStepAddress({
        node: step.id,
        iteration,
        slot: sib.slotId,
        retry: sib.retryIndex > 0 ? sib.retryIndex : null,
      });

      // Materialize inputs + compose body.
      const portSpecs: InputPortValue[] = [];
      for (const [name, port] of Object.entries(step.in)) {
        if (!(name in siblingInputs)) continue;
        portSpecs.push({
          name,
          type: port.type,
          value: siblingInputs[name],
        });
      }
      const materialized = materializeInputs({
        workspaceRoot,
        address,
        inputs: portSpecs,
      });
      const renderEntries: RenderInputEntry[] = materialized.ports.map((p) => ({
        name: p.port,
        type: p.type,
        value: siblingInputs[p.port],
        materializationPath: p.missingReferent ? undefined : p.relativePath,
        missingReferent: p.missingReferent,
      }));
      // Also render scalars that were not file-materialized as paths.
      for (const [name, port] of Object.entries(step.in)) {
        if (!(name in siblingInputs)) continue;
        if (renderEntries.some((e) => e.name === name)) continue;
        renderEntries.push({
          name,
          type: port.type,
          value: siblingInputs[name],
        });
      }
      const inputsSection = renderInputsSection(renderEntries);
      const body = composeStepBody({
        workflowDir: definition.dir,
        nodePromptPath: step.prompt,
        slotAppendPath: resolved.promptAppend,
        orchestratorNote: note ?? null,
        inputsSection,
      });

      const outPorts: Record<string, OutputPortSpec> = {};
      for (const [name, port] of Object.entries(step.out)) {
        outPorts[name] = { type: port.type, bounds: port.bounds };
      }
      const reportSchema = generateReportSchema(outPorts);

      // Allocate the task id before resolving the workspace. Isolated sibling
      // paths embed the task id, and for writable fan-out resolve is not pure
      // — it creates a worktree and cuts a branch named from the *address*.
      // Resolving once under a provisional id (`"pending"`) then again under
      // the real id collides on that branch (#265).
      const id = nextTaskId(this.db);

      // Resolve per-task cwd (shared run workspace or isolated sibling).
      // Run-owned tasks always record worktree/branch null (ADR-0018): the
      // run owns the checkout, so per-task auto-remove must not fire.
      let cwd = workspaceRoot;
      const worktree: string | null = null;
      const branch: string | null = null;
      let baseSha: string | null = null;
      if (run.workspace === "repo" && run.repo !== null) {
        try {
          const stepWs = resolveStepWorkspace({
            repoRoot: run.repo,
            worktreesDir: this.paths.worktrees,
            runId: run.id,
            runCheckoutPath: workspaceRoot,
            runBranch: runBranchName(run.id, run.workflow),
            taskId: id,
            address,
            sandbox: resolved.sandbox,
            fanOut: isFanOut,
          });
          cwd = stepWs.path;
          baseSha = stepWs.baseSha;
        } catch (err) {
          // Writable fan-out creation is required; surface the git error.
          // Linear / read-only paths only read the run checkout — fall back.
          if (isFanOut && resolved.sandbox !== "read-only") {
            throw new DelegateError(
              `failed to create sibling workspace for ${address}: ${errorMessage(err)}`,
            );
          }
          cwd = workspaceRoot;
        }
      } else if (run.workspace === "scratch") {
        try {
          const stepWs = resolveScratchStepWorkspace({
            runsDir: this.paths.runs,
            runId: run.id,
            runWorkspacePath: workspaceRoot,
            address,
            sandbox: resolved.sandbox,
            fanOut: isFanOut,
          });
          cwd = stepWs.path;
        } catch {
          cwd = workspaceRoot;
        }
      }

      const row = insertTask(this.db, {
        id,
        name: null,
        vendor: resolved.vendor,
        model: resolved.model,
        effort: resolved.effort,
        profile: resolved.profile,
        repo: run.repo,
        cwd,
        prompt: body,
        orchestrator_session_id: run.orchestrator_session_id,
        worktree,
        branch,
        base_sha: baseSha,
        sandbox: resolved.sandbox,
        network: resolved.network,
        answer_timeout_ms: null,
        report_schema: JSON.stringify(reportSchema),
        size: null,
        difficulty: null,
        type: step.task_type ?? definition.type ?? "other",
        run_id: run.id,
        node: step.id,
        iteration,
        slot: sib.slotId,
      });

      this.scheduleLocalStart(row);
    }
  }

  /**
   * Absolute path of the run's primary workspace, or null when missing.
   * `repo` mode: worktrees/<repo>/<runId>; `scratch`: runs/<runId>.
   */
  private resolveRunWorkspaceRoot(run: RunRow): string | null {
    if (run.workspace === "scratch") {
      const p = runScratchPath(this.paths.runs, run.id);
      return fs.existsSync(p) ? p : null;
    }
    if (run.repo === null || run.repo === "") return null;
    const p = runCheckoutPath(this.paths.worktrees, run.repo, run.id);
    return fs.existsSync(p) ? p : null;
  }

    /** Fresh run: spawn the vendor child via `prepare` (or template) and pump until exit. */
  private async run(task: TaskRow, adapter: VendorAdapter): Promise<void> {
    const prompt = this.initialPrompt(task, adapter);
    const plan = this.profileUsesLaunchTemplate(task.profile)
      ? this.buildTemplatePlan(task, prompt)
      : this.applyVendorConfig(task, await adapter.prepare({ ...this.buildSpec(task), prompt }, this.hubFor(task.id)));
    await this.runChild(task, adapter, plan, prompt, {
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
    const prompt = this.resumePrompt(task, adapter, answer);
    const spec: TaskSpec = { ...this.buildSpec(task), prompt };
    const plan = this.applyVendorConfig(task, await adapter.resume(spec, this.hubFor(task.id)));
    await this.runChild(task, adapter, plan, prompt, {
      // Kept from the original run; stamped here only if that never happened.
      ...(task.started_at === null ? { started_at: new Date().toISOString() } : {}),
    });
  }

  /**
   * Resume a fix attempt (#152): respawn via the adapter's `resume()` with the
   * parent's vendor session (already seeded on the row) and the fix brief as
   * the continuation prompt. Fresh `started_at` — a fix is a new attempt.
   */
  private async resumeFix(task: TaskRow, adapter: VendorAdapter, fixBrief: string): Promise<void> {
    const prompt = this.fixResumePrompt(task, adapter, fixBrief);
    const spec: TaskSpec = { ...this.buildSpec(task), prompt };
    const plan = this.applyVendorConfig(task, await adapter.resume(spec, this.hubFor(task.id)));
    await this.runChild(task, adapter, plan, prompt, {
      started_at: new Date().toISOString(),
    });
  }

  /**
   * Fresh fix attempt (#158): blank session via `prepare()`, daemon-composed
   * opening context (original brief + attempt history + fix request) behind
   * the channel-matched preamble.
   */
  private async runFreshFix(
    task: TaskRow,
    adapter: VendorAdapter,
    fixBrief: string,
  ): Promise<void> {
    const prompt = this.freshFixPrompt(task, adapter, fixBrief);
    const plan = this.profileUsesLaunchTemplate(task.profile)
      ? this.buildTemplatePlan(task, prompt)
      : this.applyVendorConfig(
          task,
          await adapter.prepare({ ...this.buildSpec(task), prompt }, this.hubFor(task.id)),
        );
    await this.runChild(task, adapter, plan, prompt, {
      started_at: new Date().toISOString(),
    });
  }

  /**
   * Build a spawn plan from a profile's launch template (#195 / ADR-0015).
   * Replaces adapter argv composition entirely. Parley still owns env merge,
   * posture env, cwd, and (via runChild) hub injection + child-channel teaching.
   * `$VAR` / `$PROMPT` expand against the merged env + assembled prompt.
   */
  private buildTemplatePlan(task: TaskRow, prompt: string): SpawnPlan {
    let config: ParleyConfig;
    try {
      config = readConfig(this.paths.config);
    } catch (err) {
      throw new Error(`config: ${errorMessage(err)}`);
    }
    const profileName = task.profile;
    const profileCfg =
      profileName !== null ? config.profiles?.[profileName] : undefined;
    if (!profileHasLaunchTemplate(profileCfg) || profileCfg?.template === undefined) {
      throw new Error(
        `profile ${profileName ?? "(none)"} has no launch template at spawn`,
      );
    }
    const vendorId = task.vendor ?? "";
    const vendorCfg = config.vendors?.[vendorId];
    // Env merge order matches applyVendorConfig: plan base < vendor < profile.
    // Posture is exposed for expansion / child visibility (adapters map it
    // themselves; templates have no adapter mapping).
    const planEnv: Record<string, string> = {
      PARLEY_SANDBOX: task.sandbox,
      PARLEY_NETWORK: task.network === 1 ? "1" : "0",
      ...(vendorCfg?.env ?? {}),
      ...(profileCfg.env ?? {}),
    };
    // Hub vars are also injected in runChild; include them here so $PARLEY_*
    // expands correctly when the template references them.
    let hubUrl = "";
    try {
      hubUrl = this.hubBaseUrl();
    } catch {
      /* hub port not ready — expansion leaves them empty; runChild still injects */
    }
    const expandEnv: Record<string, string> = {
      ...planEnv,
      ...(hubUrl !== ""
        ? { PARLEY_HUB_URL: hubUrl, PARLEY_TASK_ID: task.id }
        : { PARLEY_TASK_ID: task.id }),
      PROMPT: prompt,
    };
    const argv = expandLaunchTemplate(profileCfg.template, expandEnv);
    if (argv.length === 0 || argv[0] === "") {
      throw new Error(
        `launch template for profile ${profileName} produced an empty argv`,
      );
    }
    return {
      argv,
      env: planEnv,
      files: [],
      cwd: task.cwd ?? process.cwd(),
    };
  }

  /**
   * Resume prompt for a fix attempt: re-teach the protocol, then deliver the
   * fix brief as the conversation's continuation.
   */
  private fixResumePrompt(task: TaskRow, adapter: VendorAdapter, fixBrief: string): string {
    return [
      this.buildPreamble(task, adapter),
      "",
      "---",
      "",
      "The orchestrator is requesting a fix on the previous attempt:",
      "",
      fixBrief,
      "",
      "Continue from the prior session context and finish by calling `submit_report`.",
    ].join("\n");
  }

  /**
   * Fresh-fix prompt (#158): channel-matched preamble, then the three-section
   * composed body (original brief → attempt history → fix request). The new
   * row is already inserted, so exclude it from history (its report is empty).
   */
  private freshFixPrompt(task: TaskRow, adapter: VendorAdapter, fixBrief: string): string {
    const parentId = task.parent_task_id;
    const chain =
      parentId !== null
        ? collectAttemptChain(listTasks(this.db), parentId).filter((t) => t.id !== task.id)
        : [];
    const body = composeFreshFixBody(chain, fixBrief);
    return `${this.buildPreamble(task, adapter)}\n\n---\n\n${body}`;
  }

  /** Spawn a planned vendor child and pump its stream until exit. */
  private async runChild(
    task: TaskRow,
    adapter: VendorAdapter,
    plan: SpawnPlan,
    /** Exact prompt string in argv — elided as `"<prompt>"` in launch_command. */
    prompt: string,
    onSpawn: TaskDataPatch,
  ): Promise<void> {
    // `cancel` may have landed while the adapter was preparing; don't spawn a
    // child for an already-terminal task.
    const beforeSpawn = getTask(this.db, task.id);
    if (!beforeSpawn || isTerminalState(beforeSpawn.state)) {
      this.admitted.delete(task.id);
      this.drainConcurrencyQueue();
      return;
    }

    // Engine-side hub injection for every adapter (ADR-0011): children reach
    // the REST/CLI fallback via these, independent of MCP config quality.
    const hubUrl = this.hubBaseUrl();
    const planEnv: Record<string, string> = {
      ...plan.env,
      PARLEY_HUB_URL: hubUrl,
      PARLEY_TASK_ID: task.id,
    };
    // #154: record the final spawn argv (prompt elided) + cwd + env *names*
    // only. Spawn-per-turn vendors append one entry per spawn.
    const launchEntry = captureLaunchCommand(plan, prompt, planEnv);
    const launch_command = appendLaunchCommand(beforeSpawn.launch_command, launchEntry);
    // Materialize alongside other `.parley/` context so a subprocess that loses
    // env can still find the hub. Worktrees already git-exclude `/.parley/`.
    try {
      materializeChildHub(plan.cwd, hubUrl, task.id);
    } catch (err) {
      console.error(
        `task ${task.id}: failed to materialize .parley/child.json: ${errorMessage(err)}`,
      );
    }

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
    // Spawn-time adapter diagnostics (#186) — preflight-probe findings and other
    // prepare-phase anomalies that have no stream event to ride on.
    for (const diag of plan.diagnostics ?? []) {
      diagLog.write(`${new Date().toISOString()} ${diag}\n`);
    }

    const [command, ...args] = plan.argv;
    if (!command) throw new Error(`adapter ${adapter.id} produced an empty argv`);
    // Deliberately NOT detached: the child joins the daemon's process group
    // (the daemon is a session leader) so a group kill takes children with it,
    // and `killChildren` covers daemon shutdown — no orphans (spec §3).
    const child = spawn(command, args, {
      cwd: plan.cwd,
      env: { ...process.env, ...planEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.children.set(task.id, child);

    this.admitted.delete(task.id);
    // The child is live: `pending|queued → running` (fresh run) or
    // `stalled → running` (resume). Single published edge via transition module.
    this.taskTransitions.apply(task.id, "running", {
      cause: "spawn",
      fields: { ...onSpawn, launch_command, queued_at: null },
    });

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
    // Both output streams feed the adapter's parseEvent: several vendors put
    // load-bearing signal on stderr (hermes emits `session_id:` there, goose
    // warns about MCP-extension init failures, openclaw prints auth errors),
    // and a stdout-only feed silently loses it (adapter-validation-a/b docs,
    // #107). The raw records stay separate — stdout → vendor.jsonl, stderr →
    // stderr.log — so the durable logs are unchanged; only event extraction
    // sees both.
    const handleLine = (line: string, raw: fs.WriteStream): void => {
      // Raw stream is the durable record — stored untouched, unknown lines included.
      raw.write(`${line}\n`);
      const lineEvents = adapter.parseEvent(line);
      if (lineEvents.length === 0) return;
      events.push(...lineEvents);

      const patch: TaskDataPatch = {};
      let usageChanged = false;
      for (const event of lineEvents) {
        if (event.kind === "session_meta" && event.usage !== undefined) {
          // Codex's `usage` is treated as a cumulative running total, so each
          // new object supersedes the prior one via shallow merge rather than
          // summing (docs/research/vendor-token-usage-coverage.md).
          usage = { ...usage, ...event.usage };
          usageChanged = true;
        }
        // #154: vendor-reported model/effort upgrade the resolved-at-spawn
        // values (source flips to `vendor`). Empty reports are ignored so we
        // never overwrite a known value with nothing.
        if (
          event.kind === "session_meta" &&
          (event.model !== undefined || event.effort !== undefined)
        ) {
          const row = getTask(this.db, task.id);
          if (event.model !== undefined) {
            const current: ResolvedTraceField = {
              value: row?.model ?? null,
              source: (row?.model_source as ResolvedTraceField["source"]) ?? null,
            };
            const upgraded = upgradeTraceField(current, event.model);
            if (upgraded.value !== current.value || upgraded.source !== current.source) {
              patch.model = upgraded.value;
              patch.model_source = upgraded.source;
            }
          }
          if (event.effort !== undefined) {
            const current: ResolvedTraceField = {
              value: row?.effort ?? null,
              source: (row?.effort_source as ResolvedTraceField["source"]) ?? null,
            };
            const upgraded = upgradeTraceField(current, event.effort);
            if (upgraded.value !== current.value || upgraded.source !== current.source) {
              patch.effort = upgraded.value;
              patch.effort_source = upgraded.source;
            }
          }
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
      if (usageChanged && usage !== undefined) Object.assign(patch, this.usagePatch(usage));
      if (Object.keys(patch).length > 0) updateTask(this.db, task.id, patch);
    };
    const lines = readline.createInterface({ input: child.stdout });
    lines.on("line", (line) => handleLine(line, rawLog));
    const errLines = readline.createInterface({ input: child.stderr });
    errLines.on("line", (line) => handleLine(line, stderrLog));

    await new Promise<void>((resolve) => {
      // A resume replaces this task's entry in `children` — once that has
      // happened this child is stale (a stall's SIGTERM straggler) and its
      // exit is no longer a lifecycle event for the task.
      const isCurrentChild = (): boolean => this.children.get(task.id) === child;
      let settled = false;
      const closeStreams = (): void => {
        lines.close();
        errLines.close();
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
          // fail() promotes an already-accepted report to completed (#72).
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
        if (row && !isSettledState(row.state)) {
          if (row.report !== null) {
            // Accepted report wins over exit status (#72): commit completed +
            // final accumulated usage atomically, then notify waiters.
            this.completeAcceptedReport(task.id, usage);
          } else {
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
