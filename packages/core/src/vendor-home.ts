import os from "node:os";
import path from "node:path";

/**
 * Operator-home resolution for vendor CLI state (#281).
 *
 * Discovery reads the directory the *operator* uses when they run the vendor
 * CLI interactively — not the isolated per-task homes parley provisions for
 * spawned children (e.g. `<cwd>/.parley-kimi`, `<cwd>/.openclaw-state`). Those
 * isolated paths ride on the child's `SpawnPlan.env` (and are often visible in
 * `process.env` when a delegated child re-invokes `parley models --refresh` /
 * `parley init`). This helper must refuse those markers and fall back to the
 * well-known operator default — otherwise a task-controlled worktree file is
 * read into the operator's global catalog.
 *
 * Env keys (provenance noted per entry):
 *  - adapter-set on spawn for isolation (must refuse when pointing at a
 *    parley-provisioned marker path): `KIMI_CODE_HOME`, `OPENCLAW_STATE_DIR`,
 *    `HERMES_HOME`, `GOOSE_PATH_ROOT`, `OPENHANDS_PERSISTENCE_DIR`
 *  - research-documented CLI override (adapters may isolate via flags rather
 *    than this env key; still refuse the marker if an override points there):
 *    `CODEX_HOME`, `GROK_HOME`, `PI_CODING_AGENT_DIR`, `CLINE_DATA_DIR`
 *    (cline isolates via `--data-dir …/.cline-parley`, not by setting the env key)
 */

/**
 * Path-segment markers of parley-provisioned per-task homes.
 * Matched as directory segments (or trailing path suffix) so a genuine
 * operator override like `/opt/kimi-homes/prod` is still accepted, while
 * `/work/tree/.parley-kimi` is refused.
 */
const PARLEY_ISOLATED_MARKERS: readonly string[] = [
  ".parley-kimi", // kimi KIMI_CODE_HOME_REL
  ".openclaw-state", // openclaw OPENCLAW_STATE_DIR_REL
  path.join(".parley", "hermes-home"), // hermes HERMES_HOME_REL
  ".parley-goose", // goose PATH_ROOT_DIR
  ".parley-openhands", // openhands PERSIST_REL parent
  ".cline-parley", // cline DATA_DIR_REL
  ".parley-antigravity", // legacy antigravity private HOME marker (rejected #298)
];

type HomeSpec = {
  envKey: string;
  /** Path under the OS user home when the override is absent or refused. */
  defaultRel: string;
  /**
   * How to interpret a non-refused override:
   *  - `home` — the override *is* the vendor home (config files live inside)
   *  - `goose-path-root` — override is GOOSE_PATH_ROOT; config dir is
   *    `<root>/config` so it matches the default `~/.config/goose` level
   */
  overrideKind: "home" | "goose-path-root";
  /** Short note for docs / error strings (adapter-set vs research-only). */
  provenance: "adapter-isolation" | "research-cli-override";
};

/** Env override + default path-under-homedir for each vendor we can resolve. */
const OPERATOR_HOME_SPECS: Record<string, HomeSpec> = {
  // research-documented CLI override (codex adapter does not set CODEX_HOME).
  codex: {
    envKey: "CODEX_HOME",
    defaultRel: ".codex",
    overrideKind: "home",
    provenance: "research-cli-override",
  },
  // adapter-set on spawn to task.cwd/.parley-kimi
  kimi: {
    envKey: "KIMI_CODE_HOME",
    defaultRel: ".kimi-code",
    overrideKind: "home",
    provenance: "adapter-isolation",
  },
  // adapter-set on spawn to task.cwd/.openclaw-state
  openclaw: {
    envKey: "OPENCLAW_STATE_DIR",
    defaultRel: ".openclaw",
    overrideKind: "home",
    provenance: "adapter-isolation",
  },
  // adapter-set on spawn to task.cwd/.parley/hermes-home
  hermes: {
    envKey: "HERMES_HOME",
    defaultRel: ".hermes",
    overrideKind: "home",
    provenance: "adapter-isolation",
  },
  // research-documented CLI override (grok adapter isolates via cwd files, not env).
  grok: {
    envKey: "GROK_HOME",
    defaultRel: ".grok",
    overrideKind: "home",
    provenance: "research-cli-override",
  },
  // research-documented CLI override (pi adapter does not set PI_CODING_AGENT_DIR
  // on spawn by default — auth stays on the operator home). #282 readModels.
  pi: {
    envKey: "PI_CODING_AGENT_DIR",
    defaultRel: path.join(".pi", "agent"),
    overrideKind: "home",
    provenance: "research-cli-override",
  },
  /**
   * goose: GOOSE_PATH_ROOT is a *tree root* (adapter sets it to
   * `task.cwd/.parley-goose`); config lives at `<root>/config/config.yaml`.
   * The operator default is the config dir itself (`~/.config/goose`, where
   * `config.yaml` sits). Both branches of this resolver therefore return the
   * **config directory** level so callers can join filenames uniformly.
   */
  goose: {
    envKey: "GOOSE_PATH_ROOT",
    defaultRel: path.join(".config", "goose"),
    overrideKind: "goose-path-root",
    provenance: "adapter-isolation",
  },
  // adapter-set on spawn to task.cwd/.parley-openhands/persist
  openhands: {
    envKey: "OPENHANDS_PERSISTENCE_DIR",
    defaultRel: ".openhands",
    overrideKind: "home",
    provenance: "adapter-isolation",
  },
  // research-documented CLI override (`--data-dir` / CLINE_DATA_DIR). The
  // adapter isolates via `--data-dir task.cwd/.cline-parley` (and exports
  // PARLEY_CLINE_DATA_DIR), not by setting CLINE_DATA_DIR — refuse the marker
  // if an override does point there.
  cline: {
    envKey: "CLINE_DATA_DIR",
    defaultRel: ".cline",
    overrideKind: "home",
    provenance: "research-cli-override",
  },
  /**
   * antigravity: CLI home is always `$HOME/.gemini` (kept Gemini CLI's dir
   * name; research §1). The only relocation lever is `HOME` itself — the
   * adapter deliberately does **not** override it (#298 / ADR-0026; per-task
   * HOME + credential copy was rejected). There is no `ANTIGRAVITY_HOME` /
   * `AGY_HOME` (verified absent). Discovery reads the operator default under
   * the real OS home; a test-only override key lets unit tests inject a fake
   * operator home without clobbering HOME. The `.parley-antigravity` isolation
   * marker remains refused if an override still points there.
   */
  antigravity: {
    envKey: "PARLEY_ANTIGRAVITY_OPERATOR_HOME",
    defaultRel: ".gemini",
    overrideKind: "home",
    provenance: "research-cli-override",
  },
};

/**
 * True when `resolved` looks like a parley-provisioned per-task vendor home.
 * Exported for tests that assert the refusal path.
 */
export function isParleyIsolatedVendorHome(resolved: string): boolean {
  const normalized = path.resolve(resolved);
  // Match path separators so we don't false-positive on a substring of a
  // legitimate directory name.
  const withSeps = normalized.endsWith(path.sep) ? normalized : `${normalized}${path.sep}`;
  for (const marker of PARLEY_ISOLATED_MARKERS) {
    const needle = `${path.sep}${marker}${path.sep}`;
    if (withSeps.includes(needle)) return true;
    // Also match when the resolved path *is* the marker leaf
    // (e.g. `/work/tree/.parley-kimi`).
    if (normalized.endsWith(`${path.sep}${marker}`) || normalized.endsWith(marker)) {
      // Require a path separator before the marker (or whole path equals marker)
      // so `not-parley-kimi` does not match.
      const idx = normalized.lastIndexOf(marker);
      if (idx === 0) return true;
      if (idx > 0 && (normalized[idx - 1] === path.sep || normalized[idx - 1] === "/")) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Operator OS home: `HOME` when set and non-empty, else `os.homedir()`.
 * Shared by {@link resolveOperatorVendorHome} and {@link displayVendorPath}
 * so catalog `source` strings agree with resolution when `HOME` is unset
 * (daemons / scrubbed env).
 */
export function operatorHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.HOME && env.HOME.trim() !== "" ? path.resolve(env.HOME) : os.homedir();
}

function userHomeFromEnv(env: NodeJS.ProcessEnv): string {
  return operatorHomeDir(env);
}

/**
 * Collapse an absolute path under the operator home to a `~/…` form for
 * catalog `source` strings (avoids embedding `/home/<user>/…` in models.json
 * and command output that gets pasted into issues). Uses the same home
 * resolution as {@link resolveOperatorVendorHome} so an unset/empty `HOME`
 * still tilde-collapses against `os.homedir()`.
 */
export function displayVendorPath(
  absolutePath: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const home = operatorHomeDir(env);
  const resolved = path.resolve(absolutePath);
  if (resolved === home || resolved.startsWith(home + path.sep)) {
    return `~${resolved.slice(home.length)}`;
  }
  return absolutePath;
}

/**
 * Collapse operator-home absolute path prefixes embedded anywhere in free text
 * (e.g. Node `fs` error messages, execFile binary paths) to `~/…` form. Used
 * by catalog-refresh warnings so operator usernames do not leak into
 * `~/.parley/models.json` or bug reports (#291). Reuses {@link operatorHomeDir}
 * — the same home basis as {@link displayVendorPath} — but replaces mid-string
 * occurrences, not only when the whole string is a path.
 *
 * Also collapses a bare home dir at a path boundary (end of string, quote, or
 * whitespace). Longer paths that only share a prefix (`/home/ab` vs `/home/abc`)
 * are left alone.
 */
export function collapseOperatorHomeInText(
  text: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const home = operatorHomeDir(env);
  // Degenerate homes would rewrite nearly every absolute path; leave text alone.
  if (!home || home === path.sep) return text;
  const prefix = home.endsWith(path.sep) ? home : `${home}${path.sep}`;
  let out = text.includes(prefix) ? text.split(prefix).join(`~${path.sep}`) : text;
  // Bare home at a path boundary (not a longer username/path that shares a prefix).
  if (out.includes(home)) {
    const escaped = home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`${escaped}(?=$|[\\s"'])`, "g"), "~");
  }
  return out;
}

function defaultHome(spec: HomeSpec, env: NodeJS.ProcessEnv): string {
  return path.join(userHomeFromEnv(env), spec.defaultRel);
}

/**
 * Resolve the operator's on-disk home for `vendorId`.
 *
 * Honours the vendor's env override when set, non-empty, and **not** a
 * parley-provisioned isolated path. Otherwise returns the well-known path
 * under the OS user home (or `HOME` when tests inject it). Returns `null` for
 * vendors with no known home layout.
 *
 * Operators who genuinely relocate their CLI home via the same env var still
 * work — only paths that match the isolation markers adapters write into
 * `SpawnPlan.env` are refused.
 */
export function resolveOperatorVendorHome(
  vendorId: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const spec = OPERATOR_HOME_SPECS[vendorId];
  if (spec === undefined) return null;
  const override = env[spec.envKey];
  if (override !== undefined && override.trim() !== "") {
    const resolved = path.resolve(override);
    if (!isParleyIsolatedVendorHome(resolved)) {
      if (spec.overrideKind === "goose-path-root") {
        // Align with default (~/.config/goose): return the config directory.
        return path.join(resolved, "config");
      }
      return resolved;
    }
    // Fall through to the operator default — do not read the task home.
  }
  return defaultHome(spec, env);
}

/** Vendor ids for which {@link resolveOperatorVendorHome} has a known layout. */
export function operatorVendorHomeIds(): string[] {
  return Object.keys(OPERATOR_HOME_SPECS);
}
