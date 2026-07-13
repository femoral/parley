/**
 * Layer 4 (app) display formatters. Pure string helpers used only when the hooks
 * project SDK values into the plain shapes hud consumes. Not domain logic — no
 * `@useparley/core` import.
 */

/** Two-digit zero pad. */
function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * Render an uptime in ms as the cockpit's clock phrasing (design-manifest's
 * `3m 41s`): the two largest non-zero units. Sub-minute shows just seconds.
 */
export function formatUptime(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const totalSec = Math.floor(ms / 1000);
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  if (days > 0) return `${days}d ${pad(hours)}h`;
  if (hours > 0) return `${hours}h ${pad(minutes)}m`;
  if (minutes > 0) return `${minutes}m ${pad(seconds)}s`;
  return `${seconds}s`;
}

/** Wall-clock `HH:MM` for the day chip. */
export function formatClock(date: Date): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
