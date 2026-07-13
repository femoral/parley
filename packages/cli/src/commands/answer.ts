import fs from "node:fs";
import { parseArgs } from "../args.js";
import { DaemonRequestError, daemonPost, ensureDaemon } from "../client.js";
import { type CliContext, printJson } from "../context.js";
import { UsageError } from "../errors.js";
import { waitForOutcome } from "../wait.js";

interface AnswerAck {
  task_id: string;
  name: string | null;
  state: string;
}

/**
 * `parley answer <task> "<text>" [--wait]` — deliver an answer to a task's
 * outstanding `ask_orchestrator` question. The child unblocks with the text as
 * its tool result and the task returns to `running`. With `--wait`, re-enter the
 * blocking contract: return on the next question (exit 3) or terminal state.
 *
 * A task with no pending question (or an unknown ref) is a usage error (exit 2).
 */
export async function runAnswer(ctx: CliContext, args: string[]): Promise<number> {
  const { positionals, flags } = parseArgs(args, {
    "--wait": {},
    "--json": {},
  });

  const ref = positionals[0];
  if (ref === undefined) {
    throw new UsageError("answer: a task (id or name) is required");
  }
  let text = positionals[1];
  if (text === "-") text = fs.readFileSync(0, "utf8");
  if (text === undefined) {
    throw new UsageError('answer: answer text is required (use "-" to read stdin)');
  }
  if (positionals.length > 2) {
    throw new UsageError(`answer: unexpected argument: ${positionals[2]}`);
  }

  const discovery = await ensureDaemon(ctx.paths, ctx.env);
  let ack: AnswerAck;
  try {
    ack = await daemonPost<AnswerAck>(discovery, `/tasks/${encodeURIComponent(ref)}/answer`, {
      text,
    });
  } catch (err) {
    // No such task / no pending question are caller mistakes (exit 2).
    if (err instanceof DaemonRequestError && (err.status === 400 || err.status === 404)) {
      throw new UsageError(`answer: ${err.message}`);
    }
    throw err;
  }

  if (flags["--wait"] !== true) {
    printJson(ctx, ack);
    return 0;
  }

  return waitForOutcome(ctx, discovery, ack.task_id);
}
