import type {
  HeartbeatBody,
  LeaseTransport,
  RegisterRequest,
  RegisterResponse,
  RunnerLeaseSpec,
  TaskErrorCategory,
} from "@useparley/core";

/** One recorded transport call. */
export type TransportCall =
  | { verb: "register"; request: RegisterRequest }
  | { verb: "lease"; runner: string }
  | { verb: "heartbeat"; taskId: string; body?: HeartbeatBody }
  | { verb: "events"; taskId: string; lines: string[] }
  | { verb: "branch"; taskId: string; branch: string }
  | {
      verb: "fail";
      taskId: string;
      error: string;
      category?: TaskErrorCategory | null;
    };

export interface FakeLeaseTransport extends LeaseTransport {
  readonly calls: TransportCall[];
  /** Fail verbs matching these names (throw). */
  failVerbs: Set<string>;
  /** Last successful register request (if any). */
  lastRegister: RegisterRequest | null;
}

export interface FakeLeaseOptions {
  /**
   * Leases to hand out in order. After the queue is empty, `lease` returns null.
   * A function form may call side effects (e.g. stop the loop) before returning.
   */
  leases?: Array<RunnerLeaseSpec | null | (() => RunnerLeaseSpec | null)>;
}

/** In-memory `LeaseTransport` that records every verb call for assertions. */
export function createFakeLeaseTransport(
  options: FakeLeaseOptions = {},
): FakeLeaseTransport {
  const queue = [...(options.leases ?? [])];
  const calls: TransportCall[] = [];
  const failVerbs = new Set<string>();
  let lastRegister: RegisterRequest | null = null;

  const transport: FakeLeaseTransport = {
    calls,
    failVerbs,
    get lastRegister() {
      return lastRegister;
    },
    async register(request: RegisterRequest): Promise<RegisterResponse> {
      calls.push({ verb: "register", request });
      if (failVerbs.has("register")) throw new Error("fake register failed");
      lastRegister = request;
      const now = new Date().toISOString();
      return {
        ok: true,
        name: request.runner,
        registered_at: now,
        last_seen: now,
      };
    },
    async lease(runnerName: string) {
      calls.push({ verb: "lease", runner: runnerName });
      if (failVerbs.has("lease")) throw new Error("fake lease failed");
      const next = queue.shift();
      if (next === undefined) {
        // Yield so a spinning RunnerLoop does not starve the event loop the
        // way a real long-poll would block. Tests call loop.stop() once done.
        await new Promise((r) => setTimeout(r, 5));
        return null;
      }
      return typeof next === "function" ? next() : next;
    },
    async heartbeat(taskId: string, body: HeartbeatBody = {}) {
      calls.push({ verb: "heartbeat", taskId, body });
      if (failVerbs.has("heartbeat")) throw new Error("fake heartbeat failed");
    },
    async events(taskId: string, lines: string[]) {
      calls.push({ verb: "events", taskId, lines });
      if (failVerbs.has("events")) throw new Error("fake events failed");
    },
    async branch(taskId: string, branch: string) {
      calls.push({ verb: "branch", taskId, branch });
      if (failVerbs.has("branch")) throw new Error("fake branch failed");
    },
    async fail(taskId: string, error: string, category?: TaskErrorCategory | null) {
      calls.push({ verb: "fail", taskId, error, category: category ?? null });
      if (failVerbs.has("fail")) throw new Error("fake fail failed");
    },
  };
  return transport;
}

export function sampleLease(
  overrides: Partial<RunnerLeaseSpec> = {},
): RunnerLeaseSpec {
  return {
    task_id: "task-1",
    name: null,
    prompt: "brief",
    vendor: "fake",
    model: null,
    effort: null,
    profile: null,
    sandbox: "workspace",
    network: true,
    answer_timeout_ms: 60_000,
    report_schema: { type: "object" },
    base_ref: null,
    base_sha: null,
    repo_key: null,
    repo_fetch_url: null,
    repo: "/orchestrator/repo",
    contexts: [],
    extra_args: [],
    env: {},
    ...overrides,
  };
}
