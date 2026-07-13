/**
 * Layer 4 (hooks) — the ONLY layer importing `@useparley/core` (component-system
 * spec contract 4). Everything above takes the plain view objects these hooks
 * project.
 */
export { useCockpit } from "./useCockpit.js";
export type { CockpitView, RosterSelection } from "./useCockpit.js";
export { useHealth } from "./useHealth.js";
export type { HealthState } from "./useHealth.js";
export { useLogTail } from "./useLogTail.js";
export { useSnapshot } from "./useSnapshot.js";
export type { SnapshotView } from "./useSnapshot.js";
export { useTaskDetail } from "./useTaskDetail.js";
export { formatUptime, formatClock, formatTokenCount, formatUsage } from "./format.js";
export { classifyLogLine, buildLogLines, LogAccumulator, LOG_LINE_CAP } from "./logClassify.js";
export { projectInspector } from "./inspector.js";
