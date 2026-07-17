import { parseArgs } from "../args.js";
import { type CliContext, printJson } from "../context.js";
import { UsageError } from "../errors.js";
import {
  clearDiscovery,
  isProcessAlive,
  liveDiscovery,
  readDiscovery,
} from "@useparley/daemon/discovery.js";
import { daemonIdMatches } from "@useparley/daemon/identity.js";
import { sleep, type Discovery } from "@useparley/core";
import { ensureDaemon } from "../client.js";
import { spawnDaemon } from "../spawn.js";

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

/**
 * A live daemon this CLI may talk to. A live daemon across a `PARLEY_DAEMON_ID`
 * boundary (#130) is reported to stderr and treated as unattachable — status
 * and stop must never touch a foreign hub.
 */
function attachableDiscovery(ctx: CliContext): Discovery | null {
  const running = liveDiscovery(ctx.paths);
  if (running === null) return null;
  if (!daemonIdMatches(running, ctx.env)) {
    ctx.stderr(
      `note: a daemon is running for this home (pid ${running.pid}) but advertises ` +
        `a different isolation id; not attachable from this environment\n`,
    );
    return null;
  }
  return running;
}

/** Wait for a takeover: discovery advertising a *different* live daemon than `oldPid`. */
async function waitForReplacement(ctx: CliContext, oldPid: number): Promise<Discovery> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const current = readDiscovery(ctx.paths);
    if (current && current.pid !== oldPid && isProcessAlive(current.pid)) return current;
    if (Date.now() >= deadline) {
      throw new Error("replacement daemon did not register within 15000ms");
    }
    await sleep(STOP_POLL_INTERVAL_MS);
  }
}

async function daemonStart(ctx: CliContext, json: boolean, replace: boolean): Promise<number> {
  const running = attachableDiscovery(ctx);
  if (running && !replace) {
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

  let discovery: Discovery;
  if (running && replace) {
    // Takeover (#130): spawn a successor flagged to replace; the incumbent
    // notices its lost registration and exits on its own.
    spawnDaemon({ ...ctx.env, PARLEY_DAEMON_REPLACE: "1" });
    discovery = await waitForReplacement(ctx, running.pid);
  } else {
    discovery = await ensureDaemon(ctx.paths, ctx.env);
  }
  if (json) {
    printJson(ctx, { started: true, already_running: false, replaced: running !== null && replace, ...discovery });
  } else {
    ctx.stdout(
      `parley daemon started (pid ${discovery.pid}, port ${discovery.port})\n`,
    );
  }
  return 0;
}

async function daemonStop(ctx: CliContext, json: boolean): Promise<number> {
  const running = attachableDiscovery(ctx);
  if (!running) {
    // Clean up stale discovery (dead pid) — but never a live foreign daemon's
    // registration: unattachable means hands off entirely (#130).
    if (liveDiscovery(ctx.paths) === null) clearDiscovery(ctx.paths);
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
  const running = attachableDiscovery(ctx);
  if (running) {
    if (json) printJson(ctx, { running: true, ...running });
    else {
      // Identity readout (#130): enough to spot a version-skewed or foreign
      // hub at a glance — id, served home, code provenance, uptime.
      ctx.stdout(
        `parley daemon running (pid ${running.pid}, port ${running.port}, started ${running.started_at})\n`,
      );
      if (running.instance_id !== undefined) ctx.stdout(`  id          ${running.instance_id}\n`);
      if (running.home !== undefined) ctx.stdout(`  home        ${running.home}\n`);
      if (running.version !== undefined) {
        const provenance = running.provenance !== undefined ? ` (${running.provenance})` : "";
        ctx.stdout(`  version     ${running.version}${provenance}\n`);
      }
      if (running.entry !== undefined) ctx.stdout(`  entry       ${running.entry}\n`);
      if (running.daemon_id !== undefined) ctx.stdout(`  daemon id   ${running.daemon_id}\n`);
    }
    return 0;
  }
  if (json) printJson(ctx, { running: false });
  else ctx.stdout("parley daemon is not running\n");
  return 0;
}

/** Dispatch `parley daemon <start|stop|status>`. */
export async function runDaemon(ctx: CliContext, args: string[]): Promise<number> {
  const { positionals, flags } = parseArgs(args, { "--json": {}, "--replace": {} });
  const sub = positionals[0];
  const json = flags["--json"] === true;
  const replace = flags["--replace"] === true;
  if (replace && sub !== "start") {
    throw new UsageError("--replace only applies to: parley daemon start");
  }
  switch (sub) {
    case "start":
      return daemonStart(ctx, json, replace);
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
