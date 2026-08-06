/**
 * Run all registered acceptance demos (see registry.mjs).
 * Screen tickets append to the registry — no renumbering here.
 */
import { DEMO_REGISTRY } from "./registry.mjs";
import { readLedger } from "../lib/ledger.mjs";

async function main() {
  const total = DEMO_REGISTRY.length;
  /** @type {Record<string, object>} */
  const results = {};

  for (let i = 0; i < total; i += 1) {
    const demo = DEMO_REGISTRY[i];
    console.log(`verify: demo ${i + 1}/${total} ${demo.id} (${demo.ticket})`);
    results[demo.id] = await demo.run();
  }

  /** @type {Record<string, string[]>} */
  const byTicket = {};
  for (const d of DEMO_REGISTRY) {
    const ledger = readLedger(d.ticket);
    byTicket[d.ticket] = Object.keys(ledger?.demos ?? {});
  }

  const chrome = results["shell-chrome"];
  const find = results["find-honesty"];

  console.log("\nverify: all demos complete");
  console.log(
    JSON.stringify(
      {
        ledgers: byTicket,
        headerHeight: chrome?.headline?.headerHeight,
        noHScroll: chrome?.headline?.boardScroll?.shell?.noHorizontalScroll,
        axeRest: chrome?.a11yByState?.resting?.axe?.violations?.length,
        axeFind: chrome?.a11yByState?.findPopup?.axe?.violations?.length,
        axeSettings: chrome?.a11yByState?.settingsOpen?.axe?.violations?.length,
        findStates: Object.keys(find?.states ?? {}),
        footerNoteOk: chrome?.footerNoteScroll?.every?.((v) => v.ok),
        density1280Ok: chrome?.density1280?.allOk,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
