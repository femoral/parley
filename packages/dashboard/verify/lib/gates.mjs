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

/**
 * Assert a type-size floor still measured every selector it claims to cover.
 *
 * The membership problem above, in its type-size form: a floor that reports the
 * minimum over whatever it happened to sample stays green when a selector stops
 * matching, because the violating rows simply stop existing (#376, #378).
 *
 * `coverage` must be tallied over every match at measurement time, not derived
 * from a stored sample array — those are usually capped, so a selector can be
 * fully covered yet absent from the samples that were kept.
 *
 * @param {string} demoName prefix for error messages (the demo's ledger id)
 * @param {string} blockName ledger block holding the proof, for the absent case
 * @param {Record<string, number> | undefined} coverage selector -> rows measured
 * @param {readonly string[]} requiredSelectors selectors the gate demands
 */
export function assertSelectorCoverage(
  demoName,
  blockName,
  coverage,
  requiredSelectors,
) {
  if (!coverage || typeof coverage !== "object") {
    throw new Error(`${demoName}: ${blockName} missing selectorCoverage proof`);
  }

  const uncovered = requiredSelectors.filter((sel) => !(Number(coverage[sel]) > 0));
  if (uncovered.length > 0) {
    throw new Error(
      `${demoName}: type-size floor selectors matched nothing: ` +
        `${uncovered.join(", ")} (coverage: ${JSON.stringify(coverage)})`,
    );
  }
}
