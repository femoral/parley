import type { CSSProperties, ReactNode } from "react";
import type { EmblemMark } from "../tokens/factions.js";

export interface EmblemProps {
  /** The faction coat colour (hex) the chip is tinted with. */
  coat: string;
  /** The faction mark (glyph or original SVG path data). */
  mark: EmblemMark;
  /** Chip edge length in px (design uses 23 in the roster, 26 in headers). */
  size?: number;
  /** Accessible faction label (chip is otherwise decorative). */
  label?: string;
}

/** Render a data-only {@link EmblemMark} as chip content (white on coat). */
function EmblemMarkView({ mark }: { mark: EmblemMark }): ReactNode {
  if (mark.kind === "glyph") {
    return mark.char;
  }
  const paths = typeof mark.path === "string" ? [mark.path] : mark.path;
  return (
    <svg className="pc-emblem__mark" viewBox={mark.viewBox} aria-hidden="true" focusable="false">
      {paths.map((d) => (
        <path key={d} d={d} fill="currentColor" fillRule={mark.fillRule} />
      ))}
    </svg>
  );
}

/** Layer 1 — the faction emblem chip (design-manifest §2.7 / §4). The coat is
 * the one loud hue; the mark is white/light on it. `label` is both the
 * accessible name and the hover tooltip so production users can recognise a
 * faction without opening the chart key. */
export function Emblem({ coat, mark, size = 23, label }: EmblemProps) {
  const style = { "--coat": coat, "--emblem-size": `${size}px` } as CSSProperties;
  const accessible = label ?? "faction emblem";
  return (
    <span
      className="pc-emblem"
      style={style}
      role="img"
      aria-label={accessible}
      title={label}
    >
      <EmblemMarkView mark={mark} />
    </span>
  );
}
