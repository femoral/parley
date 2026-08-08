/**
 * #364 — state-ink × ground contrast gate must pass and must fail on neuter.
 * Runs the real verify helpers so the gate cannot stay green if inverted.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const tokensPath = path.join(root, "src/tokens.css");
const contrastLib = path.join(root, "verify/lib/contrast.mjs");
const ledgerLib = path.join(root, "verify/lib/ledger.mjs");

const temps: string[] = [];

afterEach(() => {
  for (const d of temps.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

function runNode(code: string): string {
  return execFileSync(
    process.execPath,
    ["--input-type=module", "-e", code],
    { encoding: "utf8", cwd: root },
  ).trim();
}

describe("state-ink ground contrast gate (#364)", () => {
  it("passes on live tokens.css", () => {
    const out = runNode(`
      import { assertStateInkGroundContrast } from ${JSON.stringify(contrastLib)};
      const r = assertStateInkGroundContrast({ tokensPath: ${JSON.stringify(tokensPath)} });
      console.log(JSON.stringify(r));
    `);
    const r = JSON.parse(out) as {
      ok: boolean;
      pairings: number;
      worst: { ratio: number; ink: string; ground: string };
    };
    expect(r.ok).toBe(true);
    expect(r.pairings).toBeGreaterThan(50);
    expect(r.worst.ratio).toBeGreaterThanOrEqual(4.5);
  });

  it("fails when --state-failed is neutered to the pre-#364 value", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pc-contrast-"));
    temps.push(tmp);
    const neutered = path.join(tmp, "tokens.css");
    const src = fs.readFileSync(tokensPath, "utf8");
    // Pre-lift failed ink: 4.28 on surface-soft / 3.85 on surface-active.
    const outSrc = src.replace(
      /--state-failed:\s*#[0-9a-fA-F]{3,8}/,
      "--state-failed: #d9534a",
    );
    expect(outSrc).not.toBe(src);
    fs.writeFileSync(neutered, outSrc);

    let threw = false;
    let message = "";
    try {
      runNode(`
        import { assertStateInkGroundContrast } from ${JSON.stringify(contrastLib)};
        assertStateInkGroundContrast({ tokensPath: ${JSON.stringify(neutered)} });
      `);
    } catch (err) {
      threw = true;
      message = err instanceof Error ? err.message : String(err);
    }
    expect(threw).toBe(true);
    expect(message).toMatch(/state-ink contrast gate/);
  });
});

describe("run dim-ink contrast gate (#370)", () => {
  it("passes on live tokens.css", () => {
    const out = runNode(`
      import { assertRunDimInkContrast } from ${JSON.stringify(contrastLib)};
      const r = assertRunDimInkContrast({ tokensPath: ${JSON.stringify(tokensPath)} });
      console.log(JSON.stringify(r));
    `);
    const r = JSON.parse(out) as {
      ok: boolean;
      pairings: number;
      worst: { ratio: number; ink: string; ground: string };
    };
    expect(r.ok).toBe(true);
    expect(r.pairings).toBeGreaterThan(10);
    expect(r.worst.ratio).toBeGreaterThanOrEqual(4.5);
  });

  it("fails when a dim ink is neutered below AA", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pc-dim-contrast-"));
    temps.push(tmp);
    const neutered = path.join(tmp, "tokens.css");
    const src = fs.readFileSync(tokensPath, "utf8");
    const outSrc = src.replace(
      /--run-ink-dim-4:\s*#[0-9a-fA-F]{3,8}/,
      "--run-ink-dim-4: #3a4248",
    );
    expect(outSrc).not.toBe(src);
    fs.writeFileSync(neutered, outSrc);

    let threw = false;
    let message = "";
    try {
      runNode(`
        import { assertRunDimInkContrast } from ${JSON.stringify(contrastLib)};
        assertRunDimInkContrast({ tokensPath: ${JSON.stringify(neutered)} });
      `);
    } catch (err) {
      threw = true;
      message = err instanceof Error ? err.message : String(err);
    }
    expect(threw).toBe(true);
    expect(message).toMatch(/run-dim-ink contrast gate/);
  });
});

describe("ledger shot width gate (#364)", () => {
  it("detects a mislabeled PNG via IHDR", () => {
    // Minimal 1×1 PNG
    const png1x1 = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pc-shots-"));
    temps.push(tmp);
    const bad = path.join(tmp, "demo-1460.png");
    fs.writeFileSync(bad, png1x1);

    let threw = false;
    let message = "";
    try {
      runNode(`
        import { assertLedgerShotWidths, readPngWidth } from ${JSON.stringify(ledgerLib)};
        const w = readPngWidth(${JSON.stringify(bad)});
        if (w !== 1) throw new Error("expected 1px, got " + w);
        assertLedgerShotWidths(${JSON.stringify(tmp)});
      `);
    } catch (err) {
      threw = true;
      message = err instanceof Error ? err.message : String(err);
    }
    expect(threw).toBe(true);
    expect(message).toMatch(/ledger shot width mismatch/);
  });
});
