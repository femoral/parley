/**
 * Shared Console component layer (#367).
 * Owned territory — screens consume these; do not re-implement Panel,
 * StateChip, CopyScaffold, or Field/Select per screen.
 */
import "./components.css";

export { Panel, panelHonestyMessage, type PanelProps, type PanelHonestyPhase } from "./Panel.js";
export { StateChip, stateLabel, chipStateKey, type StateChipProps } from "./StateChip.js";
export { CopyScaffold, type CopyScaffoldProps } from "./CopyScaffold.js";
export { Field, Select, type FieldProps, type SelectProps } from "./Field.js";
