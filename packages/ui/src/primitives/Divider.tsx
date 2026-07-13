export interface DividerProps {
  className?: string;
  /** Vertical column-separator variant (design-manifest §2.10's "vertical
   * version rotates to 180deg with `#6f5326` stops") — the kit band's
   * factions/legend/chrome columns (#70). */
  vertical?: boolean;
}

/** Layer 1 — the gold divider rule (design-manifest §2.10 / §4.20). */
export function Divider({ className, vertical = false }: DividerProps) {
  const classes = ["pc-divider", vertical && "pc-divider--v", className].filter(Boolean).join(" ");
  // The horizontal rule is a semantic `<hr>`; the vertical variant isn't a
  // thematic break in that sense, so it's a plain decorative `<div>`.
  return vertical ? (
    <div className={classes} aria-hidden="true" />
  ) : (
    <hr className={classes} aria-hidden="true" />
  );
}
