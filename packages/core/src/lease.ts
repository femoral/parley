/**
 * Runner lease wire contract (ADR-0012 / #209).
 *
 * Types and the HTTP client for the five `/runner/*` verbs. Daemon server
 * methods and runner host execution stay in their packages; this module is
 * only the cross-process surface so shapes cannot drift silently.
 *
 * `RunnerLeaseSpec.prompt` is the orchestrator brief, not the assembled
 * vendor argv prompt — hosts build the full child prompt after the worktree
 * exists (daemon builders / #212 spawn-plan).
 */
import type { SandboxMode } from "./adapter.js";
import type { JsonSchema } from "./contract.js";

/** Correlation header children send on every hub request (ADR-0003 / ADR-0011). */
export const TASK_HEADER = "x-parley-task";

/** Default runner heartbeat window (ADR-0012 / #111). */
export const DEFAULT_RUNNER_HEARTBEAT_TIMEOUT_MS = 90_000;

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
  vendor: string;
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
   * Repo path as recorded at create time — the runner maps this identifier to
   * a local clone via its `repos` config.
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

/** POST /runner/tasks/:id/events body. */
export interface EventsBody {
  lines: string[];
}

/** POST /runner/tasks/:id/branch body. */
export interface BranchBody {
  branch: string;
}

/** POST /runner/tasks/:id/fail body. */
export interface FailBody {
  error: string;
}

/** Client → daemon verb surface. HTTP is one implementation; tests use a fake. */
export interface LeaseTransport {
  /** Long-poll. null = 204 (window elapsed, nothing claimed). */
  lease(runnerName: string): Promise<RunnerLeaseSpec | null>;
  heartbeat(taskId: string): Promise<void>;
  events(taskId: string, lines: string[]): Promise<void>;
  branch(taskId: string, branch: string): Promise<void>;
  fail(taskId: string, error: string): Promise<void>;
}

export interface LeaseHttpOptions {
  daemonUrl: string;
  token: string;
  /** Optional fetch for tests. */
  fetch?: typeof globalThis.fetch;
}

/**
 * Five REST verbs under /runner/* — single place for path + error mapping.
 *
 * Body shapes:
 *   POST /runner/lease              { runner } → 200 RunnerLeaseSpec | 204
 *   POST /runner/tasks/:id/heartbeat {}
 *   POST /runner/tasks/:id/events    { lines: string[] }
 *   POST /runner/tasks/:id/branch    { branch: string }
 *   POST /runner/tasks/:id/fail      { error: string }
 * Auth: Authorization: Bearer <token> on every call.
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

    async fail(taskId: string, error: string): Promise<void> {
      const res = await doFetch(
        `${base}/runner/tasks/${encodeURIComponent(taskId)}/fail`,
        {
          method: "POST",
          headers: headers(),
          body: JSON.stringify({ error } satisfies FailBody),
        },
      );
      await checkOk(res, "fail");
    },
  };
}
