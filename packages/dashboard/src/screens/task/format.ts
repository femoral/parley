/**
 * Task-inspector formatters — state labels, duration, usage, ages.
 * Pure helpers; no Cove imports.
 */
import type { LogLineKind, LogTailStatus } from "../../data/types.js";

/** State → CSS custom property (status ink only). */
export const STATE_COLOR: Record<string, string> = {
  pending: "var(--state-pending)",
  queued: "var(--state-queued)",
  running: "var(--state-running)",
  awaiting_answer: "var(--state-awaiting)",
  stalled: "var(--state-stalled)",
  completed: "var(--state-completed)",
  failed: "var(--state-failed)",
  cancelled: "var(--state-cancelled)",
};

export function stateColor(state: string): string {
  return STATE_COLOR[state] ?? "var(--text-3)";
}

export function stateLabel(state: string): string {
  if (state === "awaiting_answer") return "AWAITING";
  return state.replace(/_/g, " ").toUpperCase();
}

/** Harness coat token by vendor name. */
export function coatVar(vendor: string | null | undefined): string {
  const v = (vendor ?? "").toLowerCase();
  if (v.includes("codex") || v === "openai") return "var(--coat-codex)";
  if (v.includes("grok") || v.includes("xai")) return "var(--coat-grok)";
  if (v.includes("claude") || v.includes("anthropic")) return "var(--coat-claude)";
  if (v.includes("gemini") || v.includes("google")) return "var(--coat-gemini)";
  if (v.includes("kimi")) return "var(--coat-kimi)";
  if (v.includes("opencode")) return "var(--coat-opencode)";
  return "var(--text-4)";
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  if (totalSec > 0) return `${s}s`;
  if (ms > 0) return `${ms}ms`;
  return "0s";
}

/** Compact token counts: `12.4k ▸ 3.1k · cached 1.0k`. */
export function formatUsage(usage: Record<string, number> | null | undefined): string {
  if (!usage) return "—";
  const input = num(usage.input_tokens ?? usage.input ?? usage.prompt_tokens);
  const output = num(usage.output_tokens ?? usage.output ?? usage.completion_tokens);
  const cached = num(
    usage.cached_tokens ?? usage.cached_input_tokens ?? usage.cache_read_input_tokens ?? usage.cached,
  );
  if (input == null && output == null && cached == null) return "—";
  const parts: string[] = [];
  parts.push(`${fmtK(input)} ▸ ${fmtK(output)}`);
  if (cached != null && cached > 0) parts.push(`cached ${fmtK(cached)}`);
  return parts.join(" · ");
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function fmtK(n: number | null): string {
  if (n == null) return "—";
  if (Math.abs(n) < 1000) return String(Math.round(n));
  if (Math.abs(n) < 10_000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
}

/** Relative age from an ISO timestamp to now. */
export function formatAge(iso: string | null | undefined, nowMs = Date.now()): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const sec = Math.max(0, Math.floor((nowMs - t) / 1000));
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

/** HH:MM:SS local wall clock for log lines (no wire timestamp — sequential). */
export function formatLogClock(index: number, total: number, now = new Date()): string {
  // Synthetic gutter times counting backward from now so the well feels live.
  const offsetSec = Math.max(0, total - 1 - index) * 3;
  const d = new Date(now.getTime() - offsetSec * 1000);
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  const s = String(d.getSeconds()).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

export function formatQaClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

export function logKindColor(kind: LogLineKind): string {
  switch (kind) {
    case "error":
      return "var(--state-failed)";
    case "question":
      return "var(--state-awaiting)";
    case "shell":
      return "var(--state-awaiting)";
    case "tool":
      return "var(--link)";
    case "reasoning":
      return "var(--text-2)";
    case "stdout":
      return "var(--state-running)";
    default:
      return "var(--text-strong-2)";
  }
}

export function logTextColor(kind: LogLineKind): string {
  if (kind === "error") return "var(--state-failed)";
  if (kind === "reasoning") return "var(--text-2)";
  return "var(--text-strong-2)";
}

export function tailStatusLabel(status: LogTailStatus, follow: boolean): string {
  switch (status) {
    case "connecting":
      return "connecting";
    case "tailing":
      return follow ? "tailing · follow on" : "tailing";
    case "paused-by-setting":
      return "paused · follow off";
    case "ended":
      return "ended · nothing left to follow";
    case "unreachable":
      return "unreachable · stream dropped";
    default:
      return status;
  }
}

export function tailStatusColor(status: LogTailStatus): string {
  switch (status) {
    case "tailing":
      return "var(--state-running)";
    case "connecting":
      return "var(--state-pending)";
    case "unreachable":
      return "var(--state-failed)";
    case "paused-by-setting":
      return "var(--state-awaiting)";
    case "ended":
      return "var(--text-3)";
    default:
      return "var(--text-3)";
  }
}

export function isLiveTail(status: LogTailStatus): boolean {
  return status === "tailing" || status === "connecting";
}

export function isTerminalState(state: string): boolean {
  return state === "completed" || state === "failed" || state === "cancelled";
}

export function outcomeColor(outcome: string): string {
  if (outcome === "success") return "var(--state-eval-good)";
  if (outcome === "blocked") return "var(--state-failed)";
  if (outcome === "partial") return "var(--state-awaiting)";
  return "var(--text-3)";
}

export function formatAddress(task: {
  run_id?: string | null;
  node?: string | null;
  iteration?: number | null;
  slot?: string | null;
}): string {
  if (!task.run_id) return "solo task (no run)";
  const node = task.node ?? "?";
  const iter = task.iteration != null ? String(task.iteration) : "?";
  const slot = task.slot ? `[${task.slot}]` : "";
  return `${task.run_id.slice(0, 8)} · ${node}.${iter}${slot}`;
}

export function formatPosture(posture: {
  sandbox?: string | null;
  network?: boolean | null;
} | null): string {
  if (!posture) return "—";
  const sandbox = posture.sandbox ?? "—";
  const net = posture.network === true ? "network on" : "network off";
  return `--sandbox ${sandbox} · ${net}`;
}

/** Eval score display: `8.0 / 5.2` or `— unscored`. */
export function formatEvalScore(
  score: number | null | undefined,
  baseline: number | null | undefined,
): string {
  if (score == null || !Number.isFinite(score)) return "— unscored";
  const s = score.toFixed(1);
  if (baseline != null && Number.isFinite(baseline)) return `${s}/${baseline.toFixed(1)}`;
  return s;
}

export function evalScoreColor(
  score: number | null | undefined,
  baseline: number | null | undefined,
): string {
  if (score == null) return "var(--text-3)";
  if (baseline != null && Number.isFinite(baseline)) {
    return score < baseline ? "var(--state-eval-poor)" : "var(--state-eval-good)";
  }
  return "var(--text-strong-2)";
}
