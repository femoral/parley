import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const CLI_ENTRY = fileURLToPath(new URL("../src/index.ts", import.meta.url));
// Resolve tsx to an absolute loader URL so it registers regardless of the
// child's cwd — worktree tests run the CLI from arbitrary temp git repos, where
// a bare `tsx` specifier would fail to resolve.
const TSX_LOADER = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;

/** The fake vendor CLI — the suite's only test double (see fake-vendor.mjs). */
export const FAKE_VENDOR_BIN = fileURLToPath(new URL("./fake-vendor.mjs", import.meta.url));

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Run the parley CLI as a real subprocess against an isolated home dir. This is
 * the only seam the suite tests: stdout, exit codes, and filesystem effects.
 */
export interface CliOptions {
  extraEnv?: NodeJS.ProcessEnv;
  /** The directory to invoke the CLI from — matters for worktree detection. */
  cwd?: string;
}

/**
 * Env for a CLI subprocess. Drops the NO_COLOR/FORCE_COLOR pair when both are
 * set — Node emits a process warning on stderr for that conflict, which fails
 * tests that assert quiet stderr.
 */
function cliEnv(home: string, extraEnv?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PARLEY_HOME: home,
    PARLEY_FAKE_VENDOR_BIN: FAKE_VENDOR_BIN,
    // Default orchestrator identity so delegate tests need not set it; a test
    // exercising the required-session rule overrides it via extraEnv.
    PARLEY_SESSION_ID: "test-orch-session",
    ...extraEnv,
  };
  if (env.NO_COLOR !== undefined && env.FORCE_COLOR !== undefined) {
    delete env.NO_COLOR;
  }
  return env;
}

export function runCli(args: string[], home: string, options: CliOptions = {}): Promise<CliResult> {
  return startCli(args, home, options).result;
}

/**
 * Spawn a parley CLI invocation and return the live child plus a promise for
 * its result — for commands that stream (e.g. `logs --follow`).
 */
export function startCli(
  args: string[],
  home: string,
  options: CliOptions = {},
): { child: ReturnType<typeof spawn>; result: Promise<CliResult>; stdoutSoFar: () => string } {
  const child = spawn(process.execPath, ["--import", TSX_LOADER, CLI_ENTRY, ...args], {
    cwd: options.cwd,
    env: cliEnv(home, options.extraEnv),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout!.on("data", (d: Buffer) => (stdout += d.toString()));
  child.stderr!.on("data", (d: Buffer) => (stderr += d.toString()));
  const result = new Promise<CliResult>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
  return { child, result, stdoutSoFar: () => stdout };
}

/** Single-quote a string for safe interpolation into a `bash -c` command. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Run the CLI with its stdout piped into `downstream` (e.g. `head -1`) via a
 * real shell pipeline — the only way to reproduce a downstream reader closing
 * the pipe early (EPIPE). Exit code is the *left* side's (parley's), via
 * bash's `PIPESTATUS`, not `downstream`'s.
 */
export function runCliPiped(
  args: string[],
  home: string,
  downstream: string,
  options: CliOptions = {},
): Promise<{ code: number | null; stderr: string }> {
  const cliCmd = [process.execPath, "--import", TSX_LOADER, CLI_ENTRY, ...args]
    .map(shellQuote)
    .join(" ");
  const child = spawn("bash", ["-c", `${cliCmd} | ${downstream}; exit "\${PIPESTATUS[0]}"`], {
    cwd: options.cwd,
    env: cliEnv(home, options.extraEnv),
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr!.on("data", (d: Buffer) => (stderr += d.toString()));
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stderr }));
  });
}

/**
 * Fake-vendor action script (see fake-vendor.mjs for the action vocabulary).
 */
export type FakeVendorAction = Record<string, unknown>;

/**
 * Create a task working directory containing a `.fake-vendor.json` script that
 * drives the fake vendor's behavior for that task. `resumeActions`, when given,
 * are written as `.fake-vendor.resume.json` — the script the fake vendor runs
 * when respawned via the adapter's `resume()` (stall/crash recovery, #18).
 */
export function makeTaskDir(
  actions: FakeVendorAction[],
  resumeActions?: FakeVendorAction[],
): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "parley-task-"));
  fs.writeFileSync(path.join(dir, ".fake-vendor.json"), JSON.stringify(actions, null, 2));
  if (resumeActions !== undefined) {
    fs.writeFileSync(
      path.join(dir, ".fake-vendor.resume.json"),
      JSON.stringify(resumeActions, null, 2),
    );
  }
  return dir;
}

/**
 * Create a real git repository (the only worktree fixture the suite uses). The
 * fake vendor's action script is committed as `.fake-vendor.json` so it appears
 * in any parley worktree cut from HEAD; `files` adds extra committed content
 * (e.g. `CLAUDE.md`, `.claude/skills/…`). Returns the repo's absolute path.
 */
export function makeGitRepo(
  actions: FakeVendorAction[],
  files: Record<string, string> = {},
): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "parley-repo-"));
  const run = (args: string[]): void => {
    execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  };
  run(["init", "-b", "main"]);
  run(["config", "user.email", "test@parley.test"]);
  run(["config", "user.name", "parley test"]);
  writeFiles(dir, { ".fake-vendor.json": JSON.stringify(actions, null, 2), ...files });
  run(["add", "-A"]);
  run(["commit", "-m", "initial"]);
  return dir;
}

/** Write a set of `relative path → contents` files under `dir`, making dirs. */
export function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [rel, contents] of Object.entries(files)) {
    const target = path.join(dir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
  }
}

/** Run a git command in `dir` and return trimmed stdout. */
export function git(dir: string, args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
}

/** Poll a predicate until it holds or the deadline passes. */
export async function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for: ${message}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/**
 * Read the fake vendor child's pid from the `hello` event it emits first thing
 * on spawn (captured in the task's raw vendor log). Polls: the child writes it
 * asynchronously right after spawn.
 */
export async function waitForChildPid(
  home: string,
  taskId: string,
  timeoutMs = 10_000,
): Promise<number> {
  const logPath = path.join(home, "tasks", taskId, "vendor.jsonl");
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const line = fs
        .readFileSync(logPath, "utf8")
        .split("\n")
        .find((l) => l.includes('"hello"'));
      if (line) {
        const hello = JSON.parse(line) as { pid?: number };
        if (typeof hello.pid === "number") return hello.pid;
      }
    } catch {
      /* log not written yet */
    }
    if (Date.now() >= deadline) {
      throw new Error(`no fake-vendor hello pid for ${taskId} within ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Poll until a pid is gone; throws if it is still alive at the deadline. */
export async function waitUntilDead(pid: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (isAlive(pid)) {
    if (Date.now() >= deadline) {
      throw new Error(`process ${pid} still alive after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Poll `parley status <task> --json` until the task reaches `state`. */
export async function waitForState(
  home: string,
  task: string,
  state: string,
  timeoutMs = 15_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await runCli(["status", task, "--json"], home);
    const row = JSON.parse(res.stdout) as Record<string, unknown> | null;
    if (row && row.state === state) return row;
    if (Date.now() >= deadline) {
      throw new Error(
        `task ${task} did not reach state ${state} within ${timeoutMs}ms (last: ${JSON.stringify(row)})`,
      );
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * Run `parley watch … --json` once and parse the inbox event. Used by tests
 * that previously relied on `delegate --wait` / `answer --wait` (ADR-0008).
 */
export async function watchJson(
  home: string,
  args: string[] = [],
): Promise<{
  code: number;
  stderr: string;
  event: string | null;
  seq: number | null;
  task: Record<string, unknown> | null;
  raw: string;
}> {
  const res = await runCli(["watch", ...args, "--json"], home);
  if (res.code === 0 || res.stdout.trim() === "") {
    return { code: res.code, stderr: res.stderr, event: null, seq: null, task: null, raw: res.stdout };
  }
  const body = JSON.parse(res.stdout) as {
    event: string;
    seq: number;
    task: Record<string, unknown>;
  };
  return {
    code: res.code,
    stderr: res.stderr,
    event: body.event,
    seq: body.seq,
    task: body.task,
    raw: res.stdout,
  };
}

/**
 * Delegate (always async) then poll until `state`. Returns the pending ack and
 * the status row at the target state — the post-ADR-0008 stand-in for most
 * former `delegate --wait` call sites that only needed a mid-flight or
 * terminal state.
 */
export async function delegateUntil(
  home: string,
  args: string[],
  state: string,
  options: CliOptions & { timeoutMs?: number } = {},
): Promise<{ ack: Record<string, unknown>; row: Record<string, unknown> }> {
  const { timeoutMs, ...cliOpts } = options;
  const res = await runCli(args, home, cliOpts);
  if (res.code !== 0) {
    throw new Error(`delegate exited ${res.code}: ${res.stderr}\n${res.stdout}`);
  }
  const ack = JSON.parse(res.stdout) as Record<string, unknown>;
  const row = await waitForState(home, String(ack.task_id), state, timeoutMs);
  return { ack, row };
}

/** Create a fresh isolated parley home directory. */
export function makeHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "parley-test-"));
}

interface Discovery {
  port: number;
  pid: number;
  started_at: string;
}

export function readDiscovery(home: string): Discovery | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(home, "daemon.json"), "utf8")) as Discovery;
  } catch {
    return null;
  }
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Kill any daemon this home spawned and remove the directory. */
export function cleanupHome(home: string): void {
  const discovery = readDiscovery(home);
  if (discovery && isAlive(discovery.pid)) {
    try {
      // The daemon is a session/process-group leader (spawned detached) and its
      // vendor children share the group — kill the whole group so no test child
      // outlives its daemon. Fall back to the pid alone if the group is gone.
      process.kill(-discovery.pid, "SIGKILL");
    } catch {
      try {
        process.kill(discovery.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }
  fs.rmSync(home, { recursive: true, force: true });
}

export function writeStaleDiscovery(home: string, port = 59999): number {
  // Pick a pid that is (almost certainly) not a live process.
  const deadPid = 2_147_483_646;
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(
    path.join(home, "daemon.json"),
    JSON.stringify({ port, pid: deadPid, started_at: new Date().toISOString() }),
  );
  return deadPid;
}
