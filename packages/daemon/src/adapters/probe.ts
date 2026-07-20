import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Run a read-only vendor enumeration command (`parley models --refresh`, #29)
 * and return its stdout. A generous `maxBuffer` covers codex's ~235 KB `debug
 * models` output (it embeds each model's base instructions). Rejects on a
 * missing binary or non-zero exit — the caller (catalog refresh) turns that into
 * a warning and keeps the existing entry.
 */
export async function runProbe(
  bin: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<string> {
  const { stdout } = await execFileAsync(bin, args, {
    maxBuffer: 64 * 1024 * 1024,
    encoding: "utf8",
    cwd: opts.cwd,
    env: opts.env,
    timeout: opts.timeoutMs,
  });
  return stdout;
}
