import { parseArgs } from "../args.js";
import { daemonPost, ensureDaemon } from "../client.js";
import { type CliContext, printJson } from "../context.js";
import { UsageError } from "../errors.js";

interface GcTaskEntry {
  task_id: string;
  state: string;
  completed_at: string | null;
  bytes: number;
  worktree: string | null;
}

interface GcResult {
  dry_run: boolean;
  removed: number;
  freed_bytes: number;
  tasks: GcTaskEntry[];
  failed: { task_id: string; error: string }[];
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
}

/**
 * `parley gc [--dry-run]` — retention sweep for expired terminal tasks (#153).
 * Removes task rows (evals), logs, report envelopes, and leftover worktrees;
 * never touches git branches or non-terminal tasks. `--dry-run` lists without
 * deleting. Complements `parley clean` (targeted/immediate worktree removal).
 */
export async function runGc(ctx: CliContext, args: string[]): Promise<number> {
  const { positionals, flags } = parseArgs(args, {
    "--dry-run": {},
    "--json": {},
  });
  if (positionals.length > 0) {
    throw new UsageError(`gc: unexpected argument: ${positionals[0]}`);
  }
  const dryRun = flags["--dry-run"] === true;
  const json = flags["--json"] === true;

  const discovery = await ensureDaemon(ctx.paths, ctx.env);
  const result = await daemonPost<GcResult>(discovery, "/gc", { dry_run: dryRun });

  if (json) {
    printJson(ctx, result);
  } else if (dryRun) {
    if (result.removed === 0) {
      ctx.stdout("No expired tasks.\n");
    } else {
      ctx.stdout(
        `Would remove ${result.removed} task(s), freeing ~${formatBytes(result.freed_bytes)}:\n`,
      );
      for (const t of result.tasks) {
        ctx.stdout(
          `  ${t.task_id}  ${t.state}  ${t.completed_at ?? "?"}  ~${formatBytes(t.bytes)}\n`,
        );
      }
    }
  } else if (result.removed === 0 && result.failed.length === 0) {
    ctx.stdout("No expired tasks.\n");
  } else {
    if (result.removed > 0) {
      ctx.stdout(
        `Removed ${result.removed} task(s), freed ~${formatBytes(result.freed_bytes)}.\n`,
      );
    }
    for (const f of result.failed) {
      ctx.stderr(`gc: ${f.task_id} failed: ${f.error}\n`);
    }
  }

  return result.failed.length > 0 ? 1 : 0;
}
