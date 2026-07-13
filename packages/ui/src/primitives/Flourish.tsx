/** Layer 1 — a single corner flourish glyph (design-manifest §2.11). Purely
 * decorative; the Plate mirrors it into all four corners. */
export type FlourishCorner = "tl" | "tr" | "bl" | "br";

export function Flourish({ corner }: { corner: FlourishCorner }) {
  return (
    <svg className={`pc-flourish pc-flourish--${corner}`} viewBox="0 0 30 30" aria-hidden="true">
      <path
        d="M2 2 C 2 12, 6 16, 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
      <path
        d="M6 6 C 6 12, 9 14, 15 14"
        fill="none"
        stroke="var(--brass-dim)"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <circle cx="3" cy="3" r="1.6" fill="var(--brass-bright)" />
    </svg>
  );
}
