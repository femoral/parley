import { parseArgs } from "../args.js";
import { type CliContext, printJson } from "../context.js";
import { daemonGet, ensureDaemon } from "../client.js";
import type { TaskRow } from "@useparley/daemon/db.js";
import { parseJsonColumn } from "@useparley/daemon/report.js";

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

/**
 * Basic eval summary line for human status (#157): score/baseline/version when
 * a structured rubric eval is present; legacy free-score rows show score only.
 */
function formatEvalLine(task: TaskRow): string | null {
  if (task.eval_score === null || task.eval_score === undefined) return null;
  if (task.eval_rubric != null && task.eval_rubric_version != null) {
    const baseline =
      task.eval_baseline !== null && task.eval_baseline !== undefined
        ? String(task.eval_baseline)
        : "?";
    return `eval: score=${task.eval_score} baseline=${baseline} rubric=${task.eval_rubric}@v${task.eval_rubric_version}`;
  }
  // Historical free-score row (pre-#157) — score remains displayable.
  return `eval: score=${task.eval_score} (legacy)`;
}

/** Present a task row for `--json` output: JSON columns become objects. */
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
 * `parley status [task] [--json] [--session <id>] [--all]` (and its `parley
 * list` alias). Auto-spawns the daemon, fetches the task table over the CLI
 * plane, and renders it. A task reference may be a short id or a `--name`
 * label — a targeted lookup that bypasses session filtering. With no ref, the
 * listing narrows to one orchestrator session: `--session <id>` (or `latest`),
 * else `PARLEY_SESSION_ID` from the environment, else the most-recently-used
 * session. `--all` shows every task. Exits 0 with an empty listing when no
 * tasks match.
 */
export async function runStatus(ctx: CliContext, args: string[]): Promise<number> {
  const { positionals, flags } = parseArgs(args, {
    "--json": {},
    "--session": { value: true },
    "--all": {},
  });
  const ref = positionals[0];
  const json = flags["--json"] === true;
  const all = flags["--all"] === true;
  const sessionFlag = typeof flags["--session"] === "string" ? flags["--session"] : undefined;

  const discovery = await ensureDaemon(ctx.paths, ctx.env);
  const { tasks } = await daemonGet<TasksResponse>(discovery, "/tasks");

  let filtered: TaskRow[];
  if (ref) {
    filtered = tasks.filter((t) => t.id === ref || t.name === ref);
  } else if (all) {
    filtered = tasks;
  } else {
    const session = resolveSessionFilter(sessionFlag, ctx.env, tasks);
    filtered =
      session === undefined
        ? tasks
        : tasks.filter((t) => t.orchestrator_session_id === session);
  }

  if (json) {
    const presented = filtered.map(presentRow);
    printJson(ctx, ref ? (presented[0] ?? null) : presented);
  } else {
    renderTable(ctx, filtered);
    // Single-task status: surface a basic eval line (score/baseline/version).
    if (ref && filtered.length === 1) {
      const line = formatEvalLine(filtered[0]!);
      if (line !== null) ctx.stdout(`${line}\n`);
    }
  }
  return 0;
}
