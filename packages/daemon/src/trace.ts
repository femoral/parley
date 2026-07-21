/**
 * Launch-command capture and model/effort resolution (#154 / #137).
 *
 * Pure helpers so resolution order and redaction rules are unit-testable
 * without spinning a child process. The engine calls these at spawn and when
 * a vendor stream reports model/effort via `session_meta`.
 */

/**
 * Where a recorded model or effort value came from.
 * - `resolved` — request / profile / allowlist default at spawn (adapter path)
 * - `vendor` — upgraded from the vendor event stream (adapter path)
 * - `declared` — template-profile claim; unverified, never merged with verified
 *   in eval grouping (#195 / ADR-0015)
 */
export type TraceSource = "resolved" | "vendor" | "declared";

/** One resolved trace field: concrete value + provenance, or fully unknown. */
export interface ResolvedTraceField {
  value: string | null;
  /** Null exactly when `value` is null — never a source without a value. */
  source: TraceSource | null;
}

/**
 * One spawn's launch record. Env *values* are never stored; the prompt argv
 * slot is replaced with `"<prompt>"`.
 */
export interface LaunchCommandRecord {
  argv: string[];
  cwd: string;
  env_names: string[];
}

/**
 * Resolve model or effort: explicit request > profile > adapter default.
 * Returns `source: "resolved"` when any tier supplies a value; null/null when
 * none do — never fabricates a guess.
 *
 * For launch-template profiles, prefer {@link resolveDeclaredTraceField} so
 * the value is stored as *declared* (unverified) provenance.
 */
export function resolveTraceField(
  request: string | null | undefined,
  profile: string | null | undefined,
  adapterDefault: string | null | undefined,
): ResolvedTraceField {
  const value = request ?? profile ?? adapterDefault ?? null;
  if (value === null || value === undefined || value === "") {
    return { value: null, source: null };
  }
  return { value, source: "resolved" };
}

/**
 * Resolve model or effort as *declared* provenance for a launch-template
 * profile (#195 / ADR-0015). Same precedence as {@link resolveTraceField} but
 * never consults adapter defaults (no adapter is on the path) and tags the
 * source `declared` so eval grouping keeps it separate from verified values.
 */
export function resolveDeclaredTraceField(
  request: string | null | undefined,
  profile: string | null | undefined,
): ResolvedTraceField {
  const value = request ?? profile ?? null;
  if (value === null || value === undefined || value === "") {
    return { value: null, source: null };
  }
  return { value, source: "declared" };
}

/**
 * Upgrade a previously resolved (or unknown) field when the vendor stream
 * reports a concrete value. Empty/missing vendor reports leave the current
 * field unchanged. Declared provenance is never upgraded — template claims
 * stay unverified (#195).
 */
export function upgradeTraceField(
  current: ResolvedTraceField,
  vendorReported: string | null | undefined,
): ResolvedTraceField {
  if (vendorReported === null || vendorReported === undefined || vendorReported === "") {
    return current;
  }
  // Declared (template) provenance must not flip to vendor-verified.
  if (current.source === "declared") return current;
  return { value: vendorReported, source: "vendor" };
}

/**
 * Build a launch-command record from the final spawn plan. Replaces every argv
 * element that equals the full prompt with `"<prompt>"`; records only the
 * *names* of env keys the spawn overlay set (never values, never the full
 * process environment).
 */
export function captureLaunchCommand(
  plan: { argv: string[]; cwd: string; env: Record<string, string> },
  /** The exact prompt string that landed in argv (preamble + brief / resume). */
  prompt: string,
  /**
   * Final env overlay passed to `spawn` (plan env + engine hub injection).
   * Only these keys are recorded — not the inherited `process.env`.
   */
  spawnEnv: Record<string, string>,
): LaunchCommandRecord {
  const argv = plan.argv.map((arg) => (arg === prompt ? "<prompt>" : arg));
  // Sorted for stable --json / logs output across object-key insertion orders.
  const env_names = Object.keys(spawnEnv).sort();
  return { argv, cwd: plan.cwd, env_names };
}

/**
 * Append one spawn's launch record to the persisted JSON column value.
 * Spawn-per-turn vendors accumulate one entry per spawn (ADR-0004).
 */
export function appendLaunchCommand(
  existingJson: string | null,
  entry: LaunchCommandRecord,
): string {
  const existing = parseLaunchCommands(existingJson);
  return JSON.stringify([...existing, entry]);
}

/** Parse the `launch_command` column; malformed / null → empty list. */
export function parseLaunchCommands(value: string | null | undefined): LaunchCommandRecord[] {
  if (value === null || value === undefined || value === "") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isLaunchCommandRecord);
  } catch {
    return [];
  }
}

function isLaunchCommandRecord(value: unknown): value is LaunchCommandRecord {
  if (typeof value !== "object" || value === null) return false;
  const rec = value as Record<string, unknown>;
  return (
    Array.isArray(rec.argv) &&
    rec.argv.every((a) => typeof a === "string") &&
    typeof rec.cwd === "string" &&
    Array.isArray(rec.env_names) &&
    rec.env_names.every((n) => typeof n === "string")
  );
}
