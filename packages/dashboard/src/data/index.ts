/**
 * Parley Console data layer over `@useparley/core`.
 *
 * Snapshot + SSE hooks, polled runs/health/runners, log-tail cursoring,
 * metrics + run-metrics, and pure projections (token burn, files_changed,
 * queue context, firehose join, run-tasks filter). Honesty is a first-class
 * state machine. No imports from `packages/ui`.
 */

export {
  useSnapshot,
  mergeEnvelope,
  evictTerminalOverflow,
  TERMINAL_TASK_CAP,
  STREAM_RETRY_MS,
} from "./useSnapshot.js";
export { useHealth } from "./useHealth.js";
export { useRuns } from "./useRuns.js";
export { useRunners } from "./useRunners.js";
export { useLogTail } from "./useLogTail.js";
export { useMetrics, type UseMetricsOptions } from "./useMetrics.js";
export { useRunMetrics, type UseRunMetricsOptions } from "./useRunMetrics.js";
export { useTaskDetail } from "./useTaskDetail.js";
export { useNodeTasks } from "./useNodeTasks.js";
export { usePolling, isDocumentHidden, type UsePollingOptions } from "./usePolling.js";
export {
  ConsoleDataProvider,
  useConsoleData,
  useParleyClient,
  type ConsoleData,
} from "./consoleContext.js";
export {
  useHonesty,
  useStaleFlag,
  deriveHonestyPhase,
  projectHonesty,
  STALE_DEBOUNCE_MS,
} from "./honesty.js";
export { fetchRunnersList, fetchNodeDetail, type NodeDetailQuery } from "./clientExtras.js";
export { classifyLogLine, LogAccumulator, LOG_LINE_CAP } from "./logClassify.js";

export {
  projectFileEntry,
  projectReportFiles,
  formatChurn,
} from "./projections/filesChanged.js";
export { projectQueueContext, type QueueFields } from "./projections/queueContext.js";
export {
  projectTokenBurn,
  taskBucketTimeMs,
  hourFloorMs,
  TOKEN_BURN_WINDOW_MS,
  DEFAULT_RETENTION_DAYS,
  type ProjectTokenBurnOptions,
} from "./projections/tokenBurn.js";
export { filterTasksByRunId } from "./projections/runTasks.js";
export {
  projectFirehose,
  projectFirehoseLine,
  workflowByRunId,
  RUN_EVENT_NAMES,
  type FirehoseInput,
  type RunStreamPayload,
} from "./projections/firehose.js";
export {
  FIREHOSE_CAP,
  emptyFirehoseCursor,
  advanceFirehose,
  firehoseTone,
  type FirehoseCursor,
} from "./projections/firehoseFeed.js";
export {
  ATTENTION_RANK,
  FRESH_FAILURE_MS,
  ATTENTION_TASK_STATES,
  attentionRank,
  isFreshFailure,
  sortTasksByAttention,
  runAttentionRank,
  sortRunsByAttention,
  isHeldGate,
} from "./attentionRank.js";

export type {
  HonestyPhase,
  HonestyState,
  HealthView,
  SnapshotView,
  RunsView,
  RunnersView,
  LogsView,
  LogLine,
  LogLineKind,
  LogTailStatus,
  PanelStatus,
  MetricsView,
  RunMetricsView,
  TaskDetailView,
  NodeTasksView,
  TokenBurnView,
  TokenBurnBucket,
  RetentionBoundSource,
  FileChangeView,
  ReportFilesView,
  QueueContextView,
  FirehoseLine,
  TransportStatus,
} from "./types.js";
