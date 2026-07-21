/**
 * `parley session [--session/-s <id>] [--json]`
 *
 * Registers the orchestrating session (#162 / #190 / #196 / ADR-0013).
 * Harness, model, and effort: env vars (`PARLEY_HARNESS` / `PARLEY_MODEL` /
 * `PARLEY_EFFORT`) > ancestry-matched session-state file > null (honest
 * unknown). The removed `-m/--model` and `-e/--effort` flags error with a
 * pointer at the env-var/plugin mechanism. Session id resolution:
 * `PARLEY_SESSION_ID` > `--session` > state-file `harness_session_id` > fresh id.
 */
import { parseArgs } from "../args.js";
import { readLiveAncestryChain, resolveWorkspaceRoot } from "../ancestry.js";
import { DaemonRequestError, daemonPost, ensureDaemon } from "../client.js";
import { type CliContext, printJson } from "../context.js";
import { UsageError } from "../errors.js";
import {
  resolveMatchedSessionState,
  resolveOrchestratorSessionId,
  resolveProvenanceFromEnvAndState,
} from "../session-state-match.js";

interface SessionAck {
  session_id: string;
  harness: string | null;
  model: string | null;
  effort: string | null;
  workspace_root: string;
  created_at: string;
  updated_at: string;
}

/** Message when a removed provenance flag is passed (#190). */
export function removedProvenanceFlagMessage(flag: string): string {
  return (
    `session: ${flag} was removed; set PARLEY_HARNESS / PARLEY_MODEL / ` +
    `PARLEY_EFFORT via a harness plugin (ADR-0013), or omit them for ` +
    `unknown provenance`
  );
}

/**
 * Reject removed `-m/--model` and `-e/--effort` (and the former harness
 * flags) with a teaching message before generic unknown-flag handling.
 */
function rejectRemovedProvenanceFlags(args: string[]): void {
  for (const arg of args) {
    if (arg === "-" || !arg.startsWith("-")) continue;
    // Stop at `--` if ever used; session has no positionals that need it.
    if (arg === "--") break;
    const bare = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
    if (
      bare === "-m" ||
      bare === "--model" ||
      bare === "-e" ||
      bare === "--effort" ||
      bare === "-v" ||
      bare === "--harness"
    ) {
      throw new UsageError(removedProvenanceFlagMessage(bare));
    }
  }
}

export async function runSession(ctx: CliContext, args: string[]): Promise<number> {
  rejectRemovedProvenanceFlags(args);

  const { positionals, flags } = parseArgs(args, {
    "--session": { aliases: ["-s"], value: true },
    "--json": {},
  });

  if (positionals.length > 0) {
    throw new UsageError(`session: unexpected argument: ${positionals[0]}`);
  }

  // Chain[0] is self — also used as the registration anchor.
  const chain = readLiveAncestryChain(ctx.env);
  const anchor = chain[0];
  if (anchor === undefined) {
    throw new UsageError("session: could not determine process ancestry anchor");
  }

  const note = (msg: string): void => {
    ctx.stderr(`note: ${msg}\n`);
  };

  // Session-state fallback when env is incomplete (#196).
  const matched = resolveMatchedSessionState({
    parleyHome: ctx.paths.home,
    ancestryChain: chain,
    note,
  });

  const { harness, model, effort } = resolveProvenanceFromEnvAndState(
    ctx.env,
    matched,
  );

  const flagSession =
    typeof flags["--session"] === "string" && flags["--session"] !== ""
      ? (flags["--session"] as string)
      : null;
  // Track whether the id came from env/state (plugin-owned, create-if-missing)
  // vs --session alone (re-anchor only — unknown id is a usage error).
  const fromEnv =
    typeof ctx.env.PARLEY_SESSION_ID === "string" &&
    ctx.env.PARLEY_SESSION_ID.trim() !== "";
  const fromState =
    !fromEnv &&
    flagSession === null &&
    matched !== null &&
    matched.harness_session_id.trim() !== "";
  const sessionId = resolveOrchestratorSessionId({
    envSessionId: ctx.env.PARLEY_SESSION_ID,
    flagSessionId: flagSession,
    stateSessionId: matched?.harness_session_id ?? null,
  });
  const createIfMissing = fromEnv || fromState;

  const workspaceRoot = resolveWorkspaceRoot(process.cwd());
  const discovery = await ensureDaemon(ctx.paths, ctx.env);
  let ack: SessionAck;
  try {
    ack = await daemonPost<SessionAck>(discovery, "/sessions", {
      harness,
      model,
      effort,
      workspace_root: workspaceRoot,
      anchor,
      ...(sessionId !== null ? { session_id: sessionId } : {}),
      ...(createIfMissing ? { create_if_missing: true } : {}),
    });
  } catch (err) {
    if (err instanceof DaemonRequestError && err.status === 400) {
      throw new UsageError(`session: ${err.message}`);
    }
    throw err;
  }

  if (flags["--json"] === true) {
    printJson(ctx, ack);
  } else {
    // Print the id so orchestrators can export PARLEY_SESSION_ID or re-anchor.
    ctx.stdout(`${ack.session_id}\n`);
  }
  return 0;
}
