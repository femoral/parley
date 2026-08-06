/**
 * Path roots for the verification harness.
 * Everything is derived from import.meta.url — no absolute /home/… paths.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** packages/dashboard/verify */
export const VERIFY_ROOT = path.resolve(HERE, "..");

/** packages/dashboard */
export const DASHBOARD_ROOT = path.resolve(VERIFY_ROOT, "..");

/** monorepo root (packages/../) */
export const REPO_ROOT = path.resolve(DASHBOARD_ROOT, "../..");

/** packages/cli/tests/fake-vendor.mjs — the suite's only test double */
export const FAKE_VENDOR_BIN = path.resolve(
  REPO_ROOT,
  "packages/cli/tests/fake-vendor.mjs",
);

/** packages/daemon/src/server.ts — in-process startServer entry */
export const DAEMON_SERVER_ENTRY = path.resolve(
  REPO_ROOT,
  "packages/daemon/src/server.ts",
);

/** packages/core/src/index.ts — homePaths etc. */
export const CORE_ENTRY = path.resolve(REPO_ROOT, "packages/core/src/index.ts");

/** Default ledger root (per-ticket proofs land under ledger/<ticket-id>/) */
export const LEDGER_ROOT = path.join(VERIFY_ROOT, "ledger");

/** Relative path from repo root for committed ledger metadata */
export function relFromRepo(absPath) {
  return path.relative(REPO_ROOT, absPath).split(path.sep).join("/");
}
