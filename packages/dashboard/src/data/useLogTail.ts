/**
 * Cursor-polled log tail for a selected task (`GET /tasks/:ref/logs?since=`).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { ParleyClient } from "@useparley/core";
import { LogAccumulator } from "./logClassify.js";
import type { LogLine, LogTailStatus, LogsView } from "./types.js";

const DEFAULT_POLL_MS = 1000;
const MAX_IDLE_POLL_MS = 4000;

interface TailState {
  cursor: number;
  acc: LogAccumulator;
  eof: boolean;
  sawOpen: boolean;
}

function freshTailState(): TailState {
  return { cursor: 0, acc: new LogAccumulator(), eof: false, sawOpen: false };
}

export function useLogTail(
  client: ParleyClient,
  taskId: string | null,
  follow = true,
  pollMs = DEFAULT_POLL_MS,
): LogsView {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [status, setStatus] = useState<LogTailStatus>(() =>
    !taskId ? "ended" : follow ? "connecting" : "paused-by-setting",
  );
  const stateRef = useRef<TailState | null>(null);
  if (stateRef.current === null) stateRef.current = freshTailState();

  useEffect(() => {
    stateRef.current = freshTailState();
    setLines([]);
    setStatus(taskId ? "connecting" : "ended");
  }, [taskId]);

  useEffect(() => {
    if (!taskId) {
      setStatus("ended");
      return;
    }
    if (stateRef.current!.eof) {
      setStatus("ended");
      return;
    }
    if (!follow) {
      setStatus("paused-by-setting");
      return;
    }
    if (stateRef.current!.sawOpen) {
      setStatus("tailing");
    } else {
      setStatus("connecting");
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let idlePollMs = pollMs;
    let inFlight = false;
    let pollAfterFlight = false;

    const schedule = (delay: number) => {
      if (cancelled || (typeof document !== "undefined" && document.hidden)) return;
      timer = setTimeout(() => void tick(), delay);
    };

    const tick = async (): Promise<void> => {
      if (cancelled || (typeof document !== "undefined" && document.hidden)) return;
      if (inFlight) {
        pollAfterFlight = true;
        return;
      }
      inFlight = true;
      try {
        const state = stateRef.current!;
        const res = await client.logs(taskId, state.cursor);
        if (cancelled) return;
        state.cursor = res.next;
        let changed = state.acc.append(res.chunk);
        if (res.eof) {
          changed = state.acc.flush() || changed;
          state.eof = true;
        }
        if (changed) setLines(state.acc.lines());
        if (res.eof) {
          state.sawOpen = false;
          setStatus("ended");
        } else {
          state.sawOpen = true;
          setStatus("tailing");
          if (res.chunk.length > 0) idlePollMs = pollMs;
          else idlePollMs = Math.min(Math.max(pollMs, MAX_IDLE_POLL_MS), idlePollMs * 2);
          schedule(idlePollMs);
        }
      } catch {
        if (!cancelled && !stateRef.current!.eof) {
          setStatus("unreachable");
        }
        schedule(pollMs);
      } finally {
        inFlight = false;
        if (pollAfterFlight && !cancelled && !(typeof document !== "undefined" && document.hidden)) {
          pollAfterFlight = false;
          if (timer !== undefined) clearTimeout(timer);
          timer = undefined;
          void tick();
        }
      }
    };

    const visibilityChanged = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      if (typeof document === "undefined" || !document.hidden) {
        idlePollMs = pollMs;
        void tick();
      }
    };

    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", visibilityChanged);
    }
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", visibilityChanged);
      }
    };
  }, [client, taskId, follow, pollMs]);

  return useMemo(() => ({ lines, status }), [lines, status]);
}
