/**
 * Merge-time screen check — local gate (no CI in v1 per #345).
 *
 * Runs acceptance demos and asserts ledger completeness for #353 + #354.
 *
 *   pnpm --filter @useparley/dashboard verify
 *   pnpm --filter @useparley/dashboard verify:check
 */
import fs from "node:fs";
import path from "node:path";
import { runStagedDaemonDemo } from "./demos/staged-daemon.mjs";
import { runInterceptErrorDemo } from "./demos/intercept-error.mjs";
import { runReconnectDemo } from "./demos/reconnect.mjs";
import { runShellChromeDemo } from "./demos/shell-chrome.mjs";
import { runFindHonestyDemo } from "./demos/find-honesty.mjs";
import { readLedger } from "./lib/ledger.mjs";
import { LEDGER_ROOT, relFromRepo } from "./lib/paths.mjs";

const TICKETS = {
  "issue-353": ["staged-daemon", "intercept-error", "reconnect"],
  "issue-354": ["shell-chrome", "find-honesty"],
};

async function main() {
  const skipRun = process.argv.includes("--ledger-only");
  if (!skipRun) {
    console.log("[verify:check] running acceptance demos…");
    await runStagedDaemonDemo();
    await runInterceptErrorDemo();
    await runReconnectDemo();
    await runShellChromeDemo();
    await runFindHonestyDemo();
  }

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
      if (id === "find-honesty") {
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

    // #354-specific gates
    if (ticket === "issue-354") {
      const chrome = ledger.demos["shell-chrome"];
      if (!chrome.headline?.boardScroll?.shell?.noHorizontalScroll) {
        throw new Error("shell-chrome: board horizontal scroll at 1280 not proven clear");
      }
      if (chrome.headline?.headerHeight !== 46) {
        throw new Error(
          `shell-chrome: expected header height 46, got ${chrome.headline?.headerHeight}`,
        );
      }
      if (!chrome.comboboxAria || chrome.comboboxAria.role !== "combobox") {
        throw new Error("shell-chrome: combobox ARIA role missing");
      }
      if (!chrome.a11y?.keyboardWalk?.leftBody) {
        throw new Error("shell-chrome: keyboard walk did not leave body");
      }
      const axeViolations = chrome.a11y?.axe?.violations ?? [];
      if (axeViolations.length > 0) {
        throw new Error(
          `shell-chrome: axe violations: ${axeViolations.map((v) => v.id).join(", ")}`,
        );
      }
      const contrast = chrome.contrast ?? {};
      for (const [id, m] of Object.entries(contrast)) {
        if (m && m.found && m.wcagAA === false) {
          throw new Error(`shell-chrome: contrast fail ${id} ratio=${m.ratio}`);
        }
      }
      if (!chrome.stateEncoding?.allHaveLabels) {
        throw new Error("shell-chrome: legend missing text labels (hue-only state)");
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
