/**
 * CLI integration: `parley config` admin surface against a real daemon (#156).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  cleanupHome,
  makeHome,
  makeTaskDir,
  runCli,
  waitForState,
  type FakeVendorAction,
} from "./helpers.js";

let home: string;
const taskDirs: string[] = [];
const tempFiles: string[] = [];

beforeEach(() => {
  // Config suite asserts empty/seeded home files; do not auto-seed allowlist.
  home = makeHome({ seedAllowlist: false });
});

afterEach(() => {
  cleanupHome(home);
  for (const dir of taskDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  for (const file of tempFiles.splice(0)) {
    fs.rmSync(file, { recursive: true, force: true });
  }
});

function taskDir(actions: FakeVendorAction[]): string {
  const dir = makeTaskDir(actions);
  taskDirs.push(dir);
  return dir;
}

function tempJson(body: unknown): string {
  const file = path.join(os.tmpdir(), `parley-cfg-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify(body, null, 2));
  tempFiles.push(file);
  return file;
}

describe("parley config show / get / set / unset", () => {
  it("show returns {} when no config exists yet", async () => {
    const res = await runCli(["config", "show", "--json"], home);
    expect(res.code).toBe(0);
    expect(JSON.parse(res.stdout)).toEqual({});
  });

  it("set/get/unset round-trip a dotted key", async () => {
    const set = await runCli(["config", "set", "daemon.idleTimeoutMs", "0"], home);
    expect(set.code).toBe(0);
    expect(set.stdout).toMatch(/set daemon\.idleTimeoutMs/);

    const get = await runCli(["config", "get", "daemon.idleTimeoutMs", "--json"], home);
    expect(get.code).toBe(0);
    expect(JSON.parse(get.stdout)).toEqual({ key: "daemon.idleTimeoutMs", value: 0 });

    const show = await runCli(["config", "show", "--json"], home);
    expect(JSON.parse(show.stdout)).toEqual({ daemon: { idleTimeoutMs: 0 } });

    const unset = await runCli(["config", "unset", "daemon.idleTimeoutMs"], home);
    expect(unset.code).toBe(0);

    const gone = await runCli(["config", "get", "daemon.idleTimeoutMs"], home);
    expect(gone.code).toBe(1);
    expect(gone.stderr).toMatch(/no such config key: daemon\.idleTimeoutMs/);
  });

  it("rejects an invalid set with the field named and applies nothing", async () => {
    // Prefer a key that does not redirect ensureDaemon (unlike daemon.url).
    const ok = await runCli(["config", "set", "vendors.fake.bin", "fake-bin"], home);
    expect(ok.code).toBe(0);

    // Use a non-flag-shaped invalid value ("-1" would be parsed as an unknown flag).
    const bad = await runCli(["config", "set", "daemon.idleTimeoutMs", "nope"], home);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toMatch(/daemon\.idleTimeoutMs/);
    expect(bad.stderr).toMatch(/non-negative integer/);

    // Prior valid value still present — nothing partially applied.
    const get = await runCli(["config", "get", "vendors.fake.bin"], home);
    expect(get.code).toBe(0);
    expect(get.stdout.trim()).toBe("fake-bin");

    const missing = await runCli(["config", "get", "daemon.idleTimeoutMs"], home);
    expect(missing.code).toBe(1);
  });

  it("set accepts nested profile objects via JSON", async () => {
    const set = await runCli(
      ["config", "set", "profiles.fast", '{"vendor":"fake","model":"m1"}'],
      home,
    );
    expect(set.code).toBe(0);
    const get = await runCli(["config", "get", "profiles.fast", "--json"], home);
    expect(JSON.parse(get.stdout).value).toEqual({ vendor: "fake", model: "m1" });
  });
});

describe("parley config push / pull", () => {
  it("push rejects invalid config wholesale with the field named", async () => {
    const file = tempJson({ daemon: { idleTimeoutMs: "nope" } });
    const push = await runCli(["config", "push", file], home);
    expect(push.code).toBe(1);
    expect(push.stderr).toMatch(/daemon\.idleTimeoutMs/);

    const show = await runCli(["config", "show", "--json"], home);
    expect(JSON.parse(show.stdout)).toEqual({});
  });

  it("pull → edit → push round-trips preserving unknown keys", async () => {
    // Seed via push with known + unknown keys.
    const seed = tempJson({
      experimental: true,
      daemon: { idleTimeoutMs: 0 },
      ui: { path: "/tmp/ui-bundle", theme: "dark" },
      vendors: { fake: { bin: "fake", extra: 1 } },
    });
    const push1 = await runCli(["config", "push", seed], home);
    expect(push1.code).toBe(0);
    expect(push1.stderr).toMatch(/unknown config key preserved: experimental/);
    expect(push1.stderr).toMatch(/unknown config key preserved: ui\.theme/);
    expect(push1.stderr).toMatch(/unknown config key preserved: vendors\.fake\.extra/);

    const pullFile = path.join(home, "pulled.json");
    const pull = await runCli(["config", "pull", pullFile], home);
    expect(pull.code).toBe(0);
    expect(fs.existsSync(pullFile)).toBe(true);

    const pulled = JSON.parse(fs.readFileSync(pullFile, "utf8")) as Record<string, unknown>;
    expect(pulled.experimental).toBe(true);
    expect((pulled.ui as { theme: string }).theme).toBe("dark");
    expect((pulled.vendors as { fake: { extra: number } }).fake.extra).toBe(1);

    // Edit a known field; leave unknowns alone.
    (pulled.daemon as { idleTimeoutMs: number }).idleTimeoutMs = 120_000;
    fs.writeFileSync(pullFile, JSON.stringify(pulled, null, 2));

    const push2 = await runCli(["config", "push", pullFile], home);
    expect(push2.code).toBe(0);
    expect(push2.stderr).toMatch(/experimental/);

    const show = JSON.parse((await runCli(["config", "show", "--json"], home)).stdout) as {
      experimental: boolean;
      daemon: { idleTimeoutMs: number };
      ui: { path: string; theme: string };
      vendors: { fake: { bin: string; extra: number } };
    };
    expect(show.experimental).toBe(true);
    expect(show.daemon.idleTimeoutMs).toBe(120_000);
    expect(show.ui.theme).toBe("dark");
    expect(show.vendors.fake.extra).toBe(1);
    expect(show.vendors.fake.bin).toBe("fake");
  });

  it("pull without a file writes JSON to stdout", async () => {
    await runCli(["config", "set", "daemon.idleTimeoutMs", "0"], home);
    const pull = await runCli(["config", "pull"], home);
    expect(pull.code).toBe(0);
    expect(JSON.parse(pull.stdout)).toEqual({ daemon: { idleTimeoutMs: 0 } });
  });
});

describe("parley config hot apply", () => {
  it("a profile set via config is used by the next delegate without restart", async () => {
    // Ensure the daemon is up first so set and delegate share one process.
    expect((await runCli(["daemon", "start"], home)).code).toBe(0);

    // Deny-by-default: allowlist + profile combo must be written before delegate.
    const setModels = await runCli(
      [
        "config",
        "set",
        "vendors.fake.models",
        JSON.stringify({
          "m-hot": { efforts: ["low", "medium", "high"], default: "medium" },
        }),
      ],
      home,
    );
    expect(setModels.code).toBe(0);
    const setVendor = await runCli(["config", "set", "profiles.hot.vendor", "fake"], home);
    expect(setVendor.code).toBe(0);
    const setModel = await runCli(["config", "set", "profiles.hot.model", "m-hot"], home);
    expect(setModel.code).toBe(0);
    const setEffort = await runCli(["config", "set", "profiles.hot.effort", "low"], home);
    expect(setEffort.code).toBe(0);

    const cwd = taskDir([
      {
        submit_report: {
          summary: "done",
          outcome: "success",
          files_changed: [],
        },
      },
    ]);
    const delegate = await runCli(["delegate", "--profile", "hot", "--cwd", cwd, "do it"], home);
    expect(delegate.code).toBe(0);
    const taskId = JSON.parse(delegate.stdout).task_id as string;

    const row = await waitForState(home, taskId, "completed");
    expect(row.profile).toBe("hot");
    expect(row.vendor).toBe("fake");
    expect(row.model).toBe("m-hot");
  });
});

describe("parley config usage errors (exit 2)", () => {
  it("rejects unknown subcommand", async () => {
    const res = await runCli(["config", "nope"], home);
    expect(res.code).toBe(2);
    expect(res.stderr).toMatch(/unknown subcommand/);
  });

  it("rejects get without a key", async () => {
    const res = await runCli(["config", "get"], home);
    expect(res.code).toBe(2);
    expect(res.stderr).toMatch(/dotted key/);
  });

  it("rejects set without a value", async () => {
    const res = await runCli(["config", "set", "daemon.url"], home);
    expect(res.code).toBe(2);
    expect(res.stderr).toMatch(/value is required/);
  });

  it("rejects push without a file", async () => {
    const res = await runCli(["config", "push"], home);
    expect(res.code).toBe(2);
    expect(res.stderr).toMatch(/file path/);
  });
});
