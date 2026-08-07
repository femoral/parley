/**
 * Shared Console component layer (#367 / #363).
 * Owned territory — screens consume these; do not re-implement Panel,
 * StateChip, CopyScaffold, Field/Select, or AttentionCard per screen.
 */
import "./components.css";

export { Panel, panelHonestyMessage, type PanelProps, type PanelHonestyPhase } from "./Panel.js";
export { StateChip, stateLabel, chipStateKey, type StateChipProps } from "./StateChip.js";
export { CopyScaffold, type CopyScaffoldProps } from "./CopyScaffold.js";
export { Field, Select, type FieldProps, type SelectProps } from "./Field.js";
export {
  AttentionCard,
  type AttentionCardProps,
  type AttentionCardVariant,
} from "./AttentionCard.js";
