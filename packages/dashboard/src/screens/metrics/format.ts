/**
 * Pure formatters for the metrics screen — Mono values, no flavor.
 */

/** Compact token count: 1.2k / 3.4m / raw. */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n === 0) return "0";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(Math.round(n));
}

/** Duration ms → compact: 12s / 3m 12s / 1h 02m. */
export function formatDurationMs(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return s === 0 ? `${m}m` : `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm === 0 ? `${h}h` : `${h}h ${String(rm).padStart(2, "0")}m`;
}

/** Rate 0–1 → "87%" or em-dash. */
export function formatRate(rate: number | null | undefined): string {
  if (rate == null || !Number.isFinite(rate)) return "—";
  return `${Math.round(rate * 100)}%`;
}

/** Score on 0–10 scale to one decimal. */
export function formatScore(score: number | null | undefined): string {
  if (score == null || !Number.isFinite(score)) return "—";
  return score.toFixed(1);
}

/** Signed delta: +1.2 / −0.4 / —. */
export function formatDelta(delta: number | null | undefined): string {
  if (delta == null || !Number.isFinite(delta)) return "—";
  const sign = delta > 0 ? "+" : "";
  return `${sign}${delta.toFixed(1)}`;
}

/** Group key null → structural "(unset)". */
export function formatGroupKey(key: string | null | undefined): string {
  if (key == null || key === "") return "(unset)";
  return key;
}

/** ISO timestamp → short local HH:MM for meta. */
export function formatGeneratedAt(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(11, 16) || iso;
  return d.toTimeString().slice(0, 5);
}

/** Truncate with ellipsis; full value belongs on title. */
export function truncateLabel(label: string, max = 18): string {
  if (label.length <= max) return label;
  return `${label.slice(0, Math.max(1, max - 1))}…`;
}

/** Percent width string for 0–1 rates. */
export function rateWidth(rate: number | null | undefined): string {
  if (rate == null || !Number.isFinite(rate)) return "0%";
  return `${Math.max(0, Math.min(100, rate * 100)).toFixed(0)}%`;
}

/** Score 0–10 → percent of track. */
export function scoreWidth(score: number | null | undefined): string {
  if (score == null || !Number.isFinite(score)) return "0%";
  return `${Math.max(0, Math.min(100, score * 10)).toFixed(0)}%`;
}

/** Baseline 0–10 → percent of track for the mark. */
export function baselineLeft(baseline: number | null | undefined): string {
  if (baseline == null || !Number.isFinite(baseline)) return "50%";
  return `${Math.max(0, Math.min(100, baseline * 10)).toFixed(0)}%`;
}
