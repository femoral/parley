import fs from "node:fs";
import path from "node:path";

/** One `--context` file, read by the CLI and shipped to the daemon by value. */
export interface ContextFile {
  /** Filename it is written under in `.parley/context/` (basename only). */
  name: string;
  contents: string;
}

/** Directory name parley materializes task context under, inside the workspace. */
export const PARLEY_DIR = ".parley";

/**
 * Materialize a task's context on disk under `<dir>/.parley/` (spec §7): the
 * caller's brief as `TASK.md`, and each `--context` file under `context/`.
 *
 * This context rides the workspace, not the vendor prompt — it survives resume
 * (the child re-reads it) and the prompt only ever points at it. In a parley
 * worktree `/.parley/` is git-excluded at worktree creation; a `--cwd` task owns
 * its directory, so parley writes there without excluding (no repo-owner
 * guarantee to uphold outside parley's own worktrees, spec §6).
 */
export function materializeContext(
  dir: string,
  brief: string,
  contexts: ContextFile[],
): void {
  const root = path.join(dir, PARLEY_DIR);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "TASK.md"), brief.endsWith("\n") ? brief : `${brief}\n`);
  // Idempotent: clear any prior context first so a reused directory (a `--cwd`
  // task run twice, or a re-delegation) never leaks stale files into the new
  // task's preamble via `contextPointers`.
  const contextDir = path.join(root, "context");
  fs.rmSync(contextDir, { recursive: true, force: true });
  if (contexts.length === 0) return;
  fs.mkdirSync(contextDir, { recursive: true });
  for (const file of contexts) {
    // Defense in depth: the CLI already basenames the path, but never let a
    // context name escape the context dir.
    const name = path.basename(file.name);
    if (name === "" || name === "." || name === "..") continue;
    fs.writeFileSync(path.join(contextDir, name), file.contents);
  }
}

/**
 * The relative pointers (for the prompt preamble) to the context files present
 * on disk under `<dir>/.parley/context/`, sorted. Empty when there are none.
 */
export function contextPointers(dir: string): string[] {
  try {
    return fs
      .readdirSync(path.join(dir, PARLEY_DIR, "context"))
      .sort()
      .map((name) => `${PARLEY_DIR}/context/${name}`);
  } catch {
    return [];
  }
}
