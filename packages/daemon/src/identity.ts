import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import type { Discovery } from "@useparley/core";
import { DAEMON_VERSION } from "./version.js";

/**
 * Who this daemon process is (#130): a random per-process instance id (the
 * registration token single-daemon enforcement compares), the home it serves,
 * what code it runs (package version + dist-vs-source provenance + the entry
 * path that pinpoints the checkout), and when it started. Everything needed to
 * audit a `ps` full of anonymous `node`/`tsx` processes at a glance.
 */
export interface DaemonIdentity {
  instance_id: string;
  home: string;
  version: string;
  provenance: "dist" | "source";
  entry: string;
  started_at: string;
  /** Isolation id from `PARLEY_DAEMON_ID`, when the daemon was started with one. */
  daemon_id?: string;
}

/** Build this process's identity. `entryUrl` is the entry module's import.meta.url. */
export function buildIdentity(
  home: string,
  entryUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): DaemonIdentity {
  const entry = fileURLToPath(entryUrl);
  const daemonId = env.PARLEY_DAEMON_ID;
  return {
    instance_id: crypto.randomUUID(),
    home,
    version: DAEMON_VERSION,
    // A `.ts` entry only exists in the dev workspace (published exports point
    // at dist/), so the extension is the provenance discriminator — the same
    // one the CLI's spawn uses to decide on the tsx loader.
    provenance: /\.[cm]?ts$/.test(entry) ? "source" : "dist",
    entry,
    started_at: new Date().toISOString(),
    ...(daemonId !== undefined && daemonId !== "" ? { daemon_id: daemonId } : {}),
  };
}

/** The discovery record advertising `identity` on `port`. */
export function discoveryFor(identity: DaemonIdentity, port: number): Discovery {
  return {
    port,
    pid: process.pid,
    started_at: identity.started_at,
    instance_id: identity.instance_id,
    home: identity.home,
    version: identity.version,
    provenance: identity.provenance,
    entry: identity.entry,
    ...(identity.daemon_id !== undefined ? { daemon_id: identity.daemon_id } : {}),
  };
}

/**
 * Whether a CLI in `env` may attach to `discovery` (#130): with
 * `PARLEY_DAEMON_ID` set, only to a daemon advertising exactly that id; without
 * it, never to an id-stamped daemon. Symmetric, so a test CLI can't touch the
 * real hub and a real CLI can't adopt a leftover test daemon.
 */
export function daemonIdMatches(
  discovery: Pick<Discovery, "daemon_id">,
  env: NodeJS.ProcessEnv,
): boolean {
  const want = env.PARLEY_DAEMON_ID;
  const have = discovery.daemon_id;
  if (want === undefined || want === "") return have === undefined;
  return have === want;
}
