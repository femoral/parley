import type { CSSProperties, ReactNode } from "react";
import type { EmblemMark } from "../tokens/factions.js";

export interface MarkProps {
  /** Data-only mark (glyph char or SVG path art). */
  mark: EmblemMark;
  /**
   * Edge length in px. Matches the font-size the emoji previously occupied
   * (state dot / badge 10, beacon 12, edge alert 13).
   */
  size?: number;
  /** Optional class on the root element. */
  className?: string;
}

/**
 * Layer 1 — render a data-only {@link EmblemMark} as a currentColor silhouette.
 * Used for state glyphs and weather icons so tokens stay free of React while
 * operational chrome gets platform-stable authored art.
 *
 * Always decorative: callers put `aria-hidden` on a parent (or pass it here via
 * the default attributes on the SVG/span) — text labels carry meaning.
 */
export function Mark({ mark, size = 10, className }: MarkProps): ReactNode {
  const style = {
    width: size,
    height: size,
    fontSize: size,
    lineHeight: 1,
    display: "inline-block",
    flex: "0 0 auto",
    color: "inherit",
    verticalAlign: "middle",
  } as CSSProperties;

  if (mark.kind === "glyph") {
    return (
      <span className={className} style={style} aria-hidden="true">
        {mark.char}
      </span>
    );
  }

  const paths = typeof mark.path === "string" ? [mark.path] : mark.path;
  return (
    <svg
      className={className}
      style={style}
      viewBox={mark.viewBox}
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
    >
      {paths.map((d) => (
        <path key={d} d={d} fill="currentColor" fillRule={mark.fillRule} />
      ))}
    </svg>
  );
}
