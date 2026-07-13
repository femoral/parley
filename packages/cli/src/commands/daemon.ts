import { parseArgs } from "../args.js";
import { type CliContext, printJson } from "../context.js";
import { UsageError } from "../errors.js";
import {
  clearDiscovery,
  isProcessAlive,
  liveDiscovery,
  readDiscovery,
} from "@useparley/daemon/discovery.js";
import { sleep } from "@useparley/core";
import { ensureDaemon } from "../client.js";

const STOP_TIMEOUT_MS = 10_000;
const STOP_POLL_INTERVAL_MS = 25;

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (isProcessAlive(pid) && Date.now() < deadline) {
    await sleep(STOP_POLL_INTERVAL_MS);
  }
  return !isProcessAlive(pid);
}

/**
 * Remove the discovery file only if it still points at `pid`. Guards against a
 * concurrent auto-spawn having replaced it with a newer daemon's record between
 * our liveness check and cleanup.
 */
function clearDiscoveryFor(ctx: CliContext, pid: number): void {
  const current = readDiscovery(ctx.paths);
  if (!current || current.pid === pid) {
    clearDiscovery(ctx.paths);
  }
}

async function daemonStart(ctx: CliContext, json: boolean): Promise<number> {
  const running = liveDiscovery(ctx.paths);
  if (running) {
    // Second start is refused cleanly: no new daemon, no error.
    if (json) {
      printJson(ctx, { started: false, already_running: true, ...running });
    } else {
      ctx.stdout(
        `parley daemon already running (pid ${running.pid}, port ${running.port})\n`,
      );
    }
    return 0;
  }

  const discovery = await ensureDaemon(ctx.paths, ctx.env);
  if (json) {
    printJson(ctx, { started: true, already_running: false, ...discovery });
  } else {
    ctx.stdout(
      `parley daemon started (pid ${discovery.pid}, port ${discovery.port})\n`,
    );
  }
  return 0;
}

async function daemonStop(ctx: CliContext, json: boolean): Promise<number> {
  const running = liveDiscovery(ctx.paths);
  if (!running) {
    // Clean up any stale discovery pointing at a dead pid.
    clearDiscovery(ctx.paths);
    if (json) printJson(ctx, { stopped: false, running: false });
    else ctx.stdout("parley daemon is not running\n");
    return 0;
  }

  try {
    process.kill(running.pid, "SIGTERM");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
  }

  let exited = await waitForExit(running.pid, STOP_TIMEOUT_MS);
  if (!exited) {
    // Daemon ignored SIGTERM (hung / stuck closing sockets): escalate.
    // SIGKILL is untrappable, so the daemon's own child cleanup won't run —
    // kill its whole process group (it is a session leader; vendor children
    // share the group) so no child is orphaned (spec §3). Fall back to the
    // bare pid if the group is already gone.
    try {
      process.kill(-running.pid, "SIGKILL");
    } catch {
      try {
        process.kill(running.pid, "SIGKILL");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
      }
    }
    exited = await waitForExit(running.pid, 2_000);
  }

  if (!exited) {
    // Still alive: do NOT clear discovery or claim success — it's still running.
    if (json) printJson(ctx, { stopped: false, pid: running.pid, error: "daemon did not exit" });
    else ctx.stderr(`parley daemon (pid ${running.pid}) did not exit\n`);
    return 1;
  }

  clearDiscoveryFor(ctx, running.pid);
  if (json) printJson(ctx, { stopped: true, pid: running.pid });
  else ctx.stdout(`parley daemon stopped (pid ${running.pid})\n`);
  return 0;
}

function daemonStatus(ctx: CliContext, json: boolean): number {
  const running = liveDiscovery(ctx.paths);
  if (running) {
    if (json) printJson(ctx, { running: true, ...running });
    else
      ctx.stdout(
        `parley daemon running (pid ${running.pid}, port ${running.port}, started ${running.started_at})\n`,
      );
    return 0;
  }
  if (json) printJson(ctx, { running: false });
  else ctx.stdout("parley daemon is not running\n");
  return 0;
}

/** Dispatch `parley daemon <start|stop|status>`. */
export async function runDaemon(ctx: CliContext, args: string[]): Promise<number> {
  const { positionals, flags } = parseArgs(args, { "--json": {} });
  const sub = positionals[0];
  const json = flags["--json"] === true;
  switch (sub) {
    case "start":
      return daemonStart(ctx, json);
    case "stop":
      return daemonStop(ctx, json);
    case "status":
      return daemonStatus(ctx, json);
    case undefined:
      throw new UsageError("usage: parley daemon <start|stop|status>");
    default:
      throw new UsageError(`unknown daemon subcommand: ${sub}`);
  }
}
