import fs from "node:fs";
import path from "node:path";
import type { HomePaths } from "@useparley/core";

/** Append a line to the daemon-home `diag.log` (best-effort). */
export function appendDaemonDiag(paths: HomePaths, line: string): void {
  const logPath = path.join(paths.home, "diag.log");
  try {
    fs.appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`);
  } catch {
    /* never let logging take down the daemon */
  }
}
