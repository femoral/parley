/**
 * Compounding PROMPT.md layers + `parley prompt` preview (#159).
 *
 * CLI seam against a real daemon with the fake vendor: layering matrices,
 * orchestrator isolation, and preview ≡ spawn prompt (minus brief).
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
  writeFiles,
  type FakeVendorAction,
} from "./helpers.js";

let home: string;
const scratch: string[] = [];

beforeEach(() => {
  home = makeHome();
});

afterEach(() => {
  cleanupHome(home);
  for (const dir of scratch.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const REPORT = { summary: "ok", outcome: "success", files_changed: [] as string[] };

function taskDir(actions: FakeVendorAction[] = [{ submit_report: REPORT }]): string {
  const dir = makeTaskDir(actions);
  scratch.push(dir);
  return dir;
}

function writePrompt(root: string, rel: string, body: string): void {
  writeFiles(root, { [rel]: body });
}

/** Every parsed `hello` event from a task's captured stream. */
function hellos(taskId: string): Record<string, unknown>[] {
  const log = fs.readFileSync(path.join(home, "tasks", taskId, "vendor.jsonl"), "utf8");
  return log
    .split("\n")
    .filter((l) => l.includes('"hello"'))
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("parley prompt — composition matrices (#159)", () => {
  it("home vendor → project vendor → home profile → project profile", async () => {
    const cwd = taskDir();
    writePrompt(home, "vendors/fake/PROMPT.md", "HOME-VENDOR");
    writePrompt(cwd, ".parley/vendors/fake/PROMPT.md", "PROJECT-VENDOR");
    writePrompt(home, "profiles/deep/PROMPT.md", "HOME-PROFILE");
    writePrompt(cwd, ".parley/profiles/deep/PROMPT.md", "PROJECT-PROFILE");
    writeFiles(home, {
      "parley.json": JSON.stringify(withFakeAllowlist({
        profiles: { deep: { vendor: "fake" } },
      })),
    });

    const result = await runCli(
      ["prompt", "--vendor", "fake", "--profile", "deep"],
      home,
      { cwd },
    );
    expect(result.code).toBe(0);
    const out = result.stdout;
    expect(out).toContain("## Operator instructions");
    // Order: home vendor before project vendor before home profile before project profile.
    const hv = out.indexOf("HOME-VENDOR");
    const pv = out.indexOf("PROJECT-VENDOR");
    const hp = out.indexOf("HOME-PROFILE");
    const pp = out.indexOf("PROJECT-PROFILE");
    expect(hv).toBeGreaterThan(-1);
    expect(pv).toBeGreaterThan(hv);
    expect(hp).toBeGreaterThan(pv);
    expect(pp).toBeGreaterThan(hp);
    // Protocol preamble still present.
    expect(out).toContain("Parley protocol");
    expect(out).toContain("ask_orchestrator");
  });

  it("skips missing layers; profile layers only with --profile", async () => {
    const cwd = taskDir();
    writePrompt(home, "vendors/fake/PROMPT.md", "ONLY-VENDOR");
    writePrompt(home, "profiles/deep/PROMPT.md", "PROFILE-SKIP");

    const noProfile = await runCli(["prompt", "-v", "fake"], home, { cwd });
    expect(noProfile.code).toBe(0);
    expect(noProfile.stdout).toContain("ONLY-VENDOR");
    expect(noProfile.stdout).not.toContain("PROFILE-SKIP");

    writeFiles(home, {
      "parley.json": JSON.stringify(withFakeAllowlist({
        profiles: { deep: { vendor: "fake" } },
      })),
    });
    const withProfile = await runCli(
      ["prompt", "-v", "fake", "--profile", "deep"],
      home,
      { cwd },
    );
    expect(withProfile.code).toBe(0);
    expect(withProfile.stdout).toContain("ONLY-VENDOR");
    expect(withProfile.stdout).toContain("PROFILE-SKIP");
  });

  it("omits Operator instructions entirely when no layers exist", async () => {
    const cwd = taskDir();
    const result = await runCli(["prompt", "-v", "fake"], home, { cwd });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Parley protocol");
    expect(result.stdout).not.toContain("Operator instructions");
  });

  it("--orchestrator compounds home → project and never includes vendor layers", async () => {
    const cwd = taskDir();
    writePrompt(home, "orchestrator/PROMPT.md", "ORCH-HOME");
    writePrompt(cwd, ".parley/orchestrator/PROMPT.md", "ORCH-PROJECT");
    writePrompt(home, "vendors/fake/PROMPT.md", "VENDOR-SECRET");

    const result = await runCli(["prompt", "--orchestrator"], home, { cwd });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("ORCH-HOME");
    expect(result.stdout).toContain("ORCH-PROJECT");
    expect(result.stdout.indexOf("ORCH-HOME")).toBeLessThan(
      result.stdout.indexOf("ORCH-PROJECT"),
    );
    expect(result.stdout).not.toContain("VENDOR-SECRET");
    expect(result.stdout).not.toContain("Parley protocol");
    expect(result.stdout).not.toContain("Operator instructions");
  });

  it("orchestrator layers never appear in child prompts", async () => {
    const cwd = taskDir();
    writePrompt(home, "orchestrator/PROMPT.md", "ORCH-NEVER-CHILD");
    writePrompt(home, "vendors/fake/PROMPT.md", "CHILD-OK");

    const result = await runCli(["prompt", "-v", "fake"], home, { cwd });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("CHILD-OK");
    expect(result.stdout).not.toContain("ORCH-NEVER-CHILD");
  });

  it("usage: vendor/profile required without --orchestrator (exit 2)", async () => {
    const result = await runCli(["prompt"], home);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/vendor|profile|orchestrator/i);
  });

  it("resolves vendor from --profile alone", async () => {
    const cwd = taskDir();
    writeFiles(home, {
      "parley.json": JSON.stringify(withFakeAllowlist({
        profiles: { deep: { vendor: "fake" } },
      })),
    });
    writePrompt(home, "vendors/fake/PROMPT.md", "FROM-PROFILE-VENDOR");
    writePrompt(home, "profiles/deep/PROMPT.md", "FROM-PROFILE");

    const result = await runCli(["prompt", "--profile", "deep"], home, { cwd });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("FROM-PROFILE-VENDOR");
    expect(result.stdout).toContain("FROM-PROFILE");
  });
});

describe("parley prompt matches spawn (#159)", () => {
  it("preview is a prefix of the actual spawn prompt (same --cwd, no worktree)", async () => {
    const cwd = taskDir([{ write_file: { path: "keep.txt", contents: "x" } }, { submit_report: REPORT }]);
    writePrompt(home, "vendors/fake/PROMPT.md", "HOME-V");
    writePrompt(cwd, ".parley/vendors/fake/PROMPT.md", "PROJ-V");
    writePrompt(home, "profiles/fast/PROMPT.md", "HOME-P");
    writePrompt(cwd, ".parley/profiles/fast/PROMPT.md", "PROJ-P");
    writeFiles(home, {
      "parley.json": JSON.stringify(withFakeAllowlist({
        profiles: { fast: { vendor: "fake" } },
      })),
    });

    const brief = "implement the layering feature";
    const preview = await runCli(
      ["prompt", "--vendor", "fake", "--profile", "fast"],
      home,
      { cwd },
    );
    expect(preview.code).toBe(0);
    const previewText = preview.stdout.replace(/\n$/, "");

    const delegate = await runCli(
      [
        "delegate",
        "-v",
        "fake",
        "--profile",
        "fast",
        "--cwd",
        cwd,
        brief,
      ],
      home,
      { cwd },
    );
    expect(delegate.code).toBe(0);
    await waitForState(home, "t1", "completed");

    const spawnPrompt = hellos("t1")[0]!.prompt as string;
    // Exact match: preview + separator + brief (assembleChildPrompt shape).
    expect(spawnPrompt).toBe(`${previewText}\n\n---\n\n${brief}`);
    expect(spawnPrompt).toContain("HOME-V");
    expect(spawnPrompt).toContain("PROJ-V");
    expect(spawnPrompt).toContain("HOME-P");
    expect(spawnPrompt).toContain("PROJ-P");
    expect(spawnPrompt).not.toMatch(/ORCH/);
  });

  it("project layers are read from the workspace at spawn (hot)", async () => {
    const cwd = taskDir([
      { write_file: { path: "keep.txt", contents: "x" } },
      { submit_report: REPORT },
    ]);
    writePrompt(cwd, ".parley/vendors/fake/PROMPT.md", "BEFORE-SPAWN");

    // Mutate the project layer after preview, before delegate — spawn re-reads hot.
    const preview = await runCli(["prompt", "-v", "fake"], home, { cwd });
    expect(preview.stdout).toContain("BEFORE-SPAWN");

    writePrompt(cwd, ".parley/vendors/fake/PROMPT.md", "AFTER-MUTATION");

    const delegate = await runCli(
      ["delegate", "-v", "fake", "--cwd", cwd, "hot read check"],
      home,
      { cwd },
    );
    expect(delegate.code).toBe(0);
    await waitForState(home, "t1", "completed");
    const spawnPrompt = hellos("t1")[0]!.prompt as string;
    expect(spawnPrompt).toContain("AFTER-MUTATION");
    expect(spawnPrompt).not.toContain("BEFORE-SPAWN");
  });

  it("resume re-reads operator layers (hot, per attempt)", async () => {
    const cwd = makeTaskDir(
      [
        { emit: { type: "session", session_id: "sess-pl" } },
        { ask: "which way?" },
      ],
      [{ submit_report: REPORT }],
    );
    scratch.push(cwd);
    writePrompt(home, "vendors/fake/PROMPT.md", "LAYER-V1");

    await runCli(
      ["delegate", "-v", "fake", "--cwd", cwd, "--answer-timeout", "250ms", "original"],
      home,
    );
    await waitForState(home, "t1", "stalled");
    const first = hellos("t1")[0]!.prompt as string;
    expect(first).toContain("LAYER-V1");

    writePrompt(home, "vendors/fake/PROMPT.md", "LAYER-V2-RESUME");
    await runCli(["answer", "t1", "that way"], home);
    await waitForState(home, "t1", "completed");
    const resume = hellos("t1").at(-1)!.prompt as string;
    expect(resume).toContain("LAYER-V2-RESUME");
    expect(resume).not.toContain("LAYER-V1");
    expect(resume).toContain("that way");
  });
});

describe("parley prompt --json", () => {
  it("emits { prompt } JSON", async () => {
    const cwd = taskDir();
    writePrompt(home, "vendors/fake/PROMPT.md", "JSON-LAYER");
    const result = await runCli(["prompt", "-v", "fake", "--json"], home, { cwd });
    expect(result.code).toBe(0);
    const body = JSON.parse(result.stdout) as { prompt: string };
    expect(body.prompt).toContain("JSON-LAYER");
    expect(body.prompt).toContain("Parley protocol");
  });
});
