import {
  isMetricsGroupBy,
  METRICS_GROUP_BY,
  type MetricsGroup,
  type MetricsResponse,
} from "@useparley/core";
import { parseArgs } from "../args.js";
import { daemonGet, ensureDaemon } from "../client.js";
import { type CliContext, printJson } from "../context.js";
import { UsageError } from "../errors.js";

interface TasksResponse {
  tasks: { orchestrator_session_id: string | null }[];
}

/**
 * Resolve `--session` for metrics: `all` means every task; `latest` is the
 * newest task's non-null orchestrator session; a concrete id is passed through.
 * Default when the flag is omitted: `all` (endpoint / design default).
 */
function resolveSession(
  sessionFlag: string | undefined,
  tasks: { orchestrator_session_id: string | null }[],
): string {
  if (sessionFlag === undefined || sessionFlag === "all") return "all";
  if (sessionFlag === "latest") {
    const latest = tasks.find((t) => t.orchestrator_session_id !== null)?.orchestrator_session_id;
    return latest ?? "all";
  }
  return sessionFlag;
}

function formatPct(rate: number | null): string {
  if (rate === null) return "-";
  return `${Math.round(rate * 1000) / 10}%`;
}

function formatNum(n: number | null | undefined): string {
  if (n === null || n === undefined) return "-";
  if (Number.isInteger(n)) return String(n);
  return (Math.round(n * 10) / 10).toString();
}

/** Compact duration: ms under 1s, else `MmSSs` style seconds. */
function formatDurationMs(ms: number | null): string {
  if (ms === null) return "-";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m${String(seconds).padStart(2, "0")}s`;
}

function formatTokens(n: number): string {
  if (n === 0) return "0";
  if (n < 1000) return String(Math.round(n));
  const k = Math.round((n / 1000) * 10) / 10;
  return `${k}k`;
}

function renderHuman(ctx: CliContext, groups: MetricsGroup[]): void {
  if (groups.length === 0) {
    ctx.stdout("No tasks.\n");
    return;
  }
  const header = [
    "GROUP",
    "DONE",
    "FAIL",
    "SUCCESS",
    "EVAL",
    "TOKENS_IN",
    "TOKENS_OUT",
    "CACHED",
    "AVG_DUR",
    "P95_DUR",
  ];
  const rows = groups.map((g) => {
    const evalCell =
      g.evals.count === 0
        ? "-"
        : `${formatNum(g.evals.avg)} (${g.evals.count})`;
    return [
      g.key ?? "(none)",
      String(g.tasks.completed),
      String(g.tasks.failed),
      formatPct(g.success_rate),
      evalCell,
      formatTokens(g.tokens.input),
      formatTokens(g.tokens.output),
      formatTokens(g.tokens.cached),
      formatDurationMs(g.duration_ms.avg),
      formatDurationMs(g.duration_ms.p95),
    ];
  });
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)),
  );
  const format = (cells: string[]): string =>
    cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join("  ").trimEnd();
  ctx.stdout(`${format(header)}\n`);
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i]!;
    ctx.stdout(`${format(rows[i]!)}\n`);
    // Compact per-size / per-difficulty eval lines when present.
    const sizeKeys = Object.keys(g.evals_by_size).sort();
    if (sizeKeys.length > 0) {
      const parts = sizeKeys.map((k) => {
        const e = g.evals_by_size[k]!;
        return `${k}: ${formatNum(e.avg)} (n=${e.count})`;
      });
      ctx.stdout(`  evals by size: ${parts.join(", ")}\n`);
    }
    const diffKeys = Object.keys(g.evals_by_difficulty).sort();
    if (diffKeys.length > 0) {
      const parts = diffKeys.map((k) => {
        const e = g.evals_by_difficulty[k]!;
        return `${k}: ${formatNum(e.avg)} (n=${e.count})`;
      });
      ctx.stdout(`  evals by difficulty: ${parts.join(", ")}\n`);
    }
  }
}

/**
 * `parley metrics [--session <id|latest|all>] [--group-by …] [--json]` —
 * aggregate task metrics from the daemon (#118).
 */
export async function runMetrics(ctx: CliContext, args: string[]): Promise<number> {
  const { positionals, flags } = parseArgs(args, {
    "--session": { value: true },
    "--group-by": { value: true },
    "--json": {},
  });
  if (positionals.length > 0) {
    throw new UsageError(`metrics: unexpected argument: ${positionals[0]}`);
  }

  const sessionFlag =
    typeof flags["--session"] === "string" ? flags["--session"] : undefined;
  const groupByRaw =
    typeof flags["--group-by"] === "string" ? flags["--group-by"] : "vendor";
  if (!isMetricsGroupBy(groupByRaw)) {
    throw new UsageError(
      `metrics: invalid --group-by: ${groupByRaw} (expected ${METRICS_GROUP_BY.join("|")})`,
    );
  }
  const json = flags["--json"] === true;

  const discovery = await ensureDaemon(ctx.paths, ctx.env);
  // Task list only needed to resolve `latest`; cheap enough to always fetch.
  const { tasks } = await daemonGet<TasksResponse>(discovery, "/tasks");
  const session = resolveSession(sessionFlag, tasks);

  const params = new URLSearchParams({
    session,
    group_by: groupByRaw,
  });
  const body = await daemonGet<MetricsResponse>(discovery, `/metrics?${params.toString()}`);

  if (json) {
    printJson(ctx, body);
  } else {
    renderHuman(ctx, body.groups);
  }
  return 0;
}
