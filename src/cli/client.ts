import { sleep, type HomePaths } from "@useparley/core";
import {
  clearDiscovery,
  isProcessAlive,
  liveDiscovery,
  readDiscovery,
  type Discovery,
} from "../daemon/discovery.js";
import { withLock } from "../daemon/lock.js";
import { spawnDaemon } from "./spawn.js";

const SPAWN_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 25;

async function healthy(discovery: Discovery): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${discovery.port}/health`, {
      signal: AbortSignal.timeout(1000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Wait until the daemon with the given pid has published a live, responsive
 * discovery record.
 */
async function waitForDaemon(paths: HomePaths, pid: number): Promise<Discovery> {
  const deadline = Date.now() + SPAWN_TIMEOUT_MS;
  for (;;) {
    if (!isProcessAlive(pid)) {
      throw new Error(`parley daemon (pid ${pid}) exited before becoming ready`);
    }
    const discovery = readDiscovery(paths);
    if (discovery && discovery.pid === pid && (await healthy(discovery))) {
      return discovery;
    }
    if (Date.now() >= deadline) {
      throw new Error(`parley daemon did not become ready within ${SPAWN_TIMEOUT_MS}ms`);
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

/**
 * Ensure a daemon is running and return its discovery record, spawning one if
 * necessary. Auto-spawn is guarded by the parley lock so concurrent CLI
 * invocations converge on a single daemon:
 *
 *  1. Fast path — a live daemon is already advertised: return it, no lock.
 *  2. Under the lock, re-check (another invocation may have just started one).
 *  3. Clear any stale discovery (dead pid), spawn a fresh daemon, wait for it.
 */
export async function ensureDaemon(paths: HomePaths, env: NodeJS.ProcessEnv): Promise<Discovery> {
  const existing = liveDiscovery(paths);
  if (existing) return existing;

  return withLock(paths, async () => {
    const stillRunning = liveDiscovery(paths);
    if (stillRunning) return stillRunning;

    clearDiscovery(paths);
    const pid = spawnDaemon(env);
    return waitForDaemon(paths, pid);
  });
}

/** A non-2xx daemon response; 400s map to usage errors at the command layer. */
export class DaemonRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "DaemonRequestError";
  }
}

async function daemonFetch<T>(
  discovery: Discovery,
  pathname: string,
  init: RequestInit,
): Promise<T> {
  const res = await fetch(`http://127.0.0.1:${discovery.port}${pathname}`, init);
  const raw = await res.text();
  if (!res.ok) {
    let detail = `daemon request ${pathname} failed with status ${res.status}`;
    try {
      const body: unknown = JSON.parse(raw);
      if (typeof body === "object" && body !== null && "error" in body) {
        detail = String((body as { error: unknown }).error);
      }
    } catch {
      /* keep the generic detail */
    }
    throw new DaemonRequestError(res.status, detail);
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`daemon sent a malformed response for ${pathname}: ${raw.slice(0, 200)}`);
  }
}

/** Issue a GET against the running daemon and parse the JSON response. */
export async function daemonGet<T>(
  discovery: Discovery,
  pathname: string,
  timeoutMs = 5000,
): Promise<T> {
  return daemonFetch<T>(discovery, pathname, {
    signal: AbortSignal.timeout(timeoutMs),
  });
}

/** Issue a POST with a JSON body against the running daemon. */
export async function daemonPost<T>(
  discovery: Discovery,
  pathname: string,
  body: unknown,
): Promise<T> {
  return daemonFetch<T>(discovery, pathname, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
}
