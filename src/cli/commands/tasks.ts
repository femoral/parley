import { type CliContext, printJson } from "../context.js";
import { daemonGet, ensureDaemon } from "../client.js";
import type { TaskRow } from "../../daemon/db.js";

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

/**
 * `parley status [task] [--json]` (and its `parley list` alias). Auto-spawns the
 * daemon, fetches the task table over the CLI plane, and renders it. Exits 0
 * with an empty listing when no tasks exist.
 */
export async function runStatus(
  ctx: CliContext,
  taskId: string | undefined,
  json: boolean,
): Promise<number> {
  const discovery = await ensureDaemon(ctx.paths, ctx.env);
  const { tasks } = await daemonGet<TasksResponse>(discovery, "/tasks");
  const filtered = taskId ? tasks.filter((t) => t.id === taskId || t.name === taskId) : tasks;

  if (json) {
    printJson(ctx, filtered);
  } else {
    renderTable(ctx, filtered);
  }
  return 0;
}
