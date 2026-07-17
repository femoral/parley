import path from "node:path";
import { parseArgs } from "../args.js";
import { DaemonRequestError, daemonGet, ensureDaemon } from "../client.js";
import { type CliContext, printJson } from "../context.js";
import { UsageError } from "../errors.js";

interface PromptBody {
  prompt: string;
}

/**
 * `parley prompt [--vendor <id>] [--profile <name>] [--orchestrator]` —
 * ask the daemon to render the exact composed prompt a child (or the
 * orchestrator) would receive from the current cwd (#159).
 *
 * Child mode: channel-matched protocol preamble + Operator instructions
 * (home/project vendor/profile PROMPT.md layers). Vendor or profile required.
 *
 * `--orchestrator`: compounded orchestrator PROMPT.md only (never injected
 * into children).
 */
export async function runPrompt(ctx: CliContext, args: string[]): Promise<number> {
  const { positionals, flags } = parseArgs(args, {
    "--vendor": { aliases: ["-v"], value: true },
    "--profile": { value: true },
    "--orchestrator": {},
    "--json": {},
  });

  if (positionals.length > 0) {
    throw new UsageError(`prompt: unexpected argument: ${positionals[0]}`);
  }

  const orchestrator = flags["--orchestrator"] === true;
  const vendor = typeof flags["--vendor"] === "string" ? flags["--vendor"] : null;
  const profile = typeof flags["--profile"] === "string" ? flags["--profile"] : null;

  if (!orchestrator && vendor === null && profile === null) {
    throw new UsageError(
      "prompt: --vendor or --profile is required (or pass --orchestrator)",
    );
  }

  // Project root = process cwd (resolved absolute). The daemon reads project
  // PROMPT.md layers from `<project>/.parley/...` and home layers from its own
  // home — so preview matches a spawn that used this workspace.
  const project = path.resolve(process.cwd());

  const params = new URLSearchParams();
  params.set("project", project);
  if (orchestrator) params.set("orchestrator", "1");
  if (vendor !== null) params.set("vendor", vendor);
  if (profile !== null) params.set("profile", profile);

  const discovery = await ensureDaemon(ctx.paths, ctx.env);
  let body: PromptBody;
  try {
    body = await daemonGet<PromptBody>(discovery, `/prompt?${params.toString()}`);
  } catch (err) {
    if (err instanceof DaemonRequestError && err.status === 400) {
      throw new Error(`prompt: ${err.message}`);
    }
    throw err;
  }

  if (flags["--json"] === true) {
    printJson(ctx, body);
  } else {
    const text = body.prompt.endsWith("\n") || body.prompt === "" ? body.prompt : `${body.prompt}\n`;
    ctx.stdout(text);
  }
  return 0;
}
