/** Count + noun pluralization for chrome copy (never "1 tasks"). */
export function countNoun(n: number, singular: string, plural?: string): string {
  const p = plural ?? `${singular}s`;
  return `${n} ${n === 1 ? singular : p}`;
}

/**
 * Subject-verb agreement for "need" when the subject is a count.
 * 1 → "1 needs action"; 0/2+ → "0 need action" / "3 need action".
 */
export function countNeedVerb(n: number, object: string): string {
  return `${n} ${n === 1 ? "needs" : "need"} ${object}`;
}
