/**
 * Layer 1 — primitives barrel. Dumb, styled, domain-free building blocks
 * (component-system spec §Layers). Importing this pulls the primitives stylesheet.
 */
import "./primitives.css";

export { Plate } from "./Plate.js";
export type { PlateProps, PlateVariant } from "./Plate.js";
export { PlateHeader } from "./PlateHeader.js";
export type { PlateHeaderProps } from "./PlateHeader.js";
export { Divider } from "./Divider.js";
export type { DividerProps } from "./Divider.js";
export { Badge } from "./Badge.js";
export type { BadgeProps } from "./Badge.js";
export { Emblem } from "./Emblem.js";
export type { EmblemProps } from "./Emblem.js";
export { Mark } from "./Mark.js";
export type { MarkProps } from "./Mark.js";
export { Button } from "./Button.js";
export type { ButtonProps, ButtonVariant } from "./Button.js";
export { Stat } from "./Stat.js";
export type { StatProps } from "./Stat.js";
export { Flourish } from "./Flourish.js";
export type { FlourishCorner } from "./Flourish.js";
