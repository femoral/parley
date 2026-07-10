import { homePathsFromEnv } from "../home.js";
import { clearDiscovery, writeDiscovery } from "./discovery.js";
import { startServer, type DaemonServer } from "./server.js";

/**
 * Daemon process entry point. Spawned detached by the CLI (see
 * `src/cli/spawn.ts`); it inherits `PARLEY_HOME` so it uses the same home dir
 * as the CLI that launched it.
 *
 * Lifecycle: bind an ephemeral localhost port, initialize SQLite, publish the
 * discovery file, and run until signalled. On shutdown it closes the server and
 * clears discovery so the next CLI command sees a clean slate.
 */
async function main(): Promise<void> {
  const paths = homePathsFromEnv();
  let daemon: DaemonServer;
  try {
    daemon = await startServer(paths);
  } catch (err) {
    process.stderr.write(`parley daemon failed to start: ${String(err)}\n`);
    process.exit(1);
    return;
  }

  writeDiscovery(paths, {
    port: daemon.port,
    pid: process.pid,
    started_at: new Date().toISOString(),
  });

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    void daemon.close().finally(() => {
      clearDiscovery(paths);
      process.exit(0);
    });
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

void main();
