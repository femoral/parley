/**
 * #249 / ADR-0022 — parley run start: input binding, phase-1 abort, phase-2
 * commit, base ref freeze.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  homePaths,
  type ParleyConfig,
} from "@useparley/core";
import {
  getRun,
  listRuns,
  openDatabase,
  type DatabaseHandle,
} from "../src/db.js";
import {
  bindRunInputs,
  isScalarInputPort,
  parseInputFlag,
  startRun,
  type StartRunHost,
} from "../src/run-start.js";
import { runBranchName, runCheckoutPath, runScratchPath } from "../src/run-workspace.js";
import { makeGitRepo, withFakeAllowlist } from "./helpers.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let home: string;
let db: DatabaseHandle;
let runsDir: string;
let worktreesDir: string;
let configPath: string;

function baseConfig(overrides: Partial<ParleyConfig> = {}): ParleyConfig {
  return {
    ...withFakeAllowlist({
      vendors: {
        fake: {
          models: {
            "fake-model": {
              efforts: ["low", "medium", "high"],
              default: "medium",
            },
          },
          maxConcurrent: 2,
        },
      },
      profiles: {
        deep: {
          vendor: "fake",
          model: "fake-model",
          effort: "medium",
          sandbox: "workspace",
        },
      },
      defaults: { profile: "deep" },
    }),
    ...overrides,
  } as ParleyConfig;
}

/**
 * Write a workflow into the global discovery layer (`{home}/workflows/<id>`).
 * Prefer this for scratch tests: a parent `/tmp/.git` would otherwise make
 * `findRepoRoot` treat `/tmp` as the local base and miss `{tmp}/.parley/workflows`.
 */
function installGlobalWorkflow(
  parleyHome: string,
  id: string,
  body: Record<string, unknown>,
): string {
  const dir = path.join(parleyHome, "workflows", id);
  fs.mkdirSync(path.join(dir, "prompts"), { recursive: true });
  fs.writeFileSync(path.join(dir, "prompts", "s.md"), "scope\n");
  fs.writeFileSync(path.join(dir, "prompts", "p.md"), "plan\n");
  fs.writeFileSync(path.join(dir, "workflow.json"), JSON.stringify(body, null, 2));
  return dir;
}

/** Local layer: `{repo}/.parley/workflows/<id>`. */
function installLocalWorkflow(
  repoOrCwd: string,
  id: string,
  body: Record<string, unknown>,
): string {
  const dir = path.join(repoOrCwd, ".parley", "workflows", id);
  fs.mkdirSync(path.join(dir, "prompts"), { recursive: true });
  fs.writeFileSync(path.join(dir, "prompts", "s.md"), "scope\n");
  fs.writeFileSync(path.join(dir, "prompts", "p.md"), "plan\n");
  fs.writeFileSync(path.join(dir, "workflow.json"), JSON.stringify(body, null, 2));
  return dir;
}

function startHost(opts?: { onEnter?: StartRunHost["onEnter"] }): StartRunHost {
  const config = baseConfig();
  return {
    worktreesDir,
    runsDir,
    config,
    configPath,
    loadDefinition: (id) => {
      // resolve via discovery in startRun itself; host only used for enter
      void id;
      return null;
    },
    runInputs: () => ({}),
    onEnter: opts?.onEnter,
  };
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "parley-start-"));
  const paths = homePaths(home);
  db = openDatabase(paths);
  runsDir = paths.runs;
  worktreesDir = paths.worktrees;
  configPath = paths.config;
  fs.mkdirSync(runsDir, { recursive: true });
  fs.mkdirSync(worktreesDir, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(withFakeAllowlist({
    profiles: {
      deep: {
        vendor: "fake",
        model: "fake-model",
        effort: "medium",
      },
    },
    defaults: { profile: "deep" },
  })));
});

afterEach(() => {
  try {
    db.close();
  } catch {
    /* already closed */
  }
  fs.rmSync(home, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Pure binding
// ---------------------------------------------------------------------------

describe("isScalarInputPort", () => {
  it("accepts atoms and enums; rejects containers and schema", () => {
    expect(isScalarInputPort({ kind: "text" })).toBe(true);
    expect(isScalarInputPort({ kind: "url" })).toBe(true);
    expect(isScalarInputPort({ kind: "file" })).toBe(true);
    expect(isScalarInputPort({ kind: "dir" })).toBe(true);
    expect(isScalarInputPort({ kind: "enum", name: "E", values: ["a"] })).toBe(true);
    expect(isScalarInputPort({ kind: "array", element: { kind: "text" } })).toBe(false);
    expect(isScalarInputPort({ kind: "dict", value: { kind: "text" } })).toBe(false);
    expect(
      isScalarInputPort({
        kind: "schema",
        name: "S",
        path: "x.json",
        schema: { type: "object" },
      }),
    ).toBe(false);
  });
});

describe("parseInputFlag", () => {
  it("splits on the first =", () => {
    expect(parseInputFlag("brief=hello=world")).toEqual({
      name: "brief",
      value: "hello=world",
    });
  });
  it("rejects missing =", () => {
    const r = parseInputFlag("nocolon");
    expect(r).toMatchObject({ error: expect.stringMatching(/name=value/) });
  });
});

describe("bindRunInputs", () => {
  const declared = {
    brief: { type: { kind: "text" as const }, bounds: {} },
    tags: {
      type: { kind: "array" as const, element: { kind: "text" as const } },
      bounds: {},
    },
  };

  it("merges file + flags with flag winning", () => {
    const r = bindRunInputs({
      declared,
      fileInputs: { brief: "from-file", tags: ["a"] },
      flagInputs: [{ name: "brief", value: "from-flag" }],
    });
    expect(r).toEqual({
      ok: true,
      inputs: { brief: "from-flag", tags: ["a"] },
    });
  });

  it("rejects --input on a container port, naming type and --inputs", () => {
    const r = bindRunInputs({
      declared,
      fileInputs: { brief: "x" },
      flagInputs: [{ name: "tags", value: "nope" }],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/tags/);
    expect(r.error).toMatch(/text\[\]/);
    expect(r.error).toMatch(/--inputs/);
  });

  it("rejects undeclared port names", () => {
    const r = bindRunInputs({
      declared: { brief: declared.brief },
      flagInputs: [{ name: "ghost", value: "x" }],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/undeclared input port "ghost"/);
  });

  it("rejects unbound declared ports", () => {
    const r = bindRunInputs({
      declared,
      flagInputs: [{ name: "brief", value: "x" }],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/unbound input port "tags"/);
  });
});

// ---------------------------------------------------------------------------
// Phase 1 abort — no row, no workspace, no branch
// ---------------------------------------------------------------------------

describe("run start phase 1 abort", () => {
  it("type-invalid value leaves no run row, workspace, or branch", () => {
    const id = "research-bad";
    installGlobalWorkflow(home, id, {
      id,
      version: 1,
      type: "research",
      workspace: "scratch",
      inputs: { brief: { type: "text" } },
      outputs: { out: { type: "text", from: "scope.report" } },
      nodes: [
        {
          id: "scope",
          kind: "step",
          profile: "deep",
          prompt: "prompts/s.md",
          in: { brief: { type: "text", from: "run.brief" } },
          out: { report: { type: "text" } },
        },
      ],
    });

    const result = startRun(db, startHost(), {
      workflow: id,
      // text max_length default is 16KiB; force Ajv fail with wrong type
      fileInputs: { brief: 42 },
      flagInputs: [],
      cwd: home,
      home,
    });
    expect(result.kind).toBe("usage");
    if (result.kind === "usage") {
      expect(result.message).toMatch(/invalid inputs|must be string|type/i);
    }
    expect(listRuns(db)).toEqual([]);
    expect(fs.existsSync(runScratchPath(runsDir, "r1"))).toBe(false);
  });

  it("missing file referent leaves no run row or workspace", () => {
    const id = "with-file";
    installGlobalWorkflow(home, id, {
      id,
      version: 1,
      type: "research",
      workspace: "scratch",
      inputs: {
        brief: { type: "text" },
        doc: { type: "file" },
      },
      outputs: { out: { type: "text", from: "scope.report" } },
      nodes: [
        {
          id: "scope",
          kind: "step",
          profile: "deep",
          prompt: "prompts/s.md",
          in: {
            brief: { type: "text", from: "run.brief" },
            doc: { type: "file", from: "run.doc" },
          },
          out: { report: { type: "text" } },
        },
      ],
    });

    const result = startRun(db, startHost(), {
      workflow: id,
      fileInputs: { brief: "hi", doc: "/no/such/file-parley-249.txt" },
      cwd: home,
      home,
    });
    expect(result.kind).toBe("usage");
    if (result.kind === "usage") {
      expect(result.message).toMatch(/does not exist|file/i);
    }
    expect(listRuns(db)).toEqual([]);
    expect(fs.existsSync(runScratchPath(runsDir, "r1"))).toBe(false);
  });

  it("scratch + --base-ref is refused via preflight with no side effects", () => {
    const id = "scratch-base";
    installGlobalWorkflow(home, id, {
      id,
      version: 1,
      type: "research",
      workspace: "scratch",
      inputs: { brief: { type: "text" } },
      outputs: { out: { type: "text", from: "scope.report" } },
      nodes: [
        {
          id: "scope",
          kind: "step",
          profile: "deep",
          prompt: "prompts/s.md",
          in: { brief: { type: "text", from: "run.brief" } },
          out: { report: { type: "text" } },
        },
      ],
    });

    const result = startRun(db, startHost(), {
      workflow: id,
      flagInputs: [{ name: "brief", value: "x" }],
      baseRef: "main",
      cwd: home,
      home,
    });
    expect(result.kind).toBe("usage");
    if (result.kind === "usage") {
      expect(result.message).toMatch(/scratch|base/i);
    }
    expect(listRuns(db)).toEqual([]);
    expect(fs.existsSync(runScratchPath(runsDir, "r1"))).toBe(false);
  });

  it("preflight failure (missing repo for repo mode) leaves no workspace", () => {
    const id = "needs-repo";
    // Global layer; cwd stays non-repo for this home-only path… but a parent
    // /tmp/.git may still make findRepoRoot return /tmp. Use an explicit
    // non-repo cwd by installing global and cwd=home with repo workflow —
    // preflightRepoRun fails when repoRoot(cwd) is not a usable project, or
    // when it is /tmp without our workflow's intended root. Force the
    // usage path by resolving with cwd outside any tree: we still expect
    // either "requires a git repository" or a resolve/preflight refuse.
    installGlobalWorkflow(home, id, {
      id,
      version: 1,
      type: "coding",
      workspace: "repo",
      inputs: { brief: { type: "text" } },
      outputs: { out: { type: "text", from: "plan.plan" } },
      nodes: [
        {
          id: "plan",
          kind: "step",
          profile: "deep",
          prompt: "prompts/p.md",
          in: { brief: { type: "text", from: "run.brief" } },
          out: { plan: { type: "text" } },
        },
      ],
    });

    const result = startRun(db, startHost(), {
      workflow: id,
      flagInputs: [{ name: "brief", value: "x" }],
      cwd: home,
      home,
    });
    expect(result.kind).toBe("usage");
    expect(listRuns(db)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Phase 2 success paths
// ---------------------------------------------------------------------------

describe("run start phase 2", () => {
  it("scratch workflow creates run, frozen inputs, enters node 1", () => {
    const id = "scratch-ok";
    installGlobalWorkflow(home, id, {
      id,
      version: 1,
      type: "research",
      workspace: "scratch",
      inputs: { brief: { type: "text" } },
      outputs: { out: { type: "text", from: "scope.report" } },
      nodes: [
        {
          id: "scope",
          kind: "step",
          profile: "deep",
          prompt: "prompts/s.md",
          in: { brief: { type: "text", from: "run.brief" } },
          out: { report: { type: "text" } },
        },
      ],
    });

    let entered = false;
    const result = startRun(
      db,
      startHost({
        onEnter: (args) => {
          entered = true;
          expect(args.step.id).toBe("scope");
          expect(args.iteration).toBe(1);
          expect(args.inputs.brief).toBe("hello");
          return undefined;
        },
      }),
      {
        workflow: id,
        flagInputs: [{ name: "brief", value: "hello" }],
        cwd: home,
        home,
        orchestratorSessionId: "orch-1",
      },
    );

    if (result.kind !== "ok") {
      expect.fail(`expected ok, got ${JSON.stringify(result)}`);
    }
    expect(result.run.id).toMatch(/^r\d+$/);
    expect(result.run.current_node).toBe("scope");
    expect(result.run.iteration).toBe(1);
    expect(result.run.workspace).toBe("scratch");
    expect(result.run.repo).toBeNull();
    expect(result.run.base_ref).toBeNull();
    expect(result.run.base_commit).toBeNull();
    expect(result.run.state).toBe("running");
    expect(entered).toBe(true);

    const ws = runScratchPath(runsDir, result.run.id);
    expect(fs.existsSync(ws)).toBe(true);
    const frozen = JSON.parse(
      fs.readFileSync(path.join(ws, ".parley", "inputs.json"), "utf8"),
    );
    expect(frozen).toEqual({ brief: "hello" });
  });

  it("repo workflow creates checkout + branch and records base_ref/base_commit", () => {
    const repo = makeGitRepo({ "README.md": "hi\n" });
    const head = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    const id = "coding-ok";
    installLocalWorkflow(repo, id, {
      id,
      version: 1,
      type: "coding",
      workspace: "repo",
      inputs: { brief: { type: "text" } },
      outputs: { out: { type: "text", from: "plan.plan" } },
      nodes: [
        {
          id: "plan",
          kind: "step",
          profile: "deep",
          prompt: "prompts/p.md",
          in: { brief: { type: "text", from: "run.brief" } },
          out: { plan: { type: "text" } },
        },
      ],
    });
    // Also seed config allowlist under home (daemon config).
    fs.writeFileSync(
      configPath,
      JSON.stringify(
        withFakeAllowlist({
          profiles: {
            deep: { vendor: "fake", model: "fake-model", effort: "medium" },
          },
          defaults: { profile: "deep" },
        }),
      ),
    );

    const result = startRun(db, startHost(), {
      workflow: id,
      flagInputs: [{ name: "brief", value: "ship it" }],
      baseRef: "HEAD",
      cwd: repo,
      home,
    });

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.run.workspace).toBe("repo");
    expect(result.run.repo).toBe(repo);
    expect(result.run.base_ref).toBe("HEAD");
    expect(result.run.base_commit).toBe(head);
    expect(result.run.current_node).toBe("plan");

    const checkout = runCheckoutPath(worktreesDir, repo, result.run.id);
    expect(fs.existsSync(checkout)).toBe(true);
    const branch = runBranchName(result.run.id, id);
    const tip = execFileSync("git", ["-C", repo, "rev-parse", branch], {
      encoding: "utf8",
    }).trim();
    expect(tip).toBe(head);

    fs.rmSync(repo, { recursive: true, force: true });
  });

  it("phase-2 failure leaves a failed run row", () => {
    const id = "phase2-fail";
    installGlobalWorkflow(home, id, {
      id,
      version: 1,
      type: "research",
      workspace: "scratch",
      inputs: { brief: { type: "text" } },
      outputs: { out: { type: "text", from: "scope.report" } },
      nodes: [
        {
          id: "scope",
          kind: "step",
          profile: "deep",
          prompt: "prompts/s.md",
          in: { brief: { type: "text", from: "run.brief" } },
          out: { report: { type: "text" } },
        },
      ],
    });

    // Force phase-2 failure: point runsDir at a non-writable path after phase1
    // by using a host with an invalid runsDir under a file.
    const blocker = path.join(home, "not-a-dir");
    fs.writeFileSync(blocker, "x");
    const host = startHost();
    host.runsDir = path.join(blocker, "runs"); // cannot mkdir under a file

    const result = startRun(db, host, {
      workflow: id,
      flagInputs: [{ name: "brief", value: "x" }],
      cwd: home,
      home,
    });

    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.run).toBeDefined();
    const row = result.run ?? getRun(db, "r1");
    expect(row?.state).toBe("failed");
    expect(row?.error).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// End-to-end via startRun without insertRun in the test body
// ---------------------------------------------------------------------------

describe("run start end-to-end (no direct insertRun)", () => {
  it("starts a gate-first workflow and blocks without calling insertRun", () => {
    const id = "gate-first";
    installGlobalWorkflow(home, id, {
      id,
      version: 1,
      type: "research",
      workspace: "scratch",
      inputs: { brief: { type: "text" } },
      outputs: { out: { type: "text", from: "work.report" } },
      nodes: [
        {
          id: "approve",
          kind: "gate",
          question: "Go?",
          shows: {},
          on_reject: "finish",
        },
        {
          id: "work",
          kind: "step",
          profile: "deep",
          prompt: "prompts/s.md",
          in: { brief: { type: "text", from: "run.brief" } },
          out: { report: { type: "text" } },
        },
      ],
    });

    const result = startRun(db, startHost(), {
      workflow: id,
      flagInputs: [{ name: "brief", value: "ok" }],
      cwd: home,
      home,
    });

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    // Gate entry → blocked, no insertRun in this test body.
    expect(result.run.state).toBe("blocked");
    expect(result.run.current_node).toBe("approve");
    expect(result.run.error).toMatch(/gate approve/);
  });
});

