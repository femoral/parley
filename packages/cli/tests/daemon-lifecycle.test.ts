import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupHome,
  isAlive,
  makeHome,
  readDiscovery,
  runCli,
  waitUntilDead,
  waitFor,
} from "./helpers.js";

const DAEMON_ENTRY = fileURLToPath(new URL("../../daemon/src/main.ts", import.meta.url));
const TSX_LOADER = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;

/**
 * Run the daemon entry directly — the rogue-start shape from the #130
 * incident: a dev-mode `tsx` daemon launched from a checkout, bypassing the
 * CLI entirely. Enforcement must live in the daemon itself to catch this.
 */
function runDaemonEntry(
  home: string,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<{ code: number; stderr: string }> {
  const child = spawn(
    process.execPath,
    ["--import", TSX_LOADER, DAEMON_ENTRY],
    {
      env: {
        ...process.env,
        PARLEY_HOME: home,
        PARLEY_DAEMON_ID: `test-${path.basename(home)}`,
        ...extraEnv,
      },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  let stderr = "";
  child.stderr!.on("data", (d: Buffer) => (stderr += d.toString()));
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stderr }));
  });
}

describe("daemon lifecycle (#130)", () => {
  const homes: string[] = [];
  const home = (): string => {
    const h = makeHome();
    homes.push(h);
    return h;
  };
  afterEach(() => {
    for (const h of homes.splice(0)) cleanupHome(h);
  });

  it("advertises identity in discovery, status, and status --json", async () => {
    const h = home();
    expect((await runCli(["daemon", "start"], h)).code).toBe(0);

    const discovery = readDiscovery(h)!;
    expect(discovery.instance_id).toMatch(/[0-9a-f-]{36}/);
    expect(discovery.home).toBe(h);
    expect(typeof discovery.version).toBe("string");
    expect(discovery.provenance).toBe("source"); // dev workspace runs src/main.ts
    expect(String(discovery.entry)).toMatch(/main\.ts$/);
    expect(discovery.daemon_id).toBe(`test-${path.basename(h)}`);

    const status = await runCli(["daemon", "status"], h);
    expect(status.code).toBe(0);
    expect(status.stdout).toMatch(/id {10}[0-9a-f-]{36}/);
    expect(status.stdout).toMatch(/home {8}/);
    expect(status.stdout).toMatch(/version .*\(source\)/);
    expect(status.stdout).toMatch(/daemon id {3}test-/);

    const json = JSON.parse((await runCli(["daemon", "status", "--json"], h)).stdout) as Record<
      string,
      unknown
    >;
    expect(json.running).toBe(true);
    expect(json.instance_id).toBe(discovery.instance_id);
    expect(json.provenance).toBe("source");
  });

  it("refuses a rogue second daemon start against the same home", async () => {
    const h = home();
    expect((await runCli(["daemon", "start"], h)).code).toBe(0);
    const first = readDiscovery(h)!;

    const rogue = await runDaemonEntry(h);
    expect(rogue.code).toBe(11);
    expect(rogue.stderr).toMatch(/already running/);
    expect(rogue.stderr).toMatch(/--replace/);

    // The incumbent's registration is untouched and it is still alive.
    expect(readDiscovery(h)!.pid).toBe(first.pid);
    expect(isAlive(first.pid)).toBe(true);
  });

  it("daemon start --replace takes over and the incumbent exits", async () => {
    const h = home();
    expect((await runCli(["daemon", "start"], h)).code).toBe(0);
    const first = readDiscovery(h)!;

    const replaced = await runCli(["daemon", "start", "--replace", "--json"], h);
    expect(replaced.code).toBe(0);
    const ack = JSON.parse(replaced.stdout) as { started: boolean; replaced: boolean; pid: number };
    expect(ack.started).toBe(true);
    expect(ack.replaced).toBe(true);
    expect(ack.pid).not.toBe(first.pid);

    await waitUntilDead(first.pid);
    // The successor owns the registration.
    expect(readDiscovery(h)!.pid).toBe(ack.pid);
    expect(isAlive(ack.pid)).toBe(true);
  });

  it("a daemon that loses its registration exits without clearing the successor's record", async () => {
    const h = home();
    // Tight registration poll so the loss is noticed quickly.
    expect(
      (await runCli(["daemon", "start"], h, { extraEnv: { PARLEY_REGISTRATION_POLL_MS: "100" } }))
        .code,
    ).toBe(0);
    const first = readDiscovery(h)!;

    // Simulate a takeover by a foreign instance: overwrite the registration.
    // The pid is deliberately a dead one — the watcher compares instance ids,
    // and cleanup must never group-kill a pid we don't own.
    const foreign = { ...first, pid: 2_147_483_646, instance_id: "foreign-instance" };
    fs.writeFileSync(path.join(h, "daemon.json"), JSON.stringify(foreign));

    await waitUntilDead(first.pid);
    // The loser must not have deleted the successor's registration on its way out.
    expect(readDiscovery(h)!.instance_id).toBe("foreign-instance");
  });

  it("never attaches across a PARLEY_DAEMON_ID boundary", async () => {
    const h = home();
    expect((await runCli(["daemon", "start"], h)).code).toBe(0);
    const pid = readDiscovery(h)!.pid;

    // A CLI with a different isolation id sees no attachable daemon...
    const status = await runCli(["daemon", "status"], h, {
      extraEnv: { PARLEY_DAEMON_ID: "someone-else" },
    });
    expect(status.stdout).toMatch(/not running/);
    expect(status.stderr).toMatch(/different isolation id/);

    // ...and cannot stop the foreign daemon.
    const stop = await runCli(["daemon", "stop"], h, {
      extraEnv: { PARLEY_DAEMON_ID: "someone-else" },
    });
    expect(stop.stderr).toMatch(/different isolation id/);
    expect(isAlive(pid)).toBe(true);
    // Regression (#130): the refused stop must not have cleared the foreign
    // daemon's registration — that would orphan it (its watcher would exit it,
    // but cleanup by discovery would no longer find it).
    expect(readDiscovery(h)).not.toBeNull();
    expect(readDiscovery(h)!.pid).toBe(pid);
  });

  it("arms the registration watcher by default (no env overrides)", async () => {
    const h = home();
    expect((await runCli(["daemon", "start"], h)).code).toBe(0);
    const pid = readDiscovery(h)!.pid;

    // Deleting the registration with lifecycle env UNSET must still be noticed
    // — regression for Number("") === 0 silently disabling the defaults.
    fs.rmSync(path.join(h, "daemon.json"));
    await waitUntilDead(pid, 15_000);
  });

  it("shuts itself down after the idle window and clears discovery", async () => {
    const h = home();
    expect(
      (await runCli(["daemon", "start"], h, { extraEnv: { PARLEY_IDLE_TIMEOUT_MS: "500" } })).code,
    ).toBe(0);
    const pid = readDiscovery(h)!.pid;
    expect(isAlive(pid)).toBe(true);

    await waitUntilDead(pid);
    await waitFor(() => readDiscovery(h) === null, "discovery cleared after idle exit");
  });
});
