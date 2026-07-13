import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Write a set of `relative path → contents` files under `dir`, making dirs. */
export function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [rel, contents] of Object.entries(files)) {
    const target = path.join(dir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
  }
}

/**
 * Create a real git repository — the worktree fixture the daemon adapter tests
 * cut worktrees from. `files` adds extra committed content. Returns the repo's
 * absolute path. (The CLI integration suite has a richer `makeGitRepo` that also
 * seeds the fake-vendor script; the daemon adapter tests only need a repo.)
 */
export function makeGitRepo(files: Record<string, string> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "parley-repo-"));
  const run = (args: string[]): void => {
    execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  };
  run(["init", "-b", "main"]);
  run(["config", "user.email", "test@parley.test"]);
  run(["config", "user.name", "parley test"]);
  writeFiles(dir, files);
  run(["add", "-A"]);
  run(["commit", "--allow-empty", "-m", "initial"]);
  return dir;
}
