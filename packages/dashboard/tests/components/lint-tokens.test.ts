/**
 * CSS token lint (#367) — wired into the unit suite so CI fails on
 * literal font: shorthands or hex colors outside tokens.css.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const script = path.join(root, "scripts/lint-tokens.mjs");

describe("lint-tokens (console CSS)", () => {
  it("passes on the current dashboard tree", () => {
    const out = execFileSync(process.execPath, [script], {
      encoding: "utf8",
      cwd: root,
    });
    expect(out).toMatch(/lint-tokens: ok/);
  });

  it("fails when a screen CSS file introduces a literal font: or hex", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pc-lint-"));
    const src = path.join(tmpDir, "src");
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, "tokens.css"), ":root { --x: #0b0d0f; }\n");
    fs.writeFileSync(
      path.join(src, "bad.css"),
      ".x { font: 400 12px/1 sans-serif; color: #ff00aa; }\n",
    );

    // Run the lint logic inline against tmp (script is rooted at packages/dashboard).
    // Spawn a one-off that reuses the same rules by copying the script and pointing
    // SRC via a tiny wrapper.
    const wrapper = path.join(tmpDir, "run.mjs");
    fs.writeFileSync(
      wrapper,
      `
import fs from "node:fs";
import path from "node:path";
const srcRoot = ${JSON.stringify(src)};
const FONT_LITERAL = /(?:^|[{;\\s])font:\\s*(?!var\\()/;
const HEX = /#[0-9a-fA-F]{3,8}\\b/;
function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(full, out);
    else if (ent.name.endsWith(".css")) out.push(full);
  }
  return out;
}
function stripComments(line) {
  const idx = line.indexOf("/*");
  return idx === -1 ? line : line.slice(0, idx);
}
const hits = [];
for (const file of walk(srcRoot)) {
  if (path.basename(file) === "tokens.css") continue;
  const lines = fs.readFileSync(file, "utf8").split(/\\r?\\n/);
  for (let i = 0; i < lines.length; i++) {
    const code = stripComments(lines[i]);
    if (!code.trim()) continue;
    if (FONT_LITERAL.test(code) || HEX.test(code)) hits.push(file + ":" + (i + 1));
  }
}
if (hits.length === 0) { console.error("expected failures"); process.exit(2); }
console.log("failed-as-expected", hits.length);
process.exit(1);
`,
    );
    let failed = false;
    let stdout = "";
    try {
      stdout = execFileSync(process.execPath, [wrapper], { encoding: "utf8" });
    } catch (err) {
      failed = true;
      const e = err as { stdout?: string; status?: number };
      stdout = e.stdout ?? "";
      expect(e.status).toBe(1);
    }
    expect(failed).toBe(true);
    expect(stdout).toMatch(/failed-as-expected/);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
