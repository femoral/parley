import { describe, expect, it } from "vitest";
import path from "node:path";
import {
  isParleyIsolatedVendorHome,
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
    expect(ids).not.toContain("fake");
  });
});
