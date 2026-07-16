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
      try {
        const body: unknown = JSON.parse(raw);
        if (typeof body === "object" && body !== null && "error" in body) {
          detail = String((body as { error: unknown }).error);
        }
      } catch {
        /* keep the generic detail */
      }
      throw new DaemonRequestError(res.status, detail);
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

  /** `GET /tasks` — every task plus the atomic "start from now" seq baseline. */
  listTasks(): Promise<TasksResponse> {
    return this.request<TasksResponse>("/tasks");
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
   * `GET /metrics` — per-group task/eval/token/duration aggregates (#118).
   * Defaults: session=`all`, groupBy=`vendor`.
   */
  metrics(options?: {
    session?: string;
    groupBy?: MetricsGroupBy;
  }): Promise<MetricsResponse> {
    const params = new URLSearchParams();
    if (options?.session !== undefined) params.set("session", options.session);
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
