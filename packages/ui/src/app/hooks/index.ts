/**
 * Layer 4 (hooks) — the ONLY layer importing `@useparley/core` (component-system
 * spec contract 4). Everything above takes the plain view objects these hooks
 * project.
 */
export {
  useCockpit,
  useChartStale,
  useCockpitDocumentTitle,
  formatCockpitDocumentTitle,
  COCKPIT_DOCUMENT_TITLE,
  CHART_STALE_DEBOUNCE_MS,
} from "./useCockpit.js";
export type {
  CockpitView,
  CockpitMode,
  RosterSelection,
  SelectTaskOptions,
  SceneFrameIntent,
} from "./useCockpit.js";
export {
  useCockpitKeys,
  awaitingTaskIds,
  nextAwaitingId,
  isTypingTarget,
  hasModifier,
  hasOpenPopover,
} from "./useCockpitKeys.js";
export type { CockpitKeysOptions, RosterSearchHandle } from "./useCockpitKeys.js";
export { useHealth } from "./useHealth.js";
export type { HealthState } from "./useHealth.js";
export { useLogTail } from "./useLogTail.js";
export { useMetrics } from "./useMetrics.js";
export type { MetricsState, MetricsStatus, UseMetricsOptions } from "./useMetrics.js";
export { useEvalFilters } from "./useEvalFilters.js";
export type { UseEvalFiltersResult } from "./useEvalFilters.js";
export {
  emptyEvalFilters,
  hasActiveEvalFilters,
  patchEvalFilters,
  parseRubricFilter,
  evalFiltersToMetricsQuery,
  evalFiltersToSearchParams,
  parseEvalFiltersFromSearch,
  EVAL_FILTER_TEXT_KEYS,
  EVAL_FILTER_FIELD_META,
} from "./evalFilters.js";
export type { EvalFilterState, EvalFilterTextKey } from "./evalFilters.js";
export {
  projectMetricsGroup,
  projectSoundings,
  projectDistributionRow,
  projectComparisonRow,
  projectHeatmap,
  projectFiltersView,
  metricsHasRubricEvals,
  metricsRefreshKey,
  GROUP_BY_OPTIONS,
  COMPARISON_DIMENSIONS,
  HEATMAP_DIMENSIONS,
} from "./metrics.js";
export { useSettings } from "./useSettings.js";
export type { Settings, SettingsView } from "./useSettings.js";
export { useSnapshot } from "./useSnapshot.js";
export type { SnapshotView } from "./useSnapshot.js";
export { toDisplayTask, formatTaskMeta } from "./displayTask.js";
export { projectScene, rollupSessionAttention, isSceneAttentionState } from "./scene.js";
export type {
  SceneView,
  SceneSession,
  SceneSessionAttention,
  SceneTask,
} from "./scene.js";
export {
  projectRoster,
  shortId,
  formatTaskCount,
  deriveSessionIdentity,
  collectSessionIdentities,
  resetStickySessionHandles,
  RECENT_SESSION_CHIP_CAP,
  FAILED_FRESHNESS_MS,
  isFreshFailure,
  displayAttentionRank,
  advanceFailedObservations,
  terminalTransitionMs,
} from "./roster.js";
export type {
  RosterTaskInput,
  RosterProjection,
  FailedFreshness,
  SessionIdentity,
} from "./roster.js";
export {
  projectRosterRun,
  projectInspectorRun,
  projectDeliverable,
  projectDeliverables,
  formatDeliverableAddress,
  formatDeliverableSize,
  formatRunChip,
  runAttentionState,
  buildPipTrack,
  buildListPipTrack,
  formatNodeStateLabel,
  formatRunStateLabel,
  formatBlockReasonLabel,
  formatNodeDuration,
  isHeldGate,
} from "./runs.js";
export {
  useRuns,
  useInspectorRun,
  __resetSelectedDeliverableCacheForTests,
} from "./useRuns.js";
export type { RunsView } from "./useRuns.js";
export { useTaskDetail } from "./useTaskDetail.js";
export {
  formatUptime,
  formatClock,
  formatTokenCount,
  formatUsage,
  formatSuccessRate,
  formatEvalAvg,
  formatEvalDelta,
  formatRate,
  formatScore,
  formatDurationMs,
} from "./format.js";
export { classifyLogLine, buildLogLines, LogAccumulator, LOG_LINE_CAP } from "./logClassify.js";
export {
  projectInspector,
  projectAttemptLineage,
  formatAttemptScore,
} from "./inspector.js";
