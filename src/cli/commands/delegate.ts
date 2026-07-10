import fs from "node:fs";
import { parseArgs } from "../args.js";
import { DaemonRequestError, daemonPost, ensureDaemon } from "../client.js";
import { type CliContext, printJson } from "../context.js";
import { UsageError } from "../errors.js";
import { waitForOutcome } from "../wait.js";
import { DEFAULT_SANDBOX, SANDBOX_MODES, isSandboxMode } from "../../daemon/adapters/types.js";

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
    "--base-ref": { value: true },
    "--sandbox": { value: true },
    "--no-network": {},
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

  // `--cwd` runs the child directly in that directory (no worktree). Its
  // absence is the default path: parley cuts an isolated worktree from the
  // repo the caller is in, which the daemon detects at the invocation cwd.
  const explicitCwd = typeof flags["--cwd"] === "string";
  const cwd = explicitCwd ? (flags["--cwd"] as string) : process.cwd();

  // Sandbox posture (spec §8, ADR-0006): default workspace + network on. An
  // unknown mode is a usage error (exit 2), caught before the daemon is asked.
  const sandbox = typeof flags["--sandbox"] === "string" ? flags["--sandbox"] : DEFAULT_SANDBOX;
  if (!isSandboxMode(sandbox)) {
    throw new UsageError(
      `delegate: unknown sandbox mode: ${sandbox} (expected ${SANDBOX_MODES.join("|")})`,
    );
  }
  const network = flags["--no-network"] !== true;

  const discovery = await ensureDaemon(ctx.paths, ctx.env);
  let ack: DelegateAck;
  try {
    ack = await daemonPost<DelegateAck>(discovery, "/tasks", {
      prompt,
      vendor,
      model: flags["--model"] ?? null,
      name: flags["--name"] ?? null,
      cwd,
      use_worktree: !explicitCwd,
      base_ref: flags["--base-ref"] ?? null,
      sandbox,
      network,
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
