/**
 * Shared gate assertions for ledger proofs.
 *
 * The membership check exists because a gate that only iterates what the
 * measurement recorded can judge probe *quality* but not probe *membership*:
 * delete a target and the ledger comes back smaller with the gate still green
 * (#370 → #374 → #375 → #376).
 *
 * The required-id lists deliberately stay with each demo's gate rather than
 * moving here. A list shared with the measurement shrinks on both sides when a
 * probe is deleted, which is the defect itself; only the assertion *shape* is
 * common enough to extract.
 */

/**
 * Assert a contrast record still carries every required probe, and that each
 * one matched something.
 *
 * Presence and found-ness are reported separately so the two failure modes stay
 * distinguishable: an id absent from the ledger means the measurement list
 * shrank, whereas `found: false` means the selector stopped matching.
 *
 * @param {string} demoName prefix for error messages (the demo's ledger id)
 * @param {Record<string, {found?: boolean} | undefined>} contrast ledger contrast block
 * @param {readonly string[]} requiredIds probe ids the gate demands
 */
export function assertProbeMembership(demoName, contrast, requiredIds) {
  const absent = requiredIds.filter((id) => !(id in contrast));
  if (absent.length > 0) {
    throw new Error(
      `${demoName}: contrast probes absent from ledger: ${absent.join(", ")} ` +
        `(measured: ${Object.keys(contrast).join(", ") || "none"})`,
    );
  }

  const notFound = requiredIds.filter((id) => !contrast[id]?.found);
  if (notFound.length > 0) {
    throw new Error(
      `${demoName}: contrast probe missing (selector matched nothing): ` +
        `${notFound.map((id) => `${id}=${JSON.stringify(contrast[id])}`).join("; ")}`,
    );
  }
}
