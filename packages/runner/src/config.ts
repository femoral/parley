import fs from "node:fs";
import path from "node:path";

/**
 * Runner-side config (`runner.json` + env/flag overrides). Lives on the remote
 * host; see `docs/agents/remote-runners.md`.
 */
export interface RunnerConfig {
  /** Daemon base URL (no trailing slash), e.g. `http://daemon.example:57123`. */
  daemonUrl: string;
  /** Runner name as registered in the daemon's `runners.<name>`. */
  name: string;
  /** Bearer token matching `runners.<name>.token` on the daemon. */
  token: string;
  /**
   * Map of repo identifier → local clone path. The identifier is the `repo`
   * field the daemon recorded at delegate time (usually an absolute path on
   * the orchestrator host). Keys are matched exactly, then by basename.
   */
  repos: Record<string, string>;
  /**
   * Parent directory for parley worktrees on this host (default:
   * `<cwd>/.parley-runner/worktrees`).
   */
  worktreesDir: string;
}

/** Raw JSON shape of `runner.json`. */
export interface RunnerConfigFile {
  daemonUrl?: string;
  name?: string;
  token?: string;
  repos?: Record<string, string>;
  worktreesDir?: string;
}

export interface LoadRunnerConfigOptions {
  /** Path to runner.json (default: `./runner.json` or `PARLEY_RUNNER_CONFIG`). */
  configPath?: string;
  env?: NodeJS.ProcessEnv;
  /** CLI flag overrides (highest priority). */
  flags?: {
    daemonUrl?: string;
    name?: string;
    token?: string;
    worktreesDir?: string;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Load and merge runner config: file defaults, then env, then flags.
 *
 * Env overrides:
 * - `PARLEY_RUNNER_CONFIG` — path to runner.json
 * - `PARLEY_RUNNER_DAEMON_URL`
 * - `PARLEY_RUNNER_NAME`
 * - `PARLEY_RUNNER_TOKEN`
 * - `PARLEY_RUNNER_WORKTREES`
 */
export function loadRunnerConfig(options: LoadRunnerConfigOptions = {}): RunnerConfig {
  const env = options.env ?? process.env;
  const configPath =
    options.configPath ??
    env.PARLEY_RUNNER_CONFIG ??
    path.resolve(process.cwd(), "runner.json");

  let file: RunnerConfigFile = {};
  try {
    const raw = fs.readFileSync(configPath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) {
      throw new Error(`runner config at ${configPath} must be a JSON object`);
    }
    file = parsed as RunnerConfigFile;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    // File is optional when everything is provided via env/flags.
  }

  const repos =
    file.repos !== undefined && isRecord(file.repos)
      ? Object.fromEntries(
          Object.entries(file.repos).map(([k, v]) => {
            if (typeof v !== "string" || v === "") {
              throw new Error(`runner config repos.${k} must be a non-empty string`);
            }
            return [k, path.resolve(v)];
          }),
        )
      : {};

  const daemonUrl =
    options.flags?.daemonUrl ??
    env.PARLEY_RUNNER_DAEMON_URL ??
    file.daemonUrl ??
    "";
  const name =
    options.flags?.name ?? env.PARLEY_RUNNER_NAME ?? file.name ?? "";
  const token =
    options.flags?.token ?? env.PARLEY_RUNNER_TOKEN ?? file.token ?? "";
  const worktreesDir = path.resolve(
    options.flags?.worktreesDir ??
      env.PARLEY_RUNNER_WORKTREES ??
      file.worktreesDir ??
      path.join(process.cwd(), ".parley-runner", "worktrees"),
  );

  if (daemonUrl === "") {
    throw new Error(
      "runner config: daemonUrl is required (runner.json, --daemon-url, or PARLEY_RUNNER_DAEMON_URL)",
    );
  }
  if (name === "") {
    throw new Error(
      "runner config: name is required (runner.json, --name, or PARLEY_RUNNER_NAME)",
    );
  }
  if (token === "") {
    throw new Error(
      "runner config: token is required (runner.json, --token, or PARLEY_RUNNER_TOKEN)",
    );
  }

  return {
    daemonUrl: daemonUrl.replace(/\/+$/, ""),
    name,
    token,
    repos,
    worktreesDir,
  };
}

/**
 * Resolve a daemon-recorded repo identifier to a local clone path.
 * Tries exact match, then basename match against configured keys/values.
 */
export function resolveRepoPath(
  repos: Record<string, string>,
  repoId: string,
): string | null {
  if (repos[repoId] !== undefined) return repos[repoId] ?? null;
  const base = path.basename(repoId);
  for (const [key, local] of Object.entries(repos)) {
    if (path.basename(key) === base || path.basename(local) === base) {
      return local;
    }
  }
  return null;
}
