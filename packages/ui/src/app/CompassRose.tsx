/** Layer 4 — icon-scale compass rose (design-manifest §2.11 lineage): two rings
 * and a four-point star, brass, spinning over 140s via CSS. Decorative; sits
 * top-left of the centre stage under the cartouche. Stilled by the global
 * prefers-reduced-motion rule. */
export function CompassRose() {
  return (
    <svg className="pc-compass" viewBox="0 0 100 100" aria-hidden="true">
      <circle cx="50" cy="50" r="46" fill="none" stroke="currentColor" strokeWidth="0.5" />
      <circle cx="50" cy="50" r="34" fill="none" stroke="currentColor" strokeWidth="0.4" />
      <polygon points="50,4 56,50 50,96 44,50" fill="currentColor" />
      <polygon points="4,50 50,44 96,50 50,56" fill="currentColor" />
      <polygon
        points="18,18 50,46 82,82 46,50"
        fill="currentColor"
        opacity="0.6"
        transform="rotate(0 50 50)"
      />
      <polygon points="82,18 54,50 18,82 50,54" fill="currentColor" opacity="0.6" />
    </svg>
  );
}
