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
export type { CockpitView, CockpitMode, RosterSelection } from "./useCockpit.js";
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
export {
  projectMetricsGroup,
  projectSoundings,
  metricsRefreshKey,
  GROUP_BY_OPTIONS,
} from "./metrics.js";
export { useSettings } from "./useSettings.js";
export type { Settings, SettingsView } from "./useSettings.js";
export { useSnapshot } from "./useSnapshot.js";
export type { SnapshotView } from "./useSnapshot.js";
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
  RECENT_SESSION_CHIP_CAP,
  FAILED_FRESHNESS_MS,
  isFreshFailure,
  displayAttentionRank,
  advanceFailedObservations,
} from "./roster.js";
export type { RosterTaskInput, RosterProjection, FailedFreshness } from "./roster.js";
export { useTaskDetail } from "./useTaskDetail.js";
export {
  formatUptime,
  formatClock,
  formatTokenCount,
  formatUsage,
  formatSuccessRate,
  formatEvalAvg,
  formatDurationMs,
} from "./format.js";
export { classifyLogLine, buildLogLines, LogAccumulator, LOG_LINE_CAP } from "./logClassify.js";
export { projectInspector } from "./inspector.js";
