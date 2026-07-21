/**
 * Shell-like `$VAR` / `${VAR}` expansion for profile launch templates
 * (#195 / ADR-0015).
 *
 * Expansion is open-ended: any identifier token expands from the provided
 * environment (parley-injected vars included). Unset variables expand to the
 * empty string. There is no closed placeholder vocabulary and no config-time
 * unknown-var errors — a misauthored template fails at spawn, not load.
 *
 * `$PROMPT` is supplied by the engine as the assembled task prompt (preamble +
 * brief), matching what adapter-composed paths put in argv.
 */

/** Match `$NAME` or `${NAME}` where NAME is a POSIX-ish identifier. */
const VAR_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;

/**
 * Expand all `$VAR` / `${VAR}` tokens in `input` from `env`. Unset → `""`.
 * Does not interpret quotes, escapes, or command substitution.
 */
export function expandShellVars(
  input: string,
  env: Readonly<Record<string, string>>,
): string {
  return input.replace(VAR_RE, (_match, braced: string | undefined, bare: string | undefined) => {
    const name = braced ?? bare ?? "";
    return env[name] ?? "";
  });
}

/**
 * Expand every element of a launch-template argv against `env` (including
 * `PROMPT` when the caller has set it).
 */
export function expandLaunchTemplate(
  template: readonly string[],
  env: Readonly<Record<string, string>>,
): string[] {
  return template.map((element) => expandShellVars(element, env));
}
