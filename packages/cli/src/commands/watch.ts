import {
  LONG_POLL_TIMEOUT_MS,
  formatErrorCategoryLabel,
  isActionableState,
  isTerminalState,
  type FollowEventResponse,
  type InboxEventResponse,
  type WatchTask,
  type WatchScopeResponse,
} from "@useparley/core";
import { parseArgs } from "../args.js";
import { DaemonRequestError, daemonGet, ensureDaemon } from "../client.js";
import { type CliContext, printJson } from "../context.js";
import { UsageError } from "../errors.js";
import type { Discovery } from "@useparley/daemon/discovery.js";

/**
 * Timeout for the one-shot task-list fetch that seeds a watch. Deliberately
 * larger than the 5s client default (#389): the daemon builds this list on a
 * single event loop, so concurrent callers queue behind each other and the wait
 * lands on the client's budget. Session scoping below is the real fix; this is
 * headroom so a burst of sibling watchers degrades into latency instead of a
 * spurious "could not reach the daemon" abort.
 */
const TASK_LIST_TIMEOUT_MS = 30_000;

/**
 * Inbox exit codes (ADR-0007 / ADR-0008 / ADR-0019): one code per tier so the
 * orchestrator branches on `$?` without parsing. Exit 0 is reserved for
 * session-finished; the payload picks the verb (task question vs run gate).
 * Exit codes 3/4/5/6 keep their tier meanings — no fifth tier, no new code.
 */
function exitFor(state: string): number {
  if (state === "awaiting_answer" || state === "gate") return 3;
  if (state === "stalled" || state === "blocked") return 4;
  if (state === "failed") return 5;
  if (state === "completed") return 6;
  return 0;
}

/** Resolve a task ref (id first, then most-recent name) against a snapshot. */
function resolveRef(tasks: WatchTask[], ref: string): WatchTask | undefined {
  // `tasks` is newest-first, so the first name match is the most recent — the
  // same precedence as the daemon's `resolveTask`.
  return tasks.find((t) => t.task_id === ref) ?? tasks.find((t) => t.name === ref);
}

/**
 * The session `watch` scopes to, resolved before any task list is fetched —
 * `--session <id>` first, then `PARLEY_SESSION_ID` (listing filter is
 * flag-first; binding stays env-first per #190). `latest` defers to the task
 * list because only the store knows which session is newest.
 *
 * A session is mandatory (#389). The old fallback, when neither flag nor env
 * was set, watched the newest session in the *store* — on a shared daemon that
 * is whichever agent delegated most recently, so a fan-out orchestrator could
 * silently attach to a sibling's tasks and exit on their events. There is no
 * safe default here, and a loud error costs less than a wrong guess.
 */
function requireSession(
  sessionFlag: string | undefined,
  env: NodeJS.ProcessEnv,
): string | "latest" {
  const requested = sessionFlag ?? env.PARLEY_SESSION_ID;
  if (requested === undefined || requested === "") {
    throw new UsageError(
      "watch: no orchestrator session to watch. Pass --session <id>, or set " +
        "PARLEY_SESSION_ID. Use --session latest for the daemon's most recent " +
        "session (only safe when nothing else is delegating).",
    );
  }
  return requested === "latest" ? "latest" : requested;
}

/**
 * `parley watch [task…] [--ack <event-id>] [--session <id>] [--follow] [--json]`
 * (ADR-0007 / ADR-0019 / #91 / #240) — deliver the next pending event from the
 * orchestrator-session attention inbox (tasks *and* runs), or stream every
 * transition as JSONL with `--follow`.
 *
 * Default mode is level-triggered and acked. Exit 0 only when the session is
 * finished — every subject terminal (runs included) and every event acked.
 */
export async function runWatch(ctx: CliContext, args: string[]): Promise<number> {
  const { positionals, flags } = parseArgs(args, {
    "--ack": { value: true },
    "--session": { value: true },
    "--follow": {},
    "--json": {},
  });

  let ack: number | null = null;
  if (typeof flags["--ack"] === "string") {
    const parsed = Number(flags["--ack"]);
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new UsageError(
        `watch: invalid --ack: ${flags["--ack"]} (expected a non-negative integer)`,
      );
    }
    ack = parsed;
  }

  const follow = flags["--follow"] === true;
  const json = flags["--json"] === true;
  const sessionFlag = typeof flags["--session"] === "string" ? flags["--session"] : undefined;

  if (follow && ack !== null) {
    throw new UsageError("watch: --ack cannot be combined with --follow");
  }

  // Resolved before the fetch so a concrete session can narrow it (#389).
  const requested = requireSession(sessionFlag, ctx.env);

  const discovery = await ensureDaemon(ctx.paths, ctx.env);

  // Resolve refs and latest on the daemon; bootstrap only identity/state
  // metadata, never full reports or project-config reads (#392).
  const scopeParams = new URLSearchParams({ session: requested });
  if (positionals.length > 0) scopeParams.set("ids", positionals.join(","));
  if (follow) scopeParams.set("follow", "true");
  const { tasks, seq: nowSeq, session } = await daemonGet<WatchScopeResponse>(
    discovery,
    `/tasks/scope?${scopeParams}`,
    TASK_LIST_TIMEOUT_MS,
  ).catch((err: unknown) => {
    if (err instanceof DaemonRequestError && (err.status === 400 || err.status === 404)) {
      throw new UsageError(`watch: ${err.message}`);
    }
    throw err;
  });

  if (follow) {
    return runFollow(ctx, discovery, tasks, positionals, sessionFlag, session, nowSeq);
  }

  // Inbox scope: session filter (like status), then optional task-ref filter
  // that narrows the session set. Explicit refs must exist; a ref outside the
  // resolved session is still accepted (the orchestrator named it).
  let scoped = tasks.filter((t) => t.orchestrator_session_id === session);

  if (positionals.length > 0) {
    scoped = positionals.map((ref) => {
      const row = resolveRef(tasks, ref);
      if (!row) throw new UsageError(`watch: no such task: ${ref}`);
      return row;
    });
  }

  const ids = [...new Set(scoped.map((t) => t.task_id))];

  const query = (): string => {
    const params = new URLSearchParams();
    if (ids.length > 0) params.set("ids", ids.join(","));
    // Session lets the daemon expand runs (gate-first workflows with no tasks).
    params.set("session", session);
    params.set("wait", "true");
    if (ack !== null) params.set("ack", String(ack));
    return `/tasks/inbox?${params.toString()}`;
  };

  // One-shot note when a known-but-idle session long-polls empty (#256).
  let notedIdleSession = false;

  for (;;) {
    let ev: InboxEventResponse;
    try {
      ev = await daemonGet<InboxEventResponse>(discovery, query(), LONG_POLL_TIMEOUT_MS);
    } catch (err) {
      // Unknown session (and other 400s) → usage (exit 2), never tier codes
      // or vacuous success (#256).
      if (err instanceof DaemonRequestError && err.status === 400) {
        throw new UsageError(`watch: ${err.message}`);
      }
      throw err;
    }
    // Ack is one-shot: only the first request carries it.
    ack = null;

    if (ev.all_done) {
      return 0;
    }
    if (ev.event === null) {
      // Poll window elapsed with live work still outstanding — re-poll.
      // (task and run both null, or only one set — either way no delivery.)
      if (ev.task === null && (ev.run === null || ev.run === undefined)) {
        // Known-but-idle session (registered, zero subjects): diagnose rather
        // than mute so an accidental wait is visible (#256).
        if (!notedIdleSession && ids.length === 0) {
          notedIdleSession = true;
          ctx.stderr(
            `note: session ${session} has no tasks or runs yet; waiting\n`,
          );
        }
        continue;
      }
    }

    report(ctx, ev, json);
    if (ev.subject === "run" && ev.run) {
      return exitFor(ev.run.tier ?? ev.run.state);
    }
    if (ev.task) {
      return exitFor(ev.task.state);
    }
    // Defensive: event present but no subject payload — re-poll.
    continue;
  }
}

/**
 * `--follow`: stream every transition of the watched set as JSONL (one line per
 * event), no ack, no priority — the firehose for UIs and debugging (ADR-0007 /
 * ADR-0019). Includes `run.*` (node_entered, blocked, …) so gates are visible.
 * Watches explicit refs, or every currently non-terminal task (+ session runs);
 * runs until all watched subjects are terminal or the process is killed.
 */
async function runFollow(
  ctx: CliContext,
  discovery: Discovery,
  tasks: WatchTask[],
  positionals: string[],
  sessionFlag: string | undefined,
  session: string,
  baseline: number,
): Promise<number> {
  let watched: WatchTask[];
  if (positionals.length > 0) {
    watched = positionals.map((ref) => {
      const row = resolveRef(tasks, ref);
      if (!row) throw new UsageError(`watch: no such task: ${ref}`);
      return row;
    });
  } else {
    watched = tasks.filter((t) => !isTerminalState(t.state));
  }

  const ids = [...new Set(watched.map((t) => t.task_id))];
  // Only treat follow as run-awaiting when the user explicitly scoped a session
  // (or has no tasks yet — gate-first). Env PARLEY_SESSION_ID alone must not
  // change the classic task-terminal exit (watch.test.ts --follow).
  // `session` is always resolved now (#389), so empty ids always means
  // gate-first rather than nothing-to-watch — there is no bare `return 0`.
  const awaitRuns = sessionFlag !== undefined || ids.length === 0;

  const remainingTasks = new Set(
    watched.filter((t) => !isTerminalState(t.state)).map((t) => t.task_id),
  );
  // Track live runs loosely: any run.* that isn't a terminal state keeps us open.
  const remainingRuns = new Set<string>();
  let sawRun = false;

  let cursor = baseline;
  for (;;) {
    const params = new URLSearchParams();
    if (ids.length > 0) params.set("ids", ids.join(","));
    // Always pass session so run.* edges for this orch appear; exit logic
    // still uses awaitRuns so task-only loops stay unchanged.
    params.set("session", session);
    params.set("since", String(cursor));
    params.set("wait", "true");
    const q = `/tasks/events?${params.toString()}`;
    const ev = await daemonGet<FollowEventResponse>(discovery, q, LONG_POLL_TIMEOUT_MS);
    if (ev.event === null) {
      cursor = ev.seq;
      if (remainingTasks.size === 0) {
        if (!awaitRuns) return 0;
        if (sawRun && remainingRuns.size === 0) return 0;
      }
      continue;
    }
    cursor = ev.seq;
    printJson(ctx, {
      event: ev.event,
      seq: ev.seq,
      subject: ev.subject ?? (ev.run ? "run" : "task"),
      task: ev.task,
      run: ev.run ?? null,
    });
    if (ev.subject === "run" && ev.run) {
      sawRun = true;
      const rid = ev.run.run_id;
      if (
        ev.run.state === "completed" ||
        ev.run.state === "failed" ||
        ev.run.state === "cancelled"
      ) {
        remainingRuns.delete(rid);
      } else {
        remainingRuns.add(rid);
      }
    } else if (ev.task) {
      if (isTerminalState(ev.task.state)) remainingTasks.delete(ev.task.task_id);
    }
    if (remainingTasks.size === 0) {
      if (!awaitRuns) return 0;
      if (sawRun && remainingRuns.size === 0) return 0;
    }
  }
}

/** Print a single inbox event: JSON when asked, else a concise human line. */
function report(ctx: CliContext, ev: InboxEventResponse, json: boolean): void {
  if (json) {
    printJson(ctx, {
      event: ev.event,
      seq: ev.seq,
      subject: ev.subject ?? (ev.run ? "run" : "task"),
      task: ev.task,
      run: ev.run ?? null,
    });
    return;
  }
  if (ev.subject === "run" && ev.run) {
    const r = ev.run;
    const tier = r.tier ?? r.state;
    ctx.stdout(
      `${ev.event} ${r.run_id} [${tier}] node=${r.current_node ?? "-"} iter=${r.iteration} seq=${ev.seq}\n`,
    );
    if (tier === "gate") {
      ctx.stderr(
        `run ${r.run_id} waiting on gate; action with: parley run approve|reject|redirect|finish ${r.run_id}\n`,
      );
    } else if (tier === "blocked") {
      ctx.stderr(
        `run ${r.run_id} blocked; action with: parley run approve|redirect|finish ${r.run_id}\n`,
      );
      if (r.error) ctx.stderr(`error: ${r.error}\n`);
    } else if (tier === "failed" && r.error) {
      ctx.stderr(`error: ${r.error}\n`);
    }
    return;
  }
  const t = ev.task!;
  const label = t.name !== null ? `${t.task_id} (${t.name})` : t.task_id;
  ctx.stdout(`${ev.event} ${label} [${t.state}] seq=${ev.seq}\n`);
  if (t.state === "awaiting_answer" && t.question !== null) {
    ctx.stdout(`question: ${t.question}\n`);
  }
  if (t.state === "stalled") {
    ctx.stderr(
      `task ${t.task_id} stalled; resume with: parley answer ${t.task_id} "<answer>"\n`,
    );
  }
  if (isActionableState(t.state) && t.state === "failed" && t.error !== null) {
    // Distinguish claim-time git-auth from plain vendor failures (#317).
    const cat = formatErrorCategoryLabel(t.error_category ?? null);
    if (cat !== null) {
      ctx.stderr(`error [${cat}]: ${t.error}\n`);
    } else {
      ctx.stderr(`error: ${t.error}\n`);
    }
  }
}
