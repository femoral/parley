/**
 * Console data-layer view types — plain objects screens will consume.
 * No Cove imports; re-implemented from the coverage audit / wire contract.
 */

import type {
  MetricsResponse,
  NodeDetailResponse,
  NodeTaskRow,
  Report,
  ReportFileEntry,
  RunDetailResponse,
  RunnerListEntry,
  RunMetricsResponse,
  RunSummary,
  TaskDetailResponse,
  TaskEnvelope,
} from "@useparley/core";

/** Transport lifecycle for a polled or streamed surface. */
export type TransportStatus = "connecting" | "online" | "offline";

/**
 * Connection honesty as a first-class state machine (coverage audit §2A #2).
 * Screens render these; the wire layer never collapses them into a single
 * boolean that lies.
 */
export type HonestyPhase =
  /** First contact — no successful probe or bootstrap yet. */
  | "loading"
  /** Bootstrap / first health probe in flight after a reset. */
  | "connecting"
  /** Stream + health both live. */
  | "live"
  /** Daemon unreachable; no recent good snapshot to show. */
  | "offline"
  /**
   * Had a good snapshot, then stream and/or health dropped. Keep last data
   * visible while reconnecting (debounce before promoting from a blip).
   */
  | "stale-reconnecting"
  /** A specific panel's last fetch failed while the rest may still be live. */
  | "panel-error"
  /** Connected and ready, but the projected set is genuinely empty. */
  | "empty";

export interface HonestyState {
  phase: HonestyPhase;
  /** True while stream is live (bootstrap success or post-error event). */
  streamConnected: boolean;
  /** True while the latest health probe succeeded. */
  healthOnline: boolean;
  /**
   * Debounced "chart stale" — stream or health bad for longer than the
   * debounce window. Clears immediately when both recover.
   */
  stale: boolean;
  /** Epoch ms when the stream last became disconnected, or null while live. */
  streamLostSince: number | null;
  /** Latched after the first successful task snapshot. */
  ready: boolean;
  /** Optional last panel error message (metrics, log tail, etc.). */
  panelError: string | null;
}

export interface HealthView {
  status: TransportStatus;
  online: boolean;
  version: string | null;
  pid: number | null;
  /** Epoch ms of daemon start (from `/health` `started_at`), or null. */
  startedAt: number | null;
  /** Derived uptime while online; null when offline or start unknown. */
  uptimeMs: number | null;
}

export interface SnapshotView {
  /** Full wire envelopes — tokens, duration, usage, queue, report ride here. */
  tasks: TaskEnvelope[];
  /** Atomic seq from the last successful bootstrap (for stream resume). */
  seq: number;
  connected: boolean;
  ready: boolean;
  streamLostSince: number | null;
  totalTasks: number;
  activeTasks: number;
}

export interface RunsView {
  summaries: RunSummary[];
  details: ReadonlyMap<string, RunDetailResponse>;
  status: TransportStatus;
  error: string | null;
}

export interface RunnersView {
  status: TransportStatus;
  runners: RunnerListEntry[];
}

export type LogTailStatus =
  | "connecting"
  | "tailing"
  | "paused-by-setting"
  | "ended"
  | "unreachable";

export type LogLineKind =
  | "error"
  | "question"
  | "shell"
  | "tool"
  | "reasoning"
  | "stdout"
  | "fallback";

export interface LogLine {
  kind: LogLineKind;
  text: string;
  raw: string;
}

export interface LogsView {
  lines: LogLine[];
  status: LogTailStatus;
}

export type PanelStatus = "idle" | "loading" | "ready" | "error" | "empty";

export interface MetricsView {
  status: PanelStatus;
  data: MetricsResponse | null;
  error: string | null;
}

export interface RunMetricsView {
  status: PanelStatus;
  data: RunMetricsResponse | null;
  error: string | null;
}

export interface TaskDetailView {
  status: PanelStatus;
  data: TaskDetailResponse | null;
  error: string | null;
}

export interface NodeTasksView {
  status: PanelStatus;
  data: NodeDetailResponse | null;
  /** Client-side filter of the live snapshot by run_id (whole-run list). */
  runTasks: TaskEnvelope[];
  error: string | null;
}

/** One hour bucket in the client-side 24h token-burn histogram. */
export interface TokenBurnBucket {
  /** Hour start as epoch ms (UTC hour floor). */
  hourStartMs: number;
  input: number;
  output: number;
  cached: number;
  tasks: number;
}

/**
 * Where {@link TokenBurnView.retentionDays} came from. The wire does not
 * expose the daemon's effective `retention.days`, so the default is a
 * client-side assumption — never present a guess as a daemon fact (MED-2).
 */
export type RetentionBoundSource = "default-assumed" | "explicit";

/**
 * Token burn over the last 24 wall-clock hours, bucketed client-side from
 * full task envelopes. The histogram only sees tasks still in daemon
 * retention — {@link retentionDays} + {@link retentionSource} disclose the
 * bound and whether it is assumed vs caller-supplied.
 */
export interface TokenBurnView {
  buckets: TokenBurnBucket[];
  totals: { input: number; output: number; cached: number; tasks: number };
  /**
   * Retention window (days) used for disclosure. When
   * {@link retentionSource} is `"default-assumed"`, this is the client
   * default (30) — not a value read from the daemon.
   */
  retentionDays: number;
  /**
   * `"default-assumed"` when using the client default; `"explicit"` when the
   * caller passed `retentionDays` (e.g. after a future settings surface).
   */
  retentionSource: RetentionBoundSource;
  /** Wall-clock window the histogram covers (always 24h). */
  windowMs: number;
  /** Epoch ms of the newest bucket edge (exclusive end = now). */
  asOfMs: number;
}

/** Normalized report file entry with optional churn. */
export interface FileChangeView {
  path: string;
  added: number | null;
  removed: number | null;
  /** Extra keys from custom report schemas (preserved). */
  extra: Record<string, unknown>;
}

export interface ReportFilesView {
  files: FileChangeView[];
  /** True when any entry carries known +/− counts. */
  hasChurn: boolean;
}

/**
 * Effective-cap / queue context for a queued task.
 * Renders like `QUEUED #3 · vendor:claude 2/2`.
 */
export interface QueueContextView {
  /** Full display string, or null when the task is not queued. */
  label: string | null;
  position: number | null;
  blockingCap: string | null;
  maxConcurrent: number | null;
  /** Occupied slots when known (position is 1-based among waiters, not holders). */
  capLabel: string | null;
}

/** One firehose line after client-side join (workflow name from runs cache). */
export interface FirehoseLine {
  seq: number;
  event: string;
  subject: "task" | "run";
  /** Human-readable feed line. */
  text: string;
  taskId: string | null;
  runId: string | null;
  workflow: string | null;
  state: string | null;
  at: string;
}

export type {
  MetricsResponse,
  NodeDetailResponse,
  NodeTaskRow,
  Report,
  ReportFileEntry,
  RunDetailResponse,
  RunnerListEntry,
  RunMetricsResponse,
  RunSummary,
  TaskDetailResponse,
  TaskEnvelope,
};
