/** Pure formatters for the run detail screen — durations, sizes, addresses. */

export function formatDuration(ms: number | null | undefined, live = false): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  let base: string;
  if (h > 0) base = `${h}h ${m}m`;
  else if (m > 0) base = `${m}m ${s}s`;
  else base = `${s}s`;
  return live ? `${base}…` : base;
}

export function formatUsage(
  usage: { input_tokens: number; output_tokens: number } | null | undefined,
): string {
  if (!usage) return "—";
  return `${compactTokens(usage.input_tokens)} ▸ ${compactTokens(usage.output_tokens)}`;
}

export function compactTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0";
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function shortId(id: string, n = 8): string {
  if (!id) return "—";
  return id.length <= n ? id : id.slice(0, n);
}

/** Fan-out width label: `×N`, never N marks (coverage audit). */
export function fanWidthLabel(width: number | null | undefined): string | null {
  if (width == null || width < 2) return null;
  return `×${width}`;
}

export function nodeAddress(
  node: string,
  iteration: number,
  opts?: { fan?: number | null; entered?: boolean },
): string {
  if (opts?.entered === false) return `${node} · not entered`;
  const iter = iteration > 0 ? `.${iteration}` : "";
  const fan = fanWidthLabel(opts?.fan);
  return fan ? `${node}${iter} ${fan}` : `${node}${iter || ""}`;
}
