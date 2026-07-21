import { useEffect, useMemo, useRef, useState } from "react";
import type { ParleyClient } from "@useparley/core";
import { LogAccumulator } from "./logClassify.js";
import type { LogLine, LogsView } from "../../hud/types.js";

const DEFAULT_POLL_MS = 1000;
const MAX_IDLE_POLL_MS = 4000;

/** Mutable tail state kept in a ref rather than React state — it must survive
 * the `follow` toggle flipping off and back on (pausing must not lose the
 * cursor or the already-classified window). `eof` lives here too, not as a
 * separate piece of React state: the polling effect reads it synchronously
 * at call time (never a stale closure over a prior render's value), which
 * also means it isn't a dependency the effect has to re-run for. */
interface TailState {
  cursor: number;
  acc: LogAccumulator;
  eof: boolean;
}

function freshTailState(): TailState {
  return { cursor: 0, acc: new LogAccumulator(), eof: false };
}

/**
 * Layer 4 (hooks) — follow a task's raw vendor log through the cursor
 * endpoint (docs/spec/ui-interface-contract.md's "New: per-task logs"): fetch
 * from `since=0`, then keep polling with the prior response's `next` until
 * the daemon reports `eof`. Deliberately doesn't guess "done" from the task's
 * own state — `TaskLogResponse.eof` is the one source of truth (spec:
 * `stalled` is resumable and a `completed` row's child may not have fully
 * exited yet (post-report fallback, #72), so the daemon, not this hook,
 * decides when the tail is final).
 * Each chunk is classified incrementally ({@link LogAccumulator} — never
 * re-parsing the already-seen log) and an idle tick (empty chunk, no eof
 * flip) publishes nothing, so a long-running tail costs no re-render and no
 * re-parse while the vendor is quiet. Resets to a fresh cursor whenever the
 * selected task changes.
 *
 * `live` is only ever set from a *confirmed* server response — it starts
 * `false` and stays `false` through every retry of a fetch that keeps
 * failing (a daemon that's down looks "Paused", never optimistically "Live").
 *
 * `follow` is the settings-bar "Follow logs" toggle (#70, design-manifest §7's
 * `liveLogs` toggle): while false, polling simply doesn't run — `live` drops
 * to false immediately (no fetch required to report "Paused"), the window
 * already accumulated stays put, and flipping back to true resumes from the
 * same cursor rather than re-fetching from scratch.
 */
export function useLogTail(
  client: ParleyClient,
  taskId: string | null,
  follow = true,
  pollMs = DEFAULT_POLL_MS,
): LogsView {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [live, setLive] = useState(false);
  // Lazy ref init (React docs' pattern for an expensive/allocating initial
  // value): `useRef(freshTailState())` would evaluate a fresh accumulator on
  // every render even though only the very first one is ever kept.
  const stateRef = useRef<TailState | null>(null);
  if (stateRef.current === null) stateRef.current = freshTailState();

  // A task switch is the one thing that really resets the tail — the cursor,
  // the accumulator, and the classified window all start over.
  useEffect(() => {
    stateRef.current = freshTailState();
    setLines([]);
    setLive(false);
  }, [taskId]);

  useEffect(() => {
    if (!taskId || !follow || stateRef.current!.eof) {
      // Reflects "Paused" the instant `follow` flips off (or the tail
      // already ended) — no fetch required to report that.
      setLive(false);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let idlePollMs = pollMs;
    let inFlight = false;
    let pollAfterFlight = false;

    const schedule = (delay: number) => {
      if (cancelled || document.hidden) return;
      timer = setTimeout(() => void tick(), delay);
    };

    const tick = async (): Promise<void> => {
      if (cancelled || document.hidden) return;
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
        // At eof no further newline is coming — render the trailing partial.
        if (res.eof) {
          changed = state.acc.flush() || changed;
          state.eof = true;
        }
        if (changed) setLines(state.acc.lines());
        setLive(!res.eof);
        if (!res.eof) {
          // Bytes, including a trailing partial line, are activity even when
          // they do not produce a newly classified line yet.
          if (res.chunk.length > 0) idlePollMs = pollMs;
          else idlePollMs = Math.min(Math.max(pollMs, MAX_IDLE_POLL_MS), idlePollMs * 2);
          schedule(idlePollMs);
        }
      } catch {
        // A transient daemon hiccup — keep trying at the same cadence rather
        // than giving up the tail (mirrors useHealth's tolerance). `live` is
        // left exactly as it was; a failed attempt never optimistically
        // flips it true.
        schedule(pollMs);
      } finally {
        inFlight = false;
        if (pollAfterFlight && !cancelled && !document.hidden) {
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
      if (!document.hidden) {
        idlePollMs = pollMs;
        void tick();
      }
    };

    document.addEventListener("visibilitychange", visibilityChanged);
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", visibilityChanged);
    };
  }, [client, taskId, follow, pollMs]);

  // Memoized so identity only changes when the data actually does — the
  // cockpit's one-second clock tick re-renders this hook's caller constantly,
  // and a fresh `{ lines, live }` literal every render would defeat the
  // `inspector` memo in useCockpit.ts (and Inspector's own `memo()`) exactly
  // the way their comments say those memos exist to prevent.
  return useMemo(() => ({ lines, live }), [lines, live]);
}
