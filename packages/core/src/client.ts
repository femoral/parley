import { sleep } from "./util/time.js";

const SPAWN_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 25;
const REMOTE_HEALTH_TIMEOUT_MS = 5_000;

/** Contents of the daemon discovery file (`~/.parley/daemon.json`). */
export interface Discovery {
  /** Ephemeral localhost port the daemon's HTTP server is bound to. */
  port: number;
  /** OS process id of the running daemon. */
  pid: number;
  /** ISO-8601 timestamp of when the daemon started. */
  started_at: string;
  /**
   * When set (config `daemon.url`), all requests go to this base URL instead of
   * `http://127.0.0.1:<port>`. Trailing slashes are stripped at use sites.
   */
  url?: string;
  /** Random per-process instance id — the registration token (#130). */
  instance_id?: string;
  /** The parley home this daemon serves. */
  home?: string;
  /** Daemon package version. */
  version?: string;
  /** How the daemon's code is run: a published build or dev source. */
  provenance?: "dist" | "source";
  /** Absolute path of the daemon entry module (pinpoints *which* checkout). */
  entry?: string;
  /**
   * Isolation id advertised by a daemon started with `PARLEY_DAEMON_ID` set.
   * A CLI carrying the env var attaches only on an exact match, and a CLI
   * without it never attaches to an id-stamped daemon (#130).
   */
  daemon_id?: string;
  /**
   * Bearer token for remote daemon auth (#323 / ADR-0030). When set, every
   * `daemonGet`/`daemonPost`/`daemonPut` and the remote health probe send
   * `Authorization: Bearer <token>`. Loopback auto-spawn leaves this unset.
   */
  token?: string;
  /**
   * Client name matching `clients.<name>` on the daemon (stored for
   * attribution / config round-trip; the wire only carries the bearer token).
   */
  client?: string;
}

/**
 * Daemon-lifecycle operations `ensureDaemon` needs but that live in the daemon
 * and CLI packages (discovery/lock in `@useparley/daemon`, spawn in
 * `@useparley/cli`). The CLI injects a concrete implementation, inverting the
 * dependency so this HTTP client can live in core without cycling back to
 * daemon/cli. See docs/spec/monorepo-layout.md.
 */
export interface DaemonLauncher {
  /** The advertised daemon, but only if its pid is alive; else `null`. */
  liveDiscovery(): Discovery | null;
  /** Read the raw discovery record (may point at a dead pid), or `null`. */
  readDiscovery(): Discovery | null;
  /** Remove a stale discovery record; a missing file is not an error. */
  clearDiscovery(): void;
  /** Liveness probe for a pid. */
  isProcessAlive(pid: number): boolean;
  /** Spawn a detached daemon and return its pid. */
  spawnDaemon(): number;
  /** Run `fn` while holding the parley lock. */
  withLock<T>(fn: () => Promise<T>): Promise<T>;
}

/** Base URL for daemon HTTP — remote `url` when set, else local loopback port. */
export function discoveryBaseUrl(discovery: Discovery): string {
  if (discovery.url !== undefined && discovery.url !== "") {
    return discovery.url.replace(/\/$/, "");
  }
  return `http://127.0.0.1:${discovery.port}`;
}

/** Authorization headers when Discovery carries a remote client token. */
function authHeaders(discovery: Discovery): Record<string, string> {
  if (discovery.token === undefined || discovery.token === "") return {};
  return { authorization: `Bearer ${discovery.token}` };
}

async function healthy(discovery: Discovery): Promise<boolean> {
  try {
    const res = await fetch(`${discoveryBaseUrl(discovery)}/health`, {
      headers: authHeaders(discovery),
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
async function waitForDaemon(launcher: DaemonLauncher, pid: number): Promise<Discovery> {
  const deadline = Date.now() + SPAWN_TIMEOUT_MS;
  for (;;) {
    if (!launcher.isProcessAlive(pid)) {
      throw new Error(`parley daemon (pid ${pid}) exited before becoming ready`);
    }
    const discovery = launcher.readDiscovery();
    if (discovery && discovery.pid === pid && (await healthy(discovery))) {
      return discovery;
    }
    if (Date.now() >= deadline) {
      throw new Error(`parley daemon did not become ready within ${SPAWN_TIMEOUT_MS}ms`);
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

/** Options for a remote (`daemon.url`) connection (#323). */
export interface RemoteDaemonOptions {
  /** Base URL of the remote daemon (trailing slash stripped). */
  url: string;
  /** Bearer token matching `clients.<name>.token` on the daemon. */
  token?: string;
  /** Client name (`clients.<name>`); stored on Discovery, not sent on the wire. */
  client?: string;
}

/**
 * Probe a non-local daemon at `url` (`GET /health`) and return a Discovery that
 * routes subsequent requests there. Skips local discovery/spawn entirely.
 * Throws a clear error naming the URL when unreachable.
 *
 * When `token` is set it is sent as bearer auth on the health probe and
 * carried on the returned Discovery for subsequent RPC (#323 / ADR-0030).
 */
export async function ensureRemoteDaemon(
  url: string,
  options?: { token?: string; client?: string },
): Promise<Discovery> {
  const base = url.replace(/\/$/, "");
  const token = options?.token;
  const client = options?.client;
  const headers: Record<string, string> = {};
  if (token !== undefined && token !== "") {
    headers.authorization = `Bearer ${token}`;
  }
  let res: Response;
  try {
    res = await fetch(`${base}/health`, {
      headers,
      signal: AbortSignal.timeout(REMOTE_HEALTH_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(
      `parley daemon at ${base} is unreachable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!res.ok) {
    throw new Error(
      `parley daemon at ${base} is unreachable: GET /health returned ${res.status}`,
    );
  }
  let body: { pid?: unknown; started_at?: unknown } = {};
  try {
    body = (await res.json()) as { pid?: unknown; started_at?: unknown };
  } catch {
    /* health without a body is still live */
  }
  // Synthesize a Discovery: port is unused when `url` is set; pid/started_at
  // come from health when present so `parley daemon status` stays informative.
  return {
    port: 0,
    pid: typeof body.pid === "number" ? body.pid : 0,
    started_at:
      typeof body.started_at === "string" ? body.started_at : new Date().toISOString(),
    url: base,
    ...(token !== undefined && token !== "" ? { token } : {}),
    ...(client !== undefined && client !== "" ? { client } : {}),
  };
}

/**
 * Ensure a daemon is running and return its discovery record, spawning one if
 * necessary. Auto-spawn is guarded by the parley lock so concurrent CLI
 * invocations converge on a single daemon:
 *
 *  1. Fast path — a live daemon is already advertised: return it, no lock.
 *  2. Under the lock, re-check (another invocation may have just started one).
 *  3. Clear any stale discovery (dead pid), spawn a fresh daemon, wait for it.
 *
 * When `options.url` is set (config `daemon.url`), skip discovery/spawn and
 * probe that URL instead (ADR-0010). Optional `token` / `client` ride along
 * for remote auth (#323).
 */
export async function ensureDaemon(
  launcher: DaemonLauncher,
  options?: { url?: string; token?: string; client?: string },
): Promise<Discovery> {
  if (options?.url !== undefined && options.url !== "") {
    return ensureRemoteDaemon(options.url, {
      token: options.token,
      client: options.client,
    });
  }

  const existing = launcher.liveDiscovery();
  if (existing) return existing;

  return launcher.withLock(async () => {
    const stillRunning = launcher.liveDiscovery();
    if (stillRunning) return stillRunning;

    launcher.clearDiscovery();
    const pid = launcher.spawnDaemon();
    return waitForDaemon(launcher, pid);
  });
}

/**
 * A non-2xx daemon response; 400s map to usage errors at the command layer.
 * When the daemon returns a stable `code` field (e.g. retry gates, #158), it is
 * preserved so the CLI can map to distinct exit codes without parsing prose.
 */
export class DaemonRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
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
  const headers = new Headers(init.headers);
  for (const [key, value] of Object.entries(authHeaders(discovery))) {
    if (!headers.has(key)) headers.set(key, value);
  }
  const res = await fetch(`${discoveryBaseUrl(discovery)}${pathname}`, {
    ...init,
    headers,
  });
  const raw = await res.text();
  if (!res.ok) {
    let detail = `daemon request ${pathname} failed with status ${res.status}`;
    let code: string | undefined;
    try {
      const body: unknown = JSON.parse(raw);
      if (typeof body === "object" && body !== null) {
        if ("error" in body) {
          detail = String((body as { error: unknown }).error);
        }
        if (
          "code" in body &&
          typeof (body as { code: unknown }).code === "string" &&
          (body as { code: string }).code !== ""
        ) {
          code = (body as { code: string }).code;
        }
      }
    } catch {
      /* keep the generic detail */
    }
    throw new DaemonRequestError(res.status, detail, code);
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

/** Issue a PUT with a JSON body against the running daemon. */
export async function daemonPut<T>(
  discovery: Discovery,
  pathname: string,
  body: unknown,
): Promise<T> {
  return daemonFetch<T>(discovery, pathname, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
}

/** Issue a DELETE against the running daemon and parse the JSON response. */
export async function daemonDelete<T>(
  discovery: Discovery,
  pathname: string,
): Promise<T> {
  return daemonFetch<T>(discovery, pathname, {
    method: "DELETE",
    signal: AbortSignal.timeout(10_000),
  });
}
