/** Formatting helpers for chrome (uptime, clock, ages, rail data). */

export function formatClock(date: Date = new Date()): string {
  const h = String(date.getHours()).padStart(2, "0");
  const m = String(date.getMinutes()).padStart(2, "0");
  const s = String(date.getSeconds()).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

/** Compact duration for daemon uptime in the header. */
export function formatUptime(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function formatOrigin(): string {
  if (typeof window === "undefined") return "daemon";
  const { hostname, port } = window.location;
  if (port) return `${hostname}:${port}`;
  return hostname || "same-origin";
}

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
