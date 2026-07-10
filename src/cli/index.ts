import { homePathsFromEnv } from "../home.js";
import { type CliContext } from "./context.js";
import { UsageError } from "./errors.js";
import { runDaemon } from "./commands/daemon.js";
import { runStatus } from "./commands/tasks.js";

const HELP = `parley — delegate tasks to agent CLIs

Usage:
  parley [list]                 Show the task table (alias for bare status)
  parley status [task] [--json] Show all tasks, or one
  parley daemon start           Start the background daemon
  parley daemon stop            Stop the background daemon
  parley daemon status          Report daemon port/pid
  parley daemon <cmd> [--json]

Global flags:
  --json    Emit machine-readable JSON
  -h,--help Show this help
`;

interface ParsedArgs {
  positionals: string[];
  json: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  let json = false;
  let help = false;

  for (const arg of argv) {
    if (arg === "--json") {
      json = true;
    } else if (arg === "-h" || arg === "--help") {
      help = true;
    } else if (arg.startsWith("-") && arg !== "-") {
      throw new UsageError(`unknown flag: ${arg}`);
    } else {
      positionals.push(arg);
    }
  }

  return { positionals, json, help };
}

/**
 * Parse and dispatch a parley command line. Returns the process exit code.
 * Throws `UsageError` for bad invocations (mapped to exit 2 by the caller).
 */
export async function run(argv: string[], ctx: CliContext): Promise<number> {
  const { positionals, json, help } = parseArgs(argv);

  if (help) {
    ctx.stdout(HELP);
    return 0;
  }

  const command = positionals[0] ?? "list";

  switch (command) {
    case "list":
      return runStatus(ctx, undefined, json);
    case "status":
      return runStatus(ctx, positionals[1], json);
    case "daemon":
      return runDaemon(ctx, positionals[1], json);
    default:
      throw new UsageError(`unknown command: ${command}`);
  }
}

async function main(): Promise<void> {
  const ctx: CliContext = {
    paths: homePathsFromEnv(),
    env: process.env,
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  };

  try {
    const code = await run(process.argv.slice(2), ctx);
    process.exitCode = code;
  } catch (err) {
    if (err instanceof UsageError) {
      ctx.stderr(`error: ${err.message}\n`);
      process.exitCode = 2;
      return;
    }
    ctx.stderr(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
}

void main();
