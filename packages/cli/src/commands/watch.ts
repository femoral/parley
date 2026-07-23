import {
  isActionableState,
  isTerminalState,
  type FollowEventResponse,
  type InboxEventResponse,
  type TaskEnvelope,
  type TasksResponse,
} from "@useparley/core";
import { parseArgs } from "../args.js";
import { daemonGet, ensureDaemon } from "../client.js";
import { type CliContext, printJson } from "../context.js";
import { UsageError } from "../errors.js";
import type { Discovery } from "@useparley/daemon/discovery.js";

/**
 * How long each long-poll request may take; must exceed the daemon's window so
 * the CLI, not the request, controls re-polling.
 */
const LONG_POLL_TIMEOUT_MS = 60_000;

/**
 * Inbox exit codes (ADR-0007 / ADR-0008): one code per actionable state so the
 * orchestrator branches on `$?` without parsing. Exit 0 is reserved for
 * all-done; `completed` is 6 and `failed` is 5. This is the only state-typed
 * exit vocabulary — `delegate` and `answer` exit only 0 or 2.
 */
function exitFor(state: string): number {
  if (state === "awaiting_answer") return 3;
  if (state === "stalled") return 4;
  if (state === "failed") return 5;
  if (state === "completed") return 6;
  return 0;
}

/** Resolve a task ref (id first, then most-recent name) against a snapshot. */
function resolveRef(tasks: TaskEnvelope[], ref: string): TaskEnvelope | undefined {
  // `tasks` is newest-first, so the first name match is the most recent — the
  // same precedence as the daemon's `resolveTask`.
  return tasks.find((t) => t.task_id === ref) ?? tasks.find((t) => t.name === ref);
}

/**
 * Resolve the orchestrator session the inbox narrows to — same rules as
 * `status` (listing filter stays flag-first): `--session <id>`, else
 * `PARLEY_SESSION_ID`, else the newest session. Binding (delegate/fix/eval)
 * is env-first per #190. `undefined` means no session filter.
 */
function resolveSessionFilter(
  sessionFlag: string | undefined,
  env: NodeJS.ProcessEnv,
  tasks: TaskEnvelope[],
): string | undefined {
  const latest = (): string | undefined =>
    tasks.find((t) => t.orchestrator_session_id !== null)?.orchestrator_session_id ?? undefined;
  if (sessionFlag !== undefined) {
    return sessionFlag === "latest" ? latest() : sessionFlag;
  }
  const envSession = env.PARLEY_SESSION_ID;
  return envSession ? envSession : latest();
}

/**
 * `parley watch [task…] [--ack <event-id>] [--session <id>] [--follow] [--json]`
 * (ADR-0007 / #91) — deliver the next pending event from the orchestrator-session
 * attention inbox, or stream every transition as JSONL with `--follow`.
 *
 * Default mode is level-triggered and acked: each task contributes at most its
 * current actionable state (`awaiting_answer` / `stalled` / `failed` /
 * `completed`) until acked. `--ack` records handling of a prior event, then the
 * next pending one is returned (blocking if none). Exit 0 only when all watched
 * tasks are terminal and all events are acked.
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

  const discovery = await ensureDaemon(ctx.paths, ctx.env);
  const { tasks, seq: nowSeq } = await daemonGet<TasksResponse>(discovery, "/tasks");

  if (follow) {
    return runFollow(ctx, discovery, tasks, positionals, nowSeq);
  }

  // Inbox scope: session filter (like status), then optional task-ref filter
  // that narrows the session set. Explicit refs must exist; a ref outside the
  // resolved session is still accepted (the orchestrator named it).
  const session = resolveSessionFilter(sessionFlag, ctx.env, tasks);
  let scoped =
    session === undefined
      ? tasks
      : tasks.filter((t) => t.orchestrator_session_id === session);

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
    params.set("wait", "true");
    if (ack !== null) params.set("ack", String(ack));
    return `/tasks/inbox?${params.toString()}`;
  };

  for (;;) {
    const ev = await daemonGet<InboxEventResponse>(discovery, query(), LONG_POLL_TIMEOUT_MS);
    // Ack is one-shot: only the first request carries it.
    ack = null;

    if (ev.all_done) {
      return 0;
    }
    if (ev.event === null || ev.task === null) {
      // Poll window elapsed with live work still outstanding — re-poll.
      continue;
    }

    report(ctx, ev, json);
    return exitFor(ev.task.state);
  }
}

/**
 * `--follow`: stream every transition of the watched set as JSONL (one line per
 * event), no ack, no priority — the firehose for UIs and debugging (ADR-0007).
 * Watches explicit refs, or every currently non-terminal task; runs until all
 * watched tasks are terminal or the process is killed. Starts from "now" (no
 * `--since`).
 */
async function runFollow(
  ctx: CliContext,
  discovery: Discovery,
  tasks: TaskEnvelope[],
  positionals: string[],
  baseline: number,
): Promise<number> {
  let watched: TaskEnvelope[];
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
  if (ids.length === 0) return 0;

  const remaining = new Set(
    watched.filter((t) => !isTerminalState(t.state)).map((t) => t.task_id),
  );
  if (remaining.size === 0) return 0;

  let cursor = baseline;
  for (;;) {
    const q = `/tasks/events?ids=${encodeURIComponent(ids.join(","))}&since=${cursor}&wait=true`;
    const ev = await daemonGet<FollowEventResponse>(discovery, q, LONG_POLL_TIMEOUT_MS);
    if (ev.event === null || ev.task === null) {
      cursor = ev.seq;
      continue;
    }
    cursor = ev.seq;
    printJson(ctx, { event: ev.event, seq: ev.seq, task: ev.task });
    if (isTerminalState(ev.task.state)) remaining.delete(ev.task.task_id);
    if (remaining.size === 0) return 0;
  }
}

/** Print a single inbox event: JSON when asked, else a concise human line. */
function report(ctx: CliContext, ev: InboxEventResponse, json: boolean): void {
  if (json) {
    printJson(ctx, { event: ev.event, seq: ev.seq, task: ev.task });
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
    ctx.stderr(`error: ${t.error}\n`);
  }
}
