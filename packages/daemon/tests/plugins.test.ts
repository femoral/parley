/**
 * Plugin adapter loader (#108 / ADR-0009).
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertVendorAdapter,
  loadPluginAdapter,
  resolvePluginSpecifier,
} from "../src/adapters/plugins.js";
import { createAdapterRegistry } from "../src/adapters/index.js";

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function writePlugin(source: string): { home: string; pluginPath: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "parley-plugin-"));
  scratch.push(home);
  const pluginPath = path.join(home, "my-adapter.mjs");
  fs.writeFileSync(pluginPath, source);
  return { home, pluginPath };
}

const GOOD_ADAPTER = `
export function createAdapter(env) {
  return {
    id: "acme",
    childChannel: "mcp",
    prepare: async () => ({ argv: ["acme"], env: {}, files: [], cwd: "/tmp" }),
    resume: async () => ({ argv: ["acme"], env: {}, files: [], cwd: "/tmp" }),
    parseEvent: () => [],
    sessionId: () => undefined,
  };
}
`;

function validAdapter(overrides: Record<string, unknown> = {}) {
  return {
    id: "acme",
    childChannel: "mcp",
    prepare: async () => ({ argv: [], env: {}, files: [], cwd: "/" }),
    resume: async () => ({ argv: [], env: {}, files: [], cwd: "/" }),
    parseEvent: () => [],
    sessionId: () => undefined,
    ...overrides,
  };
}

describe("assertVendorAdapter", () => {
  it("accepts a well-formed adapter", () => {
    expect(() => assertVendorAdapter("acme", validAdapter())).not.toThrow();
  });

  it("rejects id mismatch", () => {
    expect(() => assertVendorAdapter("acme", validAdapter({ id: "other" }))).toThrow(
      /does not match config key/,
    );
  });

  it("rejects missing or invalid childChannel", () => {
    expect(() => assertVendorAdapter("acme", validAdapter({ childChannel: undefined }))).toThrow(
      /childChannel must be one of mcp\|cli\|http/,
    );
    expect(() => assertVendorAdapter("acme", validAdapter({ childChannel: "stdio" }))).toThrow(
      /childChannel must be one of mcp\|cli\|http/,
    );
  });

  it("rejects missing prepare", () => {
    expect(() =>
      assertVendorAdapter("acme", {
        id: "acme",
        childChannel: "mcp",
        resume: () => {},
        parseEvent: () => {},
        sessionId: () => {},
      }),
    ).toThrow(/prepare must be a function/);
  });

  it("rejects missing resume", () => {
    expect(() =>
      assertVendorAdapter("acme", {
        id: "acme",
        childChannel: "mcp",
        prepare: () => {},
        parseEvent: () => {},
        sessionId: () => {},
      }),
    ).toThrow(/resume must be a function/);
  });

  it("rejects missing parseEvent", () => {
    expect(() =>
      assertVendorAdapter("acme", {
        id: "acme",
        childChannel: "mcp",
        prepare: () => {},
        resume: () => {},
        sessionId: () => {},
      }),
    ).toThrow(/parseEvent must be a function/);
  });

  it("rejects missing sessionId", () => {
    expect(() =>
      assertVendorAdapter("acme", {
        id: "acme",
        childChannel: "mcp",
        prepare: () => {},
        resume: () => {},
        parseEvent: () => {},
      }),
    ).toThrow(/sessionId must be a function/);
  });

  it("rejects non-object", () => {
    expect(() => assertVendorAdapter("acme", null)).toThrow(/must return an object/);
  });
});

describe("resolvePluginSpecifier", () => {
  it("passes through file: URLs", () => {
    expect(resolvePluginSpecifier("file:///tmp/x.mjs", "/home")).toBe("file:///tmp/x.mjs");
  });

  it("converts absolute paths to file: URLs", () => {
    const abs = "/tmp/plugin.mjs";
    expect(resolvePluginSpecifier(abs, "/home")).toBe(pathToFileURL(abs).href);
  });
});

describe("loadPluginAdapter — happy path", () => {
  it("loads a named-export createAdapter module", async () => {
    const { home, pluginPath } = writePlugin(GOOD_ADAPTER);
    const adapter = await loadPluginAdapter(
      "acme",
      { plugin: pluginPath },
      {},
      home,
    );
    expect(adapter.id).toBe("acme");
    expect(typeof adapter.prepare).toBe("function");
  });

  it("accepts a default-export factory function", async () => {
    const { home, pluginPath } = writePlugin(`
      export default function createAdapter() {
        return {
          id: "acme",
          childChannel: "cli",
          prepare: async () => ({ argv: [], env: {}, files: [], cwd: "/" }),
          resume: async () => ({ argv: [], env: {}, files: [], cwd: "/" }),
          parseEvent: () => [],
          sessionId: () => undefined,
        };
      }
    `);
    const adapter = await loadPluginAdapter("acme", { plugin: pluginPath }, {}, home);
    expect(adapter.id).toBe("acme");
    expect(adapter.childChannel).toBe("cli");
  });

  it("accepts a file: URL specifier", async () => {
    const { home, pluginPath } = writePlugin(GOOD_ADAPTER);
    const adapter = await loadPluginAdapter(
      "acme",
      { plugin: pathToFileURL(pluginPath).href },
      {},
      home,
    );
    expect(adapter.id).toBe("acme");
  });
});

describe("loadPluginAdapter — validation failures", () => {
  it("fails when plugin is missing", async () => {
    await expect(loadPluginAdapter("acme", {}, {}, "/tmp")).rejects.toThrow(
      /plugin is required/,
    );
  });

  it("fails when createAdapter is missing", async () => {
    const { home, pluginPath } = writePlugin("export const x = 1;\n");
    await expect(
      loadPluginAdapter("acme", { plugin: pluginPath }, {}, home),
    ).rejects.toThrow(/must export createAdapter/);
  });

  it("fails when returned id mismatches", async () => {
    const { home, pluginPath } = writePlugin(`
      export function createAdapter() {
        return {
          id: "wrong",
          childChannel: "mcp",
          prepare: async () => ({ argv: [], env: {}, files: [], cwd: "/" }),
          resume: async () => ({ argv: [], env: {}, files: [], cwd: "/" }),
          parseEvent: () => [],
          sessionId: () => undefined,
        };
      }
    `);
    await expect(
      loadPluginAdapter("acme", { plugin: pluginPath }, {}, home),
    ).rejects.toThrow(/does not match config key/);
  });

  it("fails when a required method is not a function", async () => {
    const { home, pluginPath } = writePlugin(`
      export function createAdapter() {
        return {
          id: "acme",
          childChannel: "mcp",
          prepare: "nope",
          resume: async () => ({ argv: [], env: {}, files: [], cwd: "/" }),
          parseEvent: () => [],
          sessionId: () => undefined,
        };
      }
    `);
    await expect(
      loadPluginAdapter("acme", { plugin: pluginPath }, {}, home),
    ).rejects.toThrow(/prepare must be a function/);
  });
});

describe("createAdapterRegistry — plugin wiring", () => {
  it("registers a successful plugin", async () => {
    const { home, pluginPath } = writePlugin(GOOD_ADAPTER);
    const registry = await createAdapterRegistry({}, {
      config: { vendors: { acme: { plugin: pluginPath } } },
      parleyHome: home,
    });
    expect(registry.has("acme")).toBe(true);
    expect(registry.has("codex")).toBe(true);
  });

  it("logs and skips a failing plugin without crashing", async () => {
    const logs: string[] = [];
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "parley-plugin-bad-"));
    scratch.push(home);
    const registry = await createAdapterRegistry({}, {
      config: { vendors: { broken: { plugin: path.join(home, "missing.mjs") } } },
      parleyHome: home,
      log: (line) => logs.push(line),
    });
    expect(registry.has("broken")).toBe(false);
    expect(logs.some((l) => /failed to load plugin adapter "broken"/.test(l))).toBe(true);
  });

  it("warns when a plugin shadows a built-in", async () => {
    const { home, pluginPath } = writePlugin(`
      export function createAdapter() {
        return {
          id: "fake",
          childChannel: "mcp",
          prepare: async () => ({ argv: ["shadow"], env: {}, files: [], cwd: "/" }),
          resume: async () => ({ argv: ["shadow"], env: {}, files: [], cwd: "/" }),
          parseEvent: () => [],
          sessionId: () => undefined,
        };
      }
    `);
    const logs: string[] = [];
    const registry = await createAdapterRegistry({}, {
      config: { vendors: { fake: { plugin: pluginPath } } },
      parleyHome: home,
      log: (line) => logs.push(line),
    });
    expect(logs.some((l) => /shadows built-in/.test(l))).toBe(true);
    const plan = await registry.get("fake")!.prepare(
      {
        id: "t1",
        name: null,
        prompt: "p",
        vendor: "fake",
        model: null,
        effort: null,
        cwd: "/tmp",
        sandbox: "workspace",
        network: true,
        answerTimeoutMs: 1000,
        extraArgs: [],
      },
      { url: "http://x", headers: {} },
    );
    expect(plan.argv[0]).toBe("shadow");
  });
});
