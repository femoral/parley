/**
 * The `@useparley/core` client SDK (docs/spec/ui-interface-contract.md): a typed
 * HTTP client over the daemon's REST routes plus an SSE helper over the
 * transition stream. Same-origin browser UIs construct it with no base URL (the
 * daemon serves them); native/TUI frontends pass the discovered
 * `http://127.0.0.1:<port>` base.
 */
import { DaemonRequestError } from "./client.js";
import type {
  CleanResponse,
  HealthResponse,
  MetricsResponse,
  SessionsResponse,
  StreamEvent,
  TaskAck,
  TaskDetailResponse,
  TaskEnvelope,
  TaskLogResponse,
  TaskMetricsFilters,
  TasksResponse,
} from "./contract.js";
import type { MetricsGroupBy } from "./classification.js";
import { TASK_EVENT_NAMES } from "./states.js";

/** How the client reaches the daemon. */
export interface ParleyClientOptions {
  /**
   * Origin the daemon is reachable at, no trailing slash — e.g.
   * `http://127.0.0.1:57123`. Omit (or `""`) for a same-origin browser UI the
   * daemon serves.
   */
  baseUrl?: string;
  /** `fetch` implementation; defaults to the global one. */
  fetch?: typeof fetch;
}

/** A typed client over the daemon's REST surface (spec §"Data contract"). */
export class ParleyClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ParleyClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "").replace(/\/$/, "");
    const impl = options.fetch ?? globalThis.fetch;
    if (!impl) throw new Error("ParleyClient requires a fetch implementation");
    this.fetchImpl = impl.bind(globalThis);
  }

  /** Absolute URL for a daemon path (`/tasks`, `/events/stream`, …). */
  url(path: string): string {
    return `${this.baseUrl}${path}`;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await this.fetchImpl(this.url(path), init);
    const raw = await res.text();
    if (!res.ok) {
      let detail = `daemon request ${path} failed with status ${res.status}`;
      let code: string | undefined;
      try {
        const body: unknown = JSON.parse(raw);
        if (typeof body === "object" && body !== null) {
          if ("error" in body) {
            detail = String((body as { error: unknown }).error);
          }
          if (
            "code" in body &&
            typeof (body as { code: unknown }).code === "string" &&
            (body as { code: string }).code !== ""
          ) {
            code = (body as { code: string }).code;
          }
        }
      } catch {
        /* keep the generic detail */
      }
      throw new DaemonRequestError(res.status, detail, code);
    }
    try {
      return JSON.parse(raw) as T;
    } catch {
      throw new Error(`daemon sent a malformed response for ${path}: ${raw.slice(0, 200)}`);
    }
  }

  private post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  /** `GET /health` — liveness plus the daemon package version. */
  health(): Promise<HealthResponse> {
    return this.request<HealthResponse>("/health");
  }

  /**
   * `GET /tasks` — tasks plus the atomic "start from now" seq baseline.
   * Optional filters (#164) narrow the list the same way as metrics.
   */
  listTasks(filters?: TaskMetricsFilters): Promise<TasksResponse> {
    const params = filtersToSearchParams(filters);
    const qs = params.toString();
    return this.request<TasksResponse>(qs === "" ? "/tasks" : `/tasks?${qs}`);
  }

  /**
   * `GET /sessions` — every orchestrator session known via tasks, most-recent
   * first (#88). Pass `q` to filter by id substring (case-insensitive).
   */
  listSessions(query?: string): Promise<SessionsResponse> {
    const q = query?.trim() ?? "";
    const path = q === "" ? "/sessions" : `/sessions?q=${encodeURIComponent(q)}`;
    return this.request<SessionsResponse>(path);
  }

  /**
   * `GET /metrics` — per-group task/eval/token/duration aggregates (#118 / #164).
   * Defaults: session=`all`, groupBy=`vendor`. Extra filters match list filters.
   */
  metrics(options?: TaskMetricsFilters & { groupBy?: MetricsGroupBy }): Promise<MetricsResponse> {
    const params = filtersToSearchParams(options);
    if (options?.groupBy !== undefined) params.set("group_by", options.groupBy);
    const qs = params.toString();
    return this.request<MetricsResponse>(qs === "" ? "/metrics" : `/metrics?${qs}`);
  }

  /** `GET /tasks/:ref` — a task's envelope alongside its raw row. */
  getTask(ref: string): Promise<TaskDetailResponse> {
    return this.request<TaskDetailResponse>(`/tasks/${encodeURIComponent(ref)}`);
  }

  /** `POST /tasks/:ref/answer` — deliver an answer to a pending question. */
  answer(ref: string, text: string): Promise<TaskAck> {
    return this.post<TaskAck>(`/tasks/${encodeURIComponent(ref)}/answer`, { text });
  }

  /** `POST /tasks/:ref/eval` — record a quality score/feedback against a task. */
  evalTask(ref: string, score: number, feedback: string): Promise<TaskAck> {
    return this.post<TaskAck>(`/tasks/${encodeURIComponent(ref)}/eval`, { score, feedback });
  }

  /** `POST /tasks/:ref/cancel` — terminate the child and end the task cancelled. */
  cancel(ref: string): Promise<TaskAck> {
    return this.post<TaskAck>(`/tasks/${encodeURIComponent(ref)}/cancel`, {});
  }

  /** `POST /clean` — remove one terminal task's worktree, or all terminal ones. */
  clean(body: { task: string } | { all_terminal: true }): Promise<CleanResponse> {
    return this.post<CleanResponse>("/clean", body);
  }

  /**
   * `GET /tasks/:ref/logs?since=<offset>` — a tail chunk of a task's raw vendor
   * log. Pass the prior response's `next` back as `since` to resume without
   * duplicating or dropping bytes; omit `since` to start from the beginning.
   */
  logs(ref: string, since = 0): Promise<TaskLogResponse> {
    return this.request<TaskLogResponse>(
      `/tasks/${encodeURIComponent(ref)}/logs?since=${encodeURIComponent(String(since))}`,
    );
  }
}

/** The minimal `EventSource` surface the SSE helper needs (browser-native). */
export interface EventSourceLike {
  addEventListener(type: string, listener: (event: { data: string; lastEventId: string }) => void): void;
  addEventListener(type: "error", listener: (event: unknown) => void): void;
  close(): void;
}

/** An `EventSource` constructor — the browser global, or an injected shim in tests. */
export type EventSourceCtor = new (url: string) => EventSourceLike;

/** A live transition subscription; `close()` tears down the underlying EventSource. */
export interface TaskStream {
  close(): void;
}

/** Options for {@link streamTaskEvents}. */
export interface StreamTaskEventsOptions {
  /** Daemon origin (no trailing slash); omit for a same-origin browser UI. */
  baseUrl?: string;
  /**
   * Resume from this transition seq — the `seq` returned by `GET /tasks` on
   * bootstrap, so nothing before connect replays. Omit to start from the
   * daemon's current seq (only future transitions).
   */
  since?: number;
  /** `EventSource` constructor; defaults to the global one (browser). */
  EventSource?: EventSourceCtor;
  /** Called for every transition, in seq order. */
  onEvent: (event: StreamEvent) => void;
  /** Called on stream error (the browser auto-reconnects afterwards). */
  onError?: (error: unknown) => void;
}

/**
 * Subscribe to the daemon's transition stream (`GET /events/stream`). Wires an
 * `EventSource` to every watch event name and decodes each message into a
 * {@link StreamEvent} (seq + event name + pinned envelope). The browser's
 * `EventSource` auto-reconnects with `Last-Event-ID`, so a dropped connection
 * resumes exactly after the last delivered seq — no gaps, no replays before it.
 */
export function streamTaskEvents(options: StreamTaskEventsOptions): TaskStream {
  const Ctor = options.EventSource ?? (globalThis as { EventSource?: EventSourceCtor }).EventSource;
  if (!Ctor) {
    throw new Error("streamTaskEvents requires an EventSource implementation");
  }
  const base = (options.baseUrl ?? "").replace(/\/$/, "");
  const query = options.since !== undefined ? `?since=${options.since}` : "";
  const source = new Ctor(`${base}/events/stream${query}`);
  for (const name of TASK_EVENT_NAMES) {
    source.addEventListener(name, (event) => {
      let task: TaskEnvelope;
      try {
        task = JSON.parse(event.data) as TaskEnvelope;
      } catch (err) {
        options.onError?.(err);
        return;
      }
      const seq = Number(event.lastEventId);
      options.onEvent({ seq: Number.isFinite(seq) ? seq : task.seq, event: name, task });
    });
  }
  if (options.onError) {
    source.addEventListener("error", (event) => options.onError?.(event));
  }
  return { close: () => source.close() };
}

/** The result of {@link bootstrapTaskStream}: the initial snapshot plus the live stream. */
export interface BootstrappedStream {
  /** The tasks and seq baseline captured atomically before the stream opened. */
  snapshot: TasksResponse;
  /** The live transition subscription — close it to stop. */
  stream: TaskStream;
}

/** Bootstrap options — a client to snapshot with, plus {@link streamTaskEvents} wiring. */
export interface BootstrapTaskStreamOptions
  extends Omit<StreamTaskEventsOptions, "since" | "baseUrl"> {
  /** The client whose base URL and fetch the snapshot uses. */
  client: ParleyClient;
}

/**
 * The full bootstrap the contract prescribes: `GET /tasks` for the snapshot and
 * its atomic seq, then open the transition stream from that seq so the UI sees
 * every transition after the snapshot with nothing dropped in the gap. Returns
 * the snapshot for initial render and the live stream to close on teardown.
 */
export async function bootstrapTaskStream(
  options: BootstrapTaskStreamOptions,
): Promise<BootstrappedStream> {
  const { client, ...streamOptions } = options;
  const snapshot = await client.listTasks();
  const stream = streamTaskEvents({
    ...streamOptions,
    baseUrl: client.url(""),
    since: snapshot.seq,
  });
  return { snapshot, stream };
}

/** Serialize {@link TaskMetricsFilters} into query params for metrics/list. */
export function filtersToSearchParams(
  filters?: TaskMetricsFilters | null,
): URLSearchParams {
  const params = new URLSearchParams();
  if (!filters) return params;
  const set = (key: string, value: string | number | boolean | undefined): void => {
    if (value === undefined) return;
    if (typeof value === "boolean") {
      params.set(key, value ? "true" : "false");
      return;
    }
    params.set(key, String(value));
  };
  set("session", filters.session);
  set("type", filters.type);
  set("vendor", filters.vendor);
  set("model", filters.model);
  set("profile", filters.profile);
  set("size", filters.size);
  set("difficulty", filters.difficulty);
  set("orch_harness", filters.orch_harness);
  set("orch_model", filters.orch_model);
  set("orch_effort", filters.orch_effort);
  set("eval_harness", filters.eval_harness);
  set("eval_model", filters.eval_model);
  set("eval_effort", filters.eval_effort);
  set("rubric", filters.rubric);
  set("rubric_version", filters.rubric_version);
  set("first_attempt", filters.first_attempt);
  set("below_baseline", filters.below_baseline);
  return params;
}

/**
 * Parse metrics/list filter query params from a URLSearchParams (#164).
 * Unknown / empty values are ignored; boolean flags accept `true`/`1`.
 */
export function parseTaskMetricsFilters(params: URLSearchParams): TaskMetricsFilters {
  const out: TaskMetricsFilters = {};
  const str = (key: keyof TaskMetricsFilters): void => {
    const v = params.get(key as string);
    if (v !== null && v !== "") (out as Record<string, unknown>)[key] = v;
  };
  str("session");
  str("type");
  str("vendor");
  str("model");
  str("profile");
  str("size");
  str("difficulty");
  str("orch_harness");
  str("orch_model");
  str("orch_effort");
  str("eval_harness");
  str("eval_model");
  str("eval_effort");
  str("rubric");
  const rv = params.get("rubric_version");
  if (rv !== null && rv !== "") {
    const n = Number(rv);
    if (Number.isInteger(n) && n >= 1) out.rubric_version = n;
  }
  const bool = (key: "first_attempt" | "below_baseline"): void => {
    const v = params.get(key);
    if (v === "true" || v === "1") out[key] = true;
    else if (v === "false" || v === "0") out[key] = false;
  };
  bool("first_attempt");
  bool("below_baseline");
  return out;
}
