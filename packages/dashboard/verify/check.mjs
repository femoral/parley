/**
 * Merge-time screen check — local gate (no CI in v1 per #345).
 *
 * Runs the three acceptance demos against the placeholder shell and exits
 * non-zero if any demo fails or the ledger entry is incomplete.
 *
 *   pnpm --filter @useparley/dashboard verify
 *   pnpm --filter @useparley/dashboard verify:check
 */
import fs from "node:fs";
import path from "node:path";
import { runStagedDaemonDemo } from "./demos/staged-daemon.mjs";
import { runInterceptErrorDemo } from "./demos/intercept-error.mjs";
import { runReconnectDemo } from "./demos/reconnect.mjs";
import { readLedger } from "./lib/ledger.mjs";
import { LEDGER_ROOT, relFromRepo } from "./lib/paths.mjs";

const REQUIRED_DEMOS = ["staged-daemon", "intercept-error", "reconnect"];
const TICKET = "issue-353";

async function main() {
  const skipRun = process.argv.includes("--ledger-only");
  if (!skipRun) {
    console.log("[verify:check] running acceptance demos…");
    await runStagedDaemonDemo();
    await runInterceptErrorDemo();
    await runReconnectDemo();
  }

  const ledger = readLedger(TICKET);
  if (!ledger) {
    throw new Error(`missing ledger entry for ${TICKET}`);
  }
  const missing = REQUIRED_DEMOS.filter((d) => !ledger.demos?.[d]);
  if (missing.length > 0) {
    throw new Error(`ledger missing demos: ${missing.join(", ")}`);
  }

  // Each demo must have viewport measurements at 1280/1460/1920.
  for (const id of REQUIRED_DEMOS) {
    const demo = ledger.demos[id];
    const vps = demo.viewports;
    if (!Array.isArray(vps) || vps.length < 3) {
      throw new Error(`${id}: expected ≥3 viewport measurements`);
    }
    const names = new Set(vps.map((v) => v.name));
    for (const n of ["1280", "1460", "1920"]) {
      if (!names.has(n)) throw new Error(`${id}: missing viewport ${n}`);
    }
    const shell = vps[0]?.elements?.shell;
    if (!shell?.found || !shell.box) {
      throw new Error(`${id}: shell element not measured`);
    }
  }

  const entryRel = relFromRepo(path.join(LEDGER_ROOT, TICKET, "entry.json"));
  console.log(`[verify:check] ok — ${entryRel}`);
  console.log(
    JSON.stringify(
      {
        ticket: TICKET,
        demos: REQUIRED_DEMOS,
        entryBytes: fs.statSync(path.join(LEDGER_ROOT, TICKET, "entry.json")).size,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error("[verify:check] failed:", err);
  process.exit(1);
});
