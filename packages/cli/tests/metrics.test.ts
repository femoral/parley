/**
 * #118 — `parley metrics` CLI + delegate --size/--difficulty flag validation.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { MetricsResponse } from "@useparley/core";
import { makeTaskDir, runCli } from "./helpers.js";

let home: string;
let taskDir: string;

const REPORT = { summary: "done", outcome: "success", files_changed: [] as string[] };

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "parley-cli-metrics-"));
  taskDir = makeTaskDir([{ submit_report: REPORT }]);
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(taskDir, { recursive: true, force: true });
});

describe("delegate --size / --difficulty (#118)", () => {
  it("accepts valid classification flags and surfaces them on status --json", async () => {
    const del = await runCli(
      [
        "delegate",
        "--vendor",
        "fake",
        "--cwd",
        taskDir,
        "--size",
        "M",
        "--difficulty",
        "hard",
        "do the thing",
      ],
      home,
    );
    expect(del.code).toBe(0);
    const ack = JSON.parse(del.stdout) as { task_id: string };
    // Wait for completion so the daemon has fully written the row.
    await runCli(["watch", ack.task_id], home);

    const status = await runCli(["status", ack.task_id, "--json", "--all"], home);
    expect(status.code).toBe(0);
    const row = JSON.parse(status.stdout) as { size: string; difficulty: string };
    expect(row.size).toBe("M");
    expect(row.difficulty).toBe("hard");
  });

  it("rejects invalid --size with exit 2", async () => {
    const res = await runCli(
      ["delegate", "--vendor", "fake", "--cwd", taskDir, "--size", "huge", "x"],
      home,
    );
    expect(res.code).toBe(2);
    expect(res.stderr).toMatch(/invalid --size/);
  });

  it("rejects invalid --difficulty with exit 2", async () => {
    const res = await runCli(
      ["delegate", "--vendor", "fake", "--cwd", taskDir, "--difficulty", "insane", "x"],
      home,
    );
    expect(res.code).toBe(2);
    expect(res.stderr).toMatch(/invalid --difficulty/);
  });
});

describe("parley metrics (#118)", () => {
  it("renders a human table and --json against a test daemon", async () => {
    // Two completed tasks with evals so per-size lines appear under the group.
    for (const [name, size, score] of [
      ["a", "S", "7"],
      ["b", "M", "9"],
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
          "--size",
          size,
          "--difficulty",
          "easy",
          "work",
        ],
        home,
      );
      expect(del.code).toBe(0);
      const ack = JSON.parse(del.stdout) as { task_id: string };
      // Completed tasks surface as watch exit 6 (not all-done 0).
      const watch = await runCli(["watch", ack.task_id], home);
      expect(watch.code).toBe(6);
      const evalRes = await runCli(
        ["eval", ack.task_id, "--score", score, "--feedback", "ok"],
        home,
      );
      expect(evalRes.code).toBe(0);
      fs.rmSync(dir, { recursive: true, force: true });
    }

    const human = await runCli(["metrics"], home);
    expect(human.code).toBe(0);
    expect(human.stderr).toBe("");
    expect(human.stdout).toMatch(/GROUP/);
    expect(human.stdout).toMatch(/fake/);
    expect(human.stdout).toMatch(/evals by size/);
    expect(human.stdout).toMatch(/evals by difficulty/);

    const json = await runCli(["metrics", "--json"], home);
    expect(json.code).toBe(0);
    const body = JSON.parse(json.stdout) as MetricsResponse;
    expect(body.groups.length).toBeGreaterThanOrEqual(1);
    const fake = body.groups.find((g) => g.key === "fake");
    expect(fake).toBeDefined();
    expect(fake!.tasks.completed).toBe(2);
    expect(fake!.success_rate).toBe(1);
    expect(fake!.evals.count).toBe(2);
    expect(fake!.evals.avg).toBe(8);
    expect(typeof body.generated_at).toBe("string");

    const bySize = await runCli(["metrics", "--group-by", "size", "--json"], home);
    expect(bySize.code).toBe(0);
    const sizeBody = JSON.parse(bySize.stdout) as MetricsResponse;
    expect(sizeBody.groups.map((g) => g.key).sort()).toEqual(["M", "S"]);
  });

  it("rejects invalid --group-by with exit 2", async () => {
    const res = await runCli(["metrics", "--group-by", "nope"], home);
    expect(res.code).toBe(2);
    expect(res.stderr).toMatch(/invalid --group-by/);
  });
});
