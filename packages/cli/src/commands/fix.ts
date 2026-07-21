import fs from "node:fs";
import { parseArgs } from "../args.js";
import { readLiveAncestryChain, resolveWorkspaceRoot } from "../ancestry.js";
import { DaemonRequestError, daemonPost, ensureDaemon } from "../client.js";
import { type CliContext, printJson } from "../context.js";
import { UsageError } from "../errors.js";
import { CODE_SESSION_REQUIRED } from "@useparley/daemon/session-binding.js";

interface FixAck {
  task_id: string;
  name: string | null;
  state: string;
  seq: number;
  parent_task_id: string | null;
  attempt: number;
  resumed: boolean;
}

/** CLI exit code for daemon `retry_limit_exceeded` (#158). */
export const EXIT_RETRY_LIMIT_EXCEEDED = 7;
/** CLI exit code for daemon `reattempt_window_expired` (#158). */
export const EXIT_REATTEMPT_WINDOW_EXPIRED = 8;

/**
 * `parley fix <task> "<fix brief>"` — create a linked attempt that inherits
 * the parent's classification/profile/workspace and resumes its vendor session
 * when `resume.enabled` is on (default). Returns immediately with the new
 * attempt's pending ack (ADR-0008); wait with `parley watch`.
 *
 * `--fresh` (#158) forces a blank session (uncapped by retry.max / window),
 * stays in the chain, and receives daemon-composed context.
 *
 * Launch-template profiles (#195 / ADR-0015) never compose resume: `parley fix`
 * on a template-profile task always behaves as `--fresh` (fresh argv from the
 * template; no vendor-session resume).
 */
export async function runFix(ctx: CliContext, args: string[]): Promise<number> {
  const { positionals, flags } = parseArgs(args, {
    "--json": {},
    "--fresh": {},
    "--session": { value: true },
  });

  const ref = positionals[0];
  let prompt = positionals[1];
  if (ref === undefined) {
    throw new UsageError('usage: parley fix [--fresh] <task> "<fix brief>"');
  }
  if (prompt === "-") prompt = fs.readFileSync(0, "utf8");
  if (prompt === undefined || prompt.trim() === "") {
    throw new UsageError('fix: a fix brief is required (use "-" to read stdin)');
  }
  if (positionals.length > 2) {
    throw new UsageError(`fix: unexpected argument: ${positionals[2]}`);
  }

  const fresh = flags["--fresh"] === true;
  // Fix resolves orchestrator session fresh at its own spawn (#162 / #190).
  // Env-first: PARLEY_SESSION_ID > --session > ancestry.
  const sessionFlag = flags["--session"];
  const orchestratorSessionId =
    typeof ctx.env.PARLEY_SESSION_ID === "string" && ctx.env.PARLEY_SESSION_ID !== ""
      ? ctx.env.PARLEY_SESSION_ID
      : typeof sessionFlag === "string" && sessionFlag !== ""
        ? sessionFlag
        : null;
  const ancestryChain = readLiveAncestryChain(ctx.env);
  const workspaceRoot = resolveWorkspaceRoot(process.cwd());

  const discovery = await ensureDaemon(ctx.paths, ctx.env);
  let ack: FixAck;
  try {
    const body: Record<string, unknown> = {
      prompt,
      ancestry_chain: ancestryChain,
      workspace_root: workspaceRoot,
      ...(fresh ? { fresh: true } : {}),
    };
    if (orchestratorSessionId !== null) {
      body.orchestrator_session_id = orchestratorSessionId;
    }
    ack = await daemonPost<FixAck>(
      discovery,
      `/tasks/${encodeURIComponent(ref)}/fix`,
      body,
    );
  } catch (err) {
    if (err instanceof DaemonRequestError && err.status === 400) {
      // Distinct exit codes for retry gates so agent orchestrators can branch
      // without parsing prose (#158).
      if (err.code === "retry_limit_exceeded") {
        ctx.stderr(`error: ${err.message}\n`);
        return EXIT_RETRY_LIMIT_EXCEEDED;
      }
      if (err.code === "reattempt_window_expired") {
        ctx.stderr(`error: ${err.message}\n`);
        return EXIT_REATTEMPT_WINDOW_EXPIRED;
      }
      if (err.code === CODE_SESSION_REQUIRED) {
        throw new UsageError(`fix: ${err.message}`);
      }
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
