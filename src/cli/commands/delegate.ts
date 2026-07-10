import fs from "node:fs";
import { parseArgs } from "../args.js";
import { DaemonRequestError, daemonPost, ensureDaemon } from "../client.js";
import { type CliContext, printJson } from "../context.js";
import { UsageError } from "../errors.js";
import { parseDuration } from "../../util/time.js";
import { waitForOutcome } from "../wait.js";

interface DelegateAck {
  task_id: string;
  name: string | null;
  state: string;
}

/**
 * `parley delegate [flags] "<prompt>"` — create a task; with `--wait`, block on
 * the task's event stream and return the first outcome: a question (exit 3 with
 * `{task_id, name, question_id, question}`) or a terminal state (report envelope
 * + its typed code). See `waitForOutcome` for the shared blocking contract.
 */
export async function runDelegate(ctx: CliContext, args: string[]): Promise<number> {
  const { positionals, flags } = parseArgs(args, {
    "--vendor": { aliases: ["-v"], value: true },
    "--model": { aliases: ["-m"], value: true },
    "--name": { aliases: ["-n"], value: true },
    "--cwd": { value: true },
    "--wait": {},
    "--json": {},
    "--answer-timeout": { value: true },
  });

  let prompt = positionals[0];
  if (prompt === "-") prompt = fs.readFileSync(0, "utf8");
  if (prompt === undefined || prompt.trim() === "") {
    throw new UsageError('delegate: a prompt is required (use "-" to read stdin)');
  }
  if (positionals.length > 1) {
    throw new UsageError(`delegate: unexpected argument: ${positionals[1]}`);
  }
  const vendor = flags["--vendor"];
  if (typeof vendor !== "string") {
    throw new UsageError("delegate: a vendor is required (-v/--vendor)");
  }
  // An unanswered question at this timeout stalls the task (spec §2). Omitted
  // means the daemon default (30m).
  let answerTimeoutMs: number | null = null;
  const timeoutFlag = flags["--answer-timeout"];
  if (typeof timeoutFlag === "string") {
    const parsed = parseDuration(timeoutFlag);
    if (parsed === null || parsed <= 0) {
      throw new UsageError(
        `delegate: invalid --answer-timeout: ${timeoutFlag} (expected e.g. 30m, 90s, 250ms)`,
      );
    }
    answerTimeoutMs = parsed;
  }

  const discovery = await ensureDaemon(ctx.paths, ctx.env);
  let ack: DelegateAck;
  try {
    ack = await daemonPost<DelegateAck>(discovery, "/tasks", {
      prompt,
      vendor,
      model: flags["--model"] ?? null,
      name: flags["--name"] ?? null,
      cwd: flags["--cwd"] ?? process.cwd(),
      answer_timeout_ms: answerTimeoutMs,
    });
  } catch (err) {
    // Daemon-side request rejections (unknown vendor, bad cwd) are usage errors.
    if (err instanceof DaemonRequestError && err.status === 400) {
      throw new UsageError(`delegate: ${err.message}`);
    }
    throw err;
  }

  if (flags["--wait"] !== true) {
    printJson(ctx, ack);
    return 0;
  }

  return waitForOutcome(ctx, discovery, ack.task_id);
}
