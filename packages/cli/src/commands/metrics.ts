import {
  filtersToSearchParams,
  isMetricsGroupBy,
  METRICS_GROUP_BY,
  type MetricsEvalStats,
  type MetricsGroup,
  type MetricsResponse,
  type TaskMetricsFilters,
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

function formatEvalCell(evals: MetricsEvalStats): string {
  if (evals.count === 0) return "-";
  const avg = formatNum(evals.avg);
  const base = formatNum(evals.avg_baseline);
  const delta = evals.avg_delta === null ? "-" : formatSigned(evals.avg_delta);
  return `${avg}/${base} Δ${delta} (n=${evals.count})`;
}

function formatSigned(n: number): string {
  const rounded = Math.round(n * 10) / 10;
  if (rounded > 0) return `+${rounded}`;
  return String(rounded);
}

/** Shared filter flags for metrics and list (#164). */
export const METRICS_FILTER_FLAGS = {
  "--type": { value: true },
  "--vendor": { value: true },
  "--model": { value: true },
  "--profile": { value: true },
  "--size": { value: true },
  "--difficulty": { value: true },
  "--orch-harness": { value: true },
  "--orch-model": { value: true },
  "--orch-effort": { value: true },
  "--eval-harness": { value: true },
  "--eval-model": { value: true },
  "--eval-effort": { value: true },
  "--rubric": { value: true },
  "--rubric-version": { value: true },
  "--first-attempt": {},
  "--below-baseline": {},
} as const;

/** Read filter flags into a {@link TaskMetricsFilters} object. */
export function filtersFromFlags(
  flags: Record<string, string | boolean | string[]>,
): TaskMetricsFilters {
  const str = (name: string): string | undefined => {
    const v = flags[name];
    return typeof v === "string" && v !== "" ? v : undefined;
  };
  const out: TaskMetricsFilters = {};
  const type = str("--type");
  if (type !== undefined) out.type = type;
  const vendor = str("--vendor");
  if (vendor !== undefined) out.vendor = vendor;
  const model = str("--model");
  if (model !== undefined) out.model = model;
  const profile = str("--profile");
  if (profile !== undefined) out.profile = profile;
  const size = str("--size");
  if (size !== undefined) out.size = size;
  const difficulty = str("--difficulty");
  if (difficulty !== undefined) out.difficulty = difficulty;
  const orchHarness = str("--orch-harness");
  if (orchHarness !== undefined) out.orch_harness = orchHarness;
  const orchModel = str("--orch-model");
  if (orchModel !== undefined) out.orch_model = orchModel;
  const orchEffort = str("--orch-effort");
  if (orchEffort !== undefined) out.orch_effort = orchEffort;
  const evalHarness = str("--eval-harness");
  if (evalHarness !== undefined) out.eval_harness = evalHarness;
  const evalModel = str("--eval-model");
  if (evalModel !== undefined) out.eval_model = evalModel;
  const evalEffort = str("--eval-effort");
  if (evalEffort !== undefined) out.eval_effort = evalEffort;
  const rubric = str("--rubric");
  if (rubric !== undefined) out.rubric = rubric;
  const rv = str("--rubric-version");
  if (rv !== undefined) {
    const n = Number(rv);
    if (!Number.isInteger(n) || n < 1) {
      throw new UsageError(`invalid --rubric-version: ${rv} (expected a positive integer)`);
    }
    out.rubric_version = n;
  }
  if (flags["--first-attempt"] === true) out.first_attempt = true;
  if (flags["--below-baseline"] === true) out.below_baseline = true;
  return out;
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
    "BELOW",
    "TOKENS_IN",
    "TOKENS_OUT",
    "CACHED",
    "AVG_DUR",
    "P95_DUR",
  ];
  const rows = groups.map((g) => {
    return [
      g.key ?? "(none)",
      String(g.tasks.completed),
      String(g.tasks.failed),
      formatPct(g.success_rate),
      formatEvalCell(g.evals),
      g.evals.count === 0 ? "-" : formatPct(g.evals.below_baseline_rate),
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
    // First-attempt vs fix split when either side has rubric evals.
    if (g.evals.first_attempt.count > 0 || g.evals.fix.count > 0) {
      const fa = g.evals.first_attempt;
      const fx = g.evals.fix;
      ctx.stdout(
        `  attempts: first avg=${formatNum(fa.avg)} (n=${fa.count}); fix avg=${formatNum(fx.avg)} (n=${fx.count})\n`,
      );
    }
    // Top criterion failures (highest rate, then failures count).
    const crit = Object.entries(g.evals.criterion_failures)
      .filter(([, s]) => s.failures > 0)
      .sort((a, b) => {
        const ar = a[1].rate ?? 0;
        const br = b[1].rate ?? 0;
        if (br !== ar) return br - ar;
        return b[1].failures - a[1].failures;
      })
      .slice(0, 5);
    if (crit.length > 0) {
      const parts = crit.map(
        ([id, s]) => `${id}: ${s.failures}/${s.count} (${formatPct(s.rate)})`,
      );
      ctx.stdout(`  criterion failures: ${parts.join(", ")}\n`);
    }
  }
}

/**
 * `parley metrics [--session <id|latest|all>] [--group-by …] [--json] [filters]`
 * — aggregate task metrics from the daemon (#118 / #164).
 */
export async function runMetrics(ctx: CliContext, args: string[]): Promise<number> {
  const { positionals, flags } = parseArgs(args, {
    "--session": { value: true },
    "--group-by": { value: true },
    "--json": {},
    ...METRICS_FILTER_FLAGS,
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
  const filters = filtersFromFlags(flags);

  const discovery = await ensureDaemon(ctx.paths, ctx.env);
  // Task list only needed to resolve `latest`; cheap enough to always fetch.
  const { tasks } = await daemonGet<TasksResponse>(discovery, "/tasks");
  const session = resolveSession(sessionFlag, tasks);

  const params = filtersToSearchParams({ ...filters, session });
  params.set("group_by", groupByRaw);
  const body = await daemonGet<MetricsResponse>(discovery, `/metrics?${params.toString()}`);

  if (json) {
    printJson(ctx, body);
  } else {
    renderHuman(ctx, body.groups);
  }
  return 0;
}
