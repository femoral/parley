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

interface GcRunEntry {
  run_id: string;
  state: string;
  completed_at: string | null;
  workspace: string;
  scratch: string | null;
  bytes: number;
  /** Task-less deliverables decayed (or that would decay); present from #250. */
  decayed_deliverables?: number;
}

interface GcResult {
  dry_run: boolean;
  removed: number;
  freed_bytes: number;
  tasks: GcTaskEntry[];
  /** Present from #244; older daemons may omit — treat as []. */
  runs?: GcRunEntry[];
  failed: { task_id?: string; run_id?: string; error: string }[];
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
}

function failedLabel(f: { task_id?: string; run_id?: string }): string {
  if (f.task_id !== undefined && f.task_id !== "") return f.task_id;
  if (f.run_id !== undefined && f.run_id !== "") return f.run_id;
  return "?";
}

/**
 * `parley gc [--dry-run]` — retention sweep for expired terminal tasks (#153)
 * and decayed runs (#244). Removes task rows (evals), logs, report envelopes,
 * and leftover worktrees; stamps run `purged_at`, purges non-declared
 * deliverable payloads, and deletes scratch subtrees. Never touches git
 * branches or non-terminal tasks/runs. `--dry-run` lists without deleting.
 * Complements `parley clean` (targeted/immediate worktree removal).
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
  const runs = result.runs ?? [];

  if (json) {
    printJson(ctx, result);
  } else if (dryRun) {
    if (result.removed === 0 && runs.length === 0) {
      // Keep the #153 phrasing when nothing is pending (tests + muscle memory).
      ctx.stdout("No expired tasks.\n");
    } else {
      if (result.removed > 0) {
        const taskBytes = result.tasks.reduce((s, t) => s + t.bytes, 0);
        ctx.stdout(
          `Would remove ${result.removed} task(s), freeing ~${formatBytes(taskBytes)}:\n`,
        );
        for (const t of result.tasks) {
          ctx.stdout(
            `  ${t.task_id}  ${t.state}  ${t.completed_at ?? "?"}  ~${formatBytes(t.bytes)}\n`,
          );
        }
      }
      if (runs.length > 0) {
        const runBytes = runs.reduce((s, r) => s + r.bytes, 0);
        ctx.stdout(
          `Would purge ${runs.length} run(s), freeing ~${formatBytes(runBytes)}:\n`,
        );
        for (const r of runs) {
          const scratchNote =
            r.workspace === "scratch"
              ? r.scratch !== null
                ? `  scratch ${r.scratch}`
                : "  scratch (absent)"
              : "  (repo: branches kept)";
          const decayNote =
            typeof r.decayed_deliverables === "number" && r.decayed_deliverables > 0
              ? `  ${r.decayed_deliverables} deliverable(s)`
              : "";
          ctx.stdout(
            `  ${r.run_id}  ${r.state}  ${r.workspace}  ${r.completed_at ?? "?"}  ~${formatBytes(r.bytes)}${scratchNote}${decayNote}\n`,
          );
        }
      }
    }
  } else if (
    result.removed === 0 &&
    runs.length === 0 &&
    result.failed.length === 0
  ) {
    ctx.stdout("No expired tasks.\n");
  } else {
    // Task-only success keeps the #153 "Removed N task(s)" shape.
    if (result.removed > 0 && runs.length === 0) {
      ctx.stdout(
        `Removed ${result.removed} task(s), freed ~${formatBytes(result.freed_bytes)}.\n`,
      );
    } else if (result.removed > 0 || runs.length > 0) {
      const parts: string[] = [];
      if (result.removed > 0) parts.push(`${result.removed} task(s)`);
      if (runs.length > 0) parts.push(`${runs.length} run(s)`);
      ctx.stdout(
        `Purged ${parts.join(" and ")}, freed ~${formatBytes(result.freed_bytes)}.\n`,
      );
    }
    for (const f of result.failed) {
      ctx.stderr(`gc: ${failedLabel(f)} failed: ${f.error}\n`);
    }
  }

  return result.failed.length > 0 ? 1 : 0;
}
