import type { CSSProperties } from "react";

export interface EmblemProps {
  /** The faction coat colour (hex) the chip is tinted with. */
  coat: string;
  /** The single-glyph emblem worn on the chip. */
  glyph: string;
  /** Chip edge length in px (design uses 23 in the roster, 26 in headers). */
  size?: number;
  /** Accessible faction label (chip is otherwise decorative). */
  label?: string;
}

/** Layer 1 — the faction emblem chip (design-manifest §2.7 / §4). The coat is
 * the one loud hue; the glyph is white on it. */
export function Emblem({ coat, glyph, size = 23, label }: EmblemProps) {
  const style = { "--coat": coat, "--emblem-size": `${size}px` } as CSSProperties;
  return (
    <span className="pc-emblem" style={style} role="img" aria-label={label ?? "faction emblem"}>
      {glyph}
    </span>
  );
}
