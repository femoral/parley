import type { CSSProperties, ReactNode } from "react";

export interface BadgeProps {
  /** Badge text (already cased, e.g. "AWAITING", "SUCCESS"). */
  label: string;
  /**
   * Optional leading glyph. Accepts a string (legacy emoji / unicode) or a
   * React node (authored {@link Mark} SVG). Strings keep working for call
   * sites that still pass text.
   */
  glyph?: ReactNode;
  /**
   * CSS colour driving border + text. Pass a `var(--state-*)` token so the
   * hue stays in the token layer; defaults to the muted label ink.
   */
  color?: string;
}

/** Layer 1 — the pill badge: state, outcome, and standalone pills share it
 * (design-manifest §4.9). */
export function Badge({ label, glyph, color }: BadgeProps) {
  const style = color ? ({ "--badge-color": color } as CSSProperties) : undefined;
  return (
    <span className="pc-badge" style={style}>
      {glyph != null && glyph !== "" && (
        <span className="pc-badge__glyph" aria-hidden="true">
          {glyph}
        </span>
      )}
      {label}
    </span>
  );
}
