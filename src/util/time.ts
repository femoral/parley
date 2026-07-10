/** Resolve after `ms` milliseconds. Shared by the daemon's poll/retry loops. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const DURATION_UNITS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
};

/**
 * Parse a human duration flag value (`30m`, `90s`, `250ms`, `1.5h`; a bare
 * number is milliseconds) into milliseconds. Returns `null` when the text is
 * not a duration — callers turn that into a usage error.
 */
export function parseDuration(text: string): number | null {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(text.trim());
  if (!match) return null;
  const value = Number(match[1]);
  const factor = DURATION_UNITS[match[2] ?? "ms"];
  if (factor === undefined) return null;
  return Math.round(value * factor);
}
