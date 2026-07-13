import type { CSSProperties, ReactNode } from "react";
import { Divider } from "./Divider.js";

export interface PlateHeaderProps {
  /** Icon-chip glyph (emblem, anchor, etc.). */
  icon?: ReactNode;
  /** Use the dark-bronze icon chip instead of the gold radial. */
  iconDark?: boolean;
  /** Coat colour for the icon chip (a faction tint); overrides the default fill. */
  iconColor?: string;
  title: string;
  subtitle?: string;
  /** Right-aligned slot (status chip, count pill). */
  aside?: ReactNode;
  /** Draw the gold divider rule under the header. */
  divider?: boolean;
}

/** Layer 1 — a panel's engraved header row (design-manifest §4.2). */
export function PlateHeader({
  icon,
  iconDark = false,
  iconColor,
  title,
  subtitle,
  aside,
  divider = false,
}: PlateHeaderProps) {
  const iconStyle: CSSProperties | undefined = iconColor
    ? { background: iconColor, color: "#fff" }
    : undefined;
  return (
    <>
      <div className="pc-plate-header">
        {icon !== undefined && (
          <span
            className={`pc-plate-header__icon${iconDark ? " pc-plate-header__icon--dark" : ""}`}
            style={iconStyle}
          >
            {icon}
          </span>
        )}
        <span className="pc-plate-header__titles">
          <span className="pc-plate-header__title">{title}</span>
          {subtitle && <span className="pc-plate-header__subtitle">{subtitle}</span>}
        </span>
        {aside !== undefined && <span className="pc-plate-header__aside">{aside}</span>}
      </div>
      {divider && <Divider />}
    </>
  );
}
