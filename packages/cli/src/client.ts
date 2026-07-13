import {
  ensureDaemon as ensureDaemonCore,
  type DaemonLauncher,
  type Discovery,
  type HomePaths,
} from "@useparley/core";
import {
  clearDiscovery,
  isProcessAlive,
  liveDiscovery,
  readDiscovery,
} from "@useparley/daemon/discovery";
import { withLock } from "@useparley/daemon/lock";
import { spawnDaemon } from "./spawn.js";

export { DaemonRequestError, daemonGet, daemonPost } from "@useparley/core";
export type { Discovery } from "@useparley/core";

/**
 * Wire the daemon-lifecycle operations (discovery/lock from `@useparley/daemon`,
 * spawn from this package) into the injectable launcher core's `ensureDaemon`
 * expects. Inverting the dependency this way keeps the HTTP client in core
 * without it cycling back to daemon/cli. See docs/spec/monorepo-layout.md.
 */
export function ensureDaemon(paths: HomePaths, env: NodeJS.ProcessEnv): Promise<Discovery> {
  const launcher: DaemonLauncher = {
    liveDiscovery: () => liveDiscovery(paths),
    readDiscovery: () => readDiscovery(paths),
    clearDiscovery: () => clearDiscovery(paths),
    isProcessAlive,
    spawnDaemon: () => spawnDaemon(env),
    withLock: (fn) => withLock(paths, fn),
  };
  return ensureDaemonCore(launcher);
}
