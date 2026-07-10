import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * Resolve the absolute path to the daemon entry module (a TypeScript file run
 * through the tsx loader).
 */
function daemonEntryPath(): string {
  return fileURLToPath(new URL("../daemon/main.ts", import.meta.url));
}

/**
 * Resolve the tsx loader so the detached daemon can execute TypeScript. We
 * resolve the package explicitly (rather than relying on `--import tsx` name
 * resolution) so the spawn is independent of the child's working directory.
 */
function tsxLoader(): string {
  return import.meta.resolve("tsx");
}

/**
 * Spawn the daemon as a detached background process and return its pid.
 *
 * The child is fully detached (`stdio: "ignore"`, `unref`) so it outlives the
 * CLI invocation that launched it. It inherits the environment — crucially
 * `PARLEY_HOME` — so it uses the same home directory as its launcher.
 */
export function spawnDaemon(env: NodeJS.ProcessEnv): number {
  const child = spawn(process.execPath, ["--import", tsxLoader(), daemonEntryPath()], {
    detached: true,
    stdio: "ignore",
    env,
  });
  child.unref();
  if (child.pid === undefined) {
    throw new Error("failed to spawn parley daemon (no pid)");
  }
  return child.pid;
}
