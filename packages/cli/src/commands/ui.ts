import { spawn } from "node:child_process";
import { parseArgs } from "../args.js";
import { daemonGet, ensureDaemon } from "../client.js";
import { type CliContext } from "../context.js";
import { UsageError } from "../errors.js";

interface HealthResponse {
  ui_available: boolean;
}

function openBrowser(url: string, env: NodeJS.ProcessEnv): Promise<void> {
  const command = process.platform === "darwin" ? "open" : "xdg-open";
  return new Promise((resolve, reject) => {
    const child = spawn(command, [url], { detached: true, env, stdio: "ignore" });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

/** Start or find the daemon, verify its UI, and print/open the cockpit URL. */
export async function runUi(ctx: CliContext, args: string[]): Promise<number> {
  const { positionals, flags } = parseArgs(args, { "--no-open": {} });
  if (positionals.length > 0) throw new UsageError("usage: parley ui [--no-open]");

  const discovery = await ensureDaemon(ctx.paths, ctx.env);
  const health = await daemonGet<HealthResponse>(discovery, "/health");
  if (!health.ui_available) {
    ctx.stderr(
      "No Parley UI is installed. Install the console with: npm install @useparley/dashboard\n" +
        "(or the Cove register: npm install @useparley/ui, then set config.ui.package)\n",
    );
    return 1;
  }

  const url = `http://127.0.0.1:${discovery.port}/`;
  ctx.stdout(`${url}\n`);
  if (flags["--no-open"] !== true) {
    try {
      await openBrowser(url, ctx.env);
    } catch {
      ctx.stderr("Could not open the default browser; use the URL above.\n");
    }
  }
  return 0;
}
