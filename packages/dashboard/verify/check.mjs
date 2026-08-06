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

      // Axe in all three chrome states (resting, find popup, settings open).
      const byState = chrome.a11yByState ?? {};
      for (const state of ["resting", "findPopup", "settingsOpen"]) {
        const block = byState[state];
        if (!block?.axe) throw new Error(`shell-chrome: missing a11yByState.${state}`);
        const v = block.axe.violations ?? [];
        if (v.length > 0) {
          throw new Error(
            `shell-chrome: axe violations in ${state}: ${v.map((x) => x.id).join(", ")}`,
          );
        }
      }

      const contrast = chrome.contrast ?? {};
      for (const [cid, m] of Object.entries(contrast)) {
        if (m && m.found && m.wcagAA === false) {
          throw new Error(`shell-chrome: contrast fail ${cid} ratio=${m.ratio}`);
        }
      }
      if (!chrome.stateEncoding?.allHaveLabels) {
        throw new Error("shell-chrome: legend missing text labels (hue-only state)");
      }

      // Footer note legible at all three widths.
      const footer = chrome.footerNoteScroll;
      if (!Array.isArray(footer) || footer.length < 3) {
        throw new Error("shell-chrome: missing footerNoteScroll proofs");
      }
      for (const row of footer) {
        if (!row.ok) {
          throw new Error(
            `shell-chrome: footer note clipped at ${row.name}: ` +
              `scrollWidth=${row.scrollWidth} clientWidth=${row.clientWidth}`,
          );
        }
      }

      // 1280 density: no silent ellipsis amputation on measured chrome bits.
      if (!chrome.density1280?.allOk) {
        throw new Error(
          `shell-chrome: 1280 density clipping: ${JSON.stringify(chrome.density1280)}`,
        );
      }

      // Skip-to-main must land focus on #main-content.
      if (chrome.skipMain?.focusedId !== "main-content") {
        throw new Error(
          `shell-chrome: skip-main focus expected main-content, got ${chrome.skipMain?.focusedId}`,
        );
      }

      // Settings popover: focus moves in, restores to trigger, no aria-modal.
      if (chrome.settingsFocus?.ariaModal !== "false") {
        throw new Error("shell-chrome: settings must be popover (aria-modal=false)");
      }
      if (!chrome.settingsFocus?.focusMovedIn) {
        throw new Error("shell-chrome: settings did not move focus into panel");
      }
      if (!chrome.settingsFocus?.focusRestored) {
        throw new Error("shell-chrome: settings did not restore focus to trigger");
      }

      // Live region: no bootstrap offline flash; restore announced after recover.
      const live = chrome.liveRegionTranscript;
      if (!live) throw new Error("shell-chrome: missing liveRegionTranscript");
      if (live.announcedOfflineOnHealthyBoot || live.offlineWhileLive) {
        throw new Error("shell-chrome: live region announced offline on healthy boot");
      }
      if (!live.announcedOfflineAfterLive) {
        throw new Error("shell-chrome: live region never announced offline after forced drop");
      }
      if (!live.announcedRestore) {
        throw new Error("shell-chrome: live region never announced connection restored");
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
