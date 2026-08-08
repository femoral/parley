/**
 * Merge-time screen check — local gate (no CI in v1 per #345).
 *
 * Demo list comes from demos/registry.mjs (screen tickets append there).
 *
 *   pnpm --filter @useparley/dashboard verify
 *   pnpm --filter @useparley/dashboard verify:check
 */
import fs from "node:fs";
import path from "node:path";
import { DEMO_REGISTRY, ticketsFromRegistry } from "./demos/registry.mjs";
import {
  assertRunDimInkContrast,
  assertStateInkGroundContrast,
} from "./lib/contrast.mjs";
import {
  assertAllLedgerShotWidths,
  assertLedgerShotWidths,
  ledgerDirs,
  readLedger,
} from "./lib/ledger.mjs";
import { LEDGER_ROOT, relFromRepo } from "./lib/paths.mjs";

async function main() {
  // #364 — pure token contrast gate (no browser). Fails on ramp regression.
  // Neuter evidence: restoring --state-failed: #d9534a fails surface-soft (~4.28)
  // and surface-active (~3.85).
  const contrastGate = assertStateInkGroundContrast();
  console.log(
    `[verify:check] state-ink contrast ok — ${contrastGate.pairings} pairings; ` +
      `worst ${contrastGate.worst.ink} on ${contrastGate.worst.ground} = ${contrastGate.worst.ratio}:1`,
  );

  // #370 — inherited-card dim inks must clear AA on their actual grounds.
  const dimGate = assertRunDimInkContrast();
  console.log(
    `[verify:check] run-dim-ink contrast ok — ${dimGate.pairings} pairings; ` +
      `worst ${dimGate.worst.ink} on ${dimGate.worst.ground} = ${dimGate.worst.ratio}:1`,
  );

  const skipRun = process.argv.includes("--ledger-only");
  if (!skipRun) {
    console.log("[verify:check] running acceptance demos…");
    for (const demo of DEMO_REGISTRY) {
      console.log(`[verify:check] ${demo.ticket}/${demo.id}`);
      await demo.run();
    }
  }

  // #364 — filename viewport must match PNG IHDR width (when shots present).
  const shotGate = assertAllLedgerShotWidths();
  if (shotGate.files > 0) {
    console.log(
      `[verify:check] ledger shot widths ok — ${shotGate.files} file(s) across ${shotGate.tickets} ticket(s)`,
    );
  } else {
    console.log(
      "[verify:check] ledger shot widths skipped — no shots/ PNGs present (gitignored)",
    );
  }

  const TICKETS = ticketsFromRegistry();

  for (const [ticket, required] of Object.entries(TICKETS)) {
    const ledger = readLedger(ticket);
    if (!ledger) {
      throw new Error(`missing ledger entry for ${ticket}`);
    }
    const missing = required.filter((d) => !ledger.demos?.[d]);
    if (missing.length > 0) {
      throw new Error(`${ticket} ledger missing demos: ${missing.join(", ")}`);
    }

    for (const id of required) {
      const demo = ledger.demos[id];
      const reg = DEMO_REGISTRY.find((d) => d.ticket === ticket && d.id === id);
      if (reg?.kind === "find-honesty" || id === "find-honesty") {
        const states = demo.states ?? {};
        for (const s of ["loading", "error", "noMatch"]) {
          if (!states[s]) throw new Error(`${id}: missing find state ${s}`);
        }
        continue;
      }
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

    // Per-entry gates (registry.gates) — screen tickets add gates without
    // hard-branching here. See SCREENS.md § registration protocol.
    for (const id of required) {
      const reg = DEMO_REGISTRY.find((d) => d.ticket === ticket && d.id === id);
      if (typeof reg?.gates === "function") {
        reg.gates(reg, ledger);
      }
    }

    // Per-ticket shot width when demos just wrote PNGs
    const { shotsDir } = ledgerDirs(ticket);
    if (fs.existsSync(shotsDir)) {
      assertLedgerShotWidths(shotsDir);
    }

    const entryRel = relFromRepo(path.join(LEDGER_ROOT, ticket, "entry.json"));
    console.log(`[verify:check] ok — ${entryRel}`);
    console.log(
      JSON.stringify(
        {
          ticket,
          demos: required,
          entryBytes: fs.statSync(path.join(LEDGER_ROOT, ticket, "entry.json")).size,
        },
        null,
        2,
      ),
    );
  }
}

main().catch((err) => {
  console.error("[verify:check] failed:", err);
  process.exit(1);
});
