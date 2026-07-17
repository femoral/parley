/**
 * #151 — work-domain task types end to end: `--type`, project `taskTypes`,
 * list/status TYPE, metrics group-by type. Fake-vendor seam only.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { MetricsResponse } from "@useparley/core";
import { cleanupHome, makeHome, makeTaskDir, runCli } from "./helpers.js";

let home: string;
let taskDir: string;

const REPORT = { summary: "done", outcome: "success", files_changed: [] as string[] };

beforeEach(() => {
  home = makeHome();
  taskDir = makeTaskDir([{ submit_report: REPORT }]);
});

afterEach(() => {
  cleanupHome(home);
  fs.rmSync(taskDir, { recursive: true, force: true });
});

function writeProjectConfig(dir: string, config: unknown): void {
  fs.mkdirSync(path.join(dir, ".parley"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".parley", "config.json"), JSON.stringify(config));
}

describe("delegate --type (#151)", () => {
  it("persists coding and surfaces it on status --json and human list TYPE", async () => {
    const del = await runCli(
      [
        "delegate",
        "--vendor",
        "fake",
        "--cwd",
        taskDir,
        "--type",
        "coding",
        "--name",
        "typed",
        "do the thing",
      ],
      home,
    );
    expect(del.code).toBe(0);
    const ack = JSON.parse(del.stdout) as { task_id: string };
    await runCli(["watch", ack.task_id], home);

    const status = await runCli(["status", ack.task_id, "--json", "--all"], home);
    expect(status.code).toBe(0);
    const row = JSON.parse(status.stdout) as { type: string };
    expect(row.type).toBe("coding");

    const list = await runCli(["list", "--all"], home);
    expect(list.code).toBe(0);
    expect(list.stdout).toMatch(/TYPE/);
    expect(list.stdout).toMatch(/coding/);
  });

  it("omitted --type stores other", async () => {
    const del = await runCli(
      ["delegate", "--vendor", "fake", "--cwd", taskDir, "no type flag"],
      home,
    );
    expect(del.code).toBe(0);
    const ack = JSON.parse(del.stdout) as { task_id: string };
    await runCli(["watch", ack.task_id], home);

    const status = await runCli(["status", ack.task_id, "--json", "--all"], home);
    expect(status.code).toBe(0);
    const row = JSON.parse(status.stdout) as { type: string };
    expect(row.type).toBe("other");
  });

  it("rejects an unknown type with exit 2 listing valid types (never coerces)", async () => {
    const res = await runCli(
      ["delegate", "--vendor", "fake", "--cwd", taskDir, "--type", "not-a-type", "x"],
      home,
    );
    expect(res.code).toBe(2);
    expect(res.stderr).toMatch(/unknown task type: not-a-type/);
    expect(res.stderr).toMatch(/coding/);
    expect(res.stderr).toMatch(/other/);
    // Must not create a task row under a coerced type.
    const list = await runCli(["list", "--all", "--json"], home);
    expect(list.code).toBe(0);
    expect(JSON.parse(list.stdout)).toEqual([]);
  });

  it("accepts a custom type from project taskTypes (rubric mapping)", async () => {
    writeProjectConfig(taskDir, {
      taskTypes: {
        coding: { rubric: "coding" },
        "ops-runbook": { rubric: "generic" },
      },
    });
    const del = await runCli(
      [
        "delegate",
        "--vendor",
        "fake",
        "--cwd",
        taskDir,
        "--type",
        "ops-runbook",
        "custom type work",
      ],
      home,
    );
    expect(del.code).toBe(0);
    const ack = JSON.parse(del.stdout) as { task_id: string };
    await runCli(["watch", ack.task_id], home);

    const status = await runCli(["status", ack.task_id, "--json", "--all"], home);
    const row = JSON.parse(status.stdout) as { type: string };
    expect(row.type).toBe("ops-runbook");
  });

  it("rejects a shipped default type that the project trimmed out", async () => {
    writeProjectConfig(taskDir, {
      taskTypes: {
        coding: "coding",
      },
    });
    const res = await runCli(
      ["delegate", "--vendor", "fake", "--cwd", taskDir, "--type", "design", "x"],
      home,
    );
    expect(res.code).toBe(2);
    expect(res.stderr).toMatch(/unknown task type: design/);
    expect(res.stderr).toMatch(/coding/);
    expect(res.stderr).toMatch(/other/);
    // design must not be listed when the project removed it
    expect(res.stderr).not.toMatch(/\|design\|/);
  });

  it("missing taskTypes section uses shipped defaults (coding still valid)", async () => {
    writeProjectConfig(taskDir, { eval: { expected: false } });
    const del = await runCli(
      ["delegate", "--vendor", "fake", "--cwd", taskDir, "--type", "research", "r"],
      home,
    );
    expect(del.code).toBe(0);
    const ack = JSON.parse(del.stdout) as { task_id: string };
    await runCli(["watch", ack.task_id], home);
    const status = await runCli(["status", ack.task_id, "--json", "--all"], home);
    expect(JSON.parse(status.stdout).type).toBe("research");
  });
});

describe("metrics --group-by type (#151)", () => {
  it("accepts type and buckets by stored type", async () => {
    for (const [name, type] of [
      ["a", "coding"],
      ["b", "writing"],
    ] as const) {
      const dir = makeTaskDir([{ submit_report: REPORT }]);
      const del = await runCli(
        [
          "delegate",
          "--vendor",
          "fake",
          "--cwd",
          dir,
          "--name",
          name,
          "--type",
          type,
          "work",
        ],
        home,
      );
      expect(del.code).toBe(0);
      const ack = JSON.parse(del.stdout) as { task_id: string };
      const watch = await runCli(["watch", ack.task_id], home);
      expect(watch.code).toBe(6);
      fs.rmSync(dir, { recursive: true, force: true });
    }

    const byType = await runCli(["metrics", "--group-by", "type", "--json"], home);
    expect(byType.code).toBe(0);
    const body = JSON.parse(byType.stdout) as MetricsResponse;
    expect(body.groups.map((g) => g.key).sort()).toEqual(["coding", "writing"]);
  });
});
