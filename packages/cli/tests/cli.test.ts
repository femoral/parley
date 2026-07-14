import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  cleanupHome,
  isAlive,
  makeHome,
  readDiscovery,
  runCli,
  writeStaleDiscovery,
} from "./helpers.js";

let home: string;

beforeEach(() => {
  home = makeHome();
});

afterEach(() => {
  cleanupHome(home);
});

describe("parley daemon lifecycle", () => {
  it("start starts exactly one daemon; a second start is refused cleanly", async () => {
    const first = await runCli(["daemon", "start"], home);
    expect(first.code).toBe(0);
    expect(first.stdout).toMatch(/started/);

    const discovery = readDiscovery(home);
    expect(discovery).not.toBeNull();
    expect(isAlive(discovery!.pid)).toBe(true);
    const firstPid = discovery!.pid;

    const second = await runCli(["daemon", "start"], home);
    expect(second.code).toBe(0);
    expect(second.stdout).toMatch(/already running/);

    // Same daemon — no second process was spawned.
    expect(readDiscovery(home)!.pid).toBe(firstPid);
  });

  it("daemon status reports port/pid; stop shuts down and clears discovery", async () => {
    await runCli(["daemon", "start"], home);
    const discovery = readDiscovery(home)!;

    const status = await runCli(["daemon", "status"], home);
    expect(status.code).toBe(0);
    expect(status.stdout).toContain(String(discovery.pid));
    expect(status.stdout).toContain(String(discovery.port));

    const stop = await runCli(["daemon", "stop"], home);
    expect(stop.code).toBe(0);
    expect(isAlive(discovery.pid)).toBe(false);
    expect(fs.existsSync(path.join(home, "daemon.json"))).toBe(false);

    const afterStop = await runCli(["daemon", "status"], home);
    expect(afterStop.code).toBe(0);
    expect(afterStop.stdout).toMatch(/not running/);
  });

  it("daemon status --json emits valid JSON in both states", async () => {
    const stopped = await runCli(["daemon", "status", "--json"], home);
    expect(stopped.code).toBe(0);
    expect(JSON.parse(stopped.stdout)).toEqual({ running: false });

    await runCli(["daemon", "start"], home);
    const running = await runCli(["daemon", "status", "--json"], home);
    const parsed = JSON.parse(running.stdout);
    expect(parsed.running).toBe(true);
    expect(typeof parsed.port).toBe("number");
    expect(typeof parsed.pid).toBe("number");
  });
});

describe("version", () => {
  it.each(["--version", "-V"])("%s prints one line without spawning the daemon", async (flag) => {
    const result = await runCli([flag], home);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toMatch(/^parley \S+\r?\n$/);
    expect(readDiscovery(home)).toBeNull();
  });
});

describe("auto-spawn", () => {
  it("a CLI command against a dead daemon auto-spawns it", async () => {
    expect(readDiscovery(home)).toBeNull();

    const result = await runCli(["status"], home);
    expect(result.code).toBe(0);

    const discovery = readDiscovery(home);
    expect(discovery).not.toBeNull();
    expect(isAlive(discovery!.pid)).toBe(true);
  });

  it("is lock-guarded: parallel invocations converge on one daemon, no races", async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, () => runCli(["status"], home)),
    );

    for (const r of results) {
      expect(r.code).toBe(0);
    }

    const discovery = readDiscovery(home);
    expect(discovery).not.toBeNull();
    expect(isAlive(discovery!.pid)).toBe(true);

    // Exactly one live daemon: any other spawned candidate must have exited.
    // We assert by confirming the lock is released and the single advertised
    // pid is the only survivor responding on its port.
    const res = await fetch(`http://127.0.0.1:${discovery!.port}/health`);
    const body = (await res.json()) as { pid: number };
    expect(body.pid).toBe(discovery!.pid);
    expect(fs.existsSync(path.join(home, "daemon.lock"))).toBe(false);
  });

  it("detects and replaces a stale discovery file (dead pid)", async () => {
    const deadPid = writeStaleDiscovery(home);
    expect(isAlive(deadPid)).toBe(false);

    const result = await runCli(["status"], home);
    expect(result.code).toBe(0);

    const discovery = readDiscovery(home);
    expect(discovery).not.toBeNull();
    expect(discovery!.pid).not.toBe(deadPid);
    expect(isAlive(discovery!.pid)).toBe(true);
  });
});

describe("status / list", () => {
  it("status exits 0 with an empty listing", async () => {
    const result = await runCli(["status"], home);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/No tasks/);
  });

  it("bare invocation lists tasks (alias for status)", async () => {
    const result = await runCli([], home);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/No tasks/);
  });

  it("status --json emits valid JSON (empty array)", async () => {
    const result = await runCli(["status", "--json"], home);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([]);
  });

  it("list --json emits valid JSON (empty array)", async () => {
    const result = await runCli(["list", "--json"], home);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([]);
  });

  it("initializes the SQLite task store on first start", async () => {
    await runCli(["status"], home);
    expect(fs.existsSync(path.join(home, "parley.db"))).toBe(true);
  });
});

describe("usage errors", () => {
  it("unknown command exits 2", async () => {
    const result = await runCli(["frobnicate"], home);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/unknown command/);
  });

  it("unknown flag exits 2", async () => {
    const result = await runCli(["status", "--nope"], home);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/unknown flag/);
  });

  it("unknown daemon subcommand exits 2", async () => {
    const result = await runCli(["daemon", "frobnicate"], home);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/unknown daemon subcommand/);
  });

  it("bare daemon (no subcommand) exits 2", async () => {
    const result = await runCli(["daemon"], home);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/usage/);
  });
});
