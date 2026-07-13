import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * Resolve the absolute path to the daemon entry module. Resolved through the
 * `@useparley/daemon` package export so it works wherever the workspace is
 * installed, not from a path relative to this file.
 *
 * In a published install this resolves to built `dist/main.js` (the package's
 * `exports` point at `dist/`); in the dev workspace it resolves to `src/main.ts`
 * (source exports). The file extension is the discriminator used below to decide
 * whether the daemon needs the `tsx` loader — dev only, never in production.
 */
function daemonEntryPath(): string {
  return fileURLToPath(import.meta.resolve("@useparley/daemon/main"));
}

/**
 * Resolve the tsx loader so a source-mode (dev) daemon can execute TypeScript.
 * We resolve the package explicitly (rather than relying on `--import tsx` name
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
 *
 * When the resolved entry is built JS (`.js` / `.mjs`, the published artifact)
 * it runs under plain `node`; only a `.ts` entry (the dev workspace) registers
 * the `tsx` loader, so a published install never depends on `tsx` at runtime.
 */
export function spawnDaemon(env: NodeJS.ProcessEnv): number {
  const entry = daemonEntryPath();
  const isSource = /\.[cm]?ts$/.test(entry);
  const args = isSource ? ["--import", tsxLoader(), entry] : [entry];
  const child = spawn(process.execPath, args, {
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
