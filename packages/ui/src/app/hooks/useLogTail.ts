import { useEffect, useMemo, useRef, useState } from "react";
import type { ParleyClient } from "@useparley/core";
import { LogAccumulator } from "./logClassify.js";
import type { LogLine, LogTailHookStatus, LogsView } from "../../hud/types.js";

const DEFAULT_POLL_MS = 1000;
const MAX_IDLE_POLL_MS = 4000;

/** Mutable tail state kept in a ref rather than React state — it must survive
 * the `follow` toggle flipping off and back on (pausing must not lose the
 * cursor or the already-classified window). `eof` / `sawOpen` live here too,
 * not as separate pieces of React state: the polling effect reads them
 * synchronously at call time (never a stale closure over a prior render's
 * value), which also means they aren't dependencies the effect has to re-run
 * for. */
interface TailState {
  cursor: number;
  acc: LogAccumulator;
  eof: boolean;
  /** True after a successful response with `eof: false` (stream confirmed open). */
  sawOpen: boolean;
}

function freshTailState(): TailState {
  return { cursor: 0, acc: new LogAccumulator(), eof: false, sawOpen: false };
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
 * Status is a discriminated union (never a single `live` boolean that lies):
 * - `connecting` — selected tail is opening; no response has confirmed its state
 * - `tailing` — confirmed open stream, actively polling
 * - `paused-by-setting` — SettingsBar "Follow logs" off (stream may still be open)
 * - `ended` — daemon reported `eof` (or no task selected)
 * - `unreachable` — last fetch failed; polling keeps retrying
 *
 * `tailing` is only ever set from a *confirmed* server response (or resume
 * after a prior confirmed open). It starts `connecting` and stays non-tailing
 * through every retry of a fetch that keeps failing — a daemon that's down
 * reports `unreachable`, never optimistically `tailing`.
 *
 * `follow` is the settings-bar "Follow logs" toggle (#70, design-manifest §7's
 * `liveLogs` toggle): while false, polling simply doesn't run — status drops
 * to `paused-by-setting` immediately (no fetch required), the window already
 * accumulated stays put, and flipping back to true resumes from the same
 * cursor rather than re-fetching from scratch. If the stream was previously
 * confirmed open, resume restores `tailing` immediately (honest: follow is on
 * and we know the stream isn't ended).
 */
export function useLogTail(
  client: ParleyClient,
  taskId: string | null,
  follow = true,
  pollMs = DEFAULT_POLL_MS,
): LogsView {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [status, setStatus] = useState<LogTailHookStatus>(() =>
    !taskId ? "ended" : follow ? "connecting" : "paused-by-setting",
  );
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
      // Reflects "Paused — follow off" the instant `follow` flips off — no
      // fetch required. Not "ended": the task may still be producing logs.
      setStatus("paused-by-setting");
      return;
    }
    // Resuming follow after a confirmed open stream: restore tailing at once
    // rather than flashing a false pause/ended while the first poll is in flight.
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
        if (res.eof) {
          state.sawOpen = false;
          setStatus("ended");
        } else {
          state.sawOpen = true;
          setStatus("tailing");
          // Bytes, including a trailing partial line, are activity even when
          // they do not produce a newly classified line yet.
          if (res.chunk.length > 0) idlePollMs = pollMs;
          else idlePollMs = Math.min(Math.max(pollMs, MAX_IDLE_POLL_MS), idlePollMs * 2);
          schedule(idlePollMs);
        }
      } catch {
        // A transient daemon hiccup — keep trying at the same cadence rather
        // than giving up the tail (mirrors useHealth's tolerance). Surface
        // `unreachable` so the HUD stops the healthy-green pulse; recovery
        // on the next success flips back to `tailing` automatically.
        if (!cancelled && !stateRef.current!.eof) {
          setStatus("unreachable");
        }
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
  // and a fresh `{ lines, status }` literal every render would defeat the
  // `inspector` memo in useCockpit.ts (and Inspector's own `memo()`) exactly
  // the way their comments say those memos exist to prevent.
  return useMemo(() => ({ lines, status }), [lines, status]);
}
