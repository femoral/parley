/**
 * `parley run <verb> <run>` — gate / block verbs (ADR-0017 / #238).
 *
 * A gate is never acked, only actioned. Four verbs:
 *   approve / reject / redirect / finish
 *
 * Redirect requires `--to <node>`; optional `--note` becomes an
 * `## Orchestrator note` on the entry task (shared with #242).
 */
import { parseArgs } from "../args.js";
import { DaemonRequestError, daemonPost, ensureDaemon } from "../client.js";
import { type CliContext, printJson } from "../context.js";
import { UsageError } from "../errors.js";

const VERBS = ["approve", "reject", "redirect", "finish"] as const;
type Verb = (typeof VERBS)[number];

function isVerb(value: string): value is Verb {
  return (VERBS as readonly string[]).includes(value);
}

interface RunVerbAck {
  run_id: string;
  state: string;
  current_node: string | null;
  iteration: number;
  decision: unknown;
  error: string | null;
}

/**
 * `parley run approve|reject|redirect|finish <run> [flags]`
 */
export async function runRun(ctx: CliContext, args: string[]): Promise<number> {
  const { positionals, flags } = parseArgs(args, {
    "--json": {},
    "--to": { value: true },
    "--note": { value: true },
  });

  const verbRaw = positionals[0];
  if (verbRaw === undefined) {
    throw new UsageError(
      "run: a verb is required (approve | reject | redirect | finish)",
    );
  }
  if (!isVerb(verbRaw)) {
    throw new UsageError(
      `run: unknown verb "${verbRaw}" (expected approve | reject | redirect | finish)`,
    );
  }
  const verb: Verb = verbRaw;

  const runId = positionals[1];
  if (runId === undefined) {
    throw new UsageError(`run ${verb}: a run id is required`);
  }
  if (positionals.length > 2) {
    throw new UsageError(`run ${verb}: unexpected argument: ${positionals[2]}`);
  }

  const to = typeof flags["--to"] === "string" ? flags["--to"] : null;
  const note = typeof flags["--note"] === "string" ? flags["--note"] : null;

  if (verb === "redirect" && (to === null || to === "")) {
    throw new UsageError("run redirect: --to <node> is required");
  }
  if (verb !== "redirect" && to !== null) {
    throw new UsageError(`run ${verb}: --to is only valid with redirect`);
  }

  const discovery = await ensureDaemon(ctx.paths, ctx.env);
  let ack: RunVerbAck;
  try {
    ack = await daemonPost<RunVerbAck>(
      discovery,
      `/runs/${encodeURIComponent(runId)}/${verb}`,
      {
        to,
        note,
      },
    );
  } catch (err) {
    if (err instanceof DaemonRequestError && (err.status === 400 || err.status === 404)) {
      throw new UsageError(`run ${verb}: ${err.message}`);
    }
    throw err;
  }

  if (flags["--json"] === true) {
    printJson(ctx, ack);
  } else {
    const node = ack.current_node ?? "—";
    ctx.stdout(
      `Run ${ack.run_id} ${verb} → ${ack.state}  node=${node}  iteration=${ack.iteration}\n`,
    );
  }
  return 0;
}
