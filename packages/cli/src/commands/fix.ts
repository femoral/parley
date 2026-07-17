import fs from "node:fs";
import { parseArgs } from "../args.js";
import { DaemonRequestError, daemonPost, ensureDaemon } from "../client.js";
import { type CliContext, printJson } from "../context.js";
import { UsageError } from "../errors.js";

interface FixAck {
  task_id: string;
  name: string | null;
  state: string;
  seq: number;
  parent_task_id: string | null;
  attempt: number;
  resumed: boolean;
}

/**
 * `parley fix <task> "<fix brief>"` — create a linked attempt that inherits
 * the parent's classification/profile/workspace and resumes its vendor session
 * when `resume.enabled` is on (default). Returns immediately with the new
 * attempt's pending ack (ADR-0008); wait with `parley watch`.
 */
export async function runFix(ctx: CliContext, args: string[]): Promise<number> {
  const { positionals, flags } = parseArgs(args, {
    "--json": {},
  });

  const ref = positionals[0];
  let prompt = positionals[1];
  if (ref === undefined) {
    throw new UsageError('usage: parley fix <task> "<fix brief>"');
  }
  if (prompt === "-") prompt = fs.readFileSync(0, "utf8");
  if (prompt === undefined || prompt.trim() === "") {
    throw new UsageError('fix: a fix brief is required (use "-" to read stdin)');
  }
  if (positionals.length > 2) {
    throw new UsageError(`fix: unexpected argument: ${positionals[2]}`);
  }

  const discovery = await ensureDaemon(ctx.paths, ctx.env);
  let ack: FixAck;
  try {
    ack = await daemonPost<FixAck>(discovery, `/tasks/${encodeURIComponent(ref)}/fix`, {
      prompt,
    });
  } catch (err) {
    if (err instanceof DaemonRequestError && err.status === 400) {
      throw new UsageError(`fix: ${err.message}`);
    }
    throw err;
  }

  // --json is the default shape for delegate/fix acks; honor the flag for
  // symmetry with other commands that also always print JSON.
  void flags;
  printJson(ctx, ack);
  return 0;
}
