/**
 * Compact display formatters for the fleet board (Mono data cells).
 * Prose duration helpers live in core; the board needs dense table forms.
 */

/** Compact token count: 1.2k, 3.4M, or plain integer. */
export function formatTokens(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) {
    const v = n / 1_000_000;
    return `${v >= 10 ? v.toFixed(0) : v.toFixed(1)}M`;
  }
  if (abs >= 1_000) {
    const v = n / 1_000;
    return `${v >= 10 ? v.toFixed(0) : v.toFixed(1)}k`;
  }
  return String(Math.round(n));
}

/** In ▸ out token pair for the tokens column. */
export function formatTokenPair(
  input: number | null | undefined,
  output: number | null | undefined,
): string {
  if (
    (input == null || !Number.isFinite(input)) &&
    (output == null || !Number.isFinite(output))
  ) {
    return "—";
  }
  return `${formatTokens(input ?? 0)}▸${formatTokens(output ?? 0)}`;
}

/** Compact duration for table cells: 1h2m / 3m12s / 45s / 320ms. */
export function formatDur(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return m > 0 ? `${h}h${m}m` : `${h}h`;
  if (m > 0) return s > 0 ? `${m}m${s}s` : `${m}m`;
  return `${s}s`;
}

/** Relative age from an ISO timestamp (or epoch ms) to now. */
export function formatAge(
  isoOrMs: string | number | null | undefined,
  nowMs: number = Date.now(),
): string {
  if (isoOrMs == null || isoOrMs === "") return "—";
  const ms = typeof isoOrMs === "number" ? isoOrMs : Date.parse(isoOrMs);
  if (!Number.isFinite(ms)) return "—";
  const delta = Math.max(0, nowMs - ms);
  if (delta < 60_000) return `${Math.floor(delta / 1000)}s`;
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h`;
  return `${Math.floor(delta / 86_400_000)}d`;
}

/** First 8 chars of an id (or whole string if shorter). */
export function shortId(id: string | null | undefined): string {
  if (id == null || id === "") return "—";
  return id.length <= 8 ? id : id.slice(0, 8);
}

/** Clock fragment HH:MM:SS from ISO. */
export function formatTimeOfDay(iso: string | null | undefined): string {
  if (iso == null || iso === "") return "—";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "—";
  const d = new Date(ms);
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  const s = String(d.getSeconds()).padStart(2, "0");
  return `${h}:${m}:${s}`;
}
