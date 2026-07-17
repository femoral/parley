import path from "node:path";
import { parseArgs } from "../args.js";
import { DaemonRequestError, daemonGet, ensureDaemon } from "../client.js";
import { type CliContext, printJson } from "../context.js";
import { UsageError } from "../errors.js";

interface InfoBody {
  prose: string;
  config: unknown;
}

/**
 * `parley info [--json]` — print the project's effective configuration as
 * orchestrator-facing prose, or the structured config the prose was rendered
 * from (#163). The CLI always sends the absolute project root so local and
 * remote daemons resolve the same workspace.
 */
export async function runInfo(ctx: CliContext, args: string[]): Promise<number> {
  const { positionals, flags } = parseArgs(args, { "--json": {} });

  if (positionals.length > 0) {
    throw new UsageError(`info: unexpected argument: ${positionals[0]}`);
  }

  const project = path.resolve(process.cwd());
  const params = new URLSearchParams();
  params.set("project", project);

  const discovery = await ensureDaemon(ctx.paths, ctx.env);
  let body: InfoBody;
  try {
    body = await daemonGet<InfoBody>(discovery, `/info?${params.toString()}`);
  } catch (err) {
    if (err instanceof DaemonRequestError && err.status === 400) {
      throw new Error(`info: ${err.message}`);
    }
    throw err;
  }

  if (flags["--json"] === true) {
    printJson(ctx, body.config);
  } else {
    const text =
      body.prose.endsWith("\n") || body.prose === "" ? body.prose : `${body.prose}\n`;
    ctx.stdout(text);
  }
  return 0;
}
