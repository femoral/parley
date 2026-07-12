import { parseArgs } from "../args.js";
import { type CliContext, printJson } from "../context.js";
import { daemonGet, ensureDaemon } from "../client.js";
import type { TaskRow } from "../../daemon/db.js";
import { parseJsonColumn } from "../../daemon/report.js";

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

function renderTable(ctx: CliContext, tasks: TaskRow[]): void {
  if (tasks.length === 0) {
    ctx.stdout("No tasks.\n");
    return;
  }
  const header = ["ID", "NAME", "VENDOR", "MODEL", "STATE", "USAGE", "DURATION"];
  const rows = tasks.map((t) => [
    t.id,
    t.name ?? "-",
    t.vendor ?? "-",
    t.model ?? "-",
    t.state,
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

/** Present a task row for `--json` output: JSON columns become objects. */
function presentRow(row: TaskRow): Record<string, unknown> {
  return {
    ...row,
    usage: parseJsonColumn(row.usage),
    report: parseJsonColumn(row.report),
    // `network` is stored as SQLite 0/1; surface it as a boolean.
    network: row.network === 1,
  };
}

/**
 * `parley status [task] [--json]` (and its `parley list` alias). Auto-spawns the
 * daemon, fetches the task table over the CLI plane, and renders it. A task
 * reference may be a short id or a `--name` label. Exits 0 with an empty
 * listing when no tasks exist.
 */
export async function runStatus(ctx: CliContext, args: string[]): Promise<number> {
  const { positionals, flags } = parseArgs(args, { "--json": {} });
  const ref = positionals[0];
  const json = flags["--json"] === true;

  const discovery = await ensureDaemon(ctx.paths, ctx.env);
  const { tasks } = await daemonGet<TasksResponse>(discovery, "/tasks");
  const filtered = ref ? tasks.filter((t) => t.id === ref || t.name === ref) : tasks;

  if (json) {
    printJson(ctx, filtered.map(presentRow));
  } else {
    renderTable(ctx, filtered);
  }
  return 0;
}
