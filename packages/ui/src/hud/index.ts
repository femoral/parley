/**
 * Layer 2 — hud barrel. Domain composites that take plain data props
 * (component-system spec §Layers, contract 2). Importing this pulls the hud
 * stylesheet.
 */
import "./hud.css";

export { Cartouche } from "./Cartouche.js";
export { ChartKey } from "./ChartKey.js";
export { DayChip } from "./DayChip.js";
export type { DayChipProps } from "./DayChip.js";
export { HealthPanel } from "./HealthPanel.js";
export { InboxCard } from "./InboxCard.js";
export type { InboxCardProps } from "./InboxCard.js";
export { InboxPanel } from "./InboxPanel.js";
export type { InboxPanelProps } from "./InboxPanel.js";
export { Inspector } from "./Inspector/index.js";
export type { InspectorProps, InspectorTabKey } from "./Inspector/index.js";
export {
  projectLogbookDigest,
  LOGBOOK_DIGEST_COMPLETION_CAP,
} from "./logbookDigest.js";
export { LogStream } from "./LogStream.js";
export type { LogStreamProps } from "./LogStream.js";
export { ReportPanel } from "./ReportPanel.js";
export type { ReportPanelProps } from "./ReportPanel.js";
export { RosterPanel, delegateScaffold } from "./RosterPanel.js";
export type { RosterPanelProps, RosterSearchHandle } from "./RosterPanel.js";
export { SettingsBar } from "./SettingsBar.js";
export type { SettingsBarProps } from "./SettingsBar.js";
export { SoundingsPanel, SOUNDINGS_GROUP_BY } from "./SoundingsPanel.js";
export type { SoundingsPanelProps } from "./SoundingsPanel.js";
export { EvalFilterBar } from "./EvalFilterBar.js";
export type { EvalFilterBarProps } from "./EvalFilterBar.js";
export { EvalDistribution } from "./EvalDistribution.js";
export type { EvalDistributionProps } from "./EvalDistribution.js";
export { EvalComparison, COMPARISON_GROUP_BY } from "./EvalComparison.js";
export type { EvalComparisonProps } from "./EvalComparison.js";
export {
  EvalHeatmap,
  HEATMAP_GROUP_BY,
  HEATMAP_LOW_SAMPLE_THRESHOLD,
  HEATMAP_MIX_CEILING,
  HEATMAP_MIX_FLOOR,
  cellStyle,
  formatHeatmapRateDisplay,
  heatmapMixPercent,
  isLowSampleCell,
  isSuspectHeatmapRate,
} from "./EvalHeatmap.js";
export type { EvalHeatmapProps } from "./EvalHeatmap.js";
export { AttemptLineage } from "./AttemptLineage.js";
export type { AttemptLineageProps } from "./AttemptLineage.js";
export type {
  AttemptLineageItem,
  BriefView,
  HealthView,
  InboxTask,
  InspectorTask,
  LogbookDigest,
  LogbookDigestItem,
  LogLine,
  LogTailHookStatus,
  LogTailStatus,
  LogsView,
  QaTurn,
  ReportFile,
  ReportView,
  InspectorRun,
  InspectorRunNode,
  InspectorRunPending,
  InspectorRunReady,
  RosterGroup,
  RosterPip,
  RosterPipKind,
  RosterRun,
  RosterSearchHit,
  RosterSessionOption,
  RosterSessionSearchHit,
  RosterTask,
  RosterTaskSearchHit,
  SoundingsComparisonRow,
  SoundingsDistributionRow,
  SoundingsEvalBucket,
  SoundingsFiltersView,
  SoundingsGroupView,
  SoundingsHeatmapCell,
  SoundingsHeatmapView,
  SoundingsView,
  SoundingsViewTab,
} from "./types.js";
