import { describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import {
  collapseOperatorHomeInText,
  displayVendorPath,
  isParleyIsolatedVendorHome,
  operatorHomeDir,
  operatorVendorHomeIds,
  resolveOperatorVendorHome,
} from "../src/vendor-home.js";

describe("resolveOperatorVendorHome", () => {
  it("returns the well-known path under HOME when no env override is set", () => {
    const env = { HOME: "/tmp/operator" };
    expect(resolveOperatorVendorHome("codex", env)).toBe(
      path.join("/tmp/operator", ".codex"),
    );
    expect(resolveOperatorVendorHome("kimi", env)).toBe(
      path.join("/tmp/operator", ".kimi-code"),
    );
    expect(resolveOperatorVendorHome("openclaw", env)).toBe(
      path.join("/tmp/operator", ".openclaw"),
    );
  });

  it("honours genuine CODEX_HOME / KIMI_CODE_HOME / OPENCLAW_STATE_DIR overrides", () => {
    expect(
      resolveOperatorVendorHome("codex", {
        HOME: "/tmp/operator",
        CODEX_HOME: "/tmp/custom-codex",
      }),
    ).toBe(path.resolve("/tmp/custom-codex"));
    expect(
      resolveOperatorVendorHome("kimi", {
        HOME: "/tmp/operator",
        KIMI_CODE_HOME: "/tmp/custom-kimi",
      }),
    ).toBe(path.resolve("/tmp/custom-kimi"));
    expect(
      resolveOperatorVendorHome("openclaw", {
        HOME: "/tmp/operator",
        OPENCLAW_STATE_DIR: "/tmp/custom-openclaw",
      }),
    ).toBe(path.resolve("/tmp/custom-openclaw"));
  });

  it("ignores empty env overrides and falls back to the default", () => {
    expect(
      resolveOperatorVendorHome("kimi", { HOME: "/tmp/operator", KIMI_CODE_HOME: "  " }),
    ).toBe(path.join("/tmp/operator", ".kimi-code"));
  });

  it("returns null for unknown vendors (no invented layout)", () => {
    expect(resolveOperatorVendorHome("no-such-vendor", { HOME: "/tmp/operator" })).toBeNull();
  });

  it("refuses a parley-provisioned kimi task home on KIMI_CODE_HOME (finding 2)", () => {
    // The shape a delegated child sees: adapter set KIMI_CODE_HOME to
    // <task.cwd>/.parley-kimi. Discovery must fall back to the operator default,
    // not read the task-controlled tree into the global catalog.
    const taskCwd = "/tmp/worktree/task-t382";
    const isolated = path.join(taskCwd, ".parley-kimi");
    expect(isParleyIsolatedVendorHome(isolated)).toBe(true);
    const resolved = resolveOperatorVendorHome("kimi", {
      HOME: "/tmp/operator",
      KIMI_CODE_HOME: isolated,
    });
    expect(resolved).toBe(path.join("/tmp/operator", ".kimi-code"));
    expect(resolved).not.toBe(isolated);
    expect(resolved).not.toContain(".parley-kimi");
  });

  it("refuses other adapter isolation markers", () => {
    const home = "/tmp/operator";
    expect(
      resolveOperatorVendorHome("openclaw", {
        HOME: home,
        OPENCLAW_STATE_DIR: "/tmp/wt/.openclaw-state",
      }),
    ).toBe(path.join(home, ".openclaw"));
    expect(
      resolveOperatorVendorHome("hermes", {
        HOME: home,
        HERMES_HOME: "/tmp/wt/.parley/hermes-home",
      }),
    ).toBe(path.join(home, ".hermes"));
    expect(
      resolveOperatorVendorHome("goose", {
        HOME: home,
        GOOSE_PATH_ROOT: "/tmp/wt/.parley-goose",
      }),
    ).toBe(path.join(home, ".config", "goose"));
    expect(
      resolveOperatorVendorHome("openhands", {
        HOME: home,
        OPENHANDS_PERSISTENCE_DIR: "/tmp/wt/.parley-openhands/persist",
      }),
    ).toBe(path.join(home, ".openhands"));
  });

  it("aligns goose override and default at the config-directory level (finding 9)", () => {
    // GOOSE_PATH_ROOT is a tree root; config lives at <root>/config/.
    // Default is already the config dir (~/.config/goose).
    expect(
      resolveOperatorVendorHome("goose", {
        HOME: "/tmp/operator",
        GOOSE_PATH_ROOT: "/opt/goose-root",
      }),
    ).toBe(path.join("/opt/goose-root", "config"));
    expect(resolveOperatorVendorHome("goose", { HOME: "/tmp/operator" })).toBe(
      path.join("/tmp/operator", ".config", "goose"),
    );
  });

  it("lists only vendors with a known operator-home layout", () => {
    const ids = operatorVendorHomeIds();
    expect(ids).toContain("codex");
    expect(ids).toContain("kimi");
    expect(ids).toContain("openclaw");
    expect(ids).toContain("cline");
    expect(ids).not.toContain("fake");
  });

  it("resolves cline default home and refuses .cline-parley isolation (#284)", () => {
    const home = "/tmp/operator";
    expect(resolveOperatorVendorHome("cline", { HOME: home })).toBe(
      path.join(home, ".cline"),
    );
    expect(
      resolveOperatorVendorHome("cline", {
        HOME: home,
        CLINE_DATA_DIR: "/tmp/wt/.cline-parley",
      }),
    ).toBe(path.join(home, ".cline"));
    expect(
      resolveOperatorVendorHome("cline", {
        HOME: home,
        CLINE_DATA_DIR: "/opt/custom-cline",
      }),
    ).toBe(path.resolve("/opt/custom-cline"));
  });
});

describe("displayVendorPath / operatorHomeDir", () => {
  it("collapses paths under HOME to tilde form", () => {
    expect(
      displayVendorPath("/tmp/operator/.codex/models_cache.json", { HOME: "/tmp/operator" }),
    ).toBe("~/.codex/models_cache.json");
  });

  it("uses os.homedir() when HOME is unset or empty so absolute paths do not leak", () => {
    const realHome = os.homedir();
    expect(operatorHomeDir({})).toBe(realHome);
    expect(operatorHomeDir({ HOME: "" })).toBe(realHome);
    const abs = path.join(realHome, ".codex", "models_cache.json");
    expect(displayVendorPath(abs, {})).toBe("~/.codex/models_cache.json");
    expect(displayVendorPath(abs, { HOME: "" })).toBe("~/.codex/models_cache.json");
  });

  it("leaves paths outside the operator home unchanged", () => {
    expect(displayVendorPath("/opt/elsewhere/cache.json", { HOME: "/tmp/operator" })).toBe(
      "/opt/elsewhere/cache.json",
    );
  });
});

describe("collapseOperatorHomeInText", () => {
  it("collapses home path prefixes embedded mid-string (fs error shape)", () => {
    const home = "/tmp/operator";
    const msg = `EACCES: permission denied, open "${home}/.hermes/cache/model_catalog.json"`;
    expect(collapseOperatorHomeInText(msg, { HOME: home })).toBe(
      'EACCES: permission denied, open "~/.hermes/cache/model_catalog.json"',
    );
  });

  it("collapses bare home at a path boundary (end, quote, whitespace)", () => {
    const home = "/tmp/operator";
    expect(collapseOperatorHomeInText(`open '${home}'`, { HOME: home })).toBe("open '~'");
    expect(collapseOperatorHomeInText(`cwd ${home} ok`, { HOME: home })).toBe("cwd ~ ok");
    expect(collapseOperatorHomeInText(home, { HOME: home })).toBe("~");
  });

  it("does not match a longer path that only shares a home prefix substring", () => {
    // /tmp/operator-extra must not become ~/.extra when HOME is /tmp/operator
    const msg = 'open "/tmp/operator-extra/.codex/cache.json"';
    expect(collapseOperatorHomeInText(msg, { HOME: "/tmp/operator" })).toBe(msg);
  });

  it("leaves text without the home prefix unchanged", () => {
    expect(
      collapseOperatorHomeInText("EACCES: permission denied", { HOME: "/tmp/operator" }),
    ).toBe("EACCES: permission denied");
  });
});
