import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readConfig } from "../src/config.js";

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
