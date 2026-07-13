import { parseArgs } from "../args.js";
import { DaemonRequestError, daemonPost, ensureDaemon } from "../client.js";
import { type CliContext, printJson } from "../context.js";
import { UsageError } from "../errors.js";

interface CleanOneResult {
  task_id: string;
  worktree: string | null;
  removed: boolean;
}

interface CleanAllResult {
  cleaned: { task_id: string; worktree: string }[];
  failed: { task_id: string; worktree: string; error: string }[];
}

/**
 * `parley clean <task> | --all-terminal` — remove parley worktrees, keeping
 * their branches (parley never merges). Cleaning a single task refuses a task
 * that is still running; `--all-terminal` sweeps only terminal-state tasks.
 */
export async function runClean(ctx: CliContext, args: string[]): Promise<number> {
  const { positionals, flags } = parseArgs(args, {
    "--all-terminal": {},
    "--json": {},
  });
  const all = flags["--all-terminal"] === true;
  const ref = positionals[0];
  const json = flags["--json"] === true;

  if (all && ref !== undefined) {
    throw new UsageError("clean: pass a task or --all-terminal, not both");
  }
  if (!all && ref === undefined) {
    throw new UsageError("usage: parley clean <task> | --all-terminal");
  }
  if (positionals.length > 1) {
    throw new UsageError(`clean: unexpected argument: ${positionals[1]}`);
  }

  const discovery = await ensureDaemon(ctx.paths, ctx.env);
  try {
    if (all) {
      const result = await daemonPost<CleanAllResult>(discovery, "/clean", {
        all_terminal: true,
      });
      if (json) {
        printJson(ctx, result);
      } else {
        if (result.cleaned.length === 0 && result.failed.length === 0) {
          ctx.stdout("No worktrees to clean.\n");
        } else if (result.cleaned.length > 0) {
          ctx.stdout(
            `Removed ${result.cleaned.length} worktree(s): ${result.cleaned
              .map((c) => c.task_id)
              .join(", ")}\n`,
          );
        }
        for (const f of result.failed) {
          ctx.stderr(`clean: ${f.task_id} failed: ${f.error}\n`);
        }
      }
      return result.failed.length > 0 ? 1 : 0;
    } else {
      const result = await daemonPost<CleanOneResult>(discovery, "/clean", { task: ref });
      if (json) printJson(ctx, result);
      else if (result.removed) ctx.stdout(`Removed worktree for ${result.task_id}.\n`);
      else ctx.stdout(`${result.task_id} has no worktree to clean.\n`);
    }
    return 0;
  } catch (err) {
    // Refusals (running task, unknown ref) are usage errors → exit 2.
    if (err instanceof DaemonRequestError && err.status === 400) {
      throw new UsageError(`clean: ${err.message}`);
    }
    throw err;
  }
}
