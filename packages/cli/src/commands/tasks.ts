import type {
  AttemptLineageEntry,
  EvalDetail,
  SessionProvenance,
  TaskDetailResponse,
  TaskMetricsFilters,
} from "@useparley/core";
import { filtersToSearchParams } from "@useparley/core";
import { parseArgs } from "../args.js";
import { type CliContext, printJson } from "../context.js";
import { daemonGet, ensureDaemon } from "../client.js";
import type { TaskRow } from "@useparley/daemon/db.js";
import { parseJsonColumn } from "@useparley/daemon/report.js";
import { filtersFromFlags, METRICS_FILTER_FLAGS } from "./metrics.js";

interface TasksResponse {
  tasks: TaskRow[];
}

/** Compact `<n>k` rendering of a raw token count, e.g. 1234 -> "1.2k". */
function formatTokenCount(n: number): string {
  const k = Math.round((n / 1000) * 10) / 10;
  return `${k}k`;
}

/**
 * `<in>k in/<out>k out` for vendors that report usage (codex); `n/r` when the
 * task has no usage data at all (grok today) or reports neither field —
 * never a bare `0` or blank, which would misread as "used nothing".
 * `cached_input_tokens` is deliberately omitted here; it stays available via
 * `--json`'s raw `usage` object.
 */
function formatUsage(usage: Record<string, number> | null): string {
  if (usage === null) return "n/r";
  const { input_tokens, output_tokens } = usage;
  if (input_tokens === undefined && output_tokens === undefined) return "n/r";
  return `${formatTokenCount(input_tokens ?? 0)} in/${formatTokenCount(output_tokens ?? 0)} out`;
}

/**
 * `MmSSs` elapsed time from `started_at ?? created_at` through `completed_at`;
 * a still-running task (no `completed_at` yet) is measured against now and
 * suffixed `...` to mark it as a live, growing figure.
 */
function formatDuration(task: TaskRow): string {
  const startMs = Date.parse(task.started_at ?? task.created_at);
  const running = task.completed_at === null;
  const endMs = task.completed_at === null ? Date.now() : Date.parse(task.completed_at);
  const totalSeconds = Math.max(0, Math.floor((endMs - startMs) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const formatted = `${minutes}m${String(seconds).padStart(2, "0")}s`;
  return running ? `${formatted}...` : formatted;
}

/** Compact session id for the table — a git-style prefix, like the short ID. */
function shortSession(id: string | null): string {
  if (!id) return "-";
  return id.length > 8 ? id.slice(0, 8) : id;
}

/**
 * ATTEMPT column (#152): show the 1-based attempt number. First delegations
 * are `1`; each `parley fix` increments. Always present so the column is
 * stable even when every row is a first attempt.
 */
function formatAttempt(task: TaskRow): string {
  return String(task.attempt ?? 1);
}

/**
 * Derived cache-hit tri-state for `--json` (#152): true when the vendor
 * reported a positive cache count, false when it reported zero, null when
 * unreported — never guessed from latency or missing usage.
 */
function cacheHit(cached: number | null | undefined): boolean | null {
  if (cached === null || cached === undefined) return null;
  return cached > 0;
}

function renderTable(ctx: CliContext, tasks: TaskRow[]): void {
  if (tasks.length === 0) {
    ctx.stdout("No tasks.\n");
    return;
  }
  const header = [
    "ID",
    "SESSION",
    "NAME",
    "TYPE",
    "VENDOR",
    "PROFILE",
    "RUNNER",
    "MODEL",
    "STATE",
    "ATTEMPT",
    "USAGE",
    "DURATION",
  ];
  const rows = tasks.map((t) => [
    t.id,
    shortSession(t.orchestrator_session_id),
    t.name ?? "-",
    t.type || "other",
    t.vendor ?? "-",
    t.profile ?? "-",
    t.runner ?? "-",
    t.model ?? "-",
    t.state,
    formatAttempt(t),
    formatUsage(parseJsonColumn<Record<string, number>>(t.usage)),
    formatDuration(t),
  ]);
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)),
  );
  const format = (cells: string[]): string =>
    cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join("  ").trimEnd();
  ctx.stdout(`${format(header)}\n`);
  for (const row of rows) ctx.stdout(`${format(row)}\n`);
}

function formatSigned(n: number): string {
  const rounded = Math.round(n * 10) / 10;
  if (rounded > 0) return `+${rounded}`;
  return String(rounded);
}

/** Render Session / Eval / Attempts sections for single-task status (#164). */
function renderDetailSections(
  ctx: CliContext,
  detail: {
    session: SessionProvenance;
    eval_detail: EvalDetail | null;
    attempts: AttemptLineageEntry[];
  },
): void {
  const s = detail.session;
  ctx.stdout("\nSession\n");
  ctx.stdout(`  id:      ${s.session_id ?? "-"}\n`);
  ctx.stdout(`  harness: ${s.harness ?? "-"}\n`);
  ctx.stdout(`  model:   ${s.model ?? "-"}\n`);
  ctx.stdout(`  effort:  ${s.effort ?? "-"}\n`);

  const e = detail.eval_detail;
  ctx.stdout("\nEval\n");
  if (e === null) {
    ctx.stdout("  (none)\n");
  } else if (e.legacy) {
    ctx.stdout(`  score: ${e.score} (legacy)\n`);
    if (e.feedback) ctx.stdout(`  feedback: ${e.feedback}\n`);
  } else {
    const base = e.baseline === null ? "?" : String(e.baseline);
    const delta =
      e.delta === null ? "" : ` delta=${formatSigned(e.delta)}`;
    const below =
      e.below_baseline === true ? " BELOW BASELINE" : e.below_baseline === false ? "" : "";
    ctx.stdout(`  score: ${e.score} baseline=${base}${delta}${below}\n`);
    if (e.rubric != null) {
      const ver = e.rubric_version != null ? `@v${e.rubric_version}` : "";
      ctx.stdout(`  rubric: ${e.rubric}${ver}\n`);
    }
    if (e.judge) {
      const j = e.judge;
      ctx.stdout(
        `  judge: harness=${j.harness ?? "-"} model=${j.model ?? "-"} effort=${j.effort ?? "-"}\n`,
      );
    }
    if (e.feedback) ctx.stdout(`  feedback: ${e.feedback}\n`);
    if (e.criteria && e.criteria.length > 0) {
      ctx.stdout("  criteria:\n");
      for (const c of e.criteria) {
        const mark = c.pass ? "✓" : "✗";
        const kind = c.kind === "negative" ? " [neg]" : "";
        ctx.stdout(`    ${mark} ${c.id} (w=${c.weight})${kind}\n`);
      }
    }
  }

  ctx.stdout("\nAttempts\n");
  if (detail.attempts.length === 0) {
    ctx.stdout("  (none)\n");
    return;
  }
  for (const a of detail.attempts) {
    const badges: string[] = [];
    if (a.resumed) badges.push("resumed");
    if (a.cache_hit === true) badges.push("cache");
    else if (a.cache_hit === false) badges.push("no-cache");
    const badgeStr = badges.length > 0 ? ` [${badges.join(",")}]` : "";
    let scoreStr = "";
    if (a.eval_score !== null && a.eval_score !== undefined) {
      if (a.eval_legacy) {
        scoreStr = ` score=${a.eval_score} (legacy)`;
      } else {
        const base =
          a.eval_baseline !== null && a.eval_baseline !== undefined
            ? `/${a.eval_baseline}`
            : "";
        scoreStr = ` score=${a.eval_score}${base}`;
      }
    }
    ctx.stdout(
      `  #${a.attempt}  ${a.id}  ${a.state}${scoreStr}${badgeStr}\n`,
    );
  }
}

/** Present a task row for list `--json` output: JSON columns become objects. */
function presentRow(row: TaskRow): Record<string, unknown> {
  const cached =
    row.cached_input_tokens === undefined ? null : row.cached_input_tokens;
  return {
    ...row,
    usage: parseJsonColumn(row.usage),
    report: parseJsonColumn(row.report),
    // #154: launch_command is stored as a JSON array of spawn records.
    launch_command: parseJsonColumn(row.launch_command),
    // #157: eval_answers is a JSON object of criterion id → boolean.
    eval_answers: parseJsonColumn(row.eval_answers ?? null),
    // `network` is stored as SQLite 0/1; surface it as a boolean.
    network: row.network === 1,
    // Attempt chain (#152): boolean + derived tri-state for cache honesty.
    resumed: row.resumed === 1,
    attempt: row.attempt ?? 1,
    parent_task_id: row.parent_task_id ?? null,
    cached_input_tokens: cached,
    cache_hit: cacheHit(cached),
  };
}

/**
 * Present single-task status `--json`: row fields plus Session/Eval/Attempts
 * sections (#164) so scripts see the same data as human output.
 */
function presentDetail(detail: TaskDetailResponse): Record<string, unknown> {
  return {
    ...presentRow(detail.row as TaskRow),
    session: detail.session,
    eval_detail: detail.eval_detail,
    attempts: detail.attempts,
  };
}

/**
 * Resolve the orchestrator session a bare listing narrows to. `--session <id>`
 * pins that id; `--session latest` (and the env/no-flag default) resolve to the
 * most-recently-used session — the newest task's non-null session id (tasks
 * arrive newest-first). `undefined` means "no session filter" (show all).
 */
function resolveSessionFilter(
  sessionFlag: string | undefined,
  env: NodeJS.ProcessEnv,
  tasks: TaskRow[],
): string | undefined {
  const latest = (): string | undefined =>
    tasks.find((t) => t.orchestrator_session_id !== null)?.orchestrator_session_id ?? undefined;
  if (sessionFlag !== undefined) {
    return sessionFlag === "latest" ? latest() : sessionFlag;
  }
  const envSession = env.PARLEY_SESSION_ID;
  return envSession ? envSession : latest();
}

/**
 * Apply local session scoping after server filters. Server already applied
 * type/provenance/rubric filters via query params; session for list still
 * uses CLI defaulting (latest / env / --all).
 */
function applySessionScope(
  tasks: TaskRow[],
  ref: string | undefined,
  all: boolean,
  sessionFlag: string | undefined,
  env: NodeJS.ProcessEnv,
): TaskRow[] {
  if (ref) {
    return tasks.filter((t) => t.id === ref || t.name === ref);
  }
  if (all) return tasks;
  const session = resolveSessionFilter(sessionFlag, env, tasks);
  if (session === undefined) return tasks;
  return tasks.filter((t) => t.orchestrator_session_id === session);
}

/**
 * `parley status [task] [--json] [--session <id>] [--all] [filters]` (and its
 * `parley list` alias). Auto-spawns the daemon, fetches the task table over the
 * CLI plane, and renders it. A task reference may be a short id or a `--name`
 * label — a targeted lookup that bypasses session filtering. With no ref, the
 * listing narrows to one orchestrator session: `--session <id>` (or `latest`),
 * else `PARLEY_SESSION_ID` from the environment, else the most-recently-used
 * session. `--all` shows every task. Dimension filters (#164) match metrics.
 * Single-task status renders Session / Eval / Attempts sections.
 */
export async function runStatus(ctx: CliContext, args: string[]): Promise<number> {
  const { positionals, flags } = parseArgs(args, {
    "--json": {},
    "--session": { value: true },
    "--all": {},
    ...METRICS_FILTER_FLAGS,
  });
  const ref = positionals[0];
  const json = flags["--json"] === true;
  const all = flags["--all"] === true;
  const sessionFlag = typeof flags["--session"] === "string" ? flags["--session"] : undefined;
  const filters: TaskMetricsFilters = filtersFromFlags(flags);

  const discovery = await ensureDaemon(ctx.paths, ctx.env);

  // Single-task path: fetch detail so Session/Eval/Attempts are complete.
  if (ref) {
    // Still need the list for name-based resolution when ref is a --name label.
    const listParams = filtersToSearchParams(filters);
    const listQs = listParams.toString();
    const { tasks } = await daemonGet<TasksResponse>(
      discovery,
      listQs === "" ? "/tasks" : `/tasks?${listQs}`,
    );
    const match = tasks.find((t) => t.id === ref || t.name === ref);
    if (!match) {
      if (json) {
        printJson(ctx, null);
      } else {
        ctx.stdout("No tasks.\n");
      }
      return 0;
    }
    const detail = await daemonGet<TaskDetailResponse>(
      discovery,
      `/tasks/${encodeURIComponent(match.id)}`,
    );
    if (json) {
      printJson(ctx, presentDetail(detail));
    } else {
      renderTable(ctx, [detail.row as TaskRow]);
      renderDetailSections(ctx, detail);
    }
    return 0;
  }

  // List path: server-side dimension filters + local session scoping.
  const listParams = filtersToSearchParams(filters);
  const listQs = listParams.toString();
  const { tasks } = await daemonGet<TasksResponse>(
    discovery,
    listQs === "" ? "/tasks" : `/tasks?${listQs}`,
  );
  const filtered = applySessionScope(tasks, undefined, all, sessionFlag, ctx.env);

  if (json) {
    printJson(ctx, filtered.map(presentRow));
  } else {
    renderTable(ctx, filtered);
  }
  return 0;
}
