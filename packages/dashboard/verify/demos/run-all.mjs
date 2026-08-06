/**
 * Run acceptance demos for the verification harness.
 * #353 harness demos + #354 shell chrome proofs.
 */
import { runStagedDaemonDemo } from "./staged-daemon.mjs";
import { runInterceptErrorDemo } from "./intercept-error.mjs";
import { runReconnectDemo } from "./reconnect.mjs";
import { runShellChromeDemo } from "./shell-chrome.mjs";
import { runFindHonestyDemo } from "./find-honesty.mjs";
import { readLedger } from "../lib/ledger.mjs";

async function main() {
  console.log("verify: demo 1/5 staged-daemon (#353)");
  const staged = await runStagedDaemonDemo();

  console.log("\nverify: demo 2/5 intercept-error (#353)");
  const intercept = await runInterceptErrorDemo();

  console.log("\nverify: demo 3/5 reconnect (#353)");
  const reconnect = await runReconnectDemo();

  console.log("\nverify: demo 4/5 shell-chrome (#354)");
  const chrome = await runShellChromeDemo();

  console.log("\nverify: demo 5/5 find-honesty (#354)");
  const find = await runFindHonestyDemo();

  const ledger353 = readLedger("issue-353");
  const ledger354 = readLedger("issue-354");
  console.log("\nverify: all demos complete");
  console.log(
    JSON.stringify(
      {
        issue353: Object.keys(ledger353?.demos ?? {}),
        issue354: Object.keys(ledger354?.demos ?? {}),
        stagedTask: staged.daemon?.taskId,
        interceptProbe: intercept.intercept?.probe?.tasks?.status,
        reconnectHealth: reconnect.daemon?.healthOkAfterRecover,
        headerHeight: chrome.headline?.headerHeight,
        noHScroll: chrome.headline?.boardScroll?.shell?.noHorizontalScroll,
        findStates: Object.keys(find.states ?? {}),
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
