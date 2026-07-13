/**
 * A usage or configuration error — bad command, unknown flag, missing argument.
 * Surfaces to the user on stderr and maps to exit code 2 (per the CLI
 * contract), distinct from task failures (1) and other outcomes.
 */
export class UsageError extends Error {
  override readonly name = "UsageError";
}

/**
 * Thrown by the argument parser when `-h`/`--help` is seen as a flag (not as a
 * value of another flag). The entry point catches it and prints help, exit 0.
 */
export class HelpRequested extends Error {
  override readonly name = "HelpRequested";
}
