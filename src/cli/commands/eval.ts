import { parseArgs } from "../args.js";
import { DaemonRequestError, daemonPost, ensureDaemon } from "../client.js";
import { type CliContext, printJson } from "../context.js";
import { UsageError } from "../errors.js";

interface EvalAck {
  task_id: string;
  name: string | null;
  state: string;
}

/**
 * `parley eval <task> --score <1-10> --feedback "<text>"` — record an
 * orchestrator's quality score and feedback against a task, symmetric with
 * `parley answer`. A later call overwrites the previous score/feedback.
 *
 * `--score` must be an integer 1-10; out-of-range, non-integer, or a missing
 * `--score`/`--feedback` is a usage error (exit 2), same posture as
 * `delegate`'s flag validation. An unknown task ref is also a usage error.
 */
export async function runEval(ctx: CliContext, args: string[]): Promise<number> {
  const { positionals, flags } = parseArgs(args, {
    "--score": { value: true },
    "--feedback": { value: true },
    "--json": {},
  });

  const ref = positionals[0];
  if (ref === undefined) {
    throw new UsageError("eval: a task (id or name) is required");
  }
  if (positionals.length > 1) {
    throw new UsageError(`eval: unexpected argument: ${positionals[1]}`);
  }

  const scoreFlag = flags["--score"];
  if (typeof scoreFlag !== "string") {
    throw new UsageError("eval: a score is required (--score <1-10>)");
  }
  const score = Number(scoreFlag);
  if (!Number.isInteger(score) || score < 1 || score > 10) {
    throw new UsageError(`eval: --score must be an integer between 1 and 10, got: ${scoreFlag}`);
  }

  const feedback = flags["--feedback"];
  if (typeof feedback !== "string" || feedback === "") {
    throw new UsageError('eval: feedback is required (--feedback "<text>")');
  }

  const discovery = await ensureDaemon(ctx.paths, ctx.env);
  let ack: EvalAck;
  try {
    ack = await daemonPost<EvalAck>(discovery, `/tasks/${encodeURIComponent(ref)}/eval`, {
      score,
      feedback,
    });
  } catch (err) {
    // No such task is a caller mistake (exit 2).
    if (err instanceof DaemonRequestError && (err.status === 400 || err.status === 404)) {
      throw new UsageError(`eval: ${err.message}`);
    }
    throw err;
  }

  printJson(ctx, ack);
  return 0;
}
