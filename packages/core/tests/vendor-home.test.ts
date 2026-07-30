import { describe, expect, it } from "vitest";
import path from "node:path";
import {
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

  it("honours CODEX_HOME / KIMI_CODE_HOME / OPENCLAW_STATE_DIR overrides", () => {
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

  it("never resolves to a per-task isolated home (no task cwd in the contract)", () => {
    // Isolated kimi homes look like `<task.cwd>/.parley-kimi`. The operator
    // resolver has no task cwd argument and must not invent one — with only
    // HOME set it always lands under the operator home.
    const taskCwd = "/tmp/worktree/task-t382";
    const isolated = path.join(taskCwd, ".parley-kimi");
    const resolved = resolveOperatorVendorHome("kimi", { HOME: "/tmp/operator" });
    expect(resolved).not.toBe(isolated);
    expect(resolved).not.toContain(".parley-kimi");
    expect(resolved).toBe(path.join("/tmp/operator", ".kimi-code"));
  });

  it("lists only vendors with a known operator-home layout", () => {
    const ids = operatorVendorHomeIds();
    expect(ids).toContain("codex");
    expect(ids).toContain("kimi");
    expect(ids).toContain("openclaw");
    expect(ids).not.toContain("fake");
  });
});
