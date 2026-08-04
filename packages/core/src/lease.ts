/**
 * Runner lease + registration wire contract (ADR-0012 / ADR-0029 / #209 / #314).
 *
 * Types and the HTTP client for the `/runner/*` verbs. Daemon server methods
 * and runner host execution stay in their packages; this module is only the
 * cross-process surface so shapes cannot drift silently.
 *
 * `RunnerLeaseSpec.prompt` is the orchestrator brief, not the assembled
 * vendor argv prompt — hosts build the full child prompt after the worktree
 * exists (daemon builders / #212 spawn-plan).
 */
import type { SandboxMode } from "./adapter.js";
import type { JsonSchema } from "./contract.js";
import type { ModelEntry } from "./models.js";

/** Correlation header children send on every hub request (ADR-0003 / ADR-0011). */
export const TASK_HEADER = "x-parley-task";

/** Default runner heartbeat window (ADR-0012 / #111). */
export const DEFAULT_RUNNER_HEARTBEAT_TIMEOUT_MS = 90_000;

/**
 * Default wait for a capable online executor when only offline capable ones
 * are registered (#315 / #304). Overridable via `daemon.routing.queueTimeoutMs`
 * or `PARLEY_ROUTING_QUEUE_TIMEOUT_MS`.
 */
export const DEFAULT_ROUTING_QUEUE_TIMEOUT_MS = 60 * 60 * 1000;

/** Stable id for the daemon's in-process executor on routing surfaces (#315). */
export const LOCAL_EXECUTOR_ID = "local";

/**
 * Registration / advertisement protocol version (ADR-0029).
 * Bump when the register payload or lease gating semantics change incompatibly.
 */
export const RUNNER_PROTOCOL_VERSION = 1;

/**
 * Default re-fingerprint interval while a runner is up (ADR-0029 / #314).
 * Overridable via `PARLEY_RUNNER_REFINGERPRINT_MS`.
 */
export const DEFAULT_RUNNER_REFINGERPRINT_MS = 60_000;

/**
 * Default online grace after last contact (~2× default long-poll window of 25s).
 * A runner with an open lease poll is always online; otherwise last_seen within
 * this window still counts as online. Overridable via `PARLEY_RUNNER_PRESENCE_GRACE_MS`.
 */
export const DEFAULT_RUNNER_PRESENCE_GRACE_MS = 50_000;

/**
 * Default stale threshold (14 days offline). Rows older than this surface as
 * `stale` and are auto-deleted by the daemon's lazy sweep (#320). Config:
 * `runnerSettings.staleWindowMs`. Test override: `PARLEY_RUNNER_STALE_MS`.
 */
export const DEFAULT_RUNNER_STALE_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * One context file shipped by value on the lease (daemon-side materialization
 * of --context). Kept structural so core does not import daemon/context.ts.
 */
export interface LeaseContextFile {
  name: string;
  contents: string;
}

/**
 * Full task spec returned by POST /runner/lease (ADR-0012).
 * `prompt` is the orchestrator brief, not the assembled vendor prompt.
 */
export interface RunnerLeaseSpec {
  task_id: string;
  name: string | null;
  /** Orchestrator brief (not the full vendor child prompt). */
  prompt: string;
  /**
   * Required vendor id for this task (capability requirement, #315).
   * Claim matching is primarily by vendor advertisement.
   */
  vendor: string;
  /**
   * Optional model requirement (#315). Advisory relative to runner catalogs;
   * matching is vendor-primary.
   */
  model: string | null;
  effort: string | null;
  profile: string | null;
  sandbox: SandboxMode;
  network: boolean;
  answer_timeout_ms: number;
  report_schema: JsonSchema;
  /** Caller's base ref, when set; null means HEAD at create time. */
  base_ref: string | null;
  /** Resolved base commit at create time; null when the daemon could not resolve it. */
  base_sha: string | null;
  /**
   * Normalized repo key (`host/path`, case-folded, `.git` stripped) derived
   * from origin at create time (#313 / #305). Null when the repo has no origin
   * or the fetch URL is not a network remote.
   */
  repo_key: string | null;
  /**
   * Exact origin fetch URL as recorded at create time (#313). Null when the
   * repo has no origin remote.
   */
  repo_fetch_url: string | null;
  /**
   * Delegate-time local path of the repo (or cwd). Used for the same-host
   * fast path; runners may also map it via `runner.repos`.
   */
  repo: string;
  contexts: LeaseContextFile[];
  /** `vendors.<id>.args` then `profiles.<name>.args`. */
  extra_args: string[];
  /** `vendors.<id>.env` then `profiles.<name>.env` (profile wins on key clash). */
  env: Record<string, string>;
}

/** POST /runner/lease body. */
export interface LeaseRequest {
  runner: string;
}

/** One vendor the runner advertises, with its fingerprinted model catalog. */
export interface RunnerVendorCapability {
  id: string;
  /** Advisory model catalog for this vendor on the runner host (may be empty). */
  models: ModelEntry[];
}

/** Fingerprinted host capabilities shipped on register (ADR-0029). */
export interface RunnerCapabilities {
  vendors: RunnerVendorCapability[];
}

/** POST /runner/register body. */
export interface RegisterRequest {
  runner: string;
  protocol_version: number;
  /** Runner package / build version string (informational). */
  build_version: string;
  capabilities: RunnerCapabilities;
}

/** POST /runner/register 200 body. */
export interface RegisterResponse {
  ok: true;
  name: string;
  registered_at: string;
  last_seen: string;
}

/** Derived runner presence (ADR-0029). */
export type RunnerStatus = "online" | "offline" | "stale";

/** One row in GET /runners (minimal fleet table for `parley runners list`). */
export interface RunnerListEntry {
  name: string;
  status: RunnerStatus;
  /** Advertised vendor ids (order preserved from last registration). */
  vendors: string[];
  last_seen: string;
  registered_at: string;
  protocol_version: number;
  build_version: string;
}

/** GET /runners body. */
export interface RunnersListResponse {
  runners: RunnerListEntry[];
}

/** One recent task on a runner detail (GET /runners/:name). */
export interface RunnerRecentTask {
  id: string;
  name: string | null;
  state: string;
  vendor: string | null;
  model: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

/**
 * One advertised repo-reachability flag (optional on the wire until mirrors
 * land; absent advertisement surfaces as null on the show response).
 */
export interface RunnerRepoReachability {
  repo_key: string;
  reachable: boolean;
}

/**
 * Full advertisement for `parley runners show` (GET /runners/:name, #320).
 * Extends the list row with models, optional reachability, age, and recent tasks.
 */
/**
 * One fail-once-then-avoid entry from `runners.unreachable_repos` (#317).
 * Daemon-recorded claim-time git failures until re-registration clears them.
 */
export interface RunnerUnreachableRepo {
  repo_key: string;
  code: string;
  /** ISO-8601 when the failure was recorded. */
  at: string;
  operation?: string;
}

export interface RunnerShowResponse {
  name: string;
  status: RunnerStatus;
  last_seen: string;
  registered_at: string;
  protocol_version: number;
  build_version: string;
  /**
   * Milliseconds since `last_seen` (last contact / presence age). Refreshed on
   * every poll, heartbeat, and task-traffic event — **not** capabilities age.
   * True advertisement age needs a separate column; tracked as #329.
   */
  last_contact_age_ms: number;
  /** Vendors with full model catalogs from the last registration. */
  vendors: RunnerVendorCapability[];
  /**
   * Repo-reachability flags from the last advertisement when present; `null`
   * when the runner did not advertise them (current wire may omit until
   * mirrors work lands).
   */
  repo_reachability: RunnerRepoReachability[] | null;
  /**
   * Daemon-recorded fail-once-then-avoid map (#317). Empty array when none;
   * never null so operators always see the section.
   */
  unreachable_repos: RunnerUnreachableRepo[];
  recent_tasks: RunnerRecentTask[];
}

/** DELETE /runners/:name body (#320). */
export interface RunnerRemoveResponse {
  ok: true;
  name: string;
  /** Whether a SQLite registration row was deleted. */
  deleted_row: boolean;
  /** Whether `runners.<name>` was removed from config. */
  deleted_config: boolean;
}

/** POST /runner/tasks/:id/events body. */
export interface EventsBody {
  lines: string[];
}

/** POST /runner/tasks/:id/branch body. */
export interface BranchBody {
  branch: string;
}

/**
 * Claim-time git failure codes (ADR-0031 / #316 / #317). Stable tokens for
 * operators, routing memory, and tests — not free-form message text.
 */
export type GitAuthFailureCode =
  | "no_repo_source"
  | "mirror_clone_failed"
  | "mirror_fetch_failed"
  | "base_sha_unresolvable"
  | "push_denied"
  | "push_preflight_failed"
  | "override_missing";

/** Closed set of {@link GitAuthFailureCode} values — use for wire validation. */
export const GIT_AUTH_FAILURE_CODES: readonly GitAuthFailureCode[] = [
  "no_repo_source",
  "mirror_clone_failed",
  "mirror_fetch_failed",
  "base_sha_unresolvable",
  "push_denied",
  "push_preflight_failed",
  "override_missing",
] as const;

/** Git operation that failed at claim time (#317). */
export type GitAuthOperation = "clone" | "fetch" | "push";

/** Closed set of {@link GitAuthOperation} values — use for wire validation. */
export const GIT_AUTH_OPERATIONS: readonly GitAuthOperation[] = [
  "clone",
  "fetch",
  "push",
] as const;

export function isGitAuthOperation(value: string): value is GitAuthOperation {
  return (GIT_AUTH_OPERATIONS as readonly string[]).includes(value);
}

export function isGitAuthFailureCode(value: string): value is GitAuthFailureCode {
  return (GIT_AUTH_FAILURE_CODES as readonly string[]).includes(value);
}

/**
 * Structured task error category for claim-time git failures (#317).
 * Distinguishes infrastructure (auth / reachability) from vendor crashes.
 *
 * **Daemon-owned identity**: `repo_key` and `runner` on the stored category
 * always come from the task row and the authenticated runner name — never from
 * the fail body (wire may still send them; the daemon ignores them).
 */
export interface GitAuthErrorCategory {
  kind: "git_auth";
  operation: GitAuthOperation;
  code: GitAuthFailureCode;
  /** Normalized repo key (`host/path`); null when the task had none. */
  repo_key: string | null;
  /** Executor name that failed (authenticated runner or `local`). */
  runner: string;
}

/** Known structured fail categories persisted on tasks (#317). */
export type TaskErrorCategory = GitAuthErrorCategory;

/**
 * Wire-only fail category body (#317). Only `kind`, `operation`, and `code`
 * are validated and used. `repo_key` / `runner` are optional and **ignored**
 * by the daemon (identity comes from the task row + bearer auth).
 */
export interface GitAuthFailCategoryWire {
  kind: "git_auth";
  operation: GitAuthOperation;
  code: GitAuthFailureCode;
  /** Ignored on the wire — daemon uses `task.repo_key`. */
  repo_key?: string | null;
  /** Ignored on the wire — daemon uses the authenticated runner name. */
  runner?: string;
}

/** Map a claim-time git code to the operation bucket operators care about. */
export function gitAuthOperationForCode(code: GitAuthFailureCode): GitAuthOperation {
  switch (code) {
    case "mirror_clone_failed":
    case "no_repo_source":
    case "override_missing":
      return "clone";
    case "mirror_fetch_failed":
    case "base_sha_unresolvable":
      return "fetch";
    case "push_denied":
    case "push_preflight_failed":
      return "push";
  }
}

/** Human-readable form of a snake_case git-auth code (`push_denied` → `push denied`). */
export function formatGitAuthCode(code: string): string {
  return code.replace(/_/g, " ");
}

/**
 * Compact label for CLI status / inbox: `git-auth:push` or `git-auth`.
 * Returns null when the value is not a git-auth category.
 */
export function formatErrorCategoryLabel(
  category: TaskErrorCategory | null | undefined,
): string | null {
  if (category === null || category === undefined) return null;
  if (category.kind === "git_auth") {
    return `git-auth:${category.operation}`;
  }
  return null;
}

/** Parse a stored JSON `error_category` column / envelope field. */
export function parseErrorCategory(raw: string | null | undefined): TaskErrorCategory | null {
  if (raw === null || raw === undefined || raw === "") return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as { kind?: unknown }).kind === "git_auth"
    ) {
      const c = parsed as Partial<GitAuthErrorCategory>;
      if (
        typeof c.operation === "string" &&
        isGitAuthOperation(c.operation) &&
        typeof c.code === "string" &&
        isGitAuthFailureCode(c.code) &&
        typeof c.runner === "string" &&
        c.runner.length > 0 &&
        c.runner.length <= 256
      ) {
        const repoKey =
          c.repo_key === null || c.repo_key === undefined
            ? null
            : typeof c.repo_key === "string" && c.repo_key.length <= 512
              ? c.repo_key
              : null;
        return {
          kind: "git_auth",
          operation: c.operation,
          code: c.code,
          repo_key: repoKey,
          runner: c.runner,
        };
      }
    }
  } catch {
    /* corrupt column → treat as absent */
  }
  return null;
}

/** POST /runner/tasks/:id/fail body. */
export interface FailBody {
  error: string;
  /**
   * Optional structured category (#317). When present with `kind: "git_auth"`,
   * the daemon validates `operation`/`code` enums (400 on invalid), ignores
   * wire `repo_key`/`runner`, and records executor×repo unreachability from
   * the task row + authenticated runner.
   */
  category?: GitAuthFailCategoryWire;
}

/** Client → daemon verb surface. HTTP is one implementation; tests use a fake. */
export interface LeaseTransport {
  /** Register (or re-register) this runner's capabilities. Idempotent upsert. */
  register(request: RegisterRequest): Promise<RegisterResponse>;
  /** Long-poll. null = 204 (window elapsed, nothing claimed). */
  lease(runnerName: string): Promise<RunnerLeaseSpec | null>;
  heartbeat(taskId: string): Promise<void>;
  events(taskId: string, lines: string[]): Promise<void>;
  branch(taskId: string, branch: string): Promise<void>;
  /**
   * Fail a leased task. Optional `category` carries structured git-auth detail
   * so the daemon can persist routing memory (#317). Only `operation`/`code`
   * are trusted; daemon fills `repo_key`/`runner` from the task + auth.
   */
  fail(
    taskId: string,
    error: string,
    category?: GitAuthFailCategoryWire | TaskErrorCategory | null,
  ): Promise<void>;
}

export interface LeaseHttpOptions {
  daemonUrl: string;
  token: string;
  /** Optional fetch for tests. */
  fetch?: typeof globalThis.fetch;
}

/**
 * REST verbs under /runner/* — single place for path + error mapping.
 *
 * Body shapes:
 *   POST /runner/register           RegisterRequest → 200 RegisterResponse
 *   POST /runner/lease              { runner } → 200 RunnerLeaseSpec | 204
 *   POST /runner/tasks/:id/heartbeat {}
 *   POST /runner/tasks/:id/events    { lines: string[] }
 *   POST /runner/tasks/:id/branch    { branch: string }
 *   POST /runner/tasks/:id/fail      { error: string, category?: TaskErrorCategory }
 * Auth: Authorization: Bearer <token> on every call.
 *
 * List / show / remove surface (operator CLI, not runner-auth):
 *   GET    /runners                 → 200 RunnersListResponse
 *   GET    /runners/:name           → 200 RunnerShowResponse (client class)
 *   DELETE /runners/:name           → 200 RunnerRemoveResponse (config-admin /
 *                                     loopback-only — mutates runners.* config)
 */
export function createLeaseHttpTransport(opts: LeaseHttpOptions): LeaseTransport {
  const base = opts.daemonUrl.replace(/\/+$/, "");
  const doFetch = opts.fetch ?? globalThis.fetch.bind(globalThis);

  const headers = (extra?: Record<string, string>): Record<string, string> => ({
    authorization: `Bearer ${opts.token}`,
    "content-type": "application/json",
    ...extra,
  });

  const checkOk = async (res: Response, verb: string): Promise<void> => {
    if (res.ok) return;
    const body = await res.text();
    throw new Error(`${verb} failed (${res.status}): ${body}`);
  };

  return {
    async register(request: RegisterRequest): Promise<RegisterResponse> {
      const res = await doFetch(`${base}/runner/register`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify(request satisfies RegisterRequest),
      });
      if (res.status === 401) {
        throw new Error(
          "runner auth failed (401): check name/token against daemon runners.*",
        );
      }
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`register failed (${res.status}): ${body}`);
      }
      return (await res.json()) as RegisterResponse;
    },

    async lease(runnerName: string): Promise<RunnerLeaseSpec | null> {
      const res = await doFetch(`${base}/runner/lease`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ runner: runnerName } satisfies LeaseRequest),
      });
      if (res.status === 204) return null;
      if (res.status === 401) {
        throw new Error(
          "runner auth failed (401): check name/token against daemon runners.*",
        );
      }
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`lease failed (${res.status}): ${body}`);
      }
      return (await res.json()) as RunnerLeaseSpec;
    },

    async heartbeat(taskId: string): Promise<void> {
      const res = await doFetch(
        `${base}/runner/tasks/${encodeURIComponent(taskId)}/heartbeat`,
        {
          method: "POST",
          headers: headers(),
          body: "{}",
        },
      );
      await checkOk(res, "heartbeat");
    },

    async events(taskId: string, lines: string[]): Promise<void> {
      if (lines.length === 0) return;
      const res = await doFetch(
        `${base}/runner/tasks/${encodeURIComponent(taskId)}/events`,
        {
          method: "POST",
          headers: headers(),
          body: JSON.stringify({ lines } satisfies EventsBody),
        },
      );
      await checkOk(res, "events");
    },

    async branch(taskId: string, branch: string): Promise<void> {
      const res = await doFetch(
        `${base}/runner/tasks/${encodeURIComponent(taskId)}/branch`,
        {
          method: "POST",
          headers: headers(),
          body: JSON.stringify({ branch } satisfies BranchBody),
        },
      );
      await checkOk(res, "branch");
    },

    async fail(
      taskId: string,
      error: string,
      category?: GitAuthFailCategoryWire | TaskErrorCategory | null,
    ): Promise<void> {
      const body: FailBody =
        category !== null && category !== undefined
          ? {
              error,
              category: {
                kind: "git_auth",
                operation: category.operation,
                code: category.code,
                // Wire may include these; daemon ignores them (task + auth win).
                repo_key: category.repo_key,
                runner: category.runner,
              },
            }
          : { error };
      const res = await doFetch(
        `${base}/runner/tasks/${encodeURIComponent(taskId)}/fail`,
        {
          method: "POST",
          headers: headers(),
          body: JSON.stringify(body),
        },
      );
      await checkOk(res, "fail");
    },
  };
}

/**
 * Derive online / offline / stale from open-poll presence and last_seen.
 * Pure helper shared by the daemon list surface and tests.
 */
export function deriveRunnerStatus(opts: {
  hasOpenPoll: boolean;
  lastSeenIso: string;
  nowMs?: number;
  graceMs?: number;
  staleMs?: number;
}): RunnerStatus {
  if (opts.hasOpenPoll) return "online";
  const now = opts.nowMs ?? Date.now();
  const grace = opts.graceMs ?? DEFAULT_RUNNER_PRESENCE_GRACE_MS;
  const stale = opts.staleMs ?? DEFAULT_RUNNER_STALE_MS;
  const last = Date.parse(opts.lastSeenIso);
  if (!Number.isFinite(last)) return "offline";
  const age = now - last;
  if (age <= grace) return "online";
  if (age > stale) return "stale";
  return "offline";
}
