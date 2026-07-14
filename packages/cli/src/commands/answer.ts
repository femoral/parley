import fs from "node:fs";
import { parseArgs } from "../args.js";
import { DaemonRequestError, daemonPost, ensureDaemon } from "../client.js";
import { type CliContext, printJson } from "../context.js";
import { UsageError } from "../errors.js";

interface AnswerAck {
  task_id: string;
  name: string | null;
  state: string;
}

/**
 * `parley answer <task> "<text>"` — deliver an answer to a task's outstanding
 * `ask_orchestrator` question. The child unblocks with the text as its tool
 * result and the task returns to `running`. Returns immediately with the ack
 * (ADR-0008); the next `parley watch` delivers whatever the resumed child does.
 * Passing the removed `--wait` flag is a usage error.
 *
 * A task with no pending question (or an unknown ref) is a usage error (exit 2).
 */
export async function runAnswer(ctx: CliContext, args: string[]): Promise<number> {
  const { positionals, flags } = parseArgs(args, {
    // Removed (ADR-0008); recognized only so the error points at `parley watch`.
    "--wait": {},
    "--json": {},
  });

  if (flags["--wait"] === true) {
    throw new UsageError(
      "answer: --wait is removed; use `parley watch` to wait on tasks (ADR-0008)",
    );
  }

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

  printJson(ctx, ack);
  return 0;
}
