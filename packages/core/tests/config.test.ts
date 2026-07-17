import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  collectUnknownConfigKeys,
  DEFAULT_RETENTION_DAYS,
  getConfigPath,
  readConfig,
  retentionDays,
  setConfigPath,
  unsetConfigPath,
  validateConfig,
  writeConfig as writeConfigFile,
} from "../src/config.js";

function writeConfig(contents: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "parley-config-"));
  const file = path.join(dir, "parley.json");
  fs.writeFileSync(file, contents);
  return file;
}

describe("readConfig — missing / corrupt", () => {
  it("returns {} when the file does not exist", () => {
    const file = path.join(os.tmpdir(), `parley-missing-${Date.now()}.json`);
    expect(readConfig(file)).toEqual({});
  });

  it("names the file on JSON syntax error", () => {
    const file = writeConfig("{ not json");
    expect(() => readConfig(file)).toThrow(/invalid config at/);
    expect(() => readConfig(file)).toThrow(file);
  });

  it("rejects a non-object root", () => {
    const file = writeConfig("[]");
    expect(() => readConfig(file)).toThrow(/must be a JSON object/);
  });
});

describe("readConfig — ui.*", () => {
  it("accepts path and package strings", () => {
    const file = writeConfig(JSON.stringify({ ui: { path: "/x", package: "@useparley/ui" } }));
    expect(readConfig(file).ui).toEqual({ path: "/x", package: "@useparley/ui" });
  });

  it("rejects empty ui.path", () => {
    const file = writeConfig(JSON.stringify({ ui: { path: "" } }));
    expect(() => readConfig(file)).toThrow(/ui\.path must be a non-empty string/);
  });

  it("rejects non-string ui.package", () => {
    const file = writeConfig(JSON.stringify({ ui: { package: 1 } }));
    expect(() => readConfig(file)).toThrow(/ui\.package must be a non-empty string/);
  });
});

describe("readConfig — daemon.*", () => {
  it("accepts daemon.url", () => {
    const file = writeConfig(JSON.stringify({ daemon: { url: "http://host:9" } }));
    expect(readConfig(file).daemon).toEqual({ url: "http://host:9" });
  });

  it("rejects empty daemon.url", () => {
    const file = writeConfig(JSON.stringify({ daemon: { url: "" } }));
    expect(() => readConfig(file)).toThrow(/daemon\.url must be a non-empty string/);
  });

  it("rejects non-object daemon", () => {
    const file = writeConfig(JSON.stringify({ daemon: "x" }));
    expect(() => readConfig(file)).toThrow(/daemon must be an object/);
  });
});

describe("readConfig — retention.*", () => {
  it("accepts retention.days", () => {
    const file = writeConfig(JSON.stringify({ retention: { days: 7 } }));
    expect(readConfig(file).retention).toEqual({ days: 7 });
  });

  it("accepts retention.days = 0 (expire immediately)", () => {
    const file = writeConfig(JSON.stringify({ retention: { days: 0 } }));
    expect(readConfig(file).retention).toEqual({ days: 0 });
  });

  it("rejects non-integer retention.days", () => {
    const file = writeConfig(JSON.stringify({ retention: { days: 1.5 } }));
    expect(() => readConfig(file)).toThrow(/retention\.days must be a non-negative integer/);
  });

  it("rejects negative retention.days", () => {
    const file = writeConfig(JSON.stringify({ retention: { days: -1 } }));
    expect(() => readConfig(file)).toThrow(/retention\.days must be a non-negative integer/);
  });

  it("retentionDays defaults to 30 when unset", () => {
    expect(retentionDays({})).toBe(DEFAULT_RETENTION_DAYS);
    expect(DEFAULT_RETENTION_DAYS).toBe(30);
  });
});

describe("readConfig — vendors.*", () => {
  it("accepts bin, args, env, plugin", () => {
    const file = writeConfig(
      JSON.stringify({
        vendors: {
          codex: {
            bin: "/opt/codex",
            args: ["--foo"],
            env: { A: "1" },
            plugin: "/plugins/codex.js",
          },
        },
      }),
    );
    expect(readConfig(file).vendors?.codex).toEqual({
      bin: "/opt/codex",
      args: ["--foo"],
      env: { A: "1" },
      plugin: "/plugins/codex.js",
    });
  });

  it("rejects non-object vendors", () => {
    const file = writeConfig(JSON.stringify({ vendors: [] }));
    expect(() => readConfig(file)).toThrow(/vendors must be an object/);
  });

  it("rejects empty vendors.<id>.bin", () => {
    const file = writeConfig(JSON.stringify({ vendors: { codex: { bin: "" } } }));
    expect(() => readConfig(file)).toThrow(/vendors\.codex\.bin must be a non-empty string/);
  });

  it("rejects non-array vendors.<id>.args", () => {
    const file = writeConfig(JSON.stringify({ vendors: { codex: { args: "x" } } }));
    expect(() => readConfig(file)).toThrow(/vendors\.codex\.args must be an array of strings/);
  });

  it("rejects non-string args entries", () => {
    const file = writeConfig(JSON.stringify({ vendors: { codex: { args: [1] } } }));
    expect(() => readConfig(file)).toThrow(/vendors\.codex\.args must be an array of strings/);
  });

  it("rejects non-string vendors.<id>.env values", () => {
    const file = writeConfig(JSON.stringify({ vendors: { codex: { env: { A: 1 } } } }));
    expect(() => readConfig(file)).toThrow(/vendors\.codex\.env\.A must be a string/);
  });

  it("rejects empty vendors.<id>.plugin", () => {
    const file = writeConfig(JSON.stringify({ vendors: { x: { plugin: "" } } }));
    expect(() => readConfig(file)).toThrow(/vendors\.x\.plugin must be a non-empty string/);
  });
});

describe("readConfig — profiles.*", () => {
  it("accepts a full profile", () => {
    const file = writeConfig(
      JSON.stringify({
        profiles: {
          deep: {
            vendor: "codex",
            model: "gpt-5",
            effort: "high",
            sandbox: "read-only",
            network: false,
            args: ["--x"],
            env: { K: "v" },
          },
        },
      }),
    );
    expect(readConfig(file).profiles?.deep).toEqual({
      vendor: "codex",
      model: "gpt-5",
      effort: "high",
      sandbox: "read-only",
      network: false,
      args: ["--x"],
      env: { K: "v" },
    });
  });

  it("requires profiles.<name>.vendor", () => {
    const file = writeConfig(JSON.stringify({ profiles: { foo: { model: "x" } } }));
    expect(() => readConfig(file)).toThrow(/profiles\.foo\.vendor is required/);
  });

  it("rejects empty profiles.<name>.vendor", () => {
    const file = writeConfig(JSON.stringify({ profiles: { foo: { vendor: "" } } }));
    expect(() => readConfig(file)).toThrow(/profiles\.foo\.vendor must be a non-empty string/);
  });

  it("rejects invalid profiles.<name>.sandbox", () => {
    const file = writeConfig(
      JSON.stringify({ profiles: { foo: { vendor: "codex", sandbox: "danger" } } }),
    );
    expect(() => readConfig(file)).toThrow(
      /profiles\.foo\.sandbox must be one of read-only\|workspace\|full/,
    );
  });

  it("rejects non-boolean profiles.<name>.network", () => {
    const file = writeConfig(
      JSON.stringify({ profiles: { foo: { vendor: "codex", network: "no" } } }),
    );
    expect(() => readConfig(file)).toThrow(/profiles\.foo\.network must be a boolean/);
  });

  it("rejects non-array profiles.<name>.args", () => {
    const file = writeConfig(
      JSON.stringify({ profiles: { foo: { vendor: "codex", args: {} } } }),
    );
    expect(() => readConfig(file)).toThrow(/profiles\.foo\.args must be an array of strings/);
  });

  it("rejects non-string profiles.<name>.env values", () => {
    const file = writeConfig(
      JSON.stringify({ profiles: { foo: { vendor: "codex", env: { A: true } } } }),
    );
    expect(() => readConfig(file)).toThrow(/profiles\.foo\.env\.A must be a string/);
  });

  it("rejects non-object profiles", () => {
    const file = writeConfig(JSON.stringify({ profiles: "x" }));
    expect(() => readConfig(file)).toThrow(/profiles must be an object/);
  });
});

describe("readConfig — runners.*", () => {
  it("accepts runners.<name>.token", () => {
    const file = writeConfig(
      JSON.stringify({ runners: { gpu: { token: "secret-token" } } }),
    );
    expect(readConfig(file).runners?.gpu).toEqual({ token: "secret-token" });
  });

  it("requires runners.<name>.token", () => {
    const file = writeConfig(JSON.stringify({ runners: { gpu: {} } }));
    expect(() => readConfig(file)).toThrow(/runners\.gpu\.token is required/);
  });

  it("rejects empty runners.<name>.token", () => {
    const file = writeConfig(JSON.stringify({ runners: { gpu: { token: "" } } }));
    expect(() => readConfig(file)).toThrow(/runners\.gpu\.token must be a non-empty string/);
  });

  it("rejects non-object runners", () => {
    const file = writeConfig(JSON.stringify({ runners: "x" }));
    expect(() => readConfig(file)).toThrow(/runners must be an object/);
  });

  it("rejects empty runner names", () => {
    const file = writeConfig(JSON.stringify({ runners: { "": { token: "x" } } }));
    expect(() => readConfig(file)).toThrow(/runners keys must be non-empty strings/);
  });
});

describe("readConfig — unknown keys preserved", () => {
  it("keeps unknown top-level and nested keys", () => {
    const file = writeConfig(
      JSON.stringify({
        experimental: true,
        ui: { path: "/x", theme: "dark" },
        vendors: { codex: { bin: "c", extra: 1 } },
      }),
    );
    const config = readConfig(file) as Record<string, unknown>;
    expect(config.experimental).toBe(true);
    expect((config.ui as { theme: string }).theme).toBe("dark");
    expect((config.vendors as { codex: { extra: number } }).codex.extra).toBe(1);
  });
});

describe("validateConfig / writeConfig / dotted paths", () => {
  it("validateConfig names the source and field", () => {
    expect(() => validateConfig("push", { daemon: { idleTimeoutMs: -1 } })).toThrow(
      /invalid config at push: daemon\.idleTimeoutMs/,
    );
  });

  it("writeConfig round-trips via readConfig", () => {
    const file = writeConfig("{}");
    writeConfigFile(file, { daemon: { idleTimeoutMs: 0 }, experimental: true } as never);
    const config = readConfig(file) as Record<string, unknown>;
    expect(config).toEqual({ daemon: { idleTimeoutMs: 0 }, experimental: true });
  });

  it("get/set/unset dotted paths", () => {
    const root: Record<string, unknown> = {};
    const set = setConfigPath(root, "profiles.fast.vendor", "fake");
    expect(getConfigPath(set, "profiles.fast.vendor")).toEqual({
      found: true,
      value: "fake",
    });
    const unset = unsetConfigPath(set, "profiles.fast.vendor");
    expect(getConfigPath(unset, "profiles.fast.vendor")).toEqual({ found: false });
    // parent object remains after unsetting the leaf
    expect(getConfigPath(unset, "profiles.fast")).toEqual({ found: true, value: {} });
  });

  it("collectUnknownConfigKeys lists dotted unknowns", () => {
    const keys = collectUnknownConfigKeys({
      experimental: true,
      ui: { path: "/x", theme: "dark" },
      vendors: { codex: { bin: "c", extra: 1 } },
      daemon: { idleTimeoutMs: 0 },
    });
    expect(keys).toEqual(
      expect.arrayContaining(["experimental", "ui.theme", "vendors.codex.extra"]),
    );
    expect(keys).not.toContain("daemon.idleTimeoutMs");
    expect(keys).not.toContain("ui.path");
  });
});
