import { parseArgs } from "../args.js";
import { type CliContext, printJson } from "../context.js";
import { daemonGet, ensureDaemon } from "../client.js";
import type { TaskRow } from "../../daemon/db.js";
import { parseJsonColumn } from "../../daemon/report.js";

interface TasksResponse {
  tasks: TaskRow[];
}

function renderTable(ctx: CliContext, tasks: TaskRow[]): void {
  if (tasks.length === 0) {
    ctx.stdout("No tasks.\n");
    return;
  }
  const header = ["ID", "NAME", "VENDOR", "MODEL", "STATE"];
  const rows = tasks.map((t) => [
    t.id,
    t.name ?? "-",
    t.vendor ?? "-",
    t.model ?? "-",
    t.state,
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
  return { ...row, usage: parseJsonColumn(row.usage), report: parseJsonColumn(row.report) };
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
