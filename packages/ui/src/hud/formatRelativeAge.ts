/**
 * Compact relative age for attention triage — one unit only so it stays
 * subordinate to the state label (mono meta tier).
 *
 * Shared by RosterPanel and InboxCard so the same-age task never reads as
 * "45s" in one panel and "now" in the other. Minute floor (`<1m`): the
 * attention clocks tick at 30s–60s, so second precision would sit stale.
 *
 * Cap policy: hours until 48h, then whole days (attention window spans a
 * couple of days before coarsening).
 *
 * @returns Compact label (`<1m`, `12m`, `4h`, `2d`), or `null` when the
 * timestamp is missing / unparseable.
 */
export function formatRelativeAge(
  iso: string | null | undefined,
  nowMs: number,
): string | null {
  if (iso == null) return null;
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return null;
  const elapsedMinutes = Math.max(0, Math.floor((nowMs - then) / 60_000));
  if (elapsedMinutes < 1) return "<1m";
  if (elapsedMinutes < 60) return `${elapsedMinutes}m`;
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 48) return `${elapsedHours}h`;
  return `${Math.floor(elapsedHours / 24)}d`;
}
