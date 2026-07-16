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

/** Render a token count the design-manifest's compact way (`1.2k`, `340`). */
export function formatTokenCount(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(Math.round(n));
}

/**
 * Success rate as a one-decimal percent (`87.5%`), or em-dash when null
 * (no completed+failed decisions yet).
 */
export function formatSuccessRate(rate: number | null | undefined): string {
  if (rate === null || rate === undefined || !Number.isFinite(rate)) return "—";
  return `${Math.round(rate * 1000) / 10}%`;
}

/**
 * Eval average with sample count (`4.2 · n=12`), or em-dash when unscored.
 */
export function formatEvalAvg(avg: number | null | undefined, count: number): string {
  if (count === 0 || avg === null || avg === undefined || !Number.isFinite(avg)) return "—";
  const rounded = Number.isInteger(avg) ? String(avg) : (Math.round(avg * 10) / 10).toString();
  return `${rounded} · n=${count}`;
}

/**
 * Duration in ms using the cockpit's compact clock phrasing (reuses
 * {@link formatUptime}). Null → em-dash.
 */
export function formatDurationMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  return formatUptime(ms);
}

/**
 * Render a task's usage map as the inspector Brief's "in ▸ out tok" reading
 * (design-manifest §4.17). Vendor usage keys are free-form (spec §"@useparley/
 * core exports" — the envelope's `usage` is `Record<string, number> | null`
 * with no fixed schema across vendors), so this sums any key whose name
 * suggests input/prompt tokens vs. output/completion tokens, falling back to a
 * single combined total when the shape doesn't split that way.
 */
export function formatUsage(usage: Record<string, number> | null | undefined): string | null {
  if (!usage) return null;
  let input = 0;
  let output = 0;
  let other = 0;
  let sawInput = false;
  let sawOutput = false;
  for (const [key, value] of Object.entries(usage)) {
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    const k = key.toLowerCase();
    if (k.includes("input") || k.includes("prompt")) {
      input += value;
      sawInput = true;
    } else if (k.includes("output") || k.includes("completion")) {
      output += value;
      sawOutput = true;
    } else {
      other += value;
    }
  }
  if (sawInput || sawOutput) return `${formatTokenCount(input)} ▸ ${formatTokenCount(output)} tok`;
  if (other > 0) return `${formatTokenCount(other)} tok`;
  return null;
}
