/**
 * Writable git-metadata grant (#385).
 *
 * - Every registered adapter must declare `writableGitMetadata`.
 * - The grant follows that declaration, not a vendor-id comparison.
 * - README list between HTML markers must match the adapters that declare true.
 * - read-only still emits no write grant for adapters that consume the fields.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createAdapterRegistrySync } from "../src/adapters/index.js";
import { createCodexAdapter } from "../src/adapters/codex.js";
import { createGrokAdapter } from "../src/adapters/grok.js";
import type { HubInfo, TaskSpec } from "../src/adapters/types.js";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const README_PATH = path.join(REPO_ROOT, "README.md");

const HUB: HubInfo = {
  url: "http://127.0.0.1:9/mcp",
  headers: { "x-parley-task": "t385" },
};

const GIT_DIR = "/repo/.git/worktrees/t385";
const GIT_COMMON = "/repo/.git";

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function happyGrokBin(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "parley-grok-gitmeta-"));
  scratch.push(dir);
  const file = path.join(dir, "grok");
  fs.writeFileSync(
    file,
    `#!/bin/sh\nif [ "$1" = "inspect" ]; then echo '{"permissions":{"loaded":0,"sources":[]}}'; fi\n`,
    { mode: 0o755 },
  );
  return file;
}

function task(overrides: Partial<TaskSpec> = {}): TaskSpec {
  return {
    id: "t385",
    name: null,
    prompt: "p",
    vendor: "x",
    model: null,
    effort: null,
    cwd: "/work/tree",
    sandbox: "workspace",
    network: true,
    answerTimeoutMs: 60_000,
    extraArgs: [],
    gitDir: GIT_DIR,
    gitCommonDir: GIT_COMMON,
    ...overrides,
  };
}

function parseReadmeDeclaringAdapters(readme: string): string[] {
  const start = readme.indexOf("<!-- writable-git-metadata:start -->");
  const end = readme.indexOf("<!-- writable-git-metadata:end -->");
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const block = readme.slice(start + "<!-- writable-git-metadata:start -->".length, end);
  return block
    .split(",")
    .map((s) => s.replace(/[`\s]/g, ""))
    .filter((s) => s.length > 0);
}

describe("adapter writableGitMetadata declarations (#385)", () => {
  it("every registered adapter declares a boolean", () => {
    const registry = createAdapterRegistrySync({ PARLEY_FAKE_VENDOR_BIN: "fake" });
    expect(registry.size).toBeGreaterThan(5);
    for (const [id, adapter] of registry) {
      expect(typeof adapter.writableGitMetadata, `${id} missing writableGitMetadata`).toBe(
        "boolean",
      );
    }
  });

  it("the grant follows the declaration rather than the vendor name", () => {
    const registry = createAdapterRegistrySync({ PARLEY_FAKE_VENDOR_BIN: "fake" });
    // grok is not named "codex" and still declares the need — this is the gap #385 closes.
    expect(registry.get("grok")?.writableGitMetadata).toBe(true);
    expect(registry.get("codex")?.writableGitMetadata).toBe(true);
    // Adapters that do not declare a need stay git-free on the spawn spec.
    for (const [id, adapter] of registry) {
      if (id === "grok" || id === "codex") continue;
      expect(adapter.writableGitMetadata, `${id} should not request git metadata`).toBe(false);
    }
  });
});

describe("README writable git-metadata list sync (#385)", () => {
  it("matches adapters that declare writableGitMetadata: true (neuter)", () => {
    const readme = fs.readFileSync(README_PATH, "utf8");
    const listed = parseReadmeDeclaringAdapters(readme);
    const registry = createAdapterRegistrySync({ PARLEY_FAKE_VENDOR_BIN: "fake" });
    const declared = [...registry.entries()]
      .filter(([, adapter]) => adapter.writableGitMetadata)
      .map(([id]) => id)
      .sort();
    expect([...listed].sort()).toEqual(declared);
  });
});

describe("read-only posture still receives no write grant (#385)", () => {
  it("every adapter that declares git metadata emits no write grant under read-only", async () => {
    const spec = task({ sandbox: "read-only" });

    const grok = await createGrokAdapter({ PARLEY_GROK_BIN: happyGrokBin() }).prepare(spec, HUB);
    const grokSandbox = grok.files.find((f) => f.path === ".grok/sandbox.toml");
    expect(grokSandbox).toBeDefined();
    expect(grokSandbox!.contents).not.toContain("read_write");

    const codex = await createCodexAdapter({}).prepare(spec, HUB);
    expect(codex.argv.join(" ")).not.toContain("writable_roots");
  });
});
