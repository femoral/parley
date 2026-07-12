import { parseArgs } from "../args.js";
import { daemonGet, ensureDaemon } from "../client.js";
import { type CliContext, printJson } from "../context.js";
import { UsageError } from "../errors.js";
import { TERMINAL_STATES, type TaskRow } from "../../daemon/db.js";
import type { Envelope } from "../../daemon/report.js";
import type { Discovery } from "../../daemon/discovery.js";

interface TasksResponse {
  tasks: TaskRow[];
  /** Current global transition seq (#34) — the "start from now" baseline. */
  seq: number;
}

/** One multi-task long-poll response (`GET /tasks/events`). */
interface WatchEvent {
  /** `task.started` / `task.question` / `task.completed` / … or null (window elapsed). */
  event: string | null;
  seq: number;
  task: Envelope | null;
}

/** Stop conditions for the single-shot mode. */
const UNTIL_MODES = ["any-change", "attention", "terminal"] as const;
type Until = (typeof UNTIL_MODES)[number];

/**
 * How long each long-poll request may take; must exceed the daemon's window so
 * the CLI, not the request, controls re-polling. Mirrors `wait.ts`.
 */
const LONG_POLL_TIMEOUT_MS = 60_000;

function isAttention(state: string): boolean {
  return state === "awaiting_answer" || state === "stalled";
}

/**
 * Single-shot exit code (spec §5): a returned event needing attention branches
 * — `awaiting_answer` → 3, `stalled` → 4 — everything else is 0 ("returned
 * normally"). Consistent with `delegate --wait`/`answer --wait`'s codes for the
 * same states, so `while parley watch; do …; done` loops branch on `$?`.
 */
function exitFor(state: string): number {
  if (state === "awaiting_answer") return 3;
  if (state === "stalled") return 4;
  return 0;
}

/** Resolve a task ref (id first, then most-recent name) against a snapshot. */
function resolveRef(tasks: TaskRow[], ref: string): TaskRow | undefined {
  // `tasks` is newest-first, so the first name match is the most recent — the
  // same precedence as the daemon's `resolveTask`.
  return tasks.find((t) => t.id === ref) ?? tasks.find((t) => t.name === ref);
}

/**
 * `parley watch [task…] [--since <seq>] [--until any-change|attention|terminal]
 * [--follow] [--json]` (#34, spec §3/§5) — block until the watched task set
 * changes state, replacing hand-rolled orchestrator poll loops.
 *
 * With no task args, watches every task non-terminal at start (a snapshot, not a
 * live-updating set). `--since` threads a previously-captured seq so a
 * transition that raced the watcher's connect is replayed rather than missed.
 * Single-shot by default (returns on the first qualifying transition, typed exit
 * code); `--follow` streams every transition as JSONL until all watched tasks
 * are terminal.
 */
export async function runWatch(ctx: CliContext, args: string[]): Promise<number> {
  const { positionals, flags } = parseArgs(args, {
    "--since": { value: true },
    "--until": { value: true },
    "--follow": {},
    "--json": {},
  });

  const untilRaw = typeof flags["--until"] === "string" ? flags["--until"] : "any-change";
  if (!UNTIL_MODES.includes(untilRaw as Until)) {
    throw new UsageError(
      `watch: unknown --until: ${untilRaw} (expected ${UNTIL_MODES.join("|")})`,
    );
  }
  const until = untilRaw as Until;

  let since: number | null = null;
  if (typeof flags["--since"] === "string") {
    const parsed = Number(flags["--since"]);
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new UsageError(`watch: invalid --since: ${flags["--since"]} (expected a non-negative integer)`);
    }
    since = parsed;
  }

  const follow = flags["--follow"] === true;
  const json = flags["--json"] === true;

  const discovery = await ensureDaemon(ctx.paths, ctx.env);
  const { tasks, seq: nowSeq } = await daemonGet<TasksResponse>(discovery, "/tasks");

  // Build the watched set as a snapshot at start (spec §5): explicit refs, else
  // every currently non-terminal task. A bad ref is a usage error (exit 2), not
  // a silent hang.
  let watched: TaskRow[];
  if (positionals.length > 0) {
    watched = positionals.map((ref) => {
      const row = resolveRef(tasks, ref);
      if (!row) throw new UsageError(`watch: no such task: ${ref}`);
      return row;
    });
  } else {
    watched = tasks.filter((t) => !TERMINAL_STATES.has(t.state));
  }

  const ids = [...new Set(watched.map((t) => t.id))];
  if (ids.length === 0) {
    // Nothing to watch (bare `watch` with no non-terminal tasks). Don't block on
    // a set that can never change — the snapshot is fixed at start.
    ctx.stderr("watch: no non-terminal tasks to watch\n");
    return 0;
  }

  // Absent `--since` starts from "now": the seq captured atomically with the
  // snapshot, so a transition between the snapshot and the first long-poll is
  // still replayed (no gap), but nothing before the snapshot is.
  const baseline = since ?? nowSeq;

  // `--until terminal` / `--follow` complete when every watched task is
  // terminal. Track the ones still live; already-terminal tasks at snapshot are
  // done from the start.
  const remaining = new Set(
    watched.filter((t) => !TERMINAL_STATES.has(t.state)).map((t) => t.id),
  );

  const query = (cursor: number): string =>
    `/tasks/events?ids=${encodeURIComponent(ids.join(","))}&since=${cursor}&wait=true`;

  if (follow) {
    return runFollow(ctx, discovery, query, baseline, remaining);
  }

  if (until === "terminal" && remaining.size === 0) {
    // All watched tasks are already terminal — the condition holds immediately.
    return 0;
  }

  let cursor = baseline;
  for (;;) {
    const ev = await daemonGet<WatchEvent>(discovery, query(cursor), LONG_POLL_TIMEOUT_MS);
    if (ev.event === null || ev.task === null) {
      cursor = ev.seq; // poll window elapsed, nothing yet — re-poll
      continue;
    }
    cursor = ev.seq;
    const state = ev.task.state;

    if (until === "attention" && !isAttention(state)) continue;

    if (until === "terminal") {
      if (TERMINAL_STATES.has(state)) remaining.delete(ev.task.task_id);
      if (remaining.size > 0) continue; // not every watched task is terminal yet
    }

    report(ctx, ev, json);
    return exitFor(state);
  }
}

/**
 * `--follow`: stream every transition of every watched task as JSONL (one line
 * per event), running until all watched tasks are terminal or the process is
 * killed. A separate, explicit mode from the single-shot default — suited to a
 * hook/daemon-style driver.
 */
async function runFollow(
  ctx: CliContext,
  discovery: Discovery,
  query: (cursor: number) => string,
  baseline: number,
  remaining: Set<string>,
): Promise<number> {
  if (remaining.size === 0) return 0; // nothing live to follow
  let cursor = baseline;
  for (;;) {
    const ev = await daemonGet<WatchEvent>(discovery, query(cursor), LONG_POLL_TIMEOUT_MS);
    if (ev.event === null || ev.task === null) {
      cursor = ev.seq;
      continue;
    }
    cursor = ev.seq;
    printJson(ctx, { event: ev.event, seq: ev.seq, task: ev.task });
    if (TERMINAL_STATES.has(ev.task.state)) remaining.delete(ev.task.task_id);
    if (remaining.size === 0) return 0;
  }
}

/** Print a single-shot result: JSON when asked, else a concise human line. */
function report(ctx: CliContext, ev: WatchEvent, json: boolean): void {
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
      `task ${t.task_id} stalled; resume with: parley answer ${t.task_id} "<answer>" [--wait]\n`,
    );
  }
}
