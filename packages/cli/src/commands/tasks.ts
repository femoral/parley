import type {
  AttemptLineageEntry,
  EvalDetail,
  SessionProvenance,
  TaskDetailResponse,
  TaskEnvelope,
  TaskMetricsFilters,
  TaskRow,
  TasksResponse,
} from "@useparley/core";
import {
  filtersToSearchParams,
  formatErrorCategoryLabel,
  formatGitAuthCode,
  parseErrorCategory,
} from "@useparley/core";
import { parseArgs } from "../args.js";
import { type CliContext, printJson } from "../context.js";
import { daemonGet, ensureDaemon } from "../client.js";
import { filtersFromFlags, METRICS_FILTER_FLAGS } from "./metrics.js";

/** Compact `<n>k` rendering of a raw token count, e.g. 1234 -> "1.2k". */
function formatTokenCount(n: number): string {
  const k = Math.round((n / 1000) * 10) / 10;
  return `${k}k`;
}

/**
 * `<in>k in/<out>k out` for vendors that report usage (codex); `n/r` when the
 * task has no usage data at all (grok today) or reports neither field —
 * never a bare `0` or blank, which would misread as "used nothing".
 * `cached_input_tokens` is deliberately omitted here; it stays available via
 * `--json`'s raw `usage` object.
 */
function formatUsage(usage: Record<string, number> | null): string {
  if (usage === null) return "n/r";
  const { input_tokens, output_tokens } = usage;
  if (input_tokens === undefined && output_tokens === undefined) return "n/r";
  return `${formatTokenCount(input_tokens ?? 0)} in/${formatTokenCount(output_tokens ?? 0)} out`;
}

/**
 * Prefer daemon-computed `duration_ms` when set; otherwise measure from
 * `started_at ?? created_at` through `completed_at` (or now while live).
 * A still-running task is suffixed `...` to mark it as a growing figure.
 */
function formatDuration(task: TaskEnvelope): string {
  const running = task.completed_at === null;
  let totalSeconds: number;
  if (task.duration_ms !== null && !running) {
    totalSeconds = Math.max(0, Math.floor(task.duration_ms / 1000));
  } else {
    const startMs = Date.parse(task.started_at ?? task.created_at);
    const endMs = task.completed_at === null ? Date.now() : Date.parse(task.completed_at);
    totalSeconds = Math.max(0, Math.floor((endMs - startMs) / 1000));
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const formatted = `${minutes}m${String(seconds).padStart(2, "0")}s`;
  return running ? `${formatted}...` : formatted;
}

/** Compact session id for the table — a git-style prefix, like the short ID. */
function shortSession(id: string | null): string {
  if (!id) return "-";
  return id.length > 8 ? id.slice(0, 8) : id;
}

/**
 * ATTEMPT column (#152): show the 1-based attempt number. First delegations
 * are `1`; each `parley fix` increments. Always present so the column is
 * stable even when every row is a first attempt.
 */
function formatAttempt(task: TaskEnvelope): string {
  return String(task.attempt ?? 1);
}

/**
 * Derived cache-hit tri-state for `--json` (#152): true when the vendor
 * reported a positive cache count, false when it reported zero, null when
 * unreported — never guessed from latency or missing usage.
 */
function cacheHit(cached: number | null | undefined): boolean | null {
  if (cached === null || cached === undefined) return null;
  return cached > 0;
}

/**
 * STATE column (#171 / #315 / #317): plain state, `queued #N (vendor:X)` when
 * waiting on a concurrency cap, `pending (waiting for capable runner…)` when
 * capability routing is waiting, or `failed [git-auth:push]` when the fail is
 * a structured claim-time git failure (distinct from vendor crashes).
 */
function formatState(task: TaskEnvelope): string {
  if (task.state === "queued") {
    const pos = typeof task.queue_position === "number" ? task.queue_position : null;
    const cap = task.blocking_cap ?? null;
    const parts: string[] = ["queued"];
    if (pos !== null) parts.push(`#${pos}`);
    if (cap) parts.push(`(${cap})`);
    return parts.join(" ");
  }
  if (
    task.state === "pending" &&
    typeof task.queue_reason === "string" &&
    task.queue_reason !== ""
  ) {
    return `pending (${task.queue_reason})`;
  }
  if (task.state === "failed") {
    const label = formatErrorCategoryLabel(task.error_category ?? null);
    if (label !== null) return `failed [${label}]`;
  }
  return task.state;
}

function renderTable(ctx: CliContext, tasks: TaskEnvelope[]): void {
  if (tasks.length === 0) {
    ctx.stdout("No tasks.\n");
    return;
  }
  const header = [
    "ID",
    "SESSION",
    "NAME",
    "TYPE",
    "VENDOR",
    "PROFILE",
    "RUNNER",
    "MODEL",
    "STATE",
    "ATTEMPT",
    "USAGE",
    "DURATION",
  ];
  const rows = tasks.map((t) => [
    t.task_id,
    shortSession(t.orchestrator_session_id),
    t.name ?? "-",
    t.type || "other",
    t.vendor ?? "-",
    t.profile ?? "-",
    t.runner ?? "-",
    t.model ?? "-",
    formatState(t),
    formatAttempt(t),
    formatUsage(t.usage),
    formatDuration(t),
  ]);
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)),
  );
  const format = (cells: string[]): string =>
    cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join("  ").trimEnd();
  ctx.stdout(`${format(header)}\n`);
  for (const row of rows) ctx.stdout(`${format(row)}\n`);
}

function formatSigned(n: number): string {
  const rounded = Math.round(n * 10) / 10;
  if (rounded > 0) return `+${rounded}`;
  return String(rounded);
}

/** Render Session / Repo / Eval / Attempts sections for single-task status. */
function renderDetailSections(
  ctx: CliContext,
  detail: {
    task: TaskEnvelope;
    session: SessionProvenance;
    eval_detail: EvalDetail | null;
    attempts: AttemptLineageEntry[];
  },
): void {
  const s = detail.session;
  ctx.stdout("\nSession\n");
  ctx.stdout(`  id:      ${s.session_id ?? "-"}\n`);
  ctx.stdout(`  harness: ${s.harness ?? "-"}\n`);
  ctx.stdout(`  model:   ${s.model ?? "-"}\n`);
  ctx.stdout(`  effort:  ${s.effort ?? "-"}\n`);

  // Repo identity (#313): always show key when present so operators can see
  // the distributed-routing handle without --json.
  const t = detail.task;
  ctx.stdout("\nRepo\n");
  ctx.stdout(`  key:   ${t.repo_key ?? "-"}\n`);
  ctx.stdout(`  fetch: ${t.repo_fetch_url ?? "-"}\n`);
  ctx.stdout(`  path:  ${t.repo ?? "-"}\n`);

  // Structured failure category (#317): git-auth vs plain vendor crash.
  if (t.state === "failed") {
    ctx.stdout("\nError\n");
    const cat = t.error_category ?? null;
    if (cat !== null && cat.kind === "git_auth") {
      ctx.stdout(`  category: git-auth (${cat.operation})\n`);
      ctx.stdout(`  code:     ${formatGitAuthCode(cat.code)}\n`);
      ctx.stdout(`  runner:   ${cat.runner}\n`);
      ctx.stdout(`  repo:     ${cat.repo_key ?? "-"}\n`);
    } else {
      ctx.stdout(`  category: vendor\n`);
    }
    if (t.error) ctx.stdout(`  message:  ${t.error}\n`);
  }

  const e = detail.eval_detail;
  ctx.stdout("\nEval\n");
  if (e === null) {
    ctx.stdout("  (none)\n");
  } else if (e.legacy) {
    ctx.stdout(`  score: ${e.score} (legacy)\n`);
    if (e.feedback) ctx.stdout(`  feedback: ${e.feedback}\n`);
  } else {
    const base = e.baseline === null ? "?" : String(e.baseline);
    const delta =
      e.delta === null ? "" : ` delta=${formatSigned(e.delta)}`;
    const below =
      e.below_baseline === true ? " BELOW BASELINE" : e.below_baseline === false ? "" : "";
    ctx.stdout(`  score: ${e.score} baseline=${base}${delta}${below}\n`);
    if (e.rubric != null) {
      const ver = e.rubric_version != null ? `@v${e.rubric_version}` : "";
      ctx.stdout(`  rubric: ${e.rubric}${ver}\n`);
    }
    if (e.judge) {
      const j = e.judge;
      ctx.stdout(
        `  judge: harness=${j.harness ?? "-"} model=${j.model ?? "-"} effort=${j.effort ?? "-"}\n`,
      );
    }
    if (e.feedback) ctx.stdout(`  feedback: ${e.feedback}\n`);
    if (e.criteria && e.criteria.length > 0) {
      ctx.stdout("  criteria:\n");
      for (const c of e.criteria) {
        const mark = c.pass ? "✓" : "✗";
        const kind = c.kind === "negative" ? " [neg]" : "";
        ctx.stdout(`    ${mark} ${c.id} (w=${c.weight})${kind}\n`);
      }
    }
  }

  // #319's lost-runner enrichment rides the `message:` line of the single
  // category-aware Error section above (#317) — no second section here.

  ctx.stdout("\nAttempts\n");
  if (detail.attempts.length === 0) {
    ctx.stdout("  (none)\n");
    return;
  }
  for (const a of detail.attempts) {
    const badges: string[] = [];
    if (a.resumed) badges.push("resumed");
    if (a.cache_hit === true) badges.push("cache");
    else if (a.cache_hit === false) badges.push("no-cache");
    const badgeStr = badges.length > 0 ? ` [${badges.join(",")}]` : "";
    let scoreStr = "";
    if (a.eval_score !== null && a.eval_score !== undefined) {
      if (a.eval_legacy) {
        scoreStr = ` score=${a.eval_score} (legacy)`;
      } else {
        const base =
          a.eval_baseline !== null && a.eval_baseline !== undefined
            ? `/${a.eval_baseline}`
            : "";
        scoreStr = ` score=${a.eval_score}${base}`;
      }
    }
    ctx.stdout(
      `  #${a.attempt}  ${a.id}  ${a.state}${scoreStr}${badgeStr}\n`,
    );
  }
}

/** CLI-only adornments on an already-decoded list envelope for `--json`. */
function presentEnvelope(task: TaskEnvelope): Record<string, unknown> {
  const cached = task.cached_input_tokens === undefined ? null : task.cached_input_tokens;
  return {
    ...task,
    attempt: task.attempt ?? 1,
    parent_task_id: task.parent_task_id ?? null,
    cached_input_tokens: cached,
    cache_hit: cacheHit(cached),
    queue_position: task.queue_position ?? null,
    blocking_cap: task.blocking_cap ?? null,
  };
}

/**
 * Decode storage-shaped detail `row` fields for status `--json` scripts that
 * still read inspector columns (prompt, launch_command, eval_*, sandbox).
 * List path never uses this — it ships envelopes only (#208).
 */
function presentStorageRow(row: TaskRow): Record<string, unknown> {
  const cached =
    row.cached_input_tokens === undefined ? null : row.cached_input_tokens;
  const parseJson = (value: string | null | undefined): unknown => {
    if (value === null || value === undefined) return null;
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  };
  return {
    ...row,
    usage: parseJson(row.usage),
    report: parseJson(row.report),
    launch_command: parseJson(row.launch_command),
    eval_answers: parseJson(row.eval_answers ?? null),
    // Decode structured fail category for --json scripts (#317).
    error_category: parseErrorCategory(
      typeof row.error_category === "string" ? row.error_category : null,
    ),
    network: row.network === 1,
    resumed: row.resumed === 1,
    attempt: row.attempt ?? 1,
    parent_task_id: row.parent_task_id ?? null,
    cached_input_tokens: cached,
    cache_hit: cacheHit(cached),
    queue_position: row.queue_position ?? null,
    blocking_cap: row.blocking_cap ?? null,
  };
}

/**
 * Present single-task status `--json`: storage row (decoded) plus Session /
 * Eval / Attempts sections (#164) so scripts see the same data as human
 * output. Detail still carries a storage `row` during the #208 migration.
 */
function presentDetail(detail: TaskDetailResponse): Record<string, unknown> {
  const base =
    detail.row !== undefined
      ? presentStorageRow(detail.row)
      : presentEnvelope(detail.task);
  return {
    ...base,
    session: detail.session,
    eval_detail: detail.eval_detail,
    attempts: detail.attempts,
  };
}

/**
 * Resolve the orchestrator session a bare listing narrows to. Listing filter
 * stays flag-first (`--session` > env > latest) so an explicit filter still
 * works under a plugin env. Binding (delegate/fix/eval) is env-first per
 * #190 / ADR-0013. `undefined` means "no session filter" (show all).
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
 * Apply local session scoping after server filters. Server already applied
 * type/provenance/rubric filters via query params; session for list still
 * uses CLI defaulting (latest / env / --all).
 */
function applySessionScope(
  tasks: TaskEnvelope[],
  ref: string | undefined,
  all: boolean,
  sessionFlag: string | undefined,
  env: NodeJS.ProcessEnv,
): TaskEnvelope[] {
  if (ref) {
    return tasks.filter((t) => t.task_id === ref || t.name === ref);
  }
  if (all) return tasks;
  const session = resolveSessionFilter(sessionFlag, env, tasks);
  if (session === undefined) return tasks;
  return tasks.filter((t) => t.orchestrator_session_id === session);
}

/**
 * `parley status [task] [--json] [--session <id>] [--all] [filters]` (and its
 * `parley list` alias). Auto-spawns the daemon, fetches the task table over the
 * CLI plane, and renders it. A task reference may be a short id or a `--name`
 * label — a targeted lookup that bypasses session filtering. With no ref, the
 * listing narrows to one orchestrator session: `--session <id>` (or `latest`),
 * else `PARLEY_SESSION_ID`, else the most-recently-used session.
 * `--all` shows every task. Dimension filters (#164) match metrics.
 * Single-task status renders Session / Eval / Attempts sections.
 */
export async function runStatus(ctx: CliContext, args: string[]): Promise<number> {
  const { positionals, flags } = parseArgs(args, {
    "--json": {},
    "--session": { value: true },
    "--all": {},
    ...METRICS_FILTER_FLAGS,
  });
  const ref = positionals[0];
  const json = flags["--json"] === true;
  const all = flags["--all"] === true;
  const sessionFlag = typeof flags["--session"] === "string" ? flags["--session"] : undefined;
  const filters: TaskMetricsFilters = filtersFromFlags(flags);

  const discovery = await ensureDaemon(ctx.paths, ctx.env);

  // Single-task path: fetch detail so Session/Eval/Attempts are complete.
  if (ref) {
    // Still need the list for name-based resolution when ref is a --name label.
    const listParams = filtersToSearchParams(filters);
    const listQs = listParams.toString();
    const { tasks } = await daemonGet<TasksResponse>(
      discovery,
      listQs === "" ? "/tasks" : `/tasks?${listQs}`,
    );
    const match = tasks.find((t) => t.task_id === ref || t.name === ref);
    if (!match) {
      if (json) {
        printJson(ctx, null);
      } else {
        ctx.stdout("No tasks.\n");
      }
      return 0;
    }
    const detail = await daemonGet<TaskDetailResponse>(
      discovery,
      `/tasks/${encodeURIComponent(match.task_id)}`,
    );
    if (json) {
      printJson(ctx, presentDetail(detail));
    } else {
      renderTable(ctx, [detail.task]);
      renderDetailSections(ctx, {
        task: detail.task,
        session: detail.session,
        eval_detail: detail.eval_detail,
        attempts: detail.attempts,
      });
    }
    return 0;
  }

  // List path: server-side dimension filters + local session scoping.
  const listParams = filtersToSearchParams(filters);
  const listQs = listParams.toString();
  const { tasks } = await daemonGet<TasksResponse>(
    discovery,
    listQs === "" ? "/tasks" : `/tasks?${listQs}`,
  );
  const filtered = applySessionScope(tasks, undefined, all, sessionFlag, ctx.env);

  if (json) {
    printJson(ctx, filtered.map(presentEnvelope));
  } else {
    renderTable(ctx, filtered);
  }
  return 0;
}
