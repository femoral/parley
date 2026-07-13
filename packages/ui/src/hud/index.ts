/**
 * Layer 2 — hud barrel. Domain composites that take plain data props
 * (component-system spec §Layers, contract 2). Importing this pulls the hud
 * stylesheet.
 */
import "./hud.css";

export { Cartouche } from "./Cartouche.js";
export { DayChip } from "./DayChip.js";
export type { DayChipProps } from "./DayChip.js";
export { HealthPanel } from "./HealthPanel.js";
export { RosterPanel } from "./RosterPanel.js";
export type { RosterPanelProps } from "./RosterPanel.js";
export type { HealthView, RosterGroup, RosterSessionOption, RosterTask } from "./types.js";
