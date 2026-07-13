/** Layer 3 effect — the sloop's wake: three trailing foam dashes that fade
 * astern. Pure decoration on the orbit arm; hidden by CSS when the ship isn't
 * making way (stalled/anchored). */
export function Wake() {
  return (
    <span className="pc-wake" aria-hidden="true">
      <span className="pc-wake__dash" />
      <span className="pc-wake__dash" />
      <span className="pc-wake__dash" />
    </span>
  );
}
