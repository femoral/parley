/**
 * Run the three acceptance demos for the verification harness (#353).
 */
import { runStagedDaemonDemo } from "./staged-daemon.mjs";
import { runInterceptErrorDemo } from "./intercept-error.mjs";
import { runReconnectDemo } from "./reconnect.mjs";
import { readLedger } from "../lib/ledger.mjs";

async function main() {
  console.log("verify: demo 1/3 staged-daemon");
  const staged = await runStagedDaemonDemo();

  console.log("\nverify: demo 2/3 intercept-error");
  const intercept = await runInterceptErrorDemo();

  console.log("\nverify: demo 3/3 reconnect");
  const reconnect = await runReconnectDemo();

  const ledger = readLedger("issue-353");
  console.log("\nverify: all demos complete");
  console.log(
    JSON.stringify(
      {
        demos: Object.keys(ledger?.demos ?? {}),
        stagedTask: staged.daemon?.taskId,
        interceptProbe: intercept.intercept?.probe?.tasks?.status,
        reconnectHealth: reconnect.daemon?.healthOkAfterRecover,
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
