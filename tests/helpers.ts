import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLI_ENTRY = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));
// `--import tsx` resolves from the child's cwd (the repo root under vitest),
// where tsx is installed. Avoids import.meta.resolve, unavailable in SSR transform.
const TSX_LOADER = "tsx";

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
export function runCli(
  args: string[],
  home: string,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<CliResult> {
  return startCli(args, home, extraEnv).result;
}

/**
 * Spawn a parley CLI invocation and return the live child plus a promise for
 * its result — for commands that stream (e.g. `logs --follow`).
 */
export function startCli(
  args: string[],
  home: string,
  extraEnv: NodeJS.ProcessEnv = {},
): { child: ReturnType<typeof spawn>; result: Promise<CliResult>; stdoutSoFar: () => string } {
  const child = spawn(process.execPath, ["--import", TSX_LOADER, CLI_ENTRY, ...args], {
    env: {
      ...process.env,
      PARLEY_HOME: home,
      PARLEY_FAKE_VENDOR_BIN: FAKE_VENDOR_BIN,
      ...extraEnv,
    },
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

/**
 * Fake-vendor action script (see fake-vendor.mjs for the action vocabulary).
 */
export type FakeVendorAction = Record<string, unknown>;

/**
 * Create a task working directory containing a `.fake-vendor.json` script that
 * drives the fake vendor's behavior for that task.
 */
export function makeTaskDir(actions: FakeVendorAction[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "parley-task-"));
  fs.writeFileSync(path.join(dir, ".fake-vendor.json"), JSON.stringify(actions, null, 2));
  return dir;
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
    const rows = JSON.parse(res.stdout) as Record<string, unknown>[];
    const row = rows[0];
    if (row && row.state === state) return row;
    if (Date.now() >= deadline) {
      throw new Error(
        `task ${task} did not reach state ${state} within ${timeoutMs}ms (last: ${JSON.stringify(row)})`,
      );
    }
    await new Promise((r) => setTimeout(r, 100));
  }
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
      process.kill(discovery.pid, "SIGKILL");
    } catch {
      /* already gone */
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
