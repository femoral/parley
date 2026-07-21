/**
 * #154 — launch_command + model/effort source tracking at the CLI seam.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  cleanupHome,
  makeHome,
  makeTaskDir,
  runCli,
  waitForState,
  withFakeAllowlist,
  type FakeVendorAction,
} from "./helpers.js";

let home: string;
const taskDirs: string[] = [];

beforeEach(() => {
  home = makeHome();
});

afterEach(() => {
  cleanupHome(home);
  for (const dir of taskDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function taskDir(actions: FakeVendorAction[], resumeActions?: FakeVendorAction[]): string {
  const dir = makeTaskDir(actions, resumeActions);
  taskDirs.push(dir);
  return dir;
}

const REPORT = { summary: "did it", outcome: "success", files_changed: ["a.ts"] };

describe("launch_command + model/effort traceability (#154)", () => {
  it("status --json shows launch_command with elided prompt and env names only", async () => {
    const cwd = taskDir([
      { emit: { type: "session", session_id: "s1" } },
      { submit_report: REPORT },
    ]);
    const delegated = await runCli(
      [
        "delegate",
        "-v",
        "fake",
        "-m",
        "fake-model",
        "--effort",
        "high",
        "--cwd",
        cwd,
        "-n",
        "trace",
        "do secret work",
      ],
      home,
    );
    expect(delegated.code).toBe(0);
    await waitForState(home, "t1", "completed");

    const status = await runCli(["status", "t1", "--json"], home);
    expect(status.code).toBe(0);
    const row = JSON.parse(status.stdout) as {
      model: string | null;
      effort: string | null;
      model_source: string | null;
      effort_source: string | null;
      launch_command: Array<{ argv: string[]; cwd: string; env_names: string[] }> | null;
      prompt: string;
    };

    expect(row.model).toBe("fake-model");
    expect(row.effort).toBe("high");
    expect(row.model_source).toBe("resolved");
    expect(row.effort_source).toBe("resolved");

    expect(Array.isArray(row.launch_command)).toBe(true);
    expect(row.launch_command).toHaveLength(1);
    const launch = row.launch_command![0]!;
    expect(launch.cwd).toBe(cwd);
    // Prompt slot is the placeholder, never the real brief or preamble.
    expect(launch.argv).toContain("<prompt>");
    expect(launch.argv.join(" ")).not.toContain("do secret work");
    expect(launch.argv.join(" ")).not.toContain("Parley protocol");
    // Env names only — values from the spawn overlay must not appear.
    expect(launch.env_names).toEqual(expect.arrayContaining(["PARLEY_HUB_URL", "PARLEY_TASK_ID"]));
    expect(launch.env_names).toEqual(expect.arrayContaining(["FAKE_MODEL", "FAKE_EFFORT"]));
    // Env *values* must never appear — only the key names above.
    const dump = JSON.stringify(row.launch_command);
    expect(dump).not.toContain("do secret work");
    expect(dump).not.toMatch(/"FAKE_MODEL"\s*:/);
  });

  it("parley logs prints a launch_command header line", async () => {
    const cwd = taskDir([
      { emit: { type: "session", session_id: "s1" } },
      { submit_report: REPORT },
    ]);
    await runCli(
      [
        "delegate",
        "-v",
        "fake",
        "-m",
        "m1",
        "--effort",
        "low",
        "--cwd",
        cwd,
        "-n",
        "logs-trace",
        "run",
      ],
      home,
    );
    await waitForState(home, "t1", "completed");

    const logs = await runCli(["logs", "t1"], home);
    expect(logs.code).toBe(0);
    const firstLine = logs.stdout.split("\n")[0] ?? "";
    expect(firstLine.startsWith("# launch_command ")).toBe(true);
    const payload = JSON.parse(firstLine.slice("# launch_command ".length)) as Array<{
      argv: string[];
      cwd: string;
      env_names: string[];
    }>;
    expect(payload).toHaveLength(1);
    expect(payload[0]!.argv).toContain("<prompt>");
    expect(payload[0]!.cwd).toBe(cwd);
    expect(payload[0]!.env_names).toContain("PARLEY_TASK_ID");
  });

  it("vendor-reported model/effort upgrade source to vendor", async () => {
    const cwd = taskDir([
      {
        emit: {
          type: "session",
          session_id: "s-vendor",
          model: "stream-model",
          effort: "xhigh",
        },
      },
      { submit_report: REPORT },
    ]);
    await runCli(
      [
        "delegate",
        "-v",
        "fake",
        "-m",
        "request-model",
        "--effort",
        "low",
        "--cwd",
        cwd,
        "-n",
        "upgrade",
        "run",
      ],
      home,
    );
    await waitForState(home, "t1", "completed");

    const status = await runCli(["status", "t1", "--json"], home);
    const row = JSON.parse(status.stdout) as {
      model: string | null;
      effort: string | null;
      model_source: string | null;
      effort_source: string | null;
    };
    expect(row.model).toBe("stream-model");
    expect(row.effort).toBe("xhigh");
    expect(row.model_source).toBe("vendor");
    expect(row.effort_source).toBe("vendor");
  });

  it("profile-only model/effort are resolved with source=resolved", async () => {
    fs.writeFileSync(
      path.join(home, "parley.json"),
      JSON.stringify(
        withFakeAllowlist({
          profiles: {
            deep: { vendor: "fake", model: "from-profile", effort: "medium" },
          },
        }),
      ),
    );
    const cwd = taskDir([
      { emit: { type: "session", session_id: "s" } },
      { submit_report: REPORT },
    ]);
    const res = await runCli(
      ["delegate", "--profile", "deep", "--cwd", cwd, "-n", "prof", "run"],
      home,
    );
    expect(res.code).toBe(0);
    await waitForState(home, "t1", "completed");

    const status = await runCli(["status", "t1", "--json"], home);
    const row = JSON.parse(status.stdout) as {
      model: string | null;
      effort: string | null;
      model_source: string | null;
      effort_source: string | null;
      profile: string | null;
    };
    expect(row.profile).toBe("deep");
    expect(row.model).toBe("from-profile");
    expect(row.effort).toBe("medium");
    expect(row.model_source).toBe("resolved");
    expect(row.effort_source).toBe("resolved");
  });

  it("resume appends a second launch_command entry", async () => {
    const cwd = taskDir(
      [{ emit: { type: "session", session_id: "s-resume" } }, { ask: "which?" }],
      [{ emit: { type: "progress", note: "ok" } }, { submit_report: REPORT }],
    );
    await runCli(
      [
        "delegate",
        "-v",
        "fake",
        "--cwd",
        cwd,
        "--answer-timeout",
        "250ms",
        "-n",
        "spawn-twice",
        "run",
      ],
      home,
    );
    await waitForState(home, "t1", "stalled");

    const mid = await runCli(["status", "t1", "--json"], home);
    const midRow = JSON.parse(mid.stdout) as {
      launch_command: unknown[] | null;
    };
    expect(midRow.launch_command).toHaveLength(1);

    const answer = await runCli(["answer", "t1", "postgres"], home);
    expect(answer.code).toBe(0);
    await waitForState(home, "t1", "completed");

    const final = await runCli(["status", "t1", "--json"], home);
    const row = JSON.parse(final.stdout) as {
      launch_command: Array<{ argv: string[] }> | null;
    };
    expect(row.launch_command).toHaveLength(2);
    for (const entry of row.launch_command ?? []) {
      expect(entry.argv).toContain("<prompt>");
    }
  });
});
