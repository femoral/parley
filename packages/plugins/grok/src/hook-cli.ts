/**
 * CLI entry for Grok command hooks. Reads stdin JSON + process env, writes
 * the parley session-state file, always exits 0 (fail-open for passive hooks).
 */
import fs from "node:fs";

import { runHook, type HookStdin } from "./index.js";

function readStdinJson(): HookStdin {
  try {
    const raw = fs.readFileSync(0, "utf8").trim();
    if (raw === "") return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    return parsed as HookStdin;
  } catch {
    return {};
  }
}

function main(): void {
  try {
    runHook({ env: process.env, stdin: readStdinJson() });
  } catch {
    // Fail-open: never crash the hook process for the harness.
  }
  process.exit(0);
}

main();
