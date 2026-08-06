/** Layer 1 — a single corner flourish glyph (design-manifest §2.11). Purely
 * decorative; the Plate mirrors it into all four corners. Paths are lifted
 * verbatim from the original approved design mock (export not kept in-repo):
 * an L-bracket hugging the corner edges, an inner spiral curl, and a bright dot. */
export type FlourishCorner = "tl" | "tr" | "bl" | "br";

export function Flourish({ corner }: { corner: FlourishCorner }) {
  return (
    <svg className={`pc-flourish pc-flourish--${corner}`} viewBox="0 0 48 48" aria-hidden="true">
      <path
        d="M4 46 L4 14 Q4 6 12 5 L44 5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
      <path
        d="M12 6 Q21 6 21 15 Q21 20 15 20 Q11 20 11 15"
        fill="none"
        stroke="var(--brass-dim)"
        strokeWidth="1.6"
      />
      <circle cx="10" cy="12" r="2.6" fill="var(--brass-bright)" />
    </svg>
  );
}
