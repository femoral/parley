/**
 * Layer 4 (hooks) — the ONLY layer importing `@useparley/core` (component-system
 * spec contract 4). Everything above takes the plain view objects these hooks
 * project.
 */
export { useCockpit } from "./useCockpit.js";
export type { CockpitView, RosterSelection } from "./useCockpit.js";
export { useHealth } from "./useHealth.js";
export type { HealthState } from "./useHealth.js";
export { useSnapshot } from "./useSnapshot.js";
export type { SnapshotView } from "./useSnapshot.js";
export { formatUptime, formatClock } from "./format.js";
