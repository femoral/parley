import { parseArgs } from "../args.js";
import { DaemonRequestError, daemonPost, ensureDaemon } from "../client.js";
import { type CliContext, printJson } from "../context.js";
import { UsageError } from "../errors.js";

interface CancelAck {
  task_id: string;
  name: string | null;
  state: string;
}

/**
 * `parley cancel <task>` — terminate a task's vendor child and end the task
 * `cancelled`. Cancelled is terminal but not an inbox event (orchestrator-
 * caused); a subsequent `parley watch` treats it as settled for all-done.
 * The worktree and captured logs are retained (parley never merges). An
 * unknown ref or an already-terminal task is a usage error (exit 2).
 */
export async function runCancel(ctx: CliContext, args: string[]): Promise<number> {
  const { positionals, flags } = parseArgs(args, { "--json": {} });

  const ref = positionals[0];
  if (ref === undefined) {
    throw new UsageError("cancel: a task (id or name) is required");
  }
  if (positionals.length > 1) {
    throw new UsageError(`cancel: unexpected argument: ${positionals[1]}`);
  }

  const discovery = await ensureDaemon(ctx.paths, ctx.env);
  let ack: CancelAck;
  try {
    ack = await daemonPost<CancelAck>(discovery, `/tasks/${encodeURIComponent(ref)}/cancel`, {});
  } catch (err) {
    // Unknown ref / already-terminal task are caller mistakes (exit 2).
    if (err instanceof DaemonRequestError && (err.status === 400 || err.status === 404)) {
      throw new UsageError(`cancel: ${err.message}`);
    }
    throw err;
  }

  if (flags["--json"] === true) printJson(ctx, ack);
  else ctx.stdout(`Cancelled ${ack.task_id}.\n`);
  return 0;
}
