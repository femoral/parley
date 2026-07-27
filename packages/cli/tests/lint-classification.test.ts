/**
 * #161 — custom classification end-to-end, `parley lint`, and `delegate --dry-run`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { getShippedRubric } from "@useparley/core";
import { cleanupHome, makeHome, makeTaskDir, runCli } from "./helpers.js";

let home: string;
const dirs: string[] = [];

const REPORT = { summary: "done", outcome: "success", files_changed: [] as string[] };

beforeEach(() => {
  home = makeHome();
});

afterEach(() => {
  cleanupHome(home);
  for (const d of dirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

function taskDir(): string {
  const dir = makeTaskDir([{ submit_report: REPORT }]);
  dirs.push(dir);
  return dir;
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function writeClassification(
  dir: string,
  doc: unknown,
): void {
  writeJson(path.join(dir, ".parley", "classification.json"), doc);
}

function writeConfig(dir: string, doc: unknown): void {
  writeJson(path.join(dir, ".parley", "config.json"), doc);
}

describe("custom classification (#161)", () => {
  it("accepts custom size/difficulty ids from classification.json end-to-end", async () => {
    const dir = taskDir();
    writeClassification(dir, {
      version: 1,
      sizes: [
        { id: "tiny", guidance: "A handful of lines." },
        { id: "epic", guidance: "Multi-week." },
      ],
      difficulties: [
        { id: "routine", guidance: "Known path." },
        { id: "hairball", guidance: "Tangled unknowns." },
      ],
    });

    const del = await runCli(
      [
        "delegate",
        "--vendor",
        "fake",
        "--cwd",
        dir,
        "--size",
        "tiny",
        "--difficulty",
        "hairball",
        "custom classification work",
      ],
      home,
    );
    expect(del.code).toBe(0);
    const ack = JSON.parse(del.stdout) as { task_id: string };
    await runCli(["watch", ack.task_id], home);

    const status = await runCli(["status", ack.task_id, "--json", "--all"], home);
    expect(status.code).toBe(0);
    const row = JSON.parse(status.stdout) as { size: string; difficulty: string };
    expect(row.size).toBe("tiny");
    expect(row.difficulty).toBe("hairball");
  });

  it("rejects unknown size with exit 2 listing the project's set", async () => {
    const dir = taskDir();
    writeClassification(dir, {
      sizes: [{ id: "tiny", guidance: "Small." }],
      difficulties: [{ id: "routine", guidance: "Easy." }],
    });
    const res = await runCli(
      ["delegate", "--vendor", "fake", "--cwd", dir, "--size", "XL", "x"],
      home,
    );
    expect(res.code).toBe(2);
    expect(res.stderr).toMatch(/invalid size: XL/);
    expect(res.stderr).toMatch(/tiny/);
    expect(res.stderr).not.toMatch(/\|M\|/);
    const list = await runCli(["list", "--all", "--json"], home);
    expect(JSON.parse(list.stdout)).toEqual([]);
  });

  it("rejects unknown difficulty listing the set; shipped defaults when file missing", async () => {
    const dir = taskDir();
    // No classification.json → shipped defaults (M and hard still valid).
    const ok = await runCli(
      [
        "delegate",
        "--vendor",
        "fake",
        "--cwd",
        dir,
        "--size",
        "M",
        "--difficulty",
        "hard",
        "defaults",
      ],
      home,
    );
    expect(ok.code).toBe(0);

    const dir2 = taskDir();
    const bad = await runCli(
      ["delegate", "--vendor", "fake", "--cwd", dir2, "--difficulty", "insane", "x"],
      home,
    );
    expect(bad.code).toBe(2);
    expect(bad.stderr).toMatch(/invalid difficulty: insane/);
    expect(bad.stderr).toMatch(/trivial\|easy\|medium\|hard\|extreme/);
  });
});

describe("parley lint (#161)", () => {
  it("exits 0 on a valid project and on an empty project", async () => {
    const dir = taskDir();
    const empty = await runCli(["lint", dir], home);
    expect(empty.code).toBe(0);
    expect(empty.stdout).toMatch(/ok/);

    writeConfig(dir, {
      eval: { enabled: false },
      taskTypes: { coding: "coding" },
    });
    writeClassification(dir, {
      sizes: [{ id: "S", guidance: "Small change." }],
      difficulties: [{ id: "easy", guidance: "Straightforward." }],
    });
    const coding = getShippedRubric("coding")!;
    writeJson(path.join(dir, ".parley", "rubrics", "coding.json"), {
      id: "coding",
      version: coding.version,
      criteria: coding.criteria,
    });

    const ok = await runCli(["lint", dir, "--json"], home);
    expect(ok.code).toBe(0);
    const body = JSON.parse(ok.stdout) as { ok: boolean; findings: unknown[] };
    expect(body.ok).toBe(true);
  });

  it("catches each error class with the field named; exit 1", async () => {
    const dir = taskDir();
    writeConfig(dir, {
      eval: { enabled: "yes" },
      retry: { max: 0.5, window: "bogus" },
      taskTypes: {
        coding: { rubric: "does-not-exist" },
      },
    });
    writeClassification(dir, {
      sizes: [{ id: "XS", guidance: "" }],
      difficulties: [{ id: "easy", guidance: "ok" }],
    });
    writeJson(path.join(dir, ".parley", "rubrics", "broken.json"), {
      id: "broken",
      version: 1,
      criteria: [
        { id: "a", kind: "positive", weight: 0, text: "bad weight" },
      ],
    });

    const res = await runCli(["lint", dir, "--json"], home);
    expect(res.code).toBe(1);
    const body = JSON.parse(res.stdout) as {
      ok: boolean;
      findings: { field: string; message: string; severity: string }[];
    };
    expect(body.ok).toBe(false);
    const fields = body.findings.map((f) => f.field);
    expect(fields).toContain("eval.enabled");
    expect(fields).toContain("retry.max");
    expect(fields).toContain("retry.window");
    expect(fields).toContain("taskTypes.coding.rubric");
    expect(fields.some((f) => f.includes("guidance"))).toBe(true);
    expect(
      body.findings.some(
        (f) => f.message.includes("weight") || f.field.includes("weight"),
      ),
    ).toBe(true);
  });

  it("emits a version-bump warning when criteria change without a bump", async () => {
    const dir = taskDir();
    const coding = getShippedRubric("coding")!;
    writeJson(path.join(dir, ".parley", "rubrics", "coding.json"), {
      id: "coding",
      version: coding.version,
      criteria: coding.criteria.map((c, i) =>
        i === 0 ? { ...c, text: "Edited without bumping version." } : c,
      ),
    });
    const res = await runCli(["lint", dir, "--json"], home);
    expect(res.code).toBe(0);
    const body = JSON.parse(res.stdout) as {
      ok: boolean;
      findings: { severity: string; field: string; message: string }[];
    };
    expect(body.ok).toBe(true);
    const warn = body.findings.find((f) => f.severity === "warning");
    expect(warn?.field).toBe("version");
    expect(warn?.message).toMatch(/bump version/i);
  });
});

/** Minimal workflow.json body for CLI lint tests (#251). */
function writeMiniWorkflow(workflowsRoot: string, id: string): void {
  const dir = path.join(workflowsRoot, id);
  fs.mkdirSync(dir, { recursive: true });
  writeJson(path.join(dir, "workflow.json"), {
    id,
    version: 1,
    type: "coding",
    inputs: {},
    outputs: {},
    types: {},
    nodes: [
      {
        id: "only",
        kind: "step",
        prompt: "p.md",
        in: {},
        out: {},
      },
    ],
  });
  // Prompt file so path resolution is quiet if lint walks it.
  fs.writeFileSync(path.join(dir, "p.md"), "do the thing\n");
}

describe("parley lint — global workflow shadowing (#251)", () => {
  it("warns when a project workflow shadows a global id; exit 0", async () => {
    const dir = taskDir();
    // Force a repo root at dir so local layer is dir/.parley/workflows, not
    // an ancestor, and so it cannot dedupe with the test home.
    fs.mkdirSync(path.join(dir, ".git"));
    writeMiniWorkflow(path.join(home, "workflows"), "shared");
    writeMiniWorkflow(path.join(home, "workflows"), "global-only");
    writeMiniWorkflow(path.join(dir, ".parley", "workflows"), "shared");
    writeMiniWorkflow(path.join(dir, ".parley", "workflows"), "local-only");

    const res = await runCli(["lint", dir, "--json"], home);
    expect(res.code).toBe(0);
    const body = JSON.parse(res.stdout) as {
      ok: boolean;
      findings: { severity: string; file: string; message: string }[];
    };
    expect(body.ok).toBe(true);
    const shadows = body.findings.filter((f) =>
      f.message.toLowerCase().includes("shadow"),
    );
    expect(shadows).toHaveLength(1);
    expect(shadows[0]!.severity).toBe("warning");
    expect(shadows[0]!.file).toBe(".parley/workflows/shared/workflow.json");
    // Global-only is not linted and not reported as a finding of its own.
    expect(
      body.findings.some((f) => f.file.includes("global-only")),
    ).toBe(false);
  });

  it("emits no shadow warning when the id is local-only", async () => {
    const dir = taskDir();
    fs.mkdirSync(path.join(dir, ".git"));
    writeMiniWorkflow(path.join(home, "workflows"), "other");
    writeMiniWorkflow(path.join(dir, ".parley", "workflows"), "local-only");

    const res = await runCli(["lint", dir, "--json"], home);
    expect(res.code).toBe(0);
    const body = JSON.parse(res.stdout) as {
      findings: { message: string }[];
    };
    expect(body.findings.some((f) => f.message.toLowerCase().includes("shadow"))).toBe(
      false,
    );
  });

  it("emits no shadow warnings when layers are deduped (home parent path)", async () => {
    // Supported global-lint route: localDir === globalDir.
    // localBase = parent (repo root), home = parent/.parley ⇒ both resolve to
    // parent/.parley/workflows. Without a .git marker here, findRepoRoot can
    // walk past the temp dir and layers would not dedupe.
    const parent = taskDir();
    fs.mkdirSync(path.join(parent, ".git"));
    const nestedHome = path.join(parent, ".parley");
    fs.mkdirSync(nestedHome, { recursive: true });
    writeMiniWorkflow(path.join(nestedHome, "workflows"), "once");

    const res = await runCli(["lint", parent, "--json"], nestedHome);
    expect(res.code).toBe(0);
    const body = JSON.parse(res.stdout) as {
      ok: boolean;
      findings: { message: string }[];
      workflows: { id: string }[];
    };
    expect(body.ok).toBe(true);
    // The workflow is linted as the project (local) layer.
    expect(body.workflows.some((w) => w.id === "once")).toBe(true);
    expect(body.findings.some((f) => f.message.toLowerCase().includes("shadow"))).toBe(
      false,
    );
  });

  it("treats a missing global workflows directory as no global ids", async () => {
    const dir = taskDir();
    fs.mkdirSync(path.join(dir, ".git"));
    writeMiniWorkflow(path.join(dir, ".parley", "workflows"), "local-only");
    // home has no workflows/ at all
    const res = await runCli(["lint", dir, "--json"], home);
    expect(res.code).toBe(0);
    const body = JSON.parse(res.stdout) as { findings: { message: string }[] };
    expect(body.findings.some((f) => f.message.toLowerCase().includes("shadow"))).toBe(
      false,
    );
  });
});

describe("delegate --dry-run (#161)", () => {
  it("runs the task but leaves no task row behind", async () => {
    const dir = taskDir();
    const del = await runCli(
      [
        "delegate",
        "--vendor",
        "fake",
        "--cwd",
        dir,
        "--dry-run",
        "--name",
        "smoke",
        "report back immediately",
      ],
      home,
    );
    expect(del.code).toBe(0);
    const ack = JSON.parse(del.stdout) as { task_id: string };
    expect(ack.task_id).toMatch(/^t\d+$/);

    // Wait for completion (watch may race with purge; tolerate missing row).
    await runCli(["watch", ack.task_id], home);

    // Poll until the purge finishes (setImmediate on the daemon after terminal).
    const deadline = Date.now() + 10_000;
    for (;;) {
      const list = await runCli(["list", "--all", "--json"], home);
      expect(list.code).toBe(0);
      const rows = JSON.parse(list.stdout) as unknown[];
      if (rows.length === 0) break;
      if (Date.now() > deadline) {
        throw new Error(`dry-run left task row(s): ${JSON.stringify(rows)}`);
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  });
});
