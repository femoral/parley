import { loadRunnerConfig } from "./config.js";
import { RunnerLoop } from "./loop.js";

function printUsage(): void {
  process.stderr.write(`Usage: parley-runner [options]

Remote task executor for parley (ADR-0012). Authenticates outbound to a daemon,
leases pending tasks tagged for this runner, executes them locally, and streams
results back.

Options:
  --config <path>       Path to runner.json (default: ./runner.json or PARLEY_RUNNER_CONFIG)
  --daemon-url <url>    Daemon base URL (or PARLEY_RUNNER_DAEMON_URL)
  --name <name>         Runner name (or PARLEY_RUNNER_NAME)
  --token <token>       Bearer token (or PARLEY_RUNNER_TOKEN)
  --worktrees <dir>     Worktrees parent dir (or PARLEY_RUNNER_WORKTREES)
  -h, --help            Show this help

Config file (runner.json) example:
  {
    "daemonUrl": "http://daemon.example:57123",
    "name": "gpu",
    "token": "shared-secret",
    "worktreesDir": "/home/runner/.parley-runner/worktrees"
  }

repos is optional (operator-managed clone override keyed by repo key).
With no repos config the runner creates parley-managed bare mirrors under
$PARLEY_HOME/clones/ on claim (ADR-0031).

See docs/agents/remote-runners.md for setup.
`);
}

function parseFlags(argv: string[]): {
  configPath?: string;
  daemonUrl?: string;
  name?: string;
  token?: string;
  worktreesDir?: string;
  help?: boolean;
} {
  const out: ReturnType<typeof parseFlags> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      out.help = true;
      continue;
    }
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`missing value for ${arg}`);
      return v;
    };
    if (arg === "--config") out.configPath = next();
    else if (arg === "--daemon-url") out.daemonUrl = next();
    else if (arg === "--name") out.name = next();
    else if (arg === "--token") out.token = next();
    else if (arg === "--worktrees") out.worktreesDir = next();
    else throw new Error(`unknown argument: ${arg}`);
  }
  return out;
}

async function main(): Promise<number> {
  let flags: ReturnType<typeof parseFlags>;
  try {
    flags = parseFlags(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`parley-runner: ${err instanceof Error ? err.message : String(err)}\n`);
    printUsage();
    return 2;
  }
  if (flags.help) {
    printUsage();
    return 0;
  }

  let config;
  try {
    config = loadRunnerConfig({
      configPath: flags.configPath,
      flags: {
        daemonUrl: flags.daemonUrl,
        name: flags.name,
        token: flags.token,
        worktreesDir: flags.worktreesDir,
      },
    });
  } catch (err) {
    process.stderr.write(`parley-runner: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }

  const loop = new RunnerLoop({ config });

  const onSignal = (signal: string): void => {
    process.stderr.write(`parley-runner: ${signal} — shutting down\n`);
    loop.stop();
    void loop.abortInFlight(`runner received ${signal}`).finally(() => {
      // Give the loop a moment to exit cleanly; hard-exit if stuck.
      setTimeout(() => process.exit(0), 5_000).unref();
    });
  };
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));

  try {
    await loop.run();
    return 0;
  } catch (err) {
    process.stderr.write(
      `parley-runner: fatal: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }
}

const code = await main();
process.exit(code);
