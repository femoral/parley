import { HelpRequested, UsageError } from "./errors.js";

/** Declares one flag a command accepts. */
export interface FlagDef {
  /** Extra spellings, e.g. `["-v"]` for `--vendor`. */
  aliases?: string[];
  /** True when the flag consumes the next argument as its value. */
  value?: boolean;
}

export interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

/**
 * Parse a command's arguments against its flag table. Unknown flags are usage
 * errors (exit 2). A bare `-` is a positional (stdin marker), not a flag.
 */
export function parseArgs(args: string[], defs: Record<string, FlagDef>): ParsedArgs {
  const lookup = new Map<string, string>();
  for (const [name, def] of Object.entries(defs)) {
    lookup.set(name, name);
    for (const alias of def.aliases ?? []) lookup.set(alias, name);
  }

  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith("-") || arg === "-") {
      positionals.push(arg);
      continue;
    }
    if (arg === "-h" || arg === "--help") throw new HelpRequested(arg);
    const name = lookup.get(arg);
    if (name === undefined) throw new UsageError(`unknown flag: ${arg}`);
    if (defs[name]!.value) {
      const value = args[++i];
      if (value === undefined) throw new UsageError(`flag ${arg} requires a value`);
      flags[name] = value;
    } else {
      flags[name] = true;
    }
  }
  return { positionals, flags };
}
