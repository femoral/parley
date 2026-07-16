/** Layer 3 effect — the sloop's wake: three trailing foam dashes that fade
 * astern. Pure decoration on the voyage/station wrapper; CSS shows it under
 * way and as a subtle pulse on station for `running`, and hides it when the
 * ship is anchored or adrift. */
export function Wake() {
  return (
    <span className="pc-wake" aria-hidden="true">
      <span className="pc-wake__dash" />
      <span className="pc-wake__dash" />
      <span className="pc-wake__dash" />
    </span>
  );
}
