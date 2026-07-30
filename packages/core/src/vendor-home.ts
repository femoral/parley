import os from "node:os";
import path from "node:path";

/**
 * Operator-home resolution for vendor CLI state (#281).
 *
 * Discovery reads the directory the *operator* uses when they run the vendor
 * CLI interactively — not the isolated per-task homes parley provisions for
 * spawned children (e.g. `<cwd>/.parley-kimi`, `<cwd>/.openclaw-state`). Those
 * isolated paths ride only on the child's `SpawnPlan.env`; this helper never
 * sees a task cwd and never invents one.
 *
 * Env overrides match the vars the adapters already honour when isolating
 * children (so an operator who relocates their CLI home via the same var is
 * still found). Defaults are the vendors' well-known home paths under the
 * OS user home.
 */

/** Env override + default path-under-homedir for each vendor we can resolve. */
const OPERATOR_HOME_SPECS: Record<string, { envKey: string; defaultRel: string }> = {
  codex: { envKey: "CODEX_HOME", defaultRel: ".codex" },
  kimi: { envKey: "KIMI_CODE_HOME", defaultRel: ".kimi-code" },
  openclaw: { envKey: "OPENCLAW_STATE_DIR", defaultRel: ".openclaw" },
  hermes: { envKey: "HERMES_HOME", defaultRel: ".hermes" },
  grok: { envKey: "GROK_HOME", defaultRel: ".grok" },
  /**
   * goose relocates its whole tree via `GOOSE_PATH_ROOT`; the operator default
   * is XDG-style `~/.config/goose` (what the CLI uses without the override).
   */
  goose: { envKey: "GOOSE_PATH_ROOT", defaultRel: path.join(".config", "goose") },
  openhands: { envKey: "OPENHANDS_PERSISTENCE_DIR", defaultRel: ".openhands" },
};

/**
 * Resolve the operator's on-disk home for `vendorId`.
 *
 * Honours the vendor's env override when set and non-empty; otherwise returns
 * the well-known path under `os.homedir()` (or `HOME` when tests inject it).
 * Returns `null` for vendors with no known home layout — callers treat that
 * as "no disk channel" and fall through to probe/shipped.
 *
 * Intentionally independent of any task cwd: never confusable with the
 * isolated homes `prepare()` writes into `SpawnPlan.env`.
 */
export function resolveOperatorVendorHome(
  vendorId: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const spec = OPERATOR_HOME_SPECS[vendorId];
  if (spec === undefined) return null;
  const override = env[spec.envKey];
  if (override !== undefined && override.trim() !== "") {
    return path.resolve(override);
  }
  const userHome = env.HOME && env.HOME.trim() !== "" ? env.HOME : os.homedir();
  return path.join(userHome, spec.defaultRel);
}

/** Vendor ids for which {@link resolveOperatorVendorHome} has a known layout. */
export function operatorVendorHomeIds(): string[] {
  return Object.keys(OPERATOR_HOME_SPECS);
}
