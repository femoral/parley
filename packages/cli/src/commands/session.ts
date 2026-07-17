/**
 * `parley session --harness/-v <h> --model/-m <m> --effort/-e <e> [--session/-s <id>]`
 *
 * Registers the orchestrating session (#162). All three provenance values are
 * required (free-form, lowercased by the daemon for grouping). Without `-s` a
 * fresh id is generated and printed; known `-s` re-anchors after crash/restart
 * and applies provenance updates; unknown `-s` errors.
 */
import { parseArgs } from "../args.js";
import { readLiveAncestryChain, resolveWorkspaceRoot } from "../ancestry.js";
import { DaemonRequestError, daemonPost, ensureDaemon } from "../client.js";
import { type CliContext, printJson } from "../context.js";
import { UsageError } from "../errors.js";

interface SessionAck {
  session_id: string;
  harness: string;
  model: string;
  effort: string;
  workspace_root: string;
  created_at: string;
  updated_at: string;
}

export async function runSession(ctx: CliContext, args: string[]): Promise<number> {
  const { positionals, flags } = parseArgs(args, {
    "--harness": { aliases: ["-v"], value: true },
    "--model": { aliases: ["-m"], value: true },
    "--effort": { aliases: ["-e"], value: true },
    "--session": { aliases: ["-s"], value: true },
    "--json": {},
  });

  if (positionals.length > 0) {
    throw new UsageError(`session: unexpected argument: ${positionals[0]}`);
  }

  const harness = flags["--harness"];
  const model = flags["--model"];
  const effort = flags["--effort"];
  if (typeof harness !== "string" || harness.trim() === "") {
    throw new UsageError("session: --harness/-v is required");
  }
  if (typeof model !== "string" || model.trim() === "") {
    throw new UsageError("session: --model/-m is required");
  }
  if (typeof effort !== "string" || effort.trim() === "") {
    throw new UsageError("session: --effort/-e is required");
  }

  const sessionId =
    typeof flags["--session"] === "string" && flags["--session"] !== ""
      ? (flags["--session"] as string)
      : null;

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
