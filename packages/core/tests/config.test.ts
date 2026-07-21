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
  it("accepts bin, args, env, plugin, childChannel, retryWindow", () => {
    const file = writeConfig(
      JSON.stringify({
        vendors: {
          codex: {
            bin: "/opt/codex",
            args: ["--foo"],
            env: { A: "1" },
            plugin: "/plugins/codex.js",
            childChannel: "cli",
            retryWindow: "10m",
          },
        },
      }),
    );
    expect(readConfig(file).vendors?.codex).toEqual({
      bin: "/opt/codex",
      args: ["--foo"],
      env: { A: "1" },
      plugin: "/plugins/codex.js",
      childChannel: "cli",
      retryWindow: "10m",
    });
  });

  it("rejects invalid vendors.<id>.retryWindow", () => {
    const file = writeConfig(JSON.stringify({ vendors: { codex: { retryWindow: "" } } }));
    expect(() => readConfig(file)).toThrow(/vendors\.codex\.retryWindow/);
  });

  it("rejects invalid vendors.<id>.childChannel", () => {
    const file = writeConfig(JSON.stringify({ vendors: { codex: { childChannel: "stdio" } } }));
    expect(() => readConfig(file)).toThrow(
      /vendors\.codex\.childChannel must be one of mcp\|cli\|http/,
    );
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

  it("accepts vendors.<id>.models allowlist (#185)", () => {
    const file = writeConfig(
      JSON.stringify({
        vendors: {
          codex: {
            models: {
              "gpt-5": {
                efforts: ["low", "medium"],
                default: "medium",
                hint: "daily",
              },
              o3: { efforts: ["high"], default: false },
            },
          },
        },
      }),
    );
    expect(readConfig(file).vendors?.codex?.models).toEqual({
      "gpt-5": { efforts: ["low", "medium"], default: "medium", hint: "daily" },
      o3: { efforts: ["high"], default: false },
    });
  });

  it("accepts default: true with a single effort", () => {
    const file = writeConfig(
      JSON.stringify({
        vendors: { v: { models: { m: { efforts: ["low"], default: true } } } },
      }),
    );
    expect(readConfig(file).vendors?.v?.models?.m?.default).toBe(true);
  });

  it("rejects default: true when multiple efforts are listed", () => {
    const file = writeConfig(
      JSON.stringify({
        vendors: {
          v: { models: { m: { efforts: ["low", "high"], default: true } } },
        },
      }),
    );
    expect(() => readConfig(file)).toThrow(/default is true but efforts lists/);
  });

  it("rejects unknown keys on model entries", () => {
    const file = writeConfig(
      JSON.stringify({
        vendors: {
          v: { models: { m: { efforts: ["low"], extra: 1 } } },
        },
      }),
    );
    expect(() => readConfig(file)).toThrow(/unknown key extra/);
  });

  it("rejects missing efforts", () => {
    const file = writeConfig(
      JSON.stringify({ vendors: { v: { models: { m: { default: true } } } } }),
    );
    expect(() => readConfig(file)).toThrow(/efforts is required/);
  });

  it("rejects default effort not in efforts list", () => {
    const file = writeConfig(
      JSON.stringify({
        vendors: {
          v: { models: { m: { efforts: ["low"], default: "high" } } },
        },
      }),
    );
    expect(() => readConfig(file)).toThrow(/not listed in efforts/);
  });

  it("rejects more than one default marker per vendor", () => {
    const file = writeConfig(
      JSON.stringify({
        vendors: {
          v: {
            models: {
              a: { efforts: ["low"], default: true },
              b: { efforts: ["high"], default: "high" },
            },
          },
        },
      }),
    );
    expect(() => readConfig(file)).toThrow(/at most one model may be the default/);
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

  it("accepts template + hint on a profile (#195)", () => {
    const file = writeConfig(
      JSON.stringify({
        profiles: {
          custom: {
            vendor: "my-tool",
            model: "m1",
            effort: "high",
            template: ["my-tool", "--prompt", "$PROMPT"],
            hint: "use for offline tools",
            env: { X: "1" },
          },
        },
      }),
    );
    expect(readConfig(file).profiles?.custom).toEqual({
      vendor: "my-tool",
      model: "m1",
      effort: "high",
      template: ["my-tool", "--prompt", "$PROMPT"],
      hint: "use for offline tools",
      env: { X: "1" },
    });
  });

  it("rejects non-array profiles.<name>.template", () => {
    const file = writeConfig(
      JSON.stringify({ profiles: { foo: { vendor: "codex", template: "x" } } }),
    );
    expect(() => readConfig(file)).toThrow(
      /profiles\.foo\.template must be an array of strings/,
    );
  });

  it("rejects non-string profiles.<name>.hint", () => {
    const file = writeConfig(
      JSON.stringify({ profiles: { foo: { vendor: "codex", hint: 1 } } }),
    );
    expect(() => readConfig(file)).toThrow(/profiles\.foo\.hint must be a string/);
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

describe("readConfig — defaults.*", () => {
  it("accepts defaults.vendor and defaults.profile", () => {
    const file = writeConfig(
      JSON.stringify({ defaults: { vendor: "fake", profile: "deep" } }),
    );
    expect(readConfig(file).defaults).toEqual({ vendor: "fake", profile: "deep" });
  });

  it("accepts either key alone", () => {
    const v = writeConfig(JSON.stringify({ defaults: { vendor: "fake" } }));
    expect(readConfig(v).defaults).toEqual({ vendor: "fake" });
    const p = writeConfig(JSON.stringify({ defaults: { profile: "deep" } }));
    expect(readConfig(p).defaults).toEqual({ profile: "deep" });
  });

  it("rejects empty defaults.vendor", () => {
    const file = writeConfig(JSON.stringify({ defaults: { vendor: "" } }));
    expect(() => readConfig(file)).toThrow(/defaults\.vendor must be a non-empty string/);
  });

  it("rejects empty defaults.profile", () => {
    const file = writeConfig(JSON.stringify({ defaults: { profile: "" } }));
    expect(() => readConfig(file)).toThrow(/defaults\.profile must be a non-empty string/);
  });

  it("rejects non-object defaults", () => {
    const file = writeConfig(JSON.stringify({ defaults: "fake" }));
    expect(() => readConfig(file)).toThrow(/defaults must be an object/);
  });

  it("collectUnknownConfigKeys ignores known defaults keys", () => {
    const keys = collectUnknownConfigKeys({
      defaults: { vendor: "fake", profile: "deep", extra: true },
    });
    expect(keys).toContain("defaults.extra");
    expect(keys).not.toContain("defaults.vendor");
    expect(keys).not.toContain("defaults.profile");
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

describe("readConfig — maxConcurrent (#171)", () => {
  it("accepts vendors.<id>.maxConcurrent positive integer", () => {
    const file = writeConfig(JSON.stringify({ vendors: { fake: { maxConcurrent: 2 } } }));
    expect(readConfig(file).vendors?.fake?.maxConcurrent).toBe(2);
  });

  it("accepts profiles.<name>.maxConcurrent positive integer", () => {
    const file = writeConfig(
      JSON.stringify({ profiles: { deep: { vendor: "fake", maxConcurrent: 1 } } }),
    );
    expect(readConfig(file).profiles?.deep?.maxConcurrent).toBe(1);
  });

  it("rejects zero maxConcurrent", () => {
    const file = writeConfig(JSON.stringify({ vendors: { fake: { maxConcurrent: 0 } } }));
    expect(() => readConfig(file)).toThrow(/vendors\.fake\.maxConcurrent must be a positive integer/);
  });

  it("rejects non-integer maxConcurrent", () => {
    const file = writeConfig(
      JSON.stringify({ profiles: { deep: { vendor: "fake", maxConcurrent: 1.5 } } }),
    );
    expect(() => readConfig(file)).toThrow(
      /profiles\.deep\.maxConcurrent must be a positive integer/,
    );
  });

  it("treats maxConcurrent as a known key", () => {
    expect(
      collectUnknownConfigKeys({
        vendors: { fake: { maxConcurrent: 2 } },
        profiles: { deep: { vendor: "fake", maxConcurrent: 1 } },
      }),
    ).toEqual([]);
  });
});

