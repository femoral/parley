import { LogStream } from "../LogStream.js";
import type { LogsView } from "../types.js";

export interface LogsTabProps {
  logs: LogsView;
}

/** Layer 2 — the Logs tab: thin wrapper over the standalone {@link LogStream}
 * (design-manifest §4.17 "Logs"). */
export function LogsTab({ logs }: LogsTabProps) {
  return <LogStream lines={logs.lines} live={logs.live} />;
}
