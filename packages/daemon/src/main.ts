import { homePathsFromEnv, readConfig, type HomePaths } from "@useparley/core";
import { clearDiscovery, isProcessAlive, readDiscovery, writeDiscovery } from "./discovery.js";
import { buildIdentity, discoveryFor, type DaemonIdentity } from "./identity.js";
import { startServer, type DaemonServer } from "./server.js";

/** Exit code for "another live daemon already serves this home" (#130). */
export const EXIT_ALREADY_RUNNING = 11;

const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_REGISTRATION_POLL_MS = 5_000;

/**
 * Non-negative-integer env override, for tests that shrink lifecycle windows.
 * An unset or blank var is `undefined` — never coerced (`Number("") === 0`
 * would silently disable the feature the default is meant to enable).
 */
function envMs(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/**
 * Resolve the idle auto-shutdown window (#130): `PARLEY_IDLE_TIMEOUT_MS` env
 * (tests) > `daemon.idleTimeoutMs` config > 5 minutes. `0` disables. A corrupt
 * config falls back to the default — lifecycle must not brick on bad JSON.
 */
function idleTimeoutMs(paths: HomePaths): number {
  const fromEnv = envMs("PARLEY_IDLE_TIMEOUT_MS");
  if (fromEnv !== undefined) return fromEnv;
  try {
    const configured = readConfig(paths.config).daemon?.idleTimeoutMs;
    if (configured !== undefined) return configured;
  } catch {
    /* fall through to default */
  }
  return DEFAULT_IDLE_TIMEOUT_MS;
}

/**
 * Daemon process entry point. Spawned detached by the CLI (see
 * `@useparley/cli` `spawn.ts`); it inherits `PARLEY_HOME` so it uses the same
 * home dir as the CLI that launched it.
 *
 * Lifecycle (#130): refuse to start when a live daemon already serves this
 * home (unless `--replace`), bind an ephemeral localhost port, publish an
 * identity-carrying discovery record, and keep watching that registration —
 * a daemon that loses it (another instance took over) exits rather than serve
 * stale state. Idle auto-shutdown exits after a quiet window so a fresh CLI
 * invocation always autostarts a current-code daemon.
 */
async function main(): Promise<void> {
  const paths = homePathsFromEnv();
  const identity: DaemonIdentity = buildIdentity(paths.home, import.meta.url);
  // Name the process so `ps`/`pgrep -f parley-daemon` finds every daemon and
  // shows which home each serves — no pid/cwd forensics (#130).
  process.title = `parley-daemon ${paths.home}`;

  const replace =
    process.argv.includes("--replace") || process.env.PARLEY_DAEMON_REPLACE === "1";
  const incumbent = readDiscovery(paths);
  const incumbentAlive =
    incumbent !== null && incumbent.pid !== process.pid && isProcessAlive(incumbent.pid);
  if (incumbentAlive && !replace) {
    process.stderr.write(
      `parley daemon already running for ${paths.home} ` +
        `(pid ${incumbent.pid}, port ${incumbent.port}); ` +
        `use --replace to take over\n`,
    );
    process.exit(EXIT_ALREADY_RUNNING);
    return;
  }

  /** Remove the discovery file only while it is still ours — never a successor's. */
  const clearOwnDiscovery = (): void => {
    const current = readDiscovery(paths);
    if (current === null) return;
    if (current.instance_id === identity.instance_id || current.pid === process.pid) {
      clearDiscovery(paths);
    }
  };

  let shuttingDown = false;
  let daemon: DaemonServer | undefined;
  const shutdown = (opts: { clearOwn: boolean } = { clearOwn: true }): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    void (daemon?.close() ?? Promise.resolve()).finally(() => {
      if (opts.clearOwn) clearOwnDiscovery();
      process.exit(0);
    });
  };

  try {
    daemon = await startServer(paths, {
      identity,
      idleTimeoutMs: idleTimeoutMs(paths),
      onIdle: () => shutdown({ clearOwn: true }),
    });
  } catch (err) {
    process.stderr.write(`parley daemon failed to start: ${String(err)}\n`);
    process.exit(1);
    return;
  }

  writeDiscovery(paths, discoveryFor(identity, daemon.port));
  if (incumbentAlive) {
    // Taking over: the incumbent will notice its lost registration and exit on
    // its own; a best-effort SIGTERM just makes that prompt.
    try {
      process.kill(incumbent.pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }

  // Registration watch (#130): single-daemon-per-home is enforced for the
  // whole lifetime, not just at spawn. If the discovery record stops carrying
  // our instance id — replaced by a takeover, or cleared by `daemon stop` of a
  // successor — this process is no longer "the" daemon and must not keep
  // serving stale state. Exit WITHOUT clearing discovery: it now belongs to
  // whoever took over.
  const registrationPoll = envMs("PARLEY_REGISTRATION_POLL_MS") ?? DEFAULT_REGISTRATION_POLL_MS;
  if (registrationPoll > 0) {
    const watcher = setInterval(() => {
      const current = readDiscovery(paths);
      if (current === null || current.instance_id !== identity.instance_id) {
        clearInterval(watcher);
        shutdown({ clearOwn: false });
      }
    }, registrationPoll);
    watcher.unref();
  }

  process.on("SIGTERM", () => shutdown());
  process.on("SIGINT", () => shutdown());
}

void main();
