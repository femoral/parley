/**
 * Drive a verify demo's merge gate over a ledger fixture, in a subprocess.
 *
 * The gates live on the demo modules, which import playwright and the
 * daemon/vite session helpers at module scope. Running them out-of-process
 * keeps that graph out of the vitest worker — the same reason
 * `state-ink-contrast.test.ts` shells out.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dashboardRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

export type GateResult = { threw: boolean; message: string };

/** Absolute path to a committed ledger entry.json. */
function ledgerPath(ticket: string): string {
  return path.join(dashboardRoot, "verify/ledger", ticket, "entry.json");
}

/** Fresh parsed copy of a committed ledger, safe to mutate per test. */
export function readLedgerFixture<T = Record<string, unknown>>(ticket: string): T {
  return JSON.parse(fs.readFileSync(ledgerPath(ticket), "utf8")) as T;
}

/**
 * Call `<gate>(entry, ledger)` from `verify/demos/<demo>` against `ledger`.
 * Never throws for a gate failure — the throw is the result under test.
 */
export function runVerifyGate(opts: {
  /** Demo module filename under verify/demos, e.g. "console-rails.mjs". */
  demo: string;
  /** Named gate export on that module, e.g. "consoleRailsGates". */
  gate: string;
  ledger: unknown;
}): GateResult {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pc-verify-gate-"));
  const file = path.join(tmp, "entry.json");
  fs.writeFileSync(file, JSON.stringify(opts.ledger));
  const demoPath = path.join(dashboardRoot, "verify/demos", opts.demo);

  try {
    execFileSync(
      process.execPath,
      [
        // Some demo modules import dashboard `src/` TypeScript, so the gate
        // subprocess needs the same loader the verify:* npm scripts use.
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `
        import fs from "node:fs";
        import { ${opts.gate} } from ${JSON.stringify(demoPath)};
        const ledger = JSON.parse(fs.readFileSync(${JSON.stringify(file)}, "utf8"));
        ${opts.gate}({}, ledger);
        `,
      ],
      { encoding: "utf8", cwd: dashboardRoot, stdio: ["ignore", "pipe", "pipe"] },
    );
    return { threw: false, message: "" };
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    return { threw: true, message: e.stderr || e.message || String(err) };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
