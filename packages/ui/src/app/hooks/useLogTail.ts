import { useEffect, useState } from "react";
import type { ParleyClient } from "@useparley/core";
import { LogAccumulator } from "./logClassify.js";
import type { LogsView } from "../../hud/types.js";

const DEFAULT_POLL_MS = 1000;

const EMPTY: LogsView = { lines: [], live: false };

/**
 * Layer 4 (hooks) — follow a task's raw vendor log through the cursor
 * endpoint (docs/spec/ui-interface-contract.md's "New: per-task logs"): fetch
 * from `since=0`, then keep polling with the prior response's `next` until
 * the daemon reports `eof`. Deliberately doesn't guess "done" from the task's
 * own state — `TaskLogResponse.eof` is the one source of truth (spec:
 * `stalled` is resumable and a `completed` row's child may not have fully
 * exited yet, so the daemon, not this hook, decides when the tail is final).
 * Each chunk is classified incrementally ({@link LogAccumulator} — never
 * re-parsing the already-seen log) and an idle tick (empty chunk, no eof
 * flip) publishes nothing, so a long-running tail costs no re-render and no
 * re-parse while the vendor is quiet. Resets to a fresh cursor whenever the
 * selected task changes.
 */
export function useLogTail(client: ParleyClient, taskId: string | null, pollMs = DEFAULT_POLL_MS): LogsView {
  const [view, setView] = useState<LogsView>(EMPTY);

  useEffect(() => {
    if (!taskId) {
      setView(EMPTY);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cursor = 0;
    let live: boolean | null = null;
    const acc = new LogAccumulator();
    setView(EMPTY);

    const tick = async (): Promise<void> => {
      try {
        const res = await client.logs(taskId, cursor);
        if (cancelled) return;
        cursor = res.next;
        let changed = acc.append(res.chunk);
        // At eof no further newline is coming — render the trailing partial.
        if (res.eof) changed = acc.flush() || changed;
        const nowLive = !res.eof;
        if (changed || nowLive !== live) {
          live = nowLive;
          setView({ lines: acc.lines(), live: nowLive });
        }
        if (!res.eof) timer = setTimeout(() => void tick(), pollMs);
      } catch {
        // A transient daemon hiccup — keep trying at the same cadence rather
        // than giving up the tail (mirrors useHealth's tolerance).
        if (!cancelled) timer = setTimeout(() => void tick(), pollMs);
      }
    };

    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [client, taskId, pollMs]);

  return view;
}
