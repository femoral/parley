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
import { readLedger } from "./lib/ledger.mjs";
import { LEDGER_ROOT, relFromRepo } from "./lib/paths.mjs";

async function main() {
  const skipRun = process.argv.includes("--ledger-only");
  if (!skipRun) {
    console.log("[verify:check] running acceptance demos…");
    for (const demo of DEMO_REGISTRY) {
      console.log(`[verify:check] ${demo.ticket}/${demo.id}`);
      await demo.run();
    }
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
