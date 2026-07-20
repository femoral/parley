/**
 * `parley session [--session/-s <id>] [--json]`
 *
 * Registers the orchestrating session (#162 / #190 / ADR-0013). Harness,
 * model, and effort come only from env vars (`PARLEY_HARNESS`,
 * `PARLEY_MODEL`, `PARLEY_EFFORT`) — missing values store as honest nulls.
 * The removed `-m/--model` and `-e/--effort` flags error with a pointer at
 * the env-var/plugin mechanism. Session id resolution is env-first:
 * `PARLEY_SESSION_ID` > `--session` > fresh id.
 */
import { parseArgs } from "../args.js";
import { readLiveAncestryChain, resolveWorkspaceRoot } from "../ancestry.js";
import { DaemonRequestError, daemonPost, ensureDaemon } from "../client.js";
import { type CliContext, printJson } from "../context.js";
import { UsageError } from "../errors.js";

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

/** Non-empty env string, or null when unset/blank. */
function envProvenance(env: NodeJS.ProcessEnv, key: string): string | null {
  const raw = env[key];
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Session id for registration: `PARLEY_SESSION_ID` > `--session` > null
 * (daemon allocates a fresh id). Supersedes the pre-#190 flag-first order.
 */
function resolveRegisterSessionId(
  flagSession: string | null,
  env: NodeJS.ProcessEnv,
): string | null {
  const fromEnv = envProvenance(env, "PARLEY_SESSION_ID");
  if (fromEnv !== null) return fromEnv;
  return flagSession;
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

  // Env-only provenance (#190): never invent defaults for missing values.
  const harness = envProvenance(ctx.env, "PARLEY_HARNESS");
  const model = envProvenance(ctx.env, "PARLEY_MODEL");
  const effort = envProvenance(ctx.env, "PARLEY_EFFORT");

  const flagSession =
    typeof flags["--session"] === "string" && flags["--session"] !== ""
      ? (flags["--session"] as string)
      : null;
  const sessionId = resolveRegisterSessionId(flagSession, ctx.env);

  // Anchor is the registering process itself (deepest match later binds
  // children whose chain includes this process). Chain[0] is self.
  const chain = readLiveAncestryChain(ctx.env);
  const anchor = chain[0];
  if (anchor === undefined) {
    throw new UsageError("session: could not determine process ancestry anchor");
  }

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
