/**
 * #330 — UI must not mask Node builtins; the client build fails loudly instead.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { rejectNodeBuiltinsInClient } from "../vite.config.js";

const UI_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("core browser export + client guard (#330)", () => {
  it("does not ship node:path / node:os shims", () => {
    expect(fs.existsSync(path.join(UI_ROOT, "src/shims"))).toBe(false);
    expect(fs.existsSync(path.join(UI_ROOT, "src/shims/path.ts"))).toBe(false);
    expect(fs.existsSync(path.join(UI_ROOT, "src/shims/os.ts"))).toBe(false);
  });

  it("vite config has no shim alias block", () => {
    const viteSrc = fs.readFileSync(path.join(UI_ROOT, "vite.config.ts"), "utf8");
    expect(viteSrc).not.toMatch(/src\/shims/);
    expect(viteSrc).not.toMatch(/find:\s*\/\^node:path\$\//);
    expect(viteSrc).not.toMatch(/find:\s*\/\^node:os\$\//);
    expect(viteSrc).toMatch(/rejectNodeBuiltinsInClient/);
  });

  it("rejectNodeBuiltinsInClient errors on node:path resolve", () => {
    const plugin = rejectNodeBuiltinsInClient();
    const resolveId = plugin.resolveId;
    expect(typeof resolveId).toBe("function");
    // Rollup plugin context: only `error` is used.
    let message = "";
    const ctx = {
      error(err: string | Error) {
        message = typeof err === "string" ? err : err.message;
        throw new Error(message);
      },
    };
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (resolveId as any).call(ctx, "node:path", "/virtual/importer.ts"),
    ).toThrow(/Node builtin/);
    expect(message).toMatch(/node:path/);
    expect(message).toMatch(/browser/);
  });

  it("rejectNodeBuiltinsInClient ignores non-builtin package ids", () => {
    const plugin = rejectNodeBuiltinsInClient();
    const resolveId = plugin.resolveId;
    const ctx = {
      error(err: string | Error): never {
        throw typeof err === "string" ? new Error(err) : err;
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = (resolveId as any).call(ctx, "react", "/virtual/x.ts");
    expect(result).toBeUndefined();
    // Deep package path that merely contains a builtin-looking segment.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((resolveId as any).call(ctx, "some-pkg/path/util", "/virtual/x.ts")).toBeUndefined();
  });
});
