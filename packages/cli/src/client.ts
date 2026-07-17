import {
  ensureDaemon as ensureDaemonCore,
  readConfig,
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
import { daemonIdMatches } from "@useparley/daemon/identity";
import { withLock } from "@useparley/daemon/lock";
import { spawnDaemon } from "./spawn.js";

export { DaemonRequestError, daemonGet, daemonPost, daemonPut } from "@useparley/core";
export type { Discovery } from "@useparley/core";

/**
 * Wire the daemon-lifecycle operations (discovery/lock from `@useparley/daemon`,
 * spawn from this package) into the injectable launcher core's `ensureDaemon`
 * expects. Inverting the dependency this way keeps the HTTP client in core
 * without it cycling back to daemon/cli. See docs/spec/monorepo-layout.md.
 *
 * When `~/.parley/parley.json` sets `daemon.url`, discovery/spawn are skipped
 * and that URL is probed instead (ADR-0010). A corrupt config is ignored for
 * lifecycle purposes so `daemon start` / auto-spawn still work (UI discovery
 * already degrades the same way); task creation re-reads config and fails the
 * delegate request loudly.
 */
export function ensureDaemon(paths: HomePaths, env: NodeJS.ProcessEnv): Promise<Discovery> {
  // Isolation handshake (#130): never attach across a `PARLEY_DAEMON_ID`
  // boundary in either direction — and never spawn over the mismatched
  // daemon's registration either. Fail loudly instead of touching it.
  const live = liveDiscovery(paths);
  if (live !== null && !daemonIdMatches(live, env)) {
    return Promise.reject(
      new Error(
        `a parley daemon is running for ${paths.home} but advertises a different ` +
          `isolation id (daemon_id ${live.daemon_id ?? "unset"} vs PARLEY_DAEMON_ID ` +
          `${env.PARLEY_DAEMON_ID ?? "unset"}); refusing to attach or replace it`,
      ),
    );
  }
  let remoteUrl: string | undefined;
  try {
    remoteUrl = readConfig(paths.config).daemon?.url;
  } catch {
    remoteUrl = undefined;
  }
  const launcher: DaemonLauncher = {
    liveDiscovery: () => liveDiscovery(paths),
    readDiscovery: () => readDiscovery(paths),
    clearDiscovery: () => clearDiscovery(paths),
    isProcessAlive,
    spawnDaemon: () => spawnDaemon(env),
    withLock: (fn) => withLock(paths, fn),
  };
  return ensureDaemonCore(launcher, remoteUrl !== undefined ? { url: remoteUrl } : undefined);
}
