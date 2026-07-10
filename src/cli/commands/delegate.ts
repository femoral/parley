import fs from "node:fs";
import { parseArgs } from "../args.js";
import { DaemonRequestError, daemonGet, daemonPost, ensureDaemon } from "../client.js";
import { type CliContext, printJson } from "../context.js";
import { UsageError } from "../errors.js";
import type { Envelope } from "../../daemon/report.js";

/** The blocking contract's exit codes (spec §5). Only 0 and 2 are reachable
 *  in this ticket; the rest are wired so later tickets only add states. */
const EXIT_CODES: Record<string, number> = {
  completed: 0,
  failed: 1,
  awaiting_answer: 3,
  stalled: 4,
  cancelled: 5,
};

interface DelegateAck {
  task_id: string;
  name: string | null;
  state: string;
}

interface EventsResponse {
  event: string | null;
  task: Envelope;
}

/** How long each long-poll request may take; must exceed the daemon's window. */
const LONG_POLL_TIMEOUT_MS = 60_000;

/**
 * `parley delegate [flags] "<prompt>"` — create a task; with `--wait`, block
 * until it reaches a terminal state and print the report envelope, exiting
 * with the typed code for that state.
 */
export async function runDelegate(ctx: CliContext, args: string[]): Promise<number> {
  const { positionals, flags } = parseArgs(args, {
    "--vendor": { aliases: ["-v"], value: true },
    "--model": { aliases: ["-m"], value: true },
    "--name": { aliases: ["-n"], value: true },
    "--cwd": { value: true },
    "--wait": {},
    "--json": {},
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

  const discovery = await ensureDaemon(ctx.paths, ctx.env);
  let ack: DelegateAck;
  try {
    ack = await daemonPost<DelegateAck>(discovery, "/tasks", {
      prompt,
      vendor,
      model: flags["--model"] ?? null,
      name: flags["--name"] ?? null,
      cwd: flags["--cwd"] ?? process.cwd(),
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

  for (;;) {
    const { event, task } = await daemonGet<EventsResponse>(
      discovery,
      `/tasks/${encodeURIComponent(ack.task_id)}/events?wait=true`,
      LONG_POLL_TIMEOUT_MS,
    );
    if (event === null) continue; // poll window elapsed, task still live
    printJson(ctx, task);
    return EXIT_CODES[task.state] ?? 1;
  }
}
