/**
 * CSS token lint (#367) — drives the REAL scripts/lint-tokens.mjs so CI
 * cannot stay green if that script is inverted.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const script = path.join(root, "scripts/lint-tokens.mjs");

const temps: string[] = [];

afterEach(() => {
  for (const d of temps.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

function makeTempSrc(files: Record<string, string>): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pc-lint-"));
  temps.push(tmpDir);
  const src = path.join(tmpDir, "src");
  fs.mkdirSync(src, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(src, name), body);
  }
  return src;
}

function runLint(srcRoot: string): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [script, "--root", srcRoot], {
      encoding: "utf8",
      cwd: root,
    });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return {
      status: typeof e.status === "number" ? e.status : 1,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
    };
  }
}

describe("lint-tokens (console CSS)", () => {
  it("passes on the current dashboard tree (default root)", () => {
    const out = execFileSync(process.execPath, [script], {
      encoding: "utf8",
      cwd: root,
    });
    expect(out).toMatch(/lint-tokens: ok/);
  });

  it("fails when a CSS file outside tokens.css has a literal font: or hex", () => {
    const dirty = makeTempSrc({
      "tokens.css": ":root { --x: #0b0d0f; }\n",
      "bad.css": ".x { font: 400 12px/1 sans-serif; color: #ff00aa; }\n",
    });
    const r = runLint(dirty);
    expect(r.status).toBe(1);
    expect(r.stderr + r.stdout).toMatch(/lint-tokens:.*violation/);
    expect(r.stderr + r.stdout).toMatch(/font-literal|hex-color/);
  });

  it("passes a clean temp tree that only uses tokens", () => {
    const clean = makeTempSrc({
      "tokens.css": ":root { --type-row: 500 11px/1 var(--font-sans); --ink: #0b0d0f; }\n",
      "ok.css": ".x { font: var(--type-row); color: var(--ink); }\n",
    });
    const r = runLint(clean);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/lint-tokens: ok/);
  });
});
